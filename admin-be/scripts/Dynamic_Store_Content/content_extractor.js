/**
 * Content Extractor
 *
 * Extracts structured content from a page URL.
 * Tries cheerio first, Playwright fallback for JS-rendered pages.
 *
 * Fixes vs previous version:
 *   1. foundingStory — broader regex: catches "Since 1998", "Est. 2003", "Our story began..."
 *   2. salePatterns  — captures "Up to X% off", "Save $X" in addition to event names
 *   3. keyParagraphs — scoped away from bare `section p` (too noisy); main/article first
 *   4. priceRange    — new signal: "$XX–$XXX" extracted from homepage for generator context
 *   5. mission       — no longer stops at first period; captures multi-sentence missions
 *   6. customerReviews — scoped to article/main to avoid UI label false positives
 */

import * as cheerio from "cheerio";
import { chromium } from "playwright";

const FETCH_TIMEOUT = 10000;
const PLAYWRIGHT_TIMEOUT = 15000;
const PLAYWRIGHT_WAIT = 2000;

// ─── Bad code words ───────────────────────────────────────────────────────────

const INVALID_CODE_WORDS = new Set([
  "POLICY",
  "BUTTON",
  "CONTAINER",
  "LABEL",
  "DRIVING",
  "INSTEAD",
  "CONTENT",
  "HEADER",
  "FOOTER",
  "SECTION",
  "WRAPPER",
  "INNER",
  "OUTER",
  "MODAL",
  "POPUP",
  "CLASS",
  "STYLE",
  "THEME",
  "COLOR",
  "IMAGE",
  "BLOCK",
  "COLUMN",
  "LAYOUT",
  "FALSE",
  "TRUE",
  "NULL",
  "UNDEFINED",
  "NONE",
  "AUTO",
  "LEFT",
  "RIGHT",
  "LARGE",
  "SMALL",
  "MEDIUM",
  "BRAND",
  "ACTIVE",
  "HIDDEN",
  "VISIBLE",
  "SENT",
  "TRACKING",
  "ACTION",
  "EVENT",
  "TOKEN",
  "SESSION",
  "STORE",
]);

// ─── Cookie / GDPR filter ─────────────────────────────────────────────────────

const COOKIE_KEYWORDS = [
  "functional",
  "statistics",
  "marketing",
  "preferences",
  "consent",
  "gdpr",
  "cookie policy",
  "accept all",
  "reject all",
  "manage consent",
  "strictly necessary",
  "performance cookie",
  "targeting cookie",
  "analytics cookie",
  "personalization",
  "opt-out",
  "opt out",
  "data retention",
  "third party",
  "process your data",
];

function isCookieContent(text) {
  const lower = text.toLowerCase();
  return COOKIE_KEYWORDS.filter((k) => lower.includes(k)).length >= 2;
}

// ─── Fetch (cheerio) ──────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GenieCouponBot/1.0; +https://geniecoupon.com)",
        Accept: "text/html",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Fetch (Playwright) ───────────────────────────────────────────────────────

async function fetchWithPlaywright(url) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PLAYWRIGHT_TIMEOUT,
    });
    await page.waitForTimeout(PLAYWRIGHT_WAIT);
    return await page.content();
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function removeChrome($) {
  $("script, style, nav, header, footer, noscript, iframe").remove();
  $('[class*="nav"], [class*="menu"], [id*="nav"], [id*="menu"]').remove();
  $(
    '[class*="cookie"], [class*="consent"], [id*="cookie"], [id*="consent"]',
  ).remove();
  $('[class*="banner"], [class*="popup"], [class*="modal"]').remove();
  $('[class*="sidebar"], [class*="breadcrumb"]').remove();
}

function getCleanText($) {
  removeChrome($);
  return $("body").text().replace(/\s+/g, " ").trim();
}

// Scoped paragraph extractor — main/article first, never bare `p` or `section p`
// bare `section p` pulls shipping disclaimers, legal notices, CTA labels.
function getParagraphs($, minLen = 60, maxLen = 800) {
  const paras = [];
  const seen = new Set();

  const selectors = [
    "main p",
    "article p",
    '[role="main"] p',
    '[class*="content"] p',
    '[class*="description"] p',
    '[class*="about"] p',
    '[class*="body"] p',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const t = $(el).text().trim();
      if (
        t.length >= minLen &&
        t.length <= maxLen &&
        !seen.has(t) &&
        !isCookieContent(t) &&
        !/^\s*[\w\s]+[|·•]\s*[\w\s]+[|·•]/i.test(t) // navigation-style pipe-separated text
      ) {
        seen.add(t);
        paras.push(t);
      }
    });
  }
  return paras;
}

// ─── FAQ extractor ────────────────────────────────────────────────────────────

function extractFaqs($) {
  const faqs = [];
  const seen = new Set();

  function add(q, a, source) {
    q = q?.trim();
    a = a?.trim();
    if (!q || !a) return;
    if (q.length < 8 || a.length < 15) return;
    if (seen.has(q)) return;
    if (isCookieContent(q) || isCookieContent(a)) return;
    if (
      /^(functional|statistics|marketing|preferences|necessary|performance)$/i.test(
        q,
      )
    )
      return;
    if (q.length > 200) return;
    seen.add(q);
    faqs.push({ question: q, answer: a.substring(0, 500), source });
  }

  // Schema.org microdata
  $('[itemtype*="FAQPage"] [itemtype*="Question"]').each((_, el) => {
    add(
      $(el).find('[itemprop="name"]').text(),
      $(el).find('[itemprop="text"], [itemprop="acceptedAnswer"]').text(),
      "schema",
    );
  });

  // JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const schemas = Array.isArray(json) ? json : [json];
      for (const schema of schemas) {
        if (schema["@type"] === "FAQPage") {
          for (const item of schema.mainEntity || []) {
            add(item.name, item.acceptedAnswer?.text, "json-ld");
          }
        }
        // Also check @graph for FAQPage nodes
        for (const node of schema["@graph"] || []) {
          if (node["@type"] === "FAQPage") {
            for (const item of node.mainEntity || []) {
              add(item.name, item.acceptedAnswer?.text, "json-ld-graph");
            }
          }
        }
      }
    } catch {}
  });

  // details/summary
  $("details").each((_, el) => {
    const q = $(el).find("summary").text().trim();
    const a = $(el).find("p, div").first().text().trim();
    add(q, a, "details");
  });

  // Accordion patterns
  $(
    '[class*="accordion"] [class*="item"], [class*="faq"] [class*="item"], [class*="faq-item"]',
  ).each((_, el) => {
    const q = $(el)
      .find('[class*="question"], [class*="title"], summary, h3, h4, button')
      .first()
      .text()
      .trim();
    const a = $(el)
      .find('[class*="answer"], [class*="content"], [class*="body"], p')
      .first()
      .text()
      .trim();
    add(q, a, "accordion");
  });

  // dl/dt/dd
  $("dl dt").each((_, dt) => {
    add($(dt).text().trim(), $(dt).next("dd").text().trim(), "dl");
  });

  // h2/h3/h4 ending with ?
  $("main h2, main h3, main h4, article h3, section h3").each((_, el) => {
    const q = $(el).text().trim();
    if (q.endsWith("?")) {
      add(q, $(el).next("p, div").text().trim(), "heading");
    }
  });

  return faqs.slice(0, 12);
}

// ─── Founding story — broadened ───────────────────────────────────────────────
// Previous: only matched "founded/established/started in YYYY"
// Now: also catches "Since 1998", "Est. 2003", "Our story began", "in business since"

function extractFoundingStory(text) {
  const patterns = [
    /(?:founded|established|started|launched)\s+(?:in\s+)?(\d{4})/i,
    /since\s+(\d{4})/i,
    /est\.?\s*(\d{4})/i,
    /in\s+business\s+since\s+(\d{4})/i,
    /(?:our\s+)?(?:story|journey)\s+(?:began|started)[^.]{0,100}/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:experience|in business|serving)/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[0].trim().substring(0, 150);
  }
  return null;
}

// ─── Mission — multi-sentence aware ──────────────────────────────────────────
// Previous: stopped at first period — missed "Our mission is to... We believe..."

function extractMission(text) {
  // Try to get up to 2 sentences starting from mission signal
  const patterns = [
    /our\s+mission\s+(?:is\s+)?(?:to\s+)?[^.]{10,200}\.(?:\s+[^.]{10,150}\.)?/i,
    /we\s+(?:believe|exist\s+to|are\s+here\s+to|strive\s+to)\s+[^.]{10,200}\.(?:\s+[^.]{10,150}\.)?/i,
    /(?:our\s+)?(?:purpose|vision)\s+(?:is\s+)?[^.]{10,200}\./i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[0].trim().substring(0, 400);
  }
  return null;
}

// ─── Sale patterns — extended ─────────────────────────────────────────────────
// Previous: only event names (Black Friday, Cyber Monday, etc.)
// Now: also captures "up to X% off", "save $X", "X% off sitewide"

function extractSalePatterns(text) {
  const patterns = [
    /(black\s+friday|cyber\s+monday|flash\s+sale|clearance|annual\s+sale|holiday\s+sale)[^.]{0,80}/gi,
    /(?:up\s+to\s+)?(\d+)%\s+off(?:\s+(?:sitewide|everything|all\s+orders|select))?[^.]{0,60}/gi,
    /save\s+(?:up\s+to\s+)?\$(\d+)(?:\s+on[^.]{0,60})?/gi,
    /(\d+)%\s+off\s+(?:your\s+)?(?:first|next)\s+order[^.]{0,60}/gi,
  ];

  const found = new Set();
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const clean = match[0].trim().replace(/\s+/g, " ");
      if (clean.length > 5 && clean.length < 120) found.add(clean);
      if (found.size >= 6) break;
    }
  }
  return [...found].slice(0, 6);
}

// ─── Price range extractor ────────────────────────────────────────────────────
// New signal: extracts price ranges visible on homepage for generator context.
// e.g. "$29.99–$199", "from $49", "starting at $15"

function extractPriceRange(text) {
  const rangePat = /\$(\d+(?:\.\d{1,2})?)\s*[–—-]\s*\$(\d+(?:\.\d{1,2})?)/;
  const fromPat =
    /(?:from|starting\s+(?:at|from)|prices?\s+from)\s+\$(\d+(?:\.\d{1,2})?)/i;
  const upToPat = /(?:under|up\s+to)\s+\$(\d+(?:\.\d{1,2})?)/i;

  const rangeMatch = text.match(rangePat);
  if (rangeMatch) return `$${rangeMatch[1]}–$${rangeMatch[2]}`;

  const fromMatch = text.match(fromPat);
  if (fromMatch) return `from $${fromMatch[1]}`;

  const upToMatch = text.match(upToPat);
  if (upToMatch) return `up to $${upToMatch[1]}`;

  return null;
}

// ─── Page-type extractors ─────────────────────────────────────────────────────

function extractPage(html, category) {
  const $ = cheerio.load(html);

  if (category === "faq") {
    $(
      '[class*="cookie"], [class*="consent"], [id*="cookie"], [id*="consent"]',
    ).remove();
    $('[class*="gdpr"], [id*="gdpr"]').remove();
    return { category, faqs: extractFaqs($) };
  }

  if (category === "about") {
    removeChrome($);
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return {
      category,
      keyParagraphs: getParagraphs($).slice(0, 6),
      headings: [
        ...new Set(
          $("h1, h2, h3")
            .map((_, el) => $(el).text().trim())
            .get()
            .filter(
              (t) => t.length > 5 && t.length < 100 && !isCookieContent(t),
            ),
        ),
      ].slice(0, 8),
      foundingStory: extractFoundingStory(text),
      mission: extractMission(text),
      stats: [
        ...new Set(
          text.match(
            /[\d,]+\+?\s*(customers?|orders?|countries|products?|years?|reviews?|members?)/gi,
          ) || [],
        ),
      ].slice(0, 5),
    };
  }

  if (category === "shipping") {
    const text = getCleanText($);
    return {
      category,
      freeShippingThreshold:
        (text.match(
          /free\s*(?:standard\s*)?shipping\s*(?:on\s*orders?\s*)?(?:over|above|of)?\s*\$[\d,.]+/i,
        ) || [])[0]?.trim() || null,
      deliveryTimes: [
        ...new Set(
          (
            text.match(
              /(\d+)[- ](\d+)?\s*(?:business\s*)?days?\s*(?:delivery|shipping)/gi,
            ) || []
          )
            .slice(0, 3)
            .map((s) => s.trim()),
        ),
      ],
      internationalShipping:
        /international\s*shipping|ship\s*(?:world)?wide/i.test(text),
      expressAvailable: /express|overnight|next.day|priority\s*shipping/i.test(
        text,
      ),
      keyParagraphs: getParagraphs($).slice(0, 3),
    };
  }

  if (category === "returns") {
    const text = getCleanText($);
    return {
      category,
      returnWindow:
        (text.match(/(\d+)[- ]day\s*(?:free\s*)?(?:return|refund|exchange)/i) ||
          [])[0]?.trim() || null,
      freeReturns: /free\s*(?:return|refund|exchange)/i.test(text),
      conditions: [
        /unworn|original\s*condition/i.test(text)
          ? "Item must be in original condition"
          : null,
        /sale\s*item|final\s*sale/i.test(text)
          ? "Sale items may be excluded"
          : null,
      ].filter(Boolean),
      keyParagraphs: getParagraphs($).slice(0, 3),
    };
  }

  if (category === "blog") {
    return {
      category,
      topics: [
        ...new Set(
          $("h1, h2, h3, article h2")
            .map((_, el) => $(el).text().trim())
            .get()
            .filter((t) => t.length > 10 && t.length < 120),
        ),
      ].slice(0, 6),
    };
  }

  return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function hasUsefulContent(content) {
  if (!content) return false;
  switch (content.category) {
    case "faq":
      return content.faqs?.length > 0;
    case "about":
      return content.keyParagraphs?.length > 0 || !!content.foundingStory;
    case "shipping":
      return (
        !!content.freeShippingThreshold || content.deliveryTimes?.length > 0
      );
    case "returns":
      return !!content.returnWindow || content.keyParagraphs?.length > 0;
    case "blog":
      return content.topics?.length > 0;
    default:
      return false;
  }
}

export async function extractContent(url, category) {
  const html = await fetchHtml(url);
  if (html) {
    const result = extractPage(html, category);
    if (hasUsefulContent(result)) return result;
  }

  const pwHtml = await fetchWithPlaywright(url);
  if (pwHtml) {
    const result = extractPage(pwHtml, category);
    if (result) result.usedPlaywright = true;
    return result;
  }

  return null;
}

export function extractHomepage(html) {
  const $ = cheerio.load(html);

  // ── Hero taglines ──────────────────────────────────────────────────────────
  const heroTaglines = [];
  $(
    '[class*="hero"] h1, [class*="hero"] h2, [class*="hero"] p, [class*="banner"] h1, [class*="banner"] h2',
  ).each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 10 && t.length < 300) heroTaglines.push(t);
  });

  // ── Customer reviews — scoped to article/main to avoid UI labels ───────────
  const reviews = [];
  $(
    'main [class*="review"] p, main [class*="testimonial"] p, ' +
      'article [class*="review"] p, [itemprop="reviewBody"], ' +
      '[class*="review-text"], [class*="reviewText"]',
  ).each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 30 && t.length < 400) reviews.push(t);
  });

  // ── Remove chrome before text extraction ───────────────────────────────────
  $("script, style, noscript, iframe").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();

  // ── Product headings ───────────────────────────────────────────────────────
  const productHeadings = [];
  $(
    'main h2, main h3, section h2, section h3, [class*="product"] h2, [class*="collection"] h2',
  ).each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 3 && t.length < 80) productHeadings.push(t);
  });

  // ── Visible promo codes ────────────────────────────────────────────────────
  const rawCodeMatches =
    text.match(/(?:code|coupon|promo)[:\s"']+([A-Z0-9]{5,20})\b/gi) || [];
  const validCodes = [
    ...new Set(
      rawCodeMatches
        .map((m) => {
          const parts = m.split(/[:\s"']+/);
          return parts[parts.length - 1].toUpperCase();
        })
        .filter((code) => {
          if (INVALID_CODE_WORDS.has(code)) return false;
          if (/^[0-9]+$/.test(code)) return false;
          if (code.length < 5 || code.length > 20) return false;
          if (/^(THE|AND|FOR|WITH|THIS|THAT|FROM|YOUR|HAVE|WILL)$/i.test(code))
            return false;
          return true;
        }),
    ),
  ].slice(0, 5);

  return {
    h1: $("h1").first().text().trim() || null,
    metaDescription: $('meta[name="description"]').attr("content") || null,
    ogDescription: $('meta[property="og:description"]').attr("content") || null,
    heroTaglines: [...new Set(heroTaglines)].slice(0, 4),
    productHeadings: [...new Set(productHeadings)].slice(0, 10),
    keyParagraphs: getParagraphs($).slice(0, 6),
    customerReviews: [...new Set(reviews)].slice(0, 4),
    priceRange: extractPriceRange(text), // NEW
    trustSignals: {
      yearsInBusiness: extractFoundingStory(text),
      returnWindow:
        (text.match(/(\d+)[- ]day\s*(?:free\s*)?(?:return|refund)/i) ||
          [])[0]?.trim() || null,
      freeShippingThreshold:
        (text.match(
          /free\s*shipping\s*(?:on\s*orders?\s*)?(?:over|above)?\s*\$[\d,.]+/i,
        ) || [])[0]?.trim() || null,
      warranty:
        (text.match(/(\d+)[- ](?:year|month)\s*warranty/i) ||
          text.match(/lifetime\s*warranty/i) ||
          [])[0]?.trim() || null,
      reviewCount:
        (text.match(/([\d,]+)\+?\s*(?:verified\s*)?reviews?/i) ||
          [])[1]?.replace(/,/g, "") || null,
      rating:
        (text.match(/(\d+\.?\d*)\s*(?:out\s*of\s*5|\/\s*5|\s*stars?)/i) ||
          [])[1] || null,
      trustpilot: html.includes("trustpilot.com"),
      bbb: /better\s+business\s+bureau|bbb\s+accredited/i.test(html),
      secureCheckout: /ssl|secure\s*(?:checkout|payment)|encrypted/i.test(html),
    },
    specialOffers: {
      financing: /affirm|klarna|afterpay|sezzle|pay\s*later|installment/i.test(
        text,
      ),
      freeShipping: /free\s*shipping/i.test(text),
      appDiscount: /app[^.]{0,40}(?:discount|off|exclusive)/i.test(text),
      studentDiscount: /student[^.]{0,40}(?:discount|off|program)/i.test(text),
      loyaltyProgram:
        /loyalty|reward\s*program|points\s*program|member\s*reward/i.test(text),
      subscriptionSave:
        /subscribe\s*(?:and|&)\s*save|subscription\s*discount/i.test(text),
      referralProgram: /refer\s*a\s*friend|referral\s*(?:program|bonus)/i.test(
        text,
      ),
      clearanceSale: /clearance|outlet\s*sale|end\s*of\s*season/i.test(text),
    },
    visibleCodes: validCodes,
    salePatterns: extractSalePatterns(text), // improved
  };
}
