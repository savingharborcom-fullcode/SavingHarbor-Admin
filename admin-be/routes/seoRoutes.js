/**
 * ─── EXPRESS BACKEND ENDPOINT REQUIRED ───────────────────────────
 *
 * Add this route to your Node/Express backend on Render.
 * It reads from your Supabase DB and returns the data
 * this engine needs to enrich content generation.
 *
 * GET /api/seo/merchant-data?slug=healthyline-coupons
 *
 * ─────────────────────────────────────────────────────────────────
 *
 */
import express from "express";
import {supabase} from "../dbhelper/dbclient.js";

const router = express.Router();

// routes/seo.js
router.get("/merchant-data", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug required" });

  try {
    // 1. Get merchant
    const { data: merchant } = await supabase
      .from("merchants")
      .select("id, name, category_id, web_url")
      .eq("slug", slug)
      .single();

    if (!merchant) return res.status(404).json({ error: "Merchant not found" });

    // 2. Get all coupons for this merchant
    const { data: coupons } = await supabase
      .from("coupons")
      .select(
        "id, title, code, discount_type, discount_value, is_active, expires_at",
      )
      .eq("merchant_id", merchant.id)
      .eq("is_active", true)
      .order("discount_value", { ascending: false })
      .limit(20);

    const { data: merchantCategory } = await supabase
      .from("merchant_categories_v2")
      .select("id, name ")
      .eq("id", merchant.category_id)
      .single();

    const activeCoupons = coupons || [];

    // 3. Compute useful stats
    const pctCoupons = activeCoupons.filter(
      (c) => c.discount_type === "percentage",
    );
    const flatCoupons = activeCoupons.filter((c) => c.discount_type === "flat");
    const maxDiscount = pctCoupons.length
      ? Math.max(...pctCoupons.map((c) => c.discount_value || 0))
      : null;
    const avgDiscount = pctCoupons.length
      ? Math.round(
          pctCoupons.reduce((s, c) => s + (c.discount_value || 0), 0) /
            pctCoupons.length,
        )
      : null;
    const couponTypes = [...new Set(activeCoupons.map((c) => c.discount_type))];

    // 4. Return structured payload
    res.json({
      merchantId: merchant.id,
      name: merchant.name,
      category: merchantCategory.name,
      totalCoupons: activeCoupons.length,
      totalDeals: activeCoupons.filter((c) => !c.code).length,
      maxDiscount,
      avgDiscount,
      couponTypes,
      hasFreeShipping: activeCoupons.some(
        (c) => c.discount_type === "free_shipping",
      ),
      hasNewUserOffer: activeCoupons.some(
        (c) =>
          (c.title || "").toLowerCase().includes("new") ||
          (c.title || "").toLowerCase().includes("first"),
      ),
      coupons: activeCoupons.slice(0, 10).map((c) => ({
        title: c.title,
        code: c.code,
        discountType: c.discount_type,
        value: c.discount_value,
        expires: c.expires_at,
      })),
      lastUpdated: new Date().toISOString().split("T")[0],
    });
  } catch (err) {
    console.error("SEO merchant data error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Columns this endpoint is allowed to write — whitelist, nothing else touches the merchants row
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
 
  if (!slug) return res.status(400).json({ error: "slug is required" });
  if (!content || typeof content !== "object") return res.status(400).json({ error: "content object is required" });
 
  // Strip any keys not in the whitelist — never let this endpoint touch operational columns
  const payload = {};
  for (const [key, value] of Object.entries(content)) {
    if (ALLOWED_CONTENT_FIELDS.has(key)) {
      payload[key] = value;
    }
  }
 
  if (Object.keys(payload).length === 0) {
    return res.status(400).json({ error: "No valid content fields provided" });
  }
 
  // updated_at is handled by the DB trigger (trg_merchants_updated_at), no need to set it manually
 
  try {
    const { data, error } = await supabase
      .from("merchants")
      .update(payload)
      .eq("slug", slug)
      .select("id, slug, name, updated_at")
      .single();
 
    if (error) throw error;
    if (!data) return res.status(404).json({ error: `No merchant found with slug: ${slug}` });
 
    return res.json({
      success: true,
      merchantId: data.id,
      slug: data.slug,
      name: data.name,
      updatedAt: data.updated_at,
      fieldsUpdated: Object.keys(payload),
    });
  } catch (err) {
    console.error("merchant-content save error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});
 
export default router;
