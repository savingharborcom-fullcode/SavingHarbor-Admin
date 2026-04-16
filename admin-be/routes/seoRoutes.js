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
      .from("merchant_categories")
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

export default router;
