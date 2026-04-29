/**
 * Merchant Category Classifier — Express Router
 * Mount: app.use('/api/classifier', classifierRouter)
 *
 * Dependencies: npm install axios cheerio
 */

import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import { supabase } from "../dbhelper/dbclient.js";

const router = Router();

// ─── Scraper ──────────────────────────────────────────────────────────────────
async function scrapeStore(url) {
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      responseType: "stream",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CategoryBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 5,
    });

    // Collect stream until 10KB or end — whichever comes first
    const chunk = await new Promise((resolve, reject) => {
      const buffers = [];
      let total = 0;
      const LIMIT = 10240; // 10KB

      response.data.on("data", (buf) => {
        const remaining = LIMIT - total;
        if (remaining <= 0) return;
        buffers.push(buf.slice(0, remaining));
        total += Math.min(buf.length, remaining);
        if (total >= LIMIT) response.data.destroy(); // stop download
      });
      response.data.on("end", () =>
        resolve(Buffer.concat(buffers).toString("utf8")),
      );
      response.data.on("close", () =>
        resolve(Buffer.concat(buffers).toString("utf8")),
      );
      response.data.on("error", reject);
    });

    const $ = cheerio.load(chunk);
    return {
      title: $("title").text().trim().slice(0, 200),
      metaDesc:
        $('meta[name="description"]').attr("content")?.trim().slice(0, 500) ||
        $('meta[property="og:description"]')
          .attr("content")
          ?.trim()
          .slice(0, 500) ||
        "",
      ogTitle:
        $('meta[property="og:title"]').attr("content")?.trim().slice(0, 200) ||
        "",
      h1: $("h1").first().text().trim().slice(0, 200),
      bodyText: $("body").text().replace(/\s+/g, " ").trim().slice(0, 1000),
      error: null,
    };
  } catch (e) {
    return {
      title: "",
      metaDesc: "",
      ogTitle: "",
      h1: "",
      bodyText: "",
      error: e.message,
    };
  }
}
// ─── Retry helper ─────────────────────────────────────────────────────────────
async function withRetry(fn, { retries = 4, baseDelay = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = e.response?.status;
      const retryable = status === 429 || status === 503 || status === 500;
      if (!retryable || attempt === retries) throw e;
      const retryAfter = e.response?.headers?.["retry-after"];
      const delay = retryAfter
        ? parseInt(retryAfter) * 1000
        : baseDelay * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Gemini Classifier ────────────────────────────────────────────────────────
async function classifyWithGemini({
  apiKey,
  model,
  store,
  categories,
  scraped,
}) {
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

CATEGORY TAXONOMY ([id] Category\n    - [id] Subcategory):
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

  const res = await withRetry(() =>
    axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
      },
      { timeout: 45000 },
    ),
  );

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/categories", async (req, res) => {
  const { data, error } = await supabase
    .from("merchant_categories_v2")
    .select("id, name, slug, parent_id")
    .order("parent_id", { ascending: true, nullsFirst: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ categories: data });
});

router.get("/merchants/batch", async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 500;
  const onlyActive = req.query.onlyActive === "true";
  const onlyPublished = req.query.onlyPublished === "true";
  const statusFilter = req.query.statusFilter || "unprocessed"; // unprocessed | failed | all

  let query = supabase
    .from("merchants")
    .select(
      "id, name, web_url, aff_url, category_id, subcategory_id, classifier_status",
      { count: "exact" },
    )
    .order("id")
    .range(offset, offset + limit - 1);

  if (onlyActive) query = query.eq("active", true);
  if (onlyPublished) query = query.eq("is_publish", true);

  if (statusFilter === "unprocessed")
    query = query.is("classifier_status", null);
  else if (statusFilter === "failed")
    query = query.eq("classifier_status", "failed");
  // "all" — no filter

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ merchants: data, total: count });
});

// Mark a single merchant failed immediately (called by frontend on classify error)
router.post("/merchants/mark-failed", async (req, res) => {
  const { id } = req.body;
  const { error } = await supabase
    .from("merchants")
    .update({ classifier_status: "failed" })
    .eq("id", id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/classify", async (req, res) => {
  const { geminiKey, model, merchant, categories } = req.body;
  try {
    const url = merchant.web_url || merchant.aff_url;
    const scraped = url
      ? await scrapeStore(url)
      : {
          title: merchant.name,
          metaDesc: "",
          ogTitle: "",
          h1: "",
          bodyText: "",
          error: "no URL",
        };

    const classification = await classifyWithGemini({
      apiKey: geminiKey || process.env.GEMINI_API_KEY,
      model,
      store: merchant,
      categories,
      scraped,
    });

    const changed =
      classification.category_id !== merchant.category_id ||
      classification.subcategory_id !== merchant.subcategory_id;

    // If no change needed — mark completed immediately, no review required
    if (!changed) {
      await supabase
        .from("merchants")
        .update({ classifier_status: "completed" })
        .eq("id", merchant.id);
    }

    res.json({ classification, scraped: { error: scraped.error }, changed });
  } catch (e) {
    // Mark failed in DB so it surfaces on next "failed" batch load
    await supabase
      .from("merchants")
      .update({ classifier_status: "failed" })
      .eq("id", merchant.id);

    res.status(500).json({ error: e.message });
  }
});

router.post("/categories/create", async (req, res) => {
  const { category } = req.body;
  const { data, error } = await supabase
    .from("merchant_categories_v2")
    .insert({
      name: category.name,
      slug: category.slug,
      description: category.description || null,
      parent_id: category.parent_id || null,
      is_publish: false,
    })
    .select("id, name, slug, parent_id")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ category: data });
});

// Commit approved corrections — marks completed, rejects stay as-is for manual review
router.post("/merchants/update", async (req, res) => {
  const { corrections, rejected } = req.body;
  // corrections: [{ id, category_id, subcategory_id }]
  // rejected: [id] — mismatches the user did not approve; mark completed since they were reviewed
  const updated = [],
    failed = [];

  await Promise.all([
    ...corrections.map(async (c) => {
      const { error } = await supabase
        .from("merchants")
        .update({
          category_id: c.category_id,
          subcategory_id: c.subcategory_id,
          classifier_status: "completed",
        })
        .eq("id", c.id);

      if (error) failed.push({ id: c.id, error: error.message });
      else updated.push(c.id);
    }),
    // Mark rejected mismatches as completed too — they were reviewed, just kept as-is
    ...(rejected || []).map((id) =>
      supabase
        .from("merchants")
        .update({ classifier_status: "completed" })
        .eq("id", id),
    ),
  ]);

  res.json({ updated, failed });
});

export default router;
