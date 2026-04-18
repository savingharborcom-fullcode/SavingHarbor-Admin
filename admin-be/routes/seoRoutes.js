/**
 * SEO routes
 * GET  /api/seo/merchant-data?slug=   — pull merchant + coupon stats
 * PATCH /api/seo/merchant-content      — save generated content to merchants table
 * GET  /api/seo/crawl?url=            — server-side crawl proxy (fixes CORS)
 */

import express from "express";
import { supabase } from "../dbhelper/dbclient.js";

const router = express.Router();

// ─── GET /api/seo/merchant-data ───────────────────────────────────
router.get("/merchant-data", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug required" });

  try {
    // 1. Merchant
    const { data: merchant, error: mErr } = await supabase
      .from("merchants")
      .select("id, name, web_url, category_id, active_coupons_count")
      .eq("slug", slug)
      .single();

    if (mErr || !merchant) return res.status(404).json({ error: "Merchant not found" });

    // 2. Category name
    const { data: categoryRow } = await supabase
      .from("merchant_categories_v2")
      .select("name")
      .eq("id", merchant.category_id)
      .single();

    // 3. Coupons — correct column names from actual schema
    // active = is_publish true
    // coupon_type: 'coupon' | 'deal'
    // discount_type: 'percent' | 'flat' | 'none'
    // code column: coupon_code (not code)
    const { data: coupons, error: cErr } = await supabase
      .from("coupons")
      .select("id, title, coupon_code, coupon_type, discount_type, discount_value, currency")
      .eq("merchant_id", merchant.id)
      .eq("is_publish", true)
      .order("discount_value", { ascending: false, nullsFirst: false })
      .limit(20);

    if (cErr) throw cErr;

    const activeCoupons = coupons || [];

    // 4. Stats
    const pctCoupons = activeCoupons.filter((c) => c.discount_type === "percent" && c.discount_value);
    const flatCoupons = activeCoupons.filter((c) => c.discount_type === "flat" && c.discount_value);

    const maxDiscount = pctCoupons.length
      ? Math.max(...pctCoupons.map((c) => Number(c.discount_value)))
      : null;

    const avgDiscount = pctCoupons.length
      ? Math.round(pctCoupons.reduce((s, c) => s + Number(c.discount_value), 0) / pctCoupons.length)
      : null;

    const maxFlat = flatCoupons.length
      ? Math.max(...flatCoupons.map((c) => Number(c.discount_value)))
      : null;

    const couponTypes = [...new Set(activeCoupons.map((c) => c.discount_type).filter(Boolean))];

    const hasNewUserOffer = activeCoupons.some((c) =>
      ["new", "first"].some((kw) => (c.title || "").toLowerCase().includes(kw))
    );

    // 5. Response — field names the frontend expects
    return res.json({
      merchantId: merchant.id,
      name: merchant.name,
      webUrl: merchant.web_url,
      category: categoryRow?.name || null,
      totalCoupons: activeCoupons.filter((c) => c.coupon_type === "coupon").length,
      totalDeals: activeCoupons.filter((c) => c.coupon_type === "deal").length,
      maxDiscount,       // highest % off
      avgDiscount,       // avg % off
      maxFlatDiscount: maxFlat,
      couponTypes,       // ['percent','flat','none']
      hasFreeShipping: false, // no free_shipping type in this schema — flag kept for prompt compat
      hasNewUserOffer,
      coupons: activeCoupons.slice(0, 10).map((c) => ({
        title: c.title,
        code: c.coupon_code,        // correct column name
        discountType: c.discount_type,
        value: c.discount_value ? Number(c.discount_value) : null,
        currency: c.currency,
        type: c.coupon_type,        // 'coupon' | 'deal'
      })),
      lastUpdated: new Date().toISOString().split("T")[0],
    });
  } catch (err) {
    console.error("merchant-data error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

// ─── PATCH /api/seo/merchant-content ─────────────────────────────
const ALLOWED_CONTENT_FIELDS = new Set([
  "meta_title",
  "meta_description",
  "h1keyword",
  "meta_keywords",
  "description_html",
  "faqs",
  "coupon_h2_blocks",
  "coupon_h3_blocks",
]);

router.patch("/merchant-content", async (req, res) => {
  const { slug, content } = req.body;
  if (!slug) return res.status(400).json({ error: "slug required" });
  if (!content || typeof content !== "object") return res.status(400).json({ error: "content object required" });

  const payload = {};
  payload.content_generated = true; // mark as generated when content is saved
  for (const [key, value] of Object.entries(content)) {
    if (ALLOWED_CONTENT_FIELDS.has(key)) payload[key] = value;
  }
  if (!Object.keys(payload).length) return res.status(400).json({ error: "No valid content fields" });

  try {
    const { data, error } = await supabase
      .from("merchants")
      .update(payload)
      .eq("slug", slug)
      .select("id, slug, name, updated_at")
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: `No merchant: ${slug}` });

    return res.json({
      success: true,
      merchantId: data.id,
      slug: data.slug,
      name: data.name,
      updatedAt: data.updated_at,
      fieldsUpdated: Object.keys(payload),
    });
  } catch (err) {
    console.error("merchant-content error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

// ─── GET /api/seo/crawl ───────────────────────────────────────────
// Server-side proxy — fixes CORS block on frontend direct fetch
router.get("/crawl", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SavingHarborBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Upstream ${response.status}`);

    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 11000);

    return res.json({ text: text.length > 100 ? text : "No substantial content found." });
  } catch (err) {
    return res.json({ text: `CRAWL FAILED: ${err.message}` });
  }
});

// ─── GET /api/seo/pending-merchants ──────────────────────────────
// Returns merchants with no generated content (description_html null/empty)
// Frontend "Load Pending" button uses this to auto-fill batch textarea
router.get("/pending-merchants", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 500);

  try {
    const { data, error } = await supabase
      .from("merchants")
      .select("id, name, slug, web_url, category_id")
      .eq("is_publish", true)
      .eq("content_generated",false)
      .order("name", { ascending: true })
      .limit(limit);

    if (error) throw error;

    // Batch fetch category names
    const categoryIds = [...new Set((data || []).map((m) => m.category_id).filter(Boolean))];
    let categoryMap = {};
    if (categoryIds.length) {
      const { data: cats } = await supabase
        .from("merchant_categories_v2")
        .select("id, name")
        .in("id", categoryIds);
      (cats || []).forEach((c) => { categoryMap[c.id] = c.name; });
    }

    const merchants = (data || []).map((m) => ({
      name: m.name,
      slug: m.slug,
      webUrl: m.web_url || "",
      category: categoryMap[m.category_id] || "General",
    }));

    return res.json({ merchants, total: merchants.length });
  } catch (err) {
    console.error("pending-merchants error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

export default router;