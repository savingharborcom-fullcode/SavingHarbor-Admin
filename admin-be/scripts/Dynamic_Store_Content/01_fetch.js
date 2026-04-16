/**
 * STEP 1: Fetch
 *
 * Reads merchants + their live coupons directly from Supabase.
 * Produces merchants_cache.json consumed by 02_scraper.js.
 *
 * What it fetches per merchant:
 *   - Core merchant fields needed downstream
 *   - All active coupons (is_publish = true): title, coupon_type,
 *     discount_type, discount_value, coupon_code, show_proof
 *   - Derives offerSummary: counts, best discount, top codes, top titles
 *
 * Run:               node scripts/Dynamic_Store_Content/01_fetch.js
 * Filter by status:  node scripts/Dynamic_Store_Content/01_fetch.js --status=template
 * Single store:      node scripts/Dynamic_Store_Content/01_fetch.js --slug=nike
 * Dry run (print):   node scripts/Dynamic_Store_Content/01_fetch.js --dry-run
 */

import fs from "fs";
import path from "path";
import { supabase } from "../../dbhelper/dbclient.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const CACHE_PATH = path.resolve(
  "./scripts/Dynamic_Store_Content/merchants_cache.json",
);

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SLUG = args.find((a) => a.startsWith("--slug="))?.split("=")[1] || null;
const STATUS =
  args.find((a) => a.startsWith("--status="))?.split("=")[1] || null;
const STATUSES = STATUS ? STATUS.split(",").map((s) => s.trim()) : null;

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;

// ─── Offer summary builder ────────────────────────────────────────────────────

function buildOfferSummary(coupons) {
  if (!coupons?.length) {
    return {
      totalActive: 0,
      couponCount: 0,
      dealCount: 0,
      verifiedCount: 0,
      bestDiscount: null,
      bestDiscountType: null,
      topCodes: [],
      topTitles: [],
    };
  }

  const couponRows = coupons.filter((c) => c.coupon_type === "coupon");
  const dealRows = coupons.filter((c) => c.coupon_type === "deal");
  const verified = coupons.filter((c) => c.show_proof === true);

  const withPct = coupons
    .filter((c) => c.discount_type === "percentage" && c.discount_value)
    .map((c) => ({ ...c, _val: parseFloat(c.discount_value) }))
    .filter((c) => !isNaN(c._val) && c._val > 0)
    .sort((a, b) => b._val - a._val);

  const withFlat = coupons
    .filter((c) => c.discount_type === "flat" && c.discount_value)
    .map((c) => ({ ...c, _val: parseFloat(c.discount_value) }))
    .filter((c) => !isNaN(c._val) && c._val > 0)
    .sort((a, b) => b._val - a._val);

  let bestDiscount = null;
  let bestDiscountType = null;

  if (withPct.length) {
    bestDiscount = String(
      withPct[0]._val % 1 === 0 ? Math.round(withPct[0]._val) : withPct[0]._val,
    );
    bestDiscountType = "percentage";
  } else if (withFlat.length) {
    bestDiscount = String(
      withFlat[0]._val % 1 === 0
        ? Math.round(withFlat[0]._val)
        : withFlat[0]._val,
    );
    bestDiscountType = "flat";
  }

  const topCodes = [
    ...new Set(
      couponRows
        .filter((c) => c.coupon_code?.trim())
        .map((c) => c.coupon_code.trim().toUpperCase()),
    ),
  ].slice(0, 3);

  const sorted = [...coupons].sort((a, b) => {
    if (a.show_proof && !b.show_proof) return -1;
    if (!a.show_proof && b.show_proof) return 1;
    const aVal = parseFloat(a.discount_value) || 0;
    const bVal = parseFloat(b.discount_value) || 0;
    return bVal - aVal;
  });

  const topTitles = sorted
    .map((c) => c.title?.trim())
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 5);

  const pctValues = withPct.map((c) => c._val).filter((v) => v > 0);
  const minPct = pctValues.length ? Math.min(...pctValues) : null;
  const maxPct = pctValues.length ? Math.max(...pctValues) : null;

  return {
    totalActive: coupons.length,
    couponCount: couponRows.length,
    dealCount: dealRows.length,
    verifiedCount: verified.length,
    bestDiscount,
    bestDiscountType,
    discountRange: pctValues.length >= 2 ? { min: minPct, max: maxPct } : null,
    topCodes,
    topTitles,
  };
}

// ─── Fetch coupons for a batch of merchant IDs ────────────────────────────────

async function fetchCouponsForMerchants(merchantIds) {
  const map = new Map();
  if (!merchantIds.length) return map;

  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("coupons")
      .select(
        "merchant_id, title, coupon_type, discount_type, discount_value, coupon_code, show_proof",
      )
      .in("merchant_id", merchantIds)
      .eq("is_publish", true)
      .order("merchant_id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`Coupons fetch failed: ${error.message}`);
    if (!data?.length) break;

    for (const row of data) {
      if (!map.has(row.merchant_id)) map.set(row.merchant_id, []);
      map.get(row.merchant_id).push(row);
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return map;
}

// ─── Fetch merchants (paginated — supports 20k+ stores) ───────────────────────

async function fetchMerchants() {
  const all = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("merchants")
      .select(
        `
        id,
        name,
        slug,
        web_url,
        is_publish,
        active_coupons_count,
        category_names,
        content_status,
        scrape_score,
        content_tier,
        scraped_data,
        scrape_attempted_at
      `,
      )
      .eq("is_publish", true)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (SLUG) {
      query = query.eq("slug", SLUG);
    } else if (STATUSES) {
      query = query.in("content_status", STATUSES);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Merchants fetch failed: ${error.message}`);
    if (!data?.length) break;

    all.push(...data);

    // Single slug → done after first page
    if (SLUG || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

// ─── Normalize category_names ─────────────────────────────────────────────────

function normalizeCategoryNames(raw) {
  if (!raw) return "";
  if (Array.isArray(raw)) return raw.join(", ");
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.join(", ");
    } catch {}
    return raw;
  }
  return "";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n📦 Fetch | DryRun: ${DRY_RUN} | Slug: ${SLUG || "all"} | Status filter: ${STATUSES?.join(",") || "none"}\n`,
  );

  console.log("  → Fetching merchants...");
  const merchants = await fetchMerchants();
  console.log(`  ✓ ${merchants.length} merchants loaded`);

  if (!merchants.length) {
    console.log("  Nothing to fetch. Check filters.");
    return;
  }

  const merchantIds = merchants.map((m) => m.id);
  console.log("  → Fetching active coupons...");
  const couponsMap = await fetchCouponsForMerchants(merchantIds);

  let totalCoupons = 0;
  for (const v of couponsMap.values()) totalCoupons += v.length;
  console.log(
    `  ✓ ${totalCoupons} active coupons across ${couponsMap.size} stores`,
  );

  const records = merchants.map((m) => {
    const coupons = couponsMap.get(m.id) || [];
    return {
      id: m.id,
      name: m.name,
      slug: m.slug,
      web_url: m.web_url,
      is_publish: m.is_publish,
      active_coupons_count: m.active_coupons_count,
      category_names: normalizeCategoryNames(m.category_names),
      content_status: m.content_status,
      scrape_score: m.scrape_score,
      content_tier: m.content_tier,
      scraped_data: m.scraped_data,
      scrape_attempted_at: m.scrape_attempted_at,
      offerSummary: buildOfferSummary(coupons),
      fetched_at: new Date().toISOString(),
    };
  });

  // ── Summary stats ──────────────────────────────────────────────────────────
  const withOffers = records.filter((r) => r.offerSummary.totalActive > 0).length;
  const withCodes = records.filter((r) => r.offerSummary.topCodes.length > 0).length;
  const withVerified = records.filter((r) => r.offerSummary.verifiedCount > 0).length;
  const withDiscount = records.filter((r) => r.offerSummary.bestDiscount !== null).length;
  const withScraped = records.filter((r) => r.scraped_data !== null).length;
  const avgOffers = withOffers
    ? Math.round(records.reduce((s, r) => s + r.offerSummary.totalActive, 0) / records.length)
    : 0;

  console.log(`\n${"─".repeat(50)}`);
  console.log(`📋 Merchants:         ${records.length}`);
  console.log(`🎟️  With offers:       ${withOffers} (avg ${avgOffers} active)`);
  console.log(`🔑 With coupon codes: ${withCodes}`);
  console.log(`✅ With verified:     ${withVerified}`);
  console.log(`💰 With discount val: ${withDiscount}`);
  console.log(`🕷️  Already scraped:   ${withScraped}`);
  console.log(`${"─".repeat(50)}\n`);

  if (DRY_RUN) {
    console.log("[DRY RUN] Sample record:");
    console.log(JSON.stringify(records[0], null, 2));
    console.log(`\n[DRY RUN] Would write ${records.length} records to ${CACHE_PATH}`);
    return;
  }

  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(CACHE_PATH, JSON.stringify(records, null, 2));
  console.log(`✅ Written: ${CACHE_PATH}`);
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});