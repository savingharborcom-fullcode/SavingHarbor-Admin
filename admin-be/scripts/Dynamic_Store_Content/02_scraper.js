/**
 * STEP 2: Scraper
 *
 * Reads merchants_cache.json (produced by 01_fetch.js).
 * For each merchant:
 *   1. Scrapes homepage (cheerio)
 *   2. Discovers + scrapes subpages: about, faq, shipping, returns
 *   3. Scrapes Trustpilot
 *   4. Queries Reddit
 *
 * offerSummary from 01_fetch.js is passed through untouched.
 * Output: scraped_results.ndjson (newline-delimited JSON for safe incremental writes)
 *
 * Run:              node scripts/Dynamic_Store_Content/02_scraper.js
 * Limit:            node scripts/Dynamic_Store_Content/02_scraper.js --limit=5
 * From ID:          node scripts/Dynamic_Store_Content/02_scraper.js --from-id=100
 * Single store:     node scripts/Dynamic_Store_Content/02_scraper.js --slug=nike
 * Force re-scrape:  node scripts/Dynamic_Store_Content/02_scraper.js --force
 * Concurrency:      node scripts/Dynamic_Store_Content/02_scraper.js --concurrency=3
 * Dry run:          node scripts/Dynamic_Store_Content/02_scraper.js --dry-run
 */

import pLimit from "p-limit";
import fs from "fs";
import path from "path";
import { discoverUrls } from "./url_discoverer.js";
import {
  extractContent,
  extractHomepage,
  hasUsefulContent,
} from "./content_extractor.js";
import { scrapeTrustpilot } from "./trustpilot_scraper.js";
import { scrapeReddit } from "./reddit_scraper.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const CACHE_PATH = path.resolve(
  "./scripts/Dynamic_Store_Content/merchants_cache.json",
);
// NDJSON: one JSON record per line — safe for incremental appends,
// no full-file rewrite on every save (critical at 20k+ stores).
const SCRAPED_PATH = path.resolve(
  "./scripts/Dynamic_Store_Content/scraped_results.ndjson",
);

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0",
);
const FROM_ID = parseInt(
  args.find((a) => a.startsWith("--from-id="))?.split("=")[1] || "0",
);
const SLUG = args.find((a) => a.startsWith("--slug="))?.split("=")[1] || null;
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || "1",
);

// ─── Config ───────────────────────────────────────────────────────────────────

const PAGE_DELAY_MS = 1500;
const SUBPAGE_TIMEOUT = 15000;

// ─── Resume support ───────────────────────────────────────────────────────────
// Reads existing NDJSON to build the already-scraped slug set.
// Never loads all records into memory — just slug index.

function loadScrapedSlugs() {
  const slugs = new Set();
  if (!fs.existsSync(SCRAPED_PATH)) return slugs;
  try {
    const lines = fs.readFileSync(SCRAPED_PATH, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (rec.slug) slugs.add(rec.slug);
      } catch {}
    }
    console.log(`📋 Resuming — ${slugs.size} already scraped`);
  } catch (err) {
    console.log(`⚠️  Could not read scraped_results.ndjson: ${err.message}`);
  }
  return slugs;
}

// Append a single record as one line — O(1), no full-file rewrite.
function appendRecord(record) {
  fs.appendFileSync(SCRAPED_PATH, JSON.stringify(record) + "\n");
}

// For --force: rewrite only the affected slug's line is complex with NDJSON,
// so on --force we rewrite the whole file. Acceptable — force is a deliberate
// operator action, not the hot path.
function rewriteNdjson(records) {
  fs.writeFileSync(
    SCRAPED_PATH,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

function loadAllRecords() {
  if (!fs.existsSync(SCRAPED_PATH)) return [];
  const lines = fs.readFileSync(SCRAPED_PATH, "utf8").split("\n");
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {}
  }
  return records;
}

// ─── Trustpilot snippet cleaner ───────────────────────────────────────────────

function cleanTrustpilotSnippets(snippets = []) {
  if (!Array.isArray(snippets)) return [];
  const banned = [
    "fake reviews",
    "platform",
    "guidelines",
    "read more",
    "learn more",
    "our software",
    "trustpilot",
  ];
  return snippets.filter((s) => {
    if (!s || typeof s !== "string" || s.length < 20) return false;
    const lower = s.toLowerCase();
    return !banned.some((b) => lower.includes(b));
  });
}

// ─── Reddit cleaner ───────────────────────────────────────────────────────────

function cleanRedditData(reddit = {}, storeName = "") {
  if (!reddit || typeof reddit !== "object") {
    return {
      found: false,
      threads: [],
      commonQuestions: [],
      commonComplaints: [],
      overallSentiment: "neutral",
    };
  }

  const brand = storeName.toLowerCase();
  const offTopicSubs = new Set([
    "destinythegame",
    "superstonk",
    "politics",
    "gaming",
    "pcgaming",
    "wallstreetbets",
    "nfl",
    "nba",
    "soccer",
    "movies",
    "television",
  ]);
  const shoppingKeywords = [
    "coupon",
    "code",
    "discount",
    "promo",
    "review",
    "experience",
    "shipping",
    "quality",
    "refund",
    "scam",
    "legit",
    "worth",
    "recommend",
    "buy",
    "purchase",
    "order",
    "customer",
    "service",
  ];

  const filtered = (reddit.threads || []).filter((t) => {
    if (!t || typeof t !== "object") return false;
    const title = (t.title || "").toLowerCase();
    const snip = (t.snippet || "").toLowerCase();
    const sub = (t.subreddit || "").toLowerCase();

    if (offTopicSubs.has(sub)) return false;

    const hasBrand =
      brand.length > 3 && (title.includes(brand) || snip.includes(brand));
    const hasKeyword = shoppingKeywords.some(
      (k) => title.includes(k) || snip.includes(k),
    );

    return hasBrand || (hasKeyword && title.includes(brand.split(" ")[0]));
  });

  return {
    found: filtered.length > 0,
    threads: filtered.slice(0, 6),
    commonQuestions: Array.isArray(reddit.commonQuestions)
      ? reddit.commonQuestions
      : [],
    commonComplaints: Array.isArray(reddit.commonComplaints)
      ? reddit.commonComplaints
      : [],
    overallSentiment: reddit.overallSentiment || "neutral",
  };
}

// ─── Richness scoring ─────────────────────────────────────────────────────────

function scoreRichness(data, offerSummary) {
  let s = 0;
  const w = data.website || {};
  const hp = w.homepage || {};
  const tp = data.trustpilot || {};
  const rd = data.reddit || {};

  if (hp.h1) s += 4;
  if ((hp.metaDescription || "").length > 50) s += 6;
  if (hp.heroTaglines?.length) s += Math.min(hp.heroTaglines.length, 4) * 1.5;
  if (hp.productHeadings?.length)
    s += Math.min(hp.productHeadings.length, 10) * 0.8;
  if (hp.keyParagraphs?.length) s += Math.min(hp.keyParagraphs.length, 6) * 1.5;
  if (hp.customerReviews?.length) s += Math.min(hp.customerReviews.length, 5);
  if (hp.trustSignals?.returnWindow) s += 4;
  if (hp.trustSignals?.freeShippingThreshold) s += 4;
  if (hp.trustSignals?.warranty) s += 3;
  if (hp.trustSignals?.reviewCount) s += 3;
  if (hp.specialOffers?.financing) s += 2;
  if (hp.specialOffers?.loyaltyProgram) s += 2;
  if (hp.specialOffers?.subscriptionSave) s += 2;
  if (hp.specialOffers?.referralProgram) s += 1;
  if (hp.salePatterns?.length) s += Math.min(hp.salePatterns.length, 3);

  if (w.about?.keyParagraphs?.length)
    s += Math.min(w.about.keyParagraphs.length, 4) * 2;
  if (w.about?.foundingStory) s += 4;
  if (w.about?.mission) s += 3;
  if (w.about?.stats?.length) s += Math.min(w.about.stats.length, 3);
  if (w.faq?.faqs?.length) s += Math.min(w.faq.faqs.length, 8) * 1.5;
  if (w.shipping?.freeShippingThreshold) s += 5;
  if (w.shipping?.deliveryTimes?.length) s += 3;
  if (w.returns?.returnWindow) s += 5;
  if (w.returns?.freeReturns) s += 3;

  if (tp.found) s += 8;
  if (tp.rating >= 4.0) s += 4;
  if ((tp.reviewCount || 0) >= 100) s += 3;
  if (tp.snippets?.length) s += Math.min(tp.snippets.length, 4);
  if (tp.commonComplaints?.length) s += 1;

  if (rd.found) s += 5;
  if (rd.commonQuestions?.length) s += Math.min(rd.commonQuestions.length, 3);
  if ((rd.threads?.length || 0) >= 2) s += 2;

  if ((offerSummary?.totalActive || 0) > 0) s += 6;
  if ((offerSummary?.verifiedCount || 0) > 0) s += 4;
  if (offerSummary?.bestDiscount) s += 3;
  if ((offerSummary?.topCodes?.length || 0) > 0) s += 3;

  return Math.min(Math.round(s), 100);
}

function assignTier(score, offerSummary, hasWebUrl) {
  if (!hasWebUrl) return "D";
  const couponCount = offerSummary?.totalActive || 0;
  const couponBoost = couponCount >= 10 ? 10 : couponCount >= 5 ? 5 : 0;
  const verifiedBoost = (offerSummary?.verifiedCount || 0) >= 3 ? 5 : 0;
  const effective = score + couponBoost + verifiedBoost;
  if (effective >= 55 && couponCount > 0) return "A";
  if (effective >= 30) return "B";
  if (effective >= 10) return "C";
  return "D";
}

// ─── Safe subpage fetch ───────────────────────────────────────────────────────

async function tryFetchSubpage(url, category) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBPAGE_TIMEOUT);
  try {
    const result = await extractContent(url, category, controller.signal);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return null;
    throw err;
  }
}

// ─── Scrape one merchant ──────────────────────────────────────────────────────

async function scrapeMerchant(merchant) {
  const base = merchant.web_url?.replace(/\/$/, "");
  if (!base) return { score: 0, tier: "D", data: null };

  const scraped = {
    website: {
      homepage: null,
      about: null,
      faq: null,
      shipping: null,
      returns: null,
    },
    trustpilot: {},
    reddit: {},
  };

  const discovery = await discoverUrls(base);
  if (discovery.homepageHtml) {
    scraped.website.homepage = extractHomepage(discovery.homepageHtml);
  }

  for (const category of ["about", "faq", "shipping", "returns"]) {
    const urls = discovery.classified[category] || [];
    if (!urls.length) continue;

    for (const { url } of urls) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      const content = await tryFetchSubpage(url, category);
      if (hasUsefulContent(content)) {
        scraped.website[category] = content;
        if (content.usedPlaywright) console.log(`      ↳ Playwright: ${url}`);
        break;
      }
    }
  }

  const tp = await scrapeTrustpilot(base);
  scraped.trustpilot = {
    ...(tp || {}),
    snippets: cleanTrustpilotSnippets(tp?.snippets),
  };

  await new Promise((r) => setTimeout(r, 800));

  const rd = await scrapeReddit(merchant.name, base);
  scraped.reddit = cleanRedditData(rd, merchant.name);

  const score = scoreRichness(scraped, merchant.offerSummary);
  const tier = assignTier(score, merchant.offerSummary, !!base);

  return { score, tier, data: scraped };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(results) {
  const ok = results.filter((r) => !r.error);
  const errored = results.filter((r) => r.error);
  const tiers = { A: 0, B: 0, C: 0, D: 0 };
  let totalScore = 0,
    withTp = 0,
    withFaq = 0,
    withReddit = 0;

  for (const r of ok) {
    tiers[r.tier] = (tiers[r.tier] || 0) + 1;
    totalScore += r.score || 0;
    if (r.scraped_data?.trustpilot?.found) withTp++;
    if (r.scraped_data?.website?.faq?.faqs?.length >= 2) withFaq++;
    if (r.scraped_data?.reddit?.found) withReddit++;
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(
    `🏁 Scrape complete — ${ok.length} ok | ${errored.length} errors`,
  );
  console.log(
    `   Tiers:        A=${tiers.A}  B=${tiers.B}  C=${tiers.C}  D=${tiers.D}`,
  );
  console.log(
    `   Avg score:    ${ok.length ? Math.round(totalScore / ok.length) : 0}`,
  );
  console.log(`   Trustpilot:   ${withTp}/${ok.length}`);
  console.log(`   Has FAQs:     ${withFaq}/${ok.length}`);
  console.log(`   Has Reddit:   ${withReddit}/${ok.length}`);
  console.log(`   Output:       ${SCRAPED_PATH}`);
  console.log(`${"─".repeat(50)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error(
      `❌ merchants_cache.json not found. Run 01_fetch.js first.\n   Expected: ${CACHE_PATH}`,
    );
    process.exit(1);
  }

  const allMerchants = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  console.log(
    `\n🔍 Scraper | Concurrency: ${CONCURRENCY} | Limit: ${LIMIT || "all"} | DryRun: ${DRY_RUN}\n`,
  );
  console.log(`📁 Cache loaded: ${allMerchants.length} merchants`);

  const alreadyScrapedSlugs = FORCE ? new Set() : loadScrapedSlugs();

  let merchants = allMerchants.filter((m) => {
    if (!m.web_url) return false;
    if (SLUG) return m.slug === SLUG;
    if (alreadyScrapedSlugs.has(m.slug)) return false;
    return true;
  });

  if (FROM_ID) merchants = merchants.filter((m) => m.id >= FROM_ID);
  if (LIMIT) merchants = merchants.slice(0, LIMIT);

  console.log(
    `📦 To scrape: ${merchants.length} | Already done: ${alreadyScrapedSlugs.size}\n`,
  );

  if (!merchants.length) {
    console.log(
      "✅ Nothing to scrape. Use --force to re-scrape all, or --slug=X for one store.",
    );
    return;
  }

  if (DRY_RUN) {
    console.log("[DRY RUN] Would scrape:");
    for (const m of merchants.slice(0, 10)) {
      console.log(
        `  ${m.name} (${m.web_url}) — offers: ${m.offerSummary?.totalActive || 0}`,
      );
    }
    if (merchants.length > 10)
      console.log(`  ... and ${merchants.length - 10} more`);
    return;
  }

  // On --force, load all existing records so we can rewrite with updates
  let existingRecords = FORCE ? loadAllRecords() : null;

  const limiter = pLimit(CONCURRENCY);
  const sessionResults = [];

  await Promise.all(
    merchants.map((m) =>
      limiter(async () => {
        console.log(
          `  ↳ [${m.offerSummary?.totalActive || 0} offers] ${m.name} (${m.web_url})`,
        );

        try {
          const { score, tier, data } = await scrapeMerchant(m);

          const tpStr = data?.trustpilot?.found
            ? `⭐${data.trustpilot.rating}(${data.trustpilot.reviewCount})`
            : "no-tp";
          const rdStr = data?.reddit?.found
            ? `💬${data.reddit.threads.length}t`
            : "no-reddit";
          const faqStr = data?.website?.faq?.faqs?.length
            ? `FAQs:${data.website.faq.faqs.length}`
            : "no-faq";

          console.log(
            `    ✓ Tier:${tier} Score:${score} | ${faqStr} | ${tpStr} | ${rdStr}`,
          );

          const record = {
            id: m.id,
            name: m.name,
            slug: m.slug,
            web_url: m.web_url,
            active_coupons_count: m.active_coupons_count,
            category_names: m.category_names,
            offerSummary: m.offerSummary,
            tier,
            score,
            scraped_data: data,
            scraped_at: new Date().toISOString(),
          };

          if (FORCE) {
            const idx = existingRecords.findIndex((r) => r.slug === m.slug);
            if (idx >= 0) existingRecords[idx] = record;
            else existingRecords.push(record);
            rewriteNdjson(existingRecords);
          } else {
            appendRecord(record); // O(1) — no full file rewrite
          }

          sessionResults.push(record);
        } catch (err) {
          console.error(`    ✗ ${m.name}: ${err.message}`);
          const errRecord = {
            id: m.id,
            name: m.name,
            slug: m.slug,
            tier: "D",
            score: 0,
            error: err.message.substring(0, 500),
            scraped_at: new Date().toISOString(),
          };

          if (FORCE) {
            const idx = existingRecords.findIndex((r) => r.slug === m.slug);
            if (idx >= 0) existingRecords[idx] = errRecord;
            else existingRecords.push(errRecord);
            rewriteNdjson(existingRecords);
          } else {
            appendRecord(errRecord);
          }

          sessionResults.push(errRecord);
        }
      }),
    ),
  );

  printSummary(sessionResults);
}

main().catch(console.error);
