/**
 * STEP 3: Content Generator
 *
 * Reads scraped_results.ndjson (from 02_scraper.js).
 * Generates SEO content per merchant and pushes to Supabase merchants table.
 *
 * Provider priority: Google (gemini-2.5-flash-lite) → Groq → OpenRouter
 *
 * Run:              node scripts/Dynamic_Store_Content/03_generator.js
 * Tier filter:      node scripts/Dynamic_Store_Content/03_generator.js --tier=A
 * Single store:     node scripts/Dynamic_Store_Content/03_generator.js --slug=nike
 * Limit:            node scripts/Dynamic_Store_Content/03_generator.js --limit=10
 * Dry run:          node scripts/Dynamic_Store_Content/03_generator.js --dry-run
 * Retry failed:     node scripts/Dynamic_Store_Content/03_generator.js --retry-failed
 * Force redo:       node scripts/Dynamic_Store_Content/03_generator.js --force
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { supabase } from "../../dbhelper/dbclient.js";

dotenv.config();

// ─── Paths ────────────────────────────────────────────────────────────────────

const SCRAPED_PATH = path.resolve(
  "./scripts/Dynamic_Store_Content/scraped_results.ndjson",
);
const GENERATED_PATH = path.resolve(
  "./scripts/Dynamic_Store_Content/generated_content.ndjson",
);

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0",
);
const TIER = args.find((a) => a.startsWith("--tier="))?.split("=")[1] || null;
const SLUG = args.find((a) => a.startsWith("--slug="))?.split("=")[1] || null;
const DRY_RUN = args.includes("--dry-run");
const RETRY_FAILED = args.includes("--retry-failed");
const FORCE = args.includes("--force");
const BLOCK_ISSUES = args.includes("--block-issues");

const MAX_RETRIES = 3;
const SIMILARITY_THRESHOLD = 0.4;

// ─── NDJSON helpers ───────────────────────────────────────────────────────────

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const records = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {}
  }
  return records;
}

function appendNdjson(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n");
}

function rewriteNdjson(filePath, records) {
  fs.writeFileSync(
    filePath,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

// ─── Provider registry ────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    name: "Google",
    model: "gemini-2.5-flash-lite",
    delayMs: 5000,
    available: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
    exhausted: false,
    async call(systemPrompt, userPrompt) {
      const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.9, maxOutputTokens: 8192 },
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err?.error?.message || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("Empty response from Google");
      return text;
    },
  },
  {
    name: "Groq",
    model: "llama-3.3-70b-versatile",
    delayMs: 6000,
    available: !!process.env.GROQ_API_KEY,
    exhausted: false,
    async call(systemPrompt, userPrompt) {
      const res = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            temperature: 0.9,
            max_tokens: 6000,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err?.error?.message || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Empty response from Groq");
      return text;
    },
  },
  {
    name: "OpenRouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    delayMs: 3000,
    available: !!process.env.OPENROUTER_API_KEY,
    exhausted: false,
    async call(systemPrompt, userPrompt) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://savingharbor.com",
          "X-Title": "Saving Harbor Content Generator",
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.3-70b-instruct:free",
          temperature: 0.9,
          max_tokens: 6000,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err?.error?.message || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Empty response from OpenRouter");
      return text;
    },
  },
];

function getActiveProvider() {
  return PROVIDERS.find((p) => p.available && !p.exhausted) || null;
}

function markExhausted(name, permanent = false) {
  const p = PROVIDERS.find((p) => p.name === name);
  if (!p) return;
  p.exhausted = true;
  console.log(
    permanent
      ? `\n  ⛔ ${name} daily limit hit — disabled for this session\n`
      : `\n  ⏳ ${name} rate limited — cooling down 65s\n`,
  );
}

function resetProvider(name) {
  const p = PROVIDERS.find((p) => p.name === name);
  if (p) {
    p.exhausted = false;
    console.log(`\n  ✅ ${name} back online\n`);
  }
}

// ─── Sanitize ─────────────────────────────────────────────────────────────────

function sanitize(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\t/g, " ")
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── DB field length guards ───────────────────────────────────────────────────

function guardStr(str, maxLen, fieldName = "") {
  if (typeof str !== "string") return str;
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  const result = (sp > maxLen - 20 ? cut.slice(0, sp) : cut).trimEnd();
  if (fieldName)
    console.warn(
      `    ⚠️  guardStr truncated "${fieldName}": ${str.length}c → ${result.length}c`,
    );
  return result;
}

// ─── Context builder ──────────────────────────────────────────────────────────

function buildContext(merchant, scraped) {
  const w = scraped?.website || {};
  const tp = scraped?.trustpilot || {};
  const rd = scraped?.reddit || {};
  const hp = w.homepage || {};
  const ts = hp.trustSignals || {};
  const so = hp.specialOffers || {};

  const off =
    merchant.offerSummary ||
    merchant.scraped_data?.offerSummary ||
    scraped?.offerSummary ||
    {};

  const siteReviewCountRaw = parseInt(ts.reviewCount) || 0;
  const siteRatingRaw = parseFloat(ts.rating) || null;
  const tpReviewCount = tp.reviewCount || 0;
  const siteReviewCount =
    siteReviewCountRaw > tpReviewCount ? siteReviewCountRaw : 0;

  const SO_LABEL = {
    financing: "financing / buy-now-pay-later",
    freeShipping: "free shipping available",
    appDiscount: "app-exclusive discount",
    studentDiscount: "student discount",
    loyaltyProgram: "loyalty / rewards program",
    subscriptionSave: "subscription savings",
    referralProgram: "referral program",
    clearanceSale: "clearance sale section",
  };
  const activeSpecialOffers = Object.entries(so)
    .filter(([k, v]) => v && SO_LABEL[k])
    .map(([k]) => SO_LABEL[k]);

  const HIGH_QUALITY_FAQ_SOURCES = new Set(["json-ld", "schema"]);
  const faqs = (w.faq?.faqs || []).map((f) => ({
    question: sanitize(f.question),
    answer: sanitize(f.answer),
    highQuality: HIGH_QUALITY_FAQ_SOURCES.has(f.source),
  }));

  return {
    name: merchant.name,
    url: merchant.web_url || "",
    categories: Array.isArray(merchant.category_names)
      ? merchant.category_names.join(", ")
      : merchant.category_names || "",
    activeCoupons: parseInt(merchant.active_coupons_count) || 0,
    offerTotalActive: off.totalActive || 0,
    offerCouponCount: off.couponCount || 0,
    offerDealCount: off.dealCount || 0,
    offerVerified: off.verifiedCount || 0,
    bestDiscount: off.bestDiscount || null,
    bestDiscountType: off.bestDiscountType || null,
    discountRange: off.discountRange || null,
    topCodes: (off.topCodes || []).map(sanitize),
    topTitles: (off.topTitles || []).map(sanitize),
    h1: sanitize(hp.h1 || ""),
    metaDescription: sanitize(hp.metaDescription || hp.ogDescription || ""),
    heroTaglines: (hp.heroTaglines || []).map(sanitize),
    productHeadings: (hp.productHeadings || []).map(sanitize),
    keyParagraphs: (hp.keyParagraphs || []).map(sanitize),
    customerReviews: (hp.customerReviews || []).map(sanitize),
    priceRange: sanitize(hp.priceRange || ""),
    visibleCodes: (hp.visibleCodes || []).map(sanitize),
    salePatterns: (hp.salePatterns || []).map(sanitize),
    warranty: sanitize(ts.warranty || ""),
    yearsInBusiness: sanitize(ts.yearsInBusiness || ""),
    siteReviewCount,
    siteRating: siteRatingRaw,
    secureCheckout: !!ts.secureCheckout,
    activeSpecialOffers,
    shippingThreshold:
      sanitize(
        w.shipping?.freeShippingThreshold || ts.freeShippingThreshold || "",
      ) || null,
    deliveryTimes: (w.shipping?.deliveryTimes || []).map(sanitize),
    internationalShipping: w.shipping?.internationalShipping || false,
    expressAvailable: w.shipping?.expressAvailable || false,
    shippingDetails: (w.shipping?.keyParagraphs || [])
      .slice(0, 2)
      .map(sanitize),
    returnWindow:
      sanitize(w.returns?.returnWindow || ts.returnWindow || "") || null,
    freeReturns: w.returns?.freeReturns || false,
    returnConditions: (w.returns?.conditions || []).map(sanitize),
    returnDetails: (w.returns?.keyParagraphs || []).slice(0, 2).map(sanitize),
    aboutParagraphs: (w.about?.keyParagraphs || []).map(sanitize),
    aboutHeadings: (w.about?.headings || []).slice(0, 6).map(sanitize),
    aboutMission: sanitize(w.about?.mission || ""),
    foundingStory: sanitize(w.about?.foundingStory || ""),
    aboutStats: (w.about?.stats || []).map(sanitize),
    faqs,
    tpFound: tp.found && (tp.reviewCount || 0) >= 5,
    tpRating: tp.rating || null,
    tpReviewCount: tp.reviewCount || null,
    tpClaimed: !!tp.claimed,
    tpSnippets: (tp.snippets || []).map(sanitize),
    tpPraise: (tp.commonPraise || []).map(sanitize),
    tpComplaints: (tp.commonComplaints || []).map(sanitize),
    rdFound: rd.found || false,
    rdSentiment: rd.overallSentiment || "neutral",
    rdQuestions: (rd.commonQuestions || []).map(sanitize),
    rdComplaints: (rd.commonComplaints || []).map(sanitize),
    rdThreads: (rd.threads?.slice(0, 4) || []).map((t) => ({
      title: sanitize(t.title),
      snippet: sanitize(t.snippet),
      score: t.score || 0,
      subreddit: sanitize(t.subreddit || ""),
      sentiment: t.sentiment || "neutral",
    })),
  };
}

// ─── Category context ─────────────────────────────────────────────────────────

const CATEGORY_CONTEXT = {
  "Health & Fitness": "fitness and wellness products",
  "Health & Wellness": "health and wellness products",
  Pets: "pet supplies and accessories",
  "Sports & Outdoors": "outdoor and sporting goods",
  "Baby & Kids": "baby and children's products",
  Beauty: "beauty and cosmetics",
  "Personal Care": "personal care products",
  "Computers & Electronics": "electronics and tech hardware",
  Electronics: "consumer electronics",
  Technology: "technology products",
  Automotive: "automotive parts and accessories",
  "Tools & Home Improvement": "tools and home improvement products",
  Finance: "financial services",
  Investing: "investment tools and services",
  Software: "software and digital tools",
  "Software & Tools": "software subscriptions and tools",
  Education: "online courses and learning resources",
  "Clothing & Apparel": "clothing and fashion",
  "Home & Garden": "home and garden products",
  "Food & Drink": "food and beverages",
  Jewelry: "jewelry and accessories",
};

function getCategoryContext(categories) {
  const cats = (categories || "").split(",").map((c) => c.trim());
  for (const c of cats) {
    if (CATEGORY_CONTEXT[c]) return CATEGORY_CONTEXT[c];
  }
  return "products and services";
}

// ─── Meta title builder ───────────────────────────────────────────────────────

function buildMetaTitle(ctx) {
  const store = ctx.name;
  const month = new Date().toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const catMap = {
    "Health & Fitness": "Fitness Gear",
    "Health & Wellness": "Wellness Products",
    "Sports & Outdoors": "Outdoor Gear",
    Pets: "Pet Supplies",
    "Computers & Electronics": "Electronics",
    Electronics: "Electronics",
    Technology: "Tech Products",
    Software: "Software",
    "Software & Tools": "Software",
    Finance: "Financial Services",
    "Clothing & Apparel": "Clothing",
    "Home & Garden": "Home & Garden",
    Beauty: "Beauty Products",
    Education: "Online Courses",
  };
  const cats = (ctx.categories || "").split(",").map((c) => c.trim());
  const catNoun = cats.map((c) => catMap[c]).find(Boolean) || null;

  const fit = (s, max = 70) => {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    return (sp > max - 15 ? cut.slice(0, sp) : cut).trim();
  };

  const hasDiscount = ctx.bestDiscount && ctx.bestDiscountType;
  const dollarTooSmall =
    ctx.bestDiscountType === "dollar" && parseFloat(ctx.bestDiscount) < 10;
  const effectiveHasDiscount = hasDiscount && !dollarTooSmall;
  const hasTp = ctx.tpFound && ctx.tpRating >= 4.0 && ctx.tpReviewCount >= 100;

  const discountLabel = effectiveHasDiscount
    ? ctx.bestDiscountType === "percentage"
      ? `Up to ${ctx.bestDiscount}% Off`
      : `Up to $${ctx.bestDiscount} Off`
    : null;

  const variants = [
    effectiveHasDiscount && ctx.activeCoupons >= 3
      ? `${store} Coupons — ${discountLabel} + ${ctx.activeCoupons} Verified Codes [${month}] | Saving Harbor`
      : null,
    effectiveHasDiscount
      ? `${store} Coupons — ${discountLabel} | Saving Harbor`
      : null,
    ctx.topCodes[0]
      ? `${store} Promo Code: ${ctx.topCodes[0]} + ${ctx.activeCoupons > 1 ? ctx.activeCoupons - 1 + " More" : ""} Deals | Saving Harbor`
      : null,
    hasTp
      ? `${store} Coupons — Rated ${ctx.tpRating}★ by ${ctx.tpReviewCount.toLocaleString()} Shoppers | Saving Harbor`
      : null,
    ctx.activeCoupons >= 5 && catNoun
      ? `${store} ${catNoun} Coupons — ${ctx.activeCoupons} Verified Codes | Saving Harbor`
      : null,
    ctx.activeCoupons >= 5
      ? `${store} Coupons — ${ctx.activeCoupons} Verified Codes [${month}] | Saving Harbor`
      : null,
    catNoun
      ? `${store} ${catNoun} Coupons & Promo Codes | Saving Harbor`
      : null,
    `${store} Coupons & Promo Codes [${month}] | Saving Harbor`,
    `${store} Coupons & Promo Codes | Saving Harbor`,
  ].filter(Boolean);

  for (const v of variants) {
    if (v.length <= 70) return v;
  }
  return fit(`${store} Coupons & Promo Codes | Saving Harbor`);
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior SEO content writer for Saving Harbor, a coupon and deals aggregator.
Your job: write store pages that rank for "[store] coupons" queries and genuinely help shoppers decide whether to buy.

NON-NEGOTIABLE RULES (violating any of these causes the response to be rejected and retried):
1. Return ONLY a valid JSON object. No markdown fences. No text outside {}.
2. Never invent facts. If data is missing, say "not listed on their site" — do not guess, extrapolate, or fabricate.
3. Never use: seamlessly, elevate, dive into, treasure trove, game-changer, curated, unlock savings, leverage, empower, in today's world, cutting-edge, robust, delve, navigate, realm, look no further, without further ado, it's worth noting.
4. Write like a knowledgeable friend who has researched this store — direct, specific, honest.
5. Every page must be unmistakably about THIS store. A reader familiar with two different stores should never confuse their pages.
6. Write 350–450 visible words in description_html. Every sentence must contain specific, verifiable data about this store. Stop when you run out of real data — short and accurate beats long and padded. Do not add sections just to fill space.
7. Reference real discount values and coupon codes by name. Do not genericise ("a discount") when you have specific numbers.
8. H3 headings must be natural search-landing phrases drawn from real store data — not decorative labels.

GOOGLE HELPFUL CONTENT & E-E-A-T RULES:
- No keyword stuffing. Refer to "[store] coupons" as a phrase at most twice in the full description.
- No doorway-page patterns. Content must serve the reader first, not just insert target keywords.
- No fabricated superlatives ("best in class", "industry-leading", "top-rated") unless a specific data point supports it.
- No thin sections. If a section cannot be filled with 2+ substantive sentences of real data, omit it entirely.
- Attribute policy claims to their source: "according to their returns page", "Trustpilot reviewers note", "their About page states".
- Each H3 must function as a meaningful content anchor that a human would use as a navigation landmark — not a label.`;

// ─── Seeded PRNG ──────────────────────────────────────────────────────────────

function seededRandom(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
    h >>>= 0;
  }
  return function () {
    h ^= h << 13;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

function seededShuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── FAQ pool builder ─────────────────────────────────────────────────────────

function buildFaqs(ctx, store, slug) {
  const candidates = [];

  for (const f of ctx.faqs.slice(0, 5)) {
    candidates.push({
      priority: f.highQuality ? 0 : 1,
      source: "store_faq",
      q: f.question,
      a: f.answer,
    });
  }
  for (const complaint of ctx.tpComplaints) {
    candidates.push({ priority: 2, source: "tp_complaint", hint: complaint });
  }
  for (const rq of ctx.rdQuestions) {
    candidates.push({ priority: 2, source: "reddit", q: rq });
  }
  if (ctx.shippingThreshold || ctx.shippingDetails.length) {
    candidates.push({
      priority: 3,
      source: "policy",
      q: `Does ${store} offer free shipping?`,
      hint: ctx.shippingThreshold
        ? `Free shipping threshold: ${ctx.shippingThreshold}${ctx.shippingDetails.length ? ". " + ctx.shippingDetails[0] : ""}`
        : ctx.shippingDetails[0],
    });
  }
  if (ctx.returnWindow || ctx.returnDetails.length) {
    candidates.push({
      priority: 3,
      source: "policy",
      q: `What is ${store}'s return policy?`,
      hint: [ctx.returnWindow, ctx.returnDetails[0]].filter(Boolean).join(". "),
    });
  }
  if (ctx.freeReturns) {
    candidates.push({
      priority: 3,
      source: "policy",
      q: `Does ${store} offer free returns?`,
      hint: "yes — confirmed on their returns page",
    });
  }
  if (ctx.deliveryTimes.length) {
    candidates.push({
      priority: 3,
      source: "policy",
      q: `How long does ${store} take to deliver?`,
      hint: ctx.deliveryTimes.join(", "),
    });
  }
  if (ctx.internationalShipping) {
    candidates.push({
      priority: 3,
      source: "policy",
      q: `Does ${store} ship internationally?`,
      hint: "yes",
    });
  }
  if (ctx.activeSpecialOffers.some((o) => o.includes("loyalty"))) {
    candidates.push({
      priority: 2,
      source: "program",
      q: `Does ${store} have a rewards or loyalty program?`,
      hint: "yes — confirmed on their homepage",
    });
  }
  if (ctx.activeSpecialOffers.some((o) => o.includes("student"))) {
    candidates.push({
      priority: 2,
      source: "program",
      q: `Does ${store} offer a student discount?`,
      hint: "yes — confirmed on their homepage",
    });
  }
  if (ctx.activeSpecialOffers.some((o) => o.includes("referral"))) {
    candidates.push({
      priority: 2,
      source: "program",
      q: `Does ${store} have a referral program?`,
      hint: "yes — confirmed on their homepage",
    });
  }
  if (ctx.activeSpecialOffers.some((o) => o.includes("financing"))) {
    candidates.push({
      priority: 2,
      source: "program",
      q: `Does ${store} offer financing or buy-now-pay-later?`,
      hint: "yes — confirmed on their homepage",
    });
  }
  if (ctx.topCodes.length > 0) {
    candidates.push({
      priority: 1,
      source: "offer_code",
      q: `What is the best ${store} coupon code right now?`,
      hint: `Top code: ${ctx.topCodes[0]}${ctx.topCodes.length > 1 ? `. Other active codes: ${ctx.topCodes.slice(1).join(", ")}` : ""}. Total active: ${ctx.offerTotalActive}.`,
    });
  } else if (ctx.bestDiscount) {
    candidates.push({
      priority: 1,
      source: "offer_discount",
      q: `How much can I save at ${store} right now?`,
      hint: `Best current discount: ${ctx.bestDiscount}${ctx.bestDiscountType === "percentage" ? "%" : " dollars"} off. ${ctx.offerTotalActive} active offers total.`,
    });
  } else {
    candidates.push({
      priority: 2,
      source: "coupon_generic",
      q: `Do ${store} coupon codes actually work?`,
      hint: `${ctx.offerTotalActive} active offers tracked on Saving Harbor.`,
    });
  }
  if (ctx.offerVerified > 0) {
    candidates.push({
      priority: 1,
      source: "offer_verified",
      q: `Does ${store} have any verified deals with proof?`,
      hint: `${ctx.offerVerified} verified offer${ctx.offerVerified > 1 ? "s" : ""} with screenshot proof on Saving Harbor.${ctx.topTitles.length ? " Examples: " + ctx.topTitles.slice(0, 2).join("; ") : ""}`,
    });
  } else if (ctx.offerDealCount > 0) {
    candidates.push({
      priority: 2,
      source: "offer_deals",
      q: `Does ${store} have any deals without a coupon code?`,
      hint: `${ctx.offerDealCount} active deal${ctx.offerDealCount > 1 ? "s" : ""} (no code needed) on Saving Harbor.`,
    });
  }

  const genericPool = [
    { source: "generic", q: `What is ${store}'s return policy?` },
    { source: "generic", q: `Does ${store} offer free shipping?` },
    { source: "generic", q: `How do I contact ${store} customer support?` },
    { source: "generic", q: `Is there a ${store} app for mobile shopping?` },
  ];

  const rng = seededRandom(slug || store.toLowerCase());
  for (const g of seededShuffle(genericPool, rng).slice(0, 2)) {
    candidates.push({ priority: 4, ...g });
  }

  candidates.sort((a, b) => a.priority - b.priority);
  const seen = new Set();
  const pool = [];
  for (const c of candidates) {
    const key = c.q || c.hint || c.source;
    if (!seen.has(key)) {
      seen.add(key);
      pool.push(c);
    }
    if (pool.length >= 4) break;
  }
  return pool;
}

// ─── Store data block ─────────────────────────────────────────────────────────

function buildStoreData(ctx) {
  const hasTp = ctx.tpFound && ctx.tpRating && ctx.tpReviewCount;

  const reviewLine = (() => {
    const parts = [];
    if (hasTp)
      parts.push(
        `Trustpilot: ${ctx.tpRating}★ from ${ctx.tpReviewCount.toLocaleString()} reviews${ctx.tpClaimed ? " (claimed profile)" : ""}`,
      );
    if (ctx.siteReviewCount > 0)
      parts.push(
        `On-site: ${ctx.siteReviewCount.toLocaleString()} reviews${ctx.siteRating ? ` rated ${ctx.siteRating}★` : ""}`,
      );
    return parts.join(" | ") || "no public rating data found";
  })();

  const rdThreadBlock = ctx.rdThreads.length
    ? ctx.rdThreads
        .map(
          (t) =>
            `  [r/${t.subreddit || "unknown"} | score:${t.score} | ${t.sentiment}] "${t.title}" — ${t.snippet}`,
        )
        .join("\n")
    : "none";

  return `
STORE: ${ctx.name}
URL: ${ctx.url}
CATEGORIES: ${ctx.categories || "not specified"} (${getCategoryContext(ctx.categories)})

OFFER DATA (live from Saving Harbor DB):
- Total active offers: ${ctx.offerTotalActive}
- Coupons (require code): ${ctx.offerCouponCount}
- Deals (no code needed): ${ctx.offerDealCount}
- Verified with screenshot proof: ${ctx.offerVerified}
- Best discount: ${ctx.bestDiscount ? `${ctx.bestDiscount}${ctx.bestDiscountType === "percentage" ? "%" : " dollars"} off` : "not available"}
- Discount range: ${ctx.discountRange ? `${ctx.discountRange.min}%–${ctx.discountRange.max}%` : "n/a"}
- Top coupon codes: ${ctx.topCodes.length ? ctx.topCodes.join(", ") : "none"}
- Top offer titles: ${ctx.topTitles.length ? ctx.topTitles.join(" | ") : "none"}

HOMEPAGE:
- H1 (store's own main headline): ${ctx.h1 || "not found"}
- Meta description: ${ctx.metaDescription || "not found"}
- Hero taglines: ${ctx.heroTaglines.slice(0, 5).join(" | ") || "none"}
- Product headings: ${ctx.productHeadings.slice(0, 8).join(", ") || "none"}
- Key paragraphs: ${ctx.keyParagraphs.slice(0, 4).join(" /// ") || "none"}
- Price range: ${ctx.priceRange || "not found"}
- Customer reviews on site: ${ctx.customerReviews.slice(0, 3).join(" /// ") || "none"}
- Sale patterns: ${ctx.salePatterns.join(", ") || "none detected"}
- Confirmed special programs: ${ctx.activeSpecialOffers.length ? ctx.activeSpecialOffers.join(", ") : "none confirmed"}
- Visible promo codes on site: ${ctx.visibleCodes.filter((c) => c.length >= 4).join(", ") || "none"}

TRUST SIGNALS:
- Reviews / ratings: ${reviewLine}
- Years in business: ${ctx.yearsInBusiness || "not stated"}
- Secure checkout: ${ctx.secureCheckout ? "confirmed" : "not confirmed"}
- Warranty: ${ctx.warranty || "not listed on their site"}

SHIPPING & RETURNS:
- Free shipping threshold: ${ctx.shippingThreshold || "not listed on their site"}
- Delivery times: ${ctx.deliveryTimes.join(", ") || "not listed on their site"}
- International shipping: ${ctx.internationalShipping ? "yes" : "not confirmed"}
- Express shipping: ${ctx.expressAvailable ? "yes" : "not confirmed"}
${ctx.shippingDetails.length ? `- Shipping policy detail: ${ctx.shippingDetails.join(" | ")}` : ""}
- Return window: ${ctx.returnWindow || "not listed on their site"}
- Free returns: ${ctx.freeReturns ? "yes" : "not confirmed"}
${ctx.returnDetails.length ? `- Returns policy detail: ${ctx.returnDetails.join(" | ")}` : ""}

ABOUT:
${ctx.aboutParagraphs.slice(0, 3).join(" /// ") || "not available"}
${ctx.foundingStory ? "Founding story: " + ctx.foundingStory : ""}
${ctx.aboutMission ? "Mission: " + ctx.aboutMission : ""}
${ctx.aboutStats.length ? "Stats/claims: " + ctx.aboutStats.join(", ") : ""}
${ctx.aboutHeadings.length ? "About page sections: " + ctx.aboutHeadings.join(" | ") : ""}

STORE FAQ DATA (${ctx.faqs.filter((f) => f.highQuality).length} structured / ${ctx.faqs.length} total):
${
  ctx.faqs.length
    ? ctx.faqs
        .slice(0, 6)
        .map(
          (f) =>
            `[${f.highQuality ? "structured" : "scraped"}] Q: ${f.question}\nA: ${f.answer}`,
        )
        .join("\n---\n")
    : "none available"
}

TRUSTPILOT:
${
  hasTp
    ? `Rating: ${ctx.tpRating}★ from ${ctx.tpReviewCount.toLocaleString()} reviews${ctx.tpClaimed ? " (active claimed profile)" : ""}`
    : "not found on Trustpilot"
}
${ctx.tpSnippets.length ? "Snippets: " + ctx.tpSnippets.slice(0, 3).join(" /// ") : ""}
${ctx.tpPraise.length ? "Praise: " + ctx.tpPraise.join(", ") : ""}
${ctx.tpComplaints.length ? "Complaints: " + ctx.tpComplaints.join(" | ") : ""}

REDDIT (overall sentiment: ${ctx.rdSentiment}):
${ctx.rdFound ? `${ctx.rdThreads.length} threads found` : "no relevant threads found"}
${rdThreadBlock !== "none" ? "Threads:\n" + rdThreadBlock : ""}
${ctx.rdQuestions.length ? "Questions asked: " + ctx.rdQuestions.join(" | ") : ""}
${ctx.rdComplaints.length ? "Complaints: " + ctx.rdComplaints.join(" | ") : ""}
`.trim();
}

// ─── Signal hint builder ──────────────────────────────────────────────────────

function buildSignalHint(ctx) {
  const signals = [];
  if (ctx.tpFound && ctx.tpRating >= 4.0)
    signals.push(
      `Trustpilot ${ctx.tpRating}★ from ${ctx.tpReviewCount?.toLocaleString()} reviews`,
    );
  if (ctx.siteReviewCount > 1000)
    signals.push(
      `${ctx.siteReviewCount.toLocaleString()} on-site reviews${ctx.siteRating ? ` rated ${ctx.siteRating}★` : ""}`,
    );
  if (ctx.bestDiscount)
    signals.push(
      `${ctx.bestDiscount}${ctx.bestDiscountType === "percentage" ? "%" : " dollar"} best discount across ${ctx.offerTotalActive} active offers`,
    );
  if (ctx.yearsInBusiness)
    signals.push(`established brand: ${ctx.yearsInBusiness}`);
  if (ctx.foundingStory) signals.push(`founding story available`);
  if (ctx.tpComplaints.length)
    signals.push(
      `known complaints worth addressing honestly: ${ctx.tpComplaints.slice(0, 2).join(", ")}`,
    );
  if (ctx.rdFound && ctx.rdSentiment !== "neutral")
    signals.push(`Reddit community sentiment: ${ctx.rdSentiment}`);
  if (ctx.shippingThreshold || ctx.freeReturns)
    signals.push(
      `strong policy: ${ctx.shippingThreshold ? "free shipping at " + ctx.shippingThreshold : "free returns confirmed"}`,
    );
  if (ctx.aboutMission) signals.push(`brand mission angle available`);
  if (ctx.activeSpecialOffers.length)
    signals.push(`confirmed programs: ${ctx.activeSpecialOffers.join(", ")}`);
  if (ctx.h1) signals.push(`store's own H1: "${ctx.h1.slice(0, 80)}"`);

  return signals.length
    ? `The strongest data signals for this store are: ${signals.slice(0, 5).join("; ")}. Let these drive your angles and section choices — not a generic template.`
    : `Data is sparse for this store. Be transparent about what is and isn't known. Do not invent anything. Short honest content beats padded generic content.`;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(ctx, slug, retryReason = null) {
  const store = ctx.name;
  const faqPool = buildFaqs(ctx, store, slug);
  const categoryContext = getCategoryContext(ctx.categories);
  const storeData = buildStoreData(ctx);
  const signalHint = buildSignalHint(ctx);
  const hasOffers = ctx.offerTotalActive > 0;
  const hasTp = ctx.tpFound && ctx.tpRating && ctx.tpReviewCount;
  const hasSales =
    ctx.salePatterns.length > 0 || ctx.activeSpecialOffers.length > 0;

  const dollarTooSmall =
    ctx.bestDiscountType === "dollar" && parseFloat(ctx.bestDiscount) < 10;
  const metaDiscountUsable = ctx.bestDiscount && !dollarTooSmall;

  const retryBlock = retryReason
    ? `⚠️ RETRY NOTICE — YOUR PREVIOUS ATTEMPT FAILED:\n${retryReason}\nFix this specific problem. Do not repeat the same mistake.\n\n`
    : "";

  return `${retryBlock}You are writing a store page for Saving Harbor about "${store}", a ${categoryContext} retailer.

A real person Googled "${store} coupons". They want to know:
1. Is this store worth buying from?
2. What do they actually sell?
3. How do I get the best price right now?

Answer all three questions honestly and specifically using ONLY the STORE DATA below. Do not invent facts not present in STORE DATA.

${signalHint}

═══════════════════════════════════════
DESCRIPTION_HTML REQUIREMENTS
═══════════════════════════════════════
- Target: 350–450 visible words. Hard maximum: 450 words. Do not pad to hit a word count.
- Use <h3> and <p> tags only. No <ul>, <li>, <strong>, or <em>.
- REQUIRED sections (include only if you have 2+ real sentences of data):
    A) What ${store} sells and who it is for — draw from H1, product headings, key paragraphs, price range
    B) How to save money at ${store} right now — use REAL offer data (codes, discounts, deal counts, confirmed programs)
    C) Trust and credibility — use whatever signals exist: Trustpilot rating, on-site reviews, years in business, return policy, Reddit sentiment

- OPTIONAL sections (only include if you have 2+ substantive sentences of real, specific data):
    D) Buying guide or category-specific advice
    E) Shipping and delivery — only if specific threshold/times data exists
    F) Brand story or mission — only if founding story or mission provides real angles
    G) Honest assessment of known issues — only if Trustpilot or Reddit complaints exist

- STOP writing when you run out of real data. An honest 350-word page outranks a padded 450-word page.

- H3 HEADING RULES:
  Each H3 must be a natural search-landing phrase tied to specific data in that section.
  BAD: <h3>How to Save at ${store}</h3>
  GOOD: <h3>${store} Promo Code ${ctx.topCodes[0] || "SAVE10"}: ${ctx.bestDiscount ? `Up to ${ctx.bestDiscount}% Off` : "What It Gets You"}</h3>
  BAD: <h3>About ${store}</h3>
  GOOD: <h3>${ctx.foundingStory ? "The Story Behind " + store : ctx.h1 ? store + ": " + ctx.h1.slice(0, 45) : store + "'s Product Range"}</h3>

- E-E-A-T: attribute claims to their source where possible.
- Mention ${store} by name 3–6 times. Do not repeat the exact phrase "${store} coupons" more than twice.
- Do not open any section with: "Are you looking for", "If you're", "In today's world", "Look no further".
- Do not use fabricated superlatives unless a specific data point in STORE DATA supports them.
- Skip any section that cannot be filled with real, specific data.

${
  hasOffers
    ? `OFFER DATA TO USE IN SECTION B:
- ${ctx.offerTotalActive} active offers (${ctx.offerCouponCount} coupons, ${ctx.offerDealCount} deals)
- Best discount: ${ctx.bestDiscount ? `${ctx.bestDiscount}${ctx.bestDiscountType === "percentage" ? "%" : " dollars"} off` : "not available"}
${ctx.discountRange ? `- Discount range: ${ctx.discountRange.min}%–${ctx.discountRange.max}%` : ""}
${ctx.topCodes.length ? `- Active codes to name: ${ctx.topCodes.join(", ")}` : ""}
${ctx.offerVerified > 0 ? `- ${ctx.offerVerified} offers verified with screenshot proof — mention this` : ""}
${hasSales ? `- Sale patterns / confirmed programs: ${[...ctx.salePatterns, ...ctx.activeSpecialOffers].join(", ")}` : ""}
- Include 1 sentence on how to apply a coupon code at checkout.`
    : "No offer data available — tell readers to check Saving Harbor directly for current codes."
}

═══════════════════════════════════════
META_DESCRIPTION REQUIREMENTS
═══════════════════════════════════════
Exactly 145–158 characters. Count every character — validated strictly.
- Start with an action verb. Not: Discover, Explore, Find out, Unlock, Shop.
- Include one specific number from OFFER DATA or STORE DATA.
- Name ${store} explicitly.
- End with a reference to Saving Harbor.
- Must be specific enough that a reader can identify the store from the meta alone.

${metaDiscountUsable ? `Preferred: use the ${ctx.bestDiscount}${ctx.bestDiscountType === "percentage" ? "%" : " dollar"} discount.` : ""}
${ctx.topCodes.length ? `Alternative: name code ${ctx.topCodes[0]} explicitly.` : ""}
${hasTp && ctx.tpRating >= 4.0 ? `Alternative: the ${ctx.tpRating}★ Trustpilot rating from ${ctx.tpReviewCount.toLocaleString()} reviewers.` : ""}
${ctx.siteReviewCount > 0 ? `Alternative: the ${ctx.siteReviewCount.toLocaleString()} on-site reviews.` : ""}

═══════════════════════════════════════
SIDE_DESCRIPTION_HTML REQUIREMENTS
═══════════════════════════════════════
50–80 words. One <p> tag only. No bullet points.
- Sentence 1: The single most compelling reason to shop at ${store} — one specific fact from STORE DATA.
- Sentence 2: One practical saving tip (a real code, confirmed program, or policy perk).
- Sentence 3: Direct readers to Saving Harbor for verified codes.
Do not repeat the store name more than twice.

═══════════════════════════════════════
TABLE_CONTENT_HTML REQUIREMENTS
═══════════════════════════════════════
100–150 words. Exactly two <p> tags. No headings, no lists.
- Para 1: What ${store} sells and who it is for — draw from H1, product headings, category, price range.
- Para 2: What makes them notable — a specific policy, rating, founding story, years in business, or product differentiator from STORE DATA. Do not mention Saving Harbor here.

═══════════════════════════════════════
FAQS REQUIREMENTS
═══════════════════════════════════════
Exactly 4 FAQ objects. Each answer: 2–3 sentences. Lead with a direct answer, follow with specific data.
Attribute policy answers to their source. Do not invent any policy, discount, or program not confirmed in STORE DATA.

${faqPool
  .map((f, i) => {
    if (f.source === "store_faq")
      return `FAQ ${i + 1}: Rewrite in your own words — Q: "${f.q}" A: "${f.a}"`;
    if (f.source === "tp_complaint")
      return `FAQ ${i + 1}: Turn this known complaint into a helpful, honest Q&A: "${f.hint}"`;
    if (f.source === "reddit")
      return `FAQ ${i + 1}: Answer this real question shoppers ask: "${f.q}"`;
    if (f.source === "policy" || f.source === "program")
      return `FAQ ${i + 1}: Q: "${f.q}" — answer using: "${f.hint}"`;
    if (
      [
        "offer_code",
        "offer_discount",
        "offer_verified",
        "offer_deals",
        "coupon_generic",
      ].includes(f.source)
    )
      return `FAQ ${i + 1}: Q: "${f.q}" — use this data: ${f.hint}`;
    return `FAQ ${i + 1}: Write a relevant, honest question and answer about ${store} using STORE DATA only.`;
  })
  .join("\n")}

═══════════════════════════════════════
TRUST_TEXT REQUIREMENTS
═══════════════════════════════════════
1–2 sentences. Use ONLY confirmed signals from STORE DATA:
${hasTp ? `- Trustpilot: ${ctx.tpRating}★ from ${ctx.tpReviewCount.toLocaleString()} reviews` : ""}
${ctx.siteReviewCount > 0 ? `- On-site: ${ctx.siteReviewCount.toLocaleString()} customer reviews` : ""}
${ctx.returnWindow ? `- Return window: ${ctx.returnWindow}` : ""}
${ctx.freeReturns ? `- Free returns confirmed` : ""}
${ctx.yearsInBusiness ? `- Years in business: ${ctx.yearsInBusiness}` : ""}
${ctx.offerTotalActive > 0 ? `- ${ctx.offerTotalActive} active offers tracked${ctx.offerVerified > 0 ? `, ${ctx.offerVerified} verified with proof` : ""}` : ""}
If none of the above apply: write "Store information is based on publicly available data from ${store}'s official website."

═══════════════════════════════════════
STORE DATA (your only factual source):
═══════════════════════════════════════
${storeData}

═══════════════════════════════════════
RETURN THIS EXACT JSON SHAPE — NO OTHER TEXT:
═══════════════════════════════════════
{
  "meta_description": "string, 145–158 chars exactly",
  "side_description_html": "string, HTML",
  "table_content_html": "string, HTML",
  "description_html": "string, HTML, 350–450 visible words",
  "faqs": [{"question": "string", "answer": "string"}],
  "trust_text": "string"
}`;
}

// ─── Meta description fixer ───────────────────────────────────────────────────

function fixMetaDescription(meta, ctx) {
  if (!meta) return meta;
  meta = meta.trim();

  const genieRefs = (meta.toLowerCase().match(/saving harbor/g) || []).length;
  if (genieRefs > 1) {
    const firstRef = meta.toLowerCase().indexOf("saving harbor");
    let cutPoint = firstRef + "saving harbor".length;
    const nextPeriod = meta.indexOf(".", cutPoint);
    if (nextPeriod !== -1 && nextPeriod - cutPoint < 20)
      cutPoint = nextPeriod + 1;
    meta = meta.slice(0, cutPoint).trim();
  }

  if (meta.length >= 145 && meta.length <= 158) return meta;

  if (meta.length > 158) {
    const cut = meta.slice(0, 159);
    const sentEnd = Math.max(
      cut.lastIndexOf(". "),
      cut.lastIndexOf("! "),
      cut.lastIndexOf("? "),
    );
    if (sentEnd >= 145) return meta.slice(0, sentEnd + 1).trim();
    const t = meta.slice(0, 158);
    const sp = t.lastIndexOf(" ");
    return (sp > 130 ? t.slice(0, sp) : t).replace(/[,\s]+$/, "") + ".";
  }

  const base = meta.endsWith(".") ? meta.slice(0, -1) : meta;
  const baseLower = base.toLowerCase();
  const baseHasSH = baseLower.includes("saving harbor");

  const trimFit = (s) => {
    if (s.length >= 145 && s.length <= 158) return s;
    if (s.length > 158) {
      const t = s.slice(0, 159);
      const sentEnd = Math.max(
        t.lastIndexOf(". "),
        t.lastIndexOf("! "),
        t.lastIndexOf("? "),
      );
      if (sentEnd >= 145) return s.slice(0, sentEnd + 1).trim();
      const t2 = s.slice(0, 158);
      const sp = t2.lastIndexOf(" ");
      const r = (sp > 130 ? t2.slice(0, sp) : t2).replace(/[,\s]+$/, "") + ".";
      return r.length >= 145 ? r : null;
    }
    return null;
  };

  if (baseHasSH) {
    const neutralPads = [
      ctx.returnWindow && !baseLower.includes("return")
        ? ` ${ctx.returnWindow} return policy.`
        : null,
      ctx.offerVerified > 0 && !baseLower.includes("verified")
        ? ` ${ctx.offerVerified} offers verified with proof.`
        : null,
      ctx.activeCoupons > 0 && !baseLower.includes("active")
        ? ` ${ctx.activeCoupons} active offers tracked.`
        : null,
      ` Updated regularly.`,
      ` Codes checked and verified before listing.`,
      ` All codes tested and verified for accuracy.`,
    ].filter(Boolean);

    for (const np of neutralPads) {
      const r = trimFit(base + np);
      if (r) return r;
    }
    const ext =
      base +
      " Updated regularly with the latest verified deals and coupon codes.";
    const r = trimFit(ext);
    if (r) return r;
    return (base.slice(0, 155) + (base.length > 155 ? "..." : ".")).slice(
      0,
      158,
    );
  }

  const shPads = [
    ctx.bestDiscount &&
    ctx.bestDiscountType === "percentage" &&
    !baseLower.includes(`${ctx.bestDiscount}%`)
      ? ` Save up to ${ctx.bestDiscount}% — find verified codes at Saving Harbor.`
      : null,
    ctx.topCodes.length > 0 &&
    !baseLower.includes(ctx.topCodes[0].toLowerCase())
      ? ` Code ${ctx.topCodes[0]} and ${ctx.activeCoupons > 1 ? ctx.activeCoupons - 1 + " more offers" : "more deals"} at Saving Harbor.`
      : null,
    ctx.offerVerified > 0 && !baseLower.includes("verified with proof")
      ? ` ${ctx.offerVerified} offers verified with proof at Saving Harbor.`
      : null,
    ctx.tpFound && ctx.tpRating >= 4.0 && !baseLower.includes("trustpilot")
      ? ` Rated ${ctx.tpRating}★ on Trustpilot. Find verified codes at Saving Harbor.`
      : null,
    ctx.activeCoupons > 0 && !baseLower.includes("active offers")
      ? ` Browse ${ctx.activeCoupons} active offers at Saving Harbor.`
      : null,
    ` Find verified discount codes at Saving Harbor.`,
    ` Find verified discount codes and current promo offers at Saving Harbor.`,
    ` Browse all verified coupon codes and the latest deals at Saving Harbor now.`,
    ` Check Saving Harbor for verified codes, current deals, and the latest promo offers.`,
  ].filter(Boolean);

  const neutralPads = [
    ctx.returnWindow && !baseLower.includes("return")
      ? ` ${ctx.returnWindow} return policy.`
      : null,
    ctx.offerVerified > 0 && !baseLower.includes("verified")
      ? ` ${ctx.offerVerified} offers verified with proof.`
      : null,
    ctx.activeCoupons > 0 && !baseLower.includes("active")
      ? ` ${ctx.activeCoupons} active offers tracked.`
      : null,
    ` Updated regularly with the latest deals.`,
    ` Codes checked and verified before listing.`,
  ].filter(Boolean);

  for (const p of shPads) {
    const r = trimFit(base + p);
    if (r) return r;
  }
  for (const gp of shPads) {
    for (const np of neutralPads) {
      const r = trimFit(base + np + gp);
      if (r && (r.toLowerCase().match(/saving harbor/g) || []).length === 1)
        return r;
    }
  }
  for (const p of shPads) {
    const c = base + p;
    if (c.length >= 140 && c.length <= 158) return c;
    if (c.length > 158) {
      const r = trimFit(c);
      if (r) return r;
    }
  }

  const fb =
    base +
    " Check Saving Harbor for verified codes, current deals, and the latest promo offers.";
  const fbr = trimFit(fb);
  if (fbr) return fbr;
  return (base.slice(0, 154) + "...").slice(0, 158);
}

// ─── Jaccard trigram similarity ───────────────────────────────────────────────

function extractTrigrams(text) {
  const clean = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
  const trigrams = new Set();
  for (let i = 0; i <= clean.length - 3; i++)
    trigrams.add(clean.slice(i, i + 3));
  return trigrams;
}

function jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── Dedup corpus ─────────────────────────────────────────────────────────────
// Streams NDJSON — never loads full corpus into memory.

function loadDedupCorpus() {
  return readNdjson(GENERATED_PATH).filter(
    (r) => !r.error && r.content?.description_html,
  );
}

function checkDuplicates(newContent, slug) {
  const corpus = loadDedupCorpus().filter((r) => r.slug !== slug);
  const newGrams = extractTrigrams(newContent.description_html || "");
  const warnings = [];
  for (const prev of corpus) {
    const score = jaccardSimilarity(
      newGrams,
      extractTrigrams(prev.content.description_html),
    );
    if (score >= SIMILARITY_THRESHOLD) {
      warnings.push({
        similar_to_slug: prev.slug,
        similar_to_name: prev.name,
        similarity_score: Math.round(score * 100) + "%",
      });
    }
  }
  return warnings;
}

// ─── JSON parser ──────────────────────────────────────────────────────────────

function sanitizeJsonStringValues(jsonStr) {
  let result = "",
    inString = false,
    escaped = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i],
      code = jsonStr.charCodeAt(i);
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      result += ch;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (
        (code >= 0x00 && code <= 0x08) ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      ) {
        result += " ";
        continue;
      }
      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }
    }
    result += ch;
  }
  return result;
}

function parseResponse(raw) {
  let clean = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("No JSON object in response");
  let depth = 0,
    end = -1;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("Unterminated JSON object");
  return JSON.parse(sanitizeJsonStringValues(clean.slice(start, end + 1)));
}

// ─── Visible word count ───────────────────────────────────────────────────────

function visibleWordCount(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

// ─── Validate ─────────────────────────────────────────────────────────────────

function validate(content, ctx) {
  const issues = [];

  const wc = visibleWordCount(content.description_html);
  if (wc < 240) issues.push(`desc too short: ${wc}w (min 240)`);
  if (wc > 450) issues.push(`desc too long: ${wc}w (max 450)`);

  const meta = (content.meta_description || "").trim();
  if (meta.length < 145) issues.push(`meta too short: ${meta.length}c`);
  if (meta.length > 158) issues.push(`meta too long: ${meta.length}c`);
  if (!/\d/.test(meta)) issues.push("meta has no number");

  const faqs = Array.isArray(content.faqs) ? content.faqs.length : 0;
  if (faqs !== 4) issues.push(`expected 4 FAQs, got ${faqs}`);

  const visible = (content.description_html || "").replace(/<[^>]+>/g, " ");
  if (!visible.toLowerCase().includes(ctx.name.toLowerCase()))
    issues.push("store name missing from description");

  const banned = [
    "in today's world",
    "dive into",
    "unlock savings",
    "treasure trove",
    "elevate your",
    "seamlessly",
    "game-changer",
    "curated selection",
    "delve",
    "navigate your",
    "realm of",
    "look no further",
    "without further ado",
  ];
  if (banned.some((b) => visible.toLowerCase().includes(b)))
    issues.push("contains banned phrases");

  if (ctx.bestDiscount && ctx.bestDiscountType === "percentage") {
    if (
      !visible.includes(ctx.bestDiscount + "%") &&
      !visible.toLowerCase().includes("save up to")
    )
      issues.push(
        `offer data (${ctx.bestDiscount}%) not reflected in description`,
      );
  }

  const side = content.side_description_html || "";
  if (!side.trim()) {
    issues.push("side_description_html is missing");
  } else {
    const sWc = visibleWordCount(side);
    if (sWc < 30) issues.push(`side_description too short: ${sWc}w`);
    if (sWc > 100) issues.push(`side_description too long: ${sWc}w`);
    if (!/<p[\s>]/i.test(side))
      issues.push("side_description_html missing <p> tag");
    if (/<ul|<li|<h[1-6]/i.test(side))
      issues.push("side_description_html has disallowed tags");
  }

  const table = content.table_content_html || "";
  if (!table.trim()) {
    issues.push("table_content_html is missing");
  } else {
    const tWc = visibleWordCount(table);
    const pCount = (table.match(/<p[\s>]/gi) || []).length;
    if (tWc < 60) issues.push(`table_content too short: ${tWc}w`);
    if (tWc > 180) issues.push(`table_content too long: ${tWc}w`);
    if (pCount < 2)
      issues.push(`table_content_html needs 2 <p> tags, found ${pCount}`);
    if (/<ul|<li|<h[1-6]/i.test(table))
      issues.push("table_content_html has disallowed tags");
  }

  const couponPhrase = new RegExp(
    `${ctx.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+coupons?`,
    "gi",
  );
  const phraseCount = (visible.match(couponPhrase) || []).length;
  if (phraseCount > 2)
    issues.push(
      `keyword phrase "${ctx.name} coupons" repeated ${phraseCount}× (max 2)`,
    );

  return issues;
}

function hasMalformedHtml(html) {
  return html ? /<[a-zA-Z][^>]*$|<p[A-Z]/m.test(html) : false;
}

// ─── Generate with provider rotation ─────────────────────────────────────────

async function generateContent(
  ctx,
  slug,
  attempt = 1,
  forcedProvider = null,
  retryReason = null,
) {
  const provider = forcedProvider || getActiveProvider();
  if (!provider) throw new Error("All providers exhausted. Resume tomorrow.");

  try {
    const raw = await provider.call(
      SYSTEM_PROMPT,
      buildPrompt(ctx, slug, retryReason),
    );
    if (!raw) throw new Error("Empty response");

    const parsed = parseResponse(raw);

    if (hasMalformedHtml(parsed.description_html) && attempt <= MAX_RETRIES) {
      const reason = `Your previous response contained malformed HTML in description_html (unclosed or broken tags). Return clean <h3> and <p> tags only — no other HTML elements.`;
      console.log(`    🔄 Malformed HTML — retry ${attempt}/${MAX_RETRIES}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return generateContent(ctx, slug, attempt + 1, provider, reason);
    }

    const wc = visibleWordCount(parsed.description_html);
    if (wc < 150) {
      const reason = `Your previous attempt produced only ${wc} words in description_html. Write at least 150 visible words. Fill every required section with specific, data-grounded content.`;
      const next = PROVIDERS.find(
        (p) => p.available && !p.exhausted && p.name !== provider.name,
      );
      if (next && attempt <= MAX_RETRIES) {
        console.log(`    🔄 Too short (${wc}w) — switching to ${next.name}`);
        return generateContent(ctx, slug, attempt + 1, next, reason);
      }
      if (attempt <= MAX_RETRIES) {
        console.log(
          `    🔄 Too short (${wc}w) — retry ${attempt}/${MAX_RETRIES}`,
        );
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        return generateContent(ctx, slug, attempt + 1, provider, reason);
      }
    }

    parsed.meta_title = buildMetaTitle(ctx);
    parsed.meta_description = fixMetaDescription(parsed.meta_description, ctx);
    return parsed;
  } catch (err) {
    const isRateLimit =
      err.status === 429 ||
      (err.message || "").toLowerCase().includes("rate limit") ||
      (err.message || "").toLowerCase().includes("quota");

    if (isRateLimit) {
      const permanent = provider.name === "Groq";
      markExhausted(provider.name, permanent);
      const next = getActiveProvider();
      if (next) return generateContent(ctx, slug, attempt, next, retryReason);
      if (!permanent) {
        await new Promise((r) => setTimeout(r, 65000));
        resetProvider(provider.name);
      }
      return generateContent(ctx, slug, attempt, null, retryReason);
    }

    if (err instanceof SyntaxError && attempt <= MAX_RETRIES) {
      const reason = `Your previous response was not valid JSON. Return ONLY a JSON object — no markdown fences, no text outside {}, no trailing commas, no comments.`;
      console.log(`    🔄 JSON parse error — retry ${attempt}/${MAX_RETRIES}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      return generateContent(ctx, slug, attempt + 1, provider, reason);
    }

    if (attempt <= MAX_RETRIES) {
      const reason = `Your previous attempt threw an error: ${err.message}. Return only the requested JSON object.`;
      await new Promise((r) => setTimeout(r, 4000 * attempt));
      return generateContent(ctx, slug, attempt + 1, provider, reason);
    }
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const available = PROVIDERS.filter((p) => p.available);
  if (!available.length) {
    console.error(
      "❌ No API keys found. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in .env",
    );
    process.exit(1);
  }
  console.log(`\n✅ Providers: ${available.map((p) => p.name).join(" → ")}`);

  if (!fs.existsSync(SCRAPED_PATH)) {
    console.error(
      `❌ scraped_results.ndjson not found. Run 02_scraper.js first.\n   Expected: ${SCRAPED_PATH}`,
    );
    process.exit(1);
  }

  const allScraped = readNdjson(SCRAPED_PATH);
  console.log(`📋 Loaded ${allScraped.length} scraped merchants`);

  const existingGenerated = readNdjson(GENERATED_PATH);
  if (existingGenerated.length)
    console.log(`📋 Resuming — ${existingGenerated.length} already attempted`);

  const initialCorpusSize = loadDedupCorpus().length;
  console.log(
    `🔍 Dedup corpus (initial): ${initialCorpusSize} entries on disk`,
  );

  const skipSlugs = new Set(
    FORCE
      ? []
      : existingGenerated
          .filter((r) => (RETRY_FAILED ? !r.error : true))
          .map((r) => r.slug)
          .filter(Boolean),
  );

  let merchants = allScraped.filter((m) => {
    const slug = m.slug || m.name?.toLowerCase().replace(/\s+/g, "-");
    if (SLUG && slug !== SLUG) return false;
    if (skipSlugs.has(slug)) return false;
    if (TIER && m.tier !== TIER) return false;
    return true;
  });

  if (LIMIT) merchants = merchants.slice(0, LIMIT);

  console.log(
    `\n✍️  Generating: ${merchants.length} stores | DryRun: ${DRY_RUN}\n`,
  );

  if (!merchants.length) {
    console.log(
      "✅ Nothing to generate. Use --retry-failed or --force to reprocess.",
    );
    return;
  }

  // On --force: load all for in-memory rewrite support
  let forceRecords = FORCE ? [...existingGenerated] : null;

  for (const m of merchants) {
    const provider = getActiveProvider();
    if (!provider) {
      console.log(
        "\n🛑 All providers exhausted. Resume tomorrow or add more API keys.",
      );
      break;
    }

    const slug = m.slug || m.name.toLowerCase().replace(/\s+/g, "-");
    const offerCount =
      m.offerSummary?.totalActive ??
      m.scraped_data?.offerSummary?.totalActive ??
      0;
    const verifiedCount =
      m.offerSummary?.verifiedCount ??
      m.scraped_data?.offerSummary?.verifiedCount ??
      0;
    console.log(
      `  ↳ [${m.tier}] ${m.name} [${provider.name}] | offers:${offerCount} verified:${verifiedCount}`,
    );

    const ctx = buildContext(m, m.scraped_data || {});

    try {
      const content = await generateContent(ctx, slug);
      const issues = validate(content, ctx);
      const wc = visibleWordCount(content.description_html);
      const similarityWarnings = checkDuplicates(content, slug);

      if (similarityWarnings.length) {
        console.log(
          `    ⚠️  Similarity: ${similarityWarnings.map((w) => `${w.similar_to_slug} (${w.similarity_score})`).join(", ")}`,
        );
      }

      if (issues.length) {
        console.log(
          `    ⚠️  ${wc}w | meta:${(content.meta_description || "").length}c | ${issues.join(" | ")}`,
        );
      } else {
        console.log(
          `    ✓ ${wc}w | FAQs:${content.faqs?.length || 0} | meta:${(content.meta_description || "").length}c${similarityWarnings.length ? " | ⚠️ similar" : ""}`,
        );
      }

      if (DRY_RUN) {
        console.log(`    [DRY] ${content.meta_title}`);
        console.log(
          `    [DRY] meta(${(content.meta_description || "").length}c): ${content.meta_description}`,
        );
        continue;
      }

      if (wc < 200) {
        console.log(`    ⛔ Rejected (${wc}w < 200w minimum)`);
        await supabase
          .from("merchants")
          .update({
            content_status: "failed",
            generation_error: guardStr(
              `content too short: ${wc}w`,
              1000,
              "generation_error",
            ),
          })
          .eq("slug", slug)
          .catch(() => {});
        const rec = {
          slug,
          id: m.id,
          name: m.name,
          tier: m.tier,
          error: `too short: ${wc}w`,
          generated_at: new Date().toISOString(),
        };
        if (FORCE) {
          const idx = forceRecords.findIndex((r) => r.slug === slug);
          if (idx >= 0) forceRecords[idx] = rec;
          else forceRecords.push(rec);
          rewriteNdjson(GENERATED_PATH, forceRecords);
        } else appendNdjson(GENERATED_PATH, rec);
        continue;
      }

      if (BLOCK_ISSUES && issues.length) {
        console.log(`    ⛔ Blocked: ${issues.join("; ")}`);
        const rec = {
          slug,
          id: m.id,
          name: m.name,
          tier: m.tier,
          error: `blocked: ${issues.join("; ")}`,
          generated_at: new Date().toISOString(),
        };
        if (FORCE) {
          const idx = forceRecords.findIndex((r) => r.slug === slug);
          if (idx >= 0) forceRecords[idx] = rec;
          else forceRecords.push(rec);
          rewriteNdjson(GENERATED_PATH, forceRecords);
        } else appendNdjson(GENERATED_PATH, rec);
        continue;
      }

      const payload = {
        meta_title: guardStr(content.meta_title, 70, "meta_title"),
        meta_description: guardStr(
          content.meta_description,
          160,
          "meta_description",
        ),
        side_description_html: content.side_description_html,
        table_content_html: content.table_content_html,
        description_html: content.description_html,
        faqs: content.faqs,
        trust_text: guardStr(content.trust_text, 500, "trust_text"),
        content_status: "generated",
        content_generated_at: new Date().toISOString(),
        generation_error: issues.length
          ? guardStr(issues.join("; "), 1000, "generation_error")
          : null,
        scrape_score: m.score,
        content_tier: m.tier,
      };

      const { data: dbData, error: dbErr } = await supabase
        .from("merchants")
        .update(payload)
        .eq("slug", slug)
        .select("id");

      if (dbErr) {
        console.error(`    ✗ DB update failed [${slug}]: ${dbErr.message}`);
        const rec = {
          slug,
          id: m.id,
          name: m.name,
          tier: m.tier,
          error: `db: ${dbErr.message}`,
          generated_at: new Date().toISOString(),
        };
        if (FORCE) {
          const idx = forceRecords.findIndex((r) => r.slug === slug);
          if (idx >= 0) forceRecords[idx] = rec;
          else forceRecords.push(rec);
          rewriteNdjson(GENERATED_PATH, forceRecords);
        } else appendNdjson(GENERATED_PATH, rec);
      } else {
        const realId = dbData?.[0]?.id;
        if (!realId) {
          console.warn(
            `    ⚠️  DB update succeeded but no id returned for slug="${slug}". Check RLS — service role may lack SELECT on merchants, or slug has no matching row.`,
          );
        } else {
          console.log(`    ✓ Saved [id=${realId} slug=${slug}]`);
        }
        const rec = {
          id: realId ?? null,
          name: m.name,
          slug,
          tier: m.tier,
          score: m.score,
          issues: issues.length ? issues : null,
          similarity_warnings: similarityWarnings.length
            ? similarityWarnings
            : null,
          generated_at: new Date().toISOString(),
          content,
        };
        if (FORCE) {
          const idx = forceRecords.findIndex((r) => r.slug === slug);
          if (idx >= 0) forceRecords[idx] = rec;
          else forceRecords.push(rec);
          rewriteNdjson(GENERATED_PATH, forceRecords);
        } else appendNdjson(GENERATED_PATH, rec);
      }
    } catch (err) {
      console.error(`    ✗ ${m.name}: ${err.message}`);
      await supabase
        .from("merchants")
        .update({
          content_status: "failed",
          generation_error: guardStr(err.message, 1000, "generation_error"),
        })
        .eq("slug", slug)
        .catch(() => {});
      const rec = {
        slug,
        id: m.id,
        name: m.name,
        tier: m.tier,
        error: err.message.slice(0, 500),
        generated_at: new Date().toISOString(),
      };
      if (FORCE) {
        const idx = forceRecords.findIndex((r) => r.slug === slug);
        if (idx >= 0) forceRecords[idx] = rec;
        else forceRecords.push(rec);
        rewriteNdjson(GENERATED_PATH, forceRecords);
      } else appendNdjson(GENERATED_PATH, rec);
    }

    await new Promise((r) => setTimeout(r, provider.delayMs ?? 3000));
  }

  const allGenerated = readNdjson(GENERATED_PATH);
  const ok = allGenerated.filter((r) => !r.error).length;
  const fail = allGenerated.filter((r) => r.error).length;
  const warned = allGenerated.filter(
    (r) => r.similarity_warnings?.length,
  ).length;
  console.log(
    `\n🏁 Done. Success: ${ok} | Failed: ${fail} | Similarity warnings: ${warned}`,
  );
  console.log(`💾 Saved to: ${GENERATED_PATH}`);
}

main().catch(console.error);
