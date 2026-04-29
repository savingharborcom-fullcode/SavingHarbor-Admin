/**
 * Merchant Category Classifier — Express Router
 * Mount in your app: app.use('/api/classifier', require('./routes/classifier'))
 *
 * Required env (or pass via request body for DB):
 *   GEMINI_API_KEY — optional fallback if not sent from UI
 */

import { Router } from "express";
import pg from "pg";
import axios from "axios";
import * as cheerio from "cheerio";

const router = Router();

// ─── DB Pool Cache ────────────────────────────────────────────────────────────
const pools = {};

function getPool(cfg) {
  const key = `${cfg.host}:${cfg.port || 5432}:${cfg.database}:${cfg.user}`;
  if (!pools[key]) {
    pools[key] = new pg.Pool({
      host: cfg.host,
      port: cfg.port || 5432,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pools[key];
}

// ─── Scraper ──────────────────────────────────────────────────────────────────
async function scrapeStore(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CategoryBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 5,
    });
    const $ = cheerio.load(data);
    return {
      title: $("title").text().trim().slice(0, 200),
      metaDesc:
        $('meta[name="description"]').attr("content")?.trim().slice(0, 500) ||
        $('meta[property="og:description"]').attr("content")?.trim().slice(0, 500) ||
        "",
      ogTitle: $('meta[property="og:title"]').attr("content")?.trim().slice(0, 200) || "",
      h1: $("h1").first().text().trim().slice(0, 200),
      bodyText: $("body").text().replace(/\s+/g, " ").trim().slice(0, 1000),
      error: null,
    };
  } catch (e) {
    return { title: "", metaDesc: "", ogTitle: "", h1: "", bodyText: "", error: e.message };
  }
}

// ─── Gemini Classifier ────────────────────────────────────────────────────────
async function classifyWithGemini({ apiKey, model, store, categories, scraped }) {
  const categoryList = categories
    .map((c) => {
      if (c.parent_id) return null;
      const subs = categories
        .filter((s) => s.parent_id === c.id)
        .map((s) => `    - [${s.id}] ${s.name}`)
        .join("\n");
      return `[${c.id}] ${c.name}${subs ? "\n" + subs : ""}`;
    })
    .filter(Boolean)
    .join("\n");

  const prompt = `You are a merchant categorization engine. Given store information and a category taxonomy, determine the best category and subcategory.

STORE:
- Name: ${store.name}
- URL: ${store.web_url || store.aff_url || "N/A"}
- Current category_id: ${store.category_id ?? "none"}
- Current subcategory_id: ${store.subcategory_id ?? "none"}

SCRAPED DATA:
- Title: ${scraped.title}
- OG Title: ${scraped.ogTitle}
- H1: ${scraped.h1}
- Meta Description: ${scraped.metaDesc}
- Body snippet: ${scraped.bodyText.slice(0, 600)}
${scraped.error ? `- Scrape error: ${scraped.error}` : ""}

CATEGORY TAXONOMY ([id] Category / [id] Subcategory):
${categoryList}

TASK:
1. Pick the single best category_id (top-level, no parent_id).
2. Pick the single best subcategory_id (child of chosen category). Null if none fits.
3. If NO existing category fits, set needs_new_category: true and suggest name/slug/description.
4. If NO existing subcategory fits, set needs_new_subcategory: true and suggest name/slug/parent_id/description.

Respond ONLY with valid JSON, no markdown:
{
  "category_id": <integer|null>,
  "subcategory_id": <integer|null>,
  "needs_new_category": <boolean>,
  "new_category": { "name": "", "slug": "", "description": "" } | null,
  "needs_new_subcategory": <boolean>,
  "new_subcategory": { "name": "", "slug": "", "parent_id": <integer>, "description": "" } | null,
  "confidence": <0.0-1.0>,
  "reasoning": "<one sentence>"
}`;

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    },
    { timeout: 30000 }
  );

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/test-connection", async (req, res) => {
  try {
    const client = await getPool(req.body).connect();
    await client.query("SELECT 1");
    client.release();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/categories", async (req, res) => {
  try {
    const { rows } = await getPool(req.body.db).query(
      "SELECT id, name, slug, parent_id FROM merchant_categories_v2 ORDER BY parent_id NULLS FIRST, id"
    );
    res.json({ categories: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/merchants/batch", async (req, res) => {
  const { db, offset = 0, limit = 500, filter = {} } = req.body;
  try {
    const conditions = [];
    if (filter.onlyActive) conditions.push("active = true");
    if (filter.onlyPublished) conditions.push("is_publish = true");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [{ rows: merchants }, { rows: count }] = await Promise.all([
      getPool(db).query(
        `SELECT id, name, web_url, aff_url, category_id, subcategory_id
         FROM merchants ${where} ORDER BY id LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      getPool(db).query(`SELECT COUNT(*) as total FROM merchants ${where}`),
    ]);

    res.json({ merchants, total: parseInt(count[0].total) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/classify", async (req, res) => {
  const { db, geminiKey, model, merchant, categories } = req.body;
  try {
    const url = merchant.web_url || merchant.aff_url;
    const scraped = url
      ? await scrapeStore(url)
      : { title: merchant.name, metaDesc: "", ogTitle: "", h1: "", bodyText: "", error: "no URL" };

    const classification = await classifyWithGemini({
      apiKey: geminiKey || process.env.GEMINI_API_KEY,
      model,
      store: merchant,
      categories,
      scraped,
    });

    res.json({
      classification,
      scraped: { error: scraped.error },
      changed:
        classification.category_id !== merchant.category_id ||
        classification.subcategory_id !== merchant.subcategory_id,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/categories/create", async (req, res) => {
  const { db, category } = req.body;
  try {
    const { rows } = await getPool(db).query(
      `INSERT INTO merchant_categories_v2 (name, slug, description, parent_id, is_publish)
       VALUES ($1, $2, $3, $4, false) RETURNING id, name, slug, parent_id`,
      [category.name, category.slug, category.description || null, category.parent_id || null]
    );
    res.json({ category: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/merchants/update", async (req, res) => {
  const { db, corrections } = req.body;
  const client = await getPool(db).connect();
  const updated = [], failed = [];
  try {
    await client.query("BEGIN");
    for (const c of corrections) {
      try {
        await client.query(
          `UPDATE merchants SET category_id = $1, subcategory_id = $2, updated_at = NOW() WHERE id = $3`,
          [c.category_id, c.subcategory_id, c.id]
        );
        updated.push(c.id);
      } catch (e) {
        failed.push({ id: c.id, error: e.message });
      }
    }
    await client.query("COMMIT");
    res.json({ updated, failed });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

export default router;