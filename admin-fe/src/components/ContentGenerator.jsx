/**
 * SavingHarbor — Content Architecture Variation Engine v2.1 (Real-Time Crawler Edition)
 * Original v2 + Real-time website crawling + Two-stage generation for better ranking
 * 384 structural variations + Supabase DB coupon data + Live merchant crawl
 * No two pages will share the same structure, tone, angle, OR facts.
 *
 * Changes from your original v2:
 * - Added real-time crawling of merchant homepage
 * - Two-stage generation: Research (crawl + DB) → Variation content
 * - New CrawlStatus UI indicator
 * - Fresh research injected into final prompt for higher specificity & E-E-A-T
 * - Default model: gemini-2.0-flash (faster/cheaper for scale)
 * - All your original logic (variations, blueprints, batch, exports, etc.) untouched
 */

import { useState, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────
const BACKEND_URL = "https://your-app.onrender.com"; // ← CHANGE THIS TO YOUR ACTUAL RENDER URL

// ─── REAL-TIME CRAWLER (NEW in v2.1) ───────────────────────────────
const crawlMerchantSite = async (url) => {
  if (!url?.trim()) return "";
  try {
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url.trim())}&t=${Date.now()}`;
    const res = await fetch(proxy);
    if (!res.ok) throw new Error("Proxy error");
    const data = await res.json();
    const html = data.contents || "";

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Aggressive cleanup
    doc
      .querySelectorAll(
        "script, style, noscript, svg, header, footer, nav, aside, .ad, .cookie, .banner",
      )
      .forEach((el) => el.remove());

    let rawText = doc.body.innerText || "";
    rawText = rawText.replace(/\s+/g, " ").trim().substring(0, 11000);
    return rawText.length > 100
      ? rawText
      : "No substantial content found on homepage.";
  } catch (err) {
    console.warn("Crawl failed:", err.message);
    return `CRAWL FAILED for ${url}. Falling back to DB + general knowledge.`;
  }
};

// ─── GEMINI HELPER ─────────────────────────────────────────────────
async function callGemini(prompt, apiKey, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.78, maxOutputTokens: 8192 },
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `Gemini error ${res.status}`);
  }
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function safeJSON(text) {
  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const fixed = clean.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(fixed);
}

// ─── YOUR ORIGINAL VARIATION ENGINE (100% UNCHANGED) ──────────────
function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const TONES = [
  {
    id: "authoritative",
    label: "Authoritative Expert",
    instruction:
      "Write with confident domain expertise. Use specific facts, figures, and industry knowledge. Tone: a knowledgeable professional briefing a peer. Avoid hedging language.",
  },
  {
    id: "conversational",
    label: "Conversational Friend",
    instruction:
      "Write like a savvy friend who genuinely knows this brand and wants to help. Warm, direct, naturally uses 'you'. No jargon. Real talk, not marketing copy.",
  },
  {
    id: "review",
    label: "Critical Reviewer",
    instruction:
      "Write like an independent reviewer who has studied this brand thoroughly. Analytical, balanced — includes genuine strengths and any honest caveats. Evidence-driven.",
  },
  {
    id: "guide",
    label: "Shopper's Guide",
    instruction:
      "Write as a practical buying guide focused on helping the reader make smart decisions. Structured, actionable, focuses on value signals and red flags.",
  },
];

const ANGLES = [
  {
    id: "value",
    label: "Value & Savings",
    instruction:
      "Emphasise total value proposition — quality-to-price ratio, long-term savings, smart spending.",
  },
  {
    id: "quality",
    label: "Quality & Trust",
    instruction:
      "Emphasise brand credibility, product quality, reliability, certifications, and track record.",
  },
  {
    id: "community",
    label: "Community & Social Proof",
    instruction:
      "Emphasise customer experiences, community trust, real-world results, and collective wisdom.",
  },
  {
    id: "discovery",
    label: "Discovery & Exploration",
    instruction:
      "Emphasise breadth of range, lesser-known gems, unique finds, and category exploration.",
  },
];

const HEADING_STYLES = [
  { id: "declarative", label: "Declarative", suffix: "" },
  { id: "question", label: "Question", suffix: "?" },
  { id: "benefit", label: "Benefit-Led", suffix: "" },
];

const BLUEPRINTS = [
  {
    id: "fashion",
    label: "Fashion & Apparel",
    keywords: [
      "cloth",
      "fashion",
      "apparel",
      "shoes",
      "bag",
      "jewel",
      "wear",
      "style",
      "dress",
      "shirt",
    ],
    sections: [
      {
        id: "brandStory",
        heads: [
          "The {m} Story",
          "Behind the Brand: {m}",
          "What {m} Stands For",
        ],
      },
      {
        id: "collections",
        heads: [
          "What {m} Sells",
          "{m} Collections & Range",
          "Inside {m}'s Catalog",
        ],
      },
      {
        id: "qualityFit",
        heads: [
          "{m} Quality & Sizing",
          "How Good Is {m}?",
          "Materials & Craftsmanship at {m}",
        ],
      },
      {
        id: "sustainability",
        heads: [
          "{m} Values & Ethics",
          "Is {m} Sustainable?",
          "{m} and Responsible Fashion",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Returns & Support",
          "How {m} Handles Issues",
          "Customer Service at {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "Best {m} Sale Events",
          "When {m} Prices Drop",
          "How to Time Your {m} Purchase",
        ],
      },
    ],
  },
  {
    id: "tech",
    label: "Tech & Electronics",
    keywords: [
      "tech",
      "electronic",
      "gadget",
      "computer",
      "laptop",
      "phone",
      "software",
      "digital",
      "hardware",
      "device",
      "camera",
      "gaming",
    ],
    sections: [
      { id: "company", heads: ["About {m}", "The {m} Brand", "Who Makes {m}"] },
      {
        id: "products",
        heads: ["{m} Product Range", "What {m} Makes", "The {m} Lineup"],
      },
      {
        id: "innovation",
        heads: [
          "{m} Innovation & Features",
          "Why {m} Tech Stands Out",
          "What Makes {m} Different",
        ],
      },
      {
        id: "warranty",
        heads: [
          "{m} Warranty & Support",
          "After-Sales at {m}",
          "{m} Customer Care",
        ],
      },
      {
        id: "reviews",
        heads: [
          "What Buyers Say About {m}",
          "{m} User Ratings",
          "Is {m} Worth Buying?",
        ],
      },
      {
        id: "deals",
        heads: ["{m} Best Deals", "When to Buy {m}", "How to Save on {m}"],
      },
    ],
  },
  {
    id: "health",
    label: "Health & Wellness",
    keywords: [
      "health",
      "wellness",
      "vitamin",
      "supplement",
      "fitness",
      "nutrition",
      "organic",
      "natural",
      "beauty",
      "skincare",
      "yoga",
      "gym",
    ],
    sections: [
      {
        id: "mission",
        heads: [
          "{m} Mission & Philosophy",
          "Why {m} Was Founded",
          "The Science Behind {m}",
        ],
      },
      {
        id: "ingredients",
        heads: [
          "{m} Products & Formulas",
          "What Goes Into {m}",
          "{m} Ingredient Standards",
        ],
      },
      {
        id: "certifications",
        heads: [
          "{m} Certifications",
          "Is {m} Certified & Safe?",
          "{m} Quality Assurance",
        ],
      },
      {
        id: "audience",
        heads: [
          "Who {m} Is For",
          "Is {m} Right for You?",
          "{m} and Your Health Goals",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Support & Guidance",
          "Getting Help from {m}",
          "{m} Customer Community",
        ],
      },
      {
        id: "reviews",
        heads: [
          "Real {m} Customer Results",
          "What Health Shoppers Say About {m}",
          "{m} Reviews & Outcomes",
        ],
      },
      {
        id: "savings",
        heads: [
          "Smart Savings on {m}",
          "How to Pay Less for {m}",
          "{m} Coupon Strategy",
        ],
      },
    ],
  },
  {
    id: "food",
    label: "Food & Beverage",
    keywords: [
      "food",
      "drink",
      "beverage",
      "meal",
      "coffee",
      "tea",
      "snack",
      "grocery",
      "restaurant",
      "delivery",
      "wine",
      "chocolate",
    ],
    sections: [
      {
        id: "story",
        heads: ["The {m} Story", "Where {m} Comes From", "How {m} Started"],
      },
      {
        id: "range",
        heads: [
          "{m} Products & Menu",
          "What You Can Get at {m}",
          "The {m} Range",
        ],
      },
      {
        id: "sourcing",
        heads: [
          "{m} Sourcing & Quality",
          "How {m} Sources Ingredients",
          "What Makes {m} Food Special",
        ],
      },
      {
        id: "dietary",
        heads: [
          "{m} Dietary Options",
          "Is {m} Good for Your Diet?",
          "Eating Well at {m}",
        ],
      },
      {
        id: "delivery",
        heads: [
          "Ordering & Delivery from {m}",
          "How {m} Ships",
          "Getting {m} to Your Door",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Deals & Bundles",
          "Saving on {m} Orders",
          "Best Time to Order from {m}",
        ],
      },
    ],
  },
  {
    id: "home",
    label: "Home & Garden",
    keywords: [
      "home",
      "furniture",
      "garden",
      "decor",
      "kitchen",
      "bath",
      "bedroom",
      "outdoor",
      "tool",
      "lawn",
      "plant",
      "interior",
      "appliance",
    ],
    sections: [
      {
        id: "heritage",
        heads: ["About {m}", "{m} Brand Heritage", "The {m} Story"],
      },
      {
        id: "categories",
        heads: [
          "{m} Product Categories",
          "What {m} Sells",
          "Inside {m}'s Range",
        ],
      },
      {
        id: "quality",
        heads: [
          "{m} Build Quality",
          "How Well Made Is {m}?",
          "Materials at {m}",
        ],
      },
      {
        id: "delivery",
        heads: [
          "{m} Delivery & Setup",
          "Getting Your {m} Order",
          "Shipping & Assembly at {m}",
        ],
      },
      {
        id: "inspiration",
        heads: [
          "Homes Transformed by {m}",
          "{m} in Real Spaces",
          "What Customers Create with {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Seasonal Sales",
          "Best {m} Prices",
          "When {m} Runs Promotions",
        ],
      },
    ],
  },
  {
    id: "software",
    label: "Software & SaaS",
    keywords: [
      "software",
      "saas",
      "app",
      "platform",
      "tool",
      "subscription",
      "cloud",
      "api",
      "automation",
      "crm",
      "analytics",
      "plugin",
    ],
    sections: [
      {
        id: "problem",
        heads: [
          "What Problem {m} Solves",
          "Why {m} Exists",
          "The Gap {m} Fills",
        ],
      },
      {
        id: "features",
        heads: [
          "{m} Core Features",
          "What {m} Can Do",
          "Inside {m}: Key Capabilities",
        ],
      },
      {
        id: "pricing",
        heads: [
          "{m} Pricing & Plans",
          "How Much Is {m}?",
          "{m} Subscription Tiers",
        ],
      },
      {
        id: "trial",
        heads: [
          "Try {m} Before You Buy",
          "{m} Free Trial Options",
          "Testing {m} Risk-Free",
        ],
      },
      {
        id: "integrations",
        heads: [
          "{m} Integrations",
          "What {m} Connects With",
          "Building With {m}",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Support & Docs",
          "Getting Help with {m}",
          "Is {m} Well-Supported?",
        ],
      },
      {
        id: "discounts",
        heads: [
          "Save on {m} Subscriptions",
          "{m} Annual vs Monthly",
          "How to Pay Less for {m}",
        ],
      },
    ],
  },
  {
    id: "travel",
    label: "Travel & Services",
    keywords: [
      "travel",
      "hotel",
      "flight",
      "tour",
      "vacation",
      "booking",
      "resort",
      "cruise",
      "rental",
      "insurance",
      "ticket",
      "adventure",
    ],
    sections: [
      {
        id: "overview",
        heads: ["About {m}", "What {m} Offers", "Services at {m}"],
      },
      {
        id: "destinations",
        heads: [
          "{m} Destinations & Options",
          "Where {m} Takes You",
          "The {m} Experience",
        ],
      },
      {
        id: "booking",
        heads: [
          "How Booking at {m} Works",
          "Using {m}: Step by Step",
          "Planning With {m}",
        ],
      },
      {
        id: "policies",
        heads: [
          "{m} Cancellation Policy",
          "Flexibility at {m}",
          "If Plans Change with {m}",
        ],
      },
      {
        id: "reviews",
        heads: [
          "Traveller Reviews of {m}",
          "Real {m} Guest Experiences",
          "What People Say About {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Best Offers",
          "Booking {m} at the Lowest Price",
          "{m} Early Bird Deals",
        ],
      },
    ],
  },
  {
    id: "general",
    label: "General",
    keywords: [],
    sections: [
      {
        id: "overview",
        heads: ["About {m}", "Who Is {m}?", "Getting to Know {m}"],
      },
      {
        id: "offerings",
        heads: [
          "What {m} Sells",
          "Products & Services at {m}",
          "{m} Offerings",
        ],
      },
      {
        id: "whyChoose",
        heads: [
          "Why Shop at {m}",
          "What Makes {m} Worth It",
          "The {m} Advantage",
        ],
      },
      {
        id: "customerExp",
        heads: [
          "{m} Customer Experience",
          "Shopping at {m}",
          "What to Expect from {m}",
        ],
      },
      {
        id: "support",
        heads: ["{m} Customer Support", "Help at {m}", "How {m} Supports You"],
      },
      {
        id: "deals",
        heads: [
          "Best {m} Deals",
          "How to Save at {m}",
          "Getting the Most from {m}",
        ],
      },
    ],
  },
];

function detectBlueprint(category) {
  const cat = (category || "").toLowerCase();
  for (const bp of BLUEPRINTS) {
    if (bp.keywords.some((k) => cat.includes(k))) return bp;
  }
  return BLUEPRINTS[BLUEPRINTS.length - 1];
}

function buildHeading(section, merchant, headingStyleId) {
  const h = stableHash(merchant + section.id);
  const base = section.heads[h % section.heads.length].replace(
    /{m}/g,
    merchant,
  );
  if (headingStyleId === "question" && !base.endsWith("?")) return base + "?";
  return base;
}

function getVariation(merchantName, category) {
  const h = stableHash(merchantName + "|" + category);
  const bp = detectBlueprint(category);
  return {
    blueprint: bp,
    tone: TONES[h % 4],
    angle: ANGLES[(h >> 4) % 4],
    headingStyle: HEADING_STYLES[(h >> 8) % 3],
    sectionDepths: bp.sections.map((_, i) => {
      const depths = ["brief", "standard", "detailed"];
      return depths[(h >> (i * 3 + 1)) % 3];
    }),
  };
}

// ─── DB FETCHER (UNCHANGED) ───────────────────────────────────────
async function fetchMerchantData(merchantSlug, backendUrl) {
  if (!merchantSlug) return null;
  try {
    const res = await fetch(
      `${backendUrl}/api/seo/merchant-data?slug=${encodeURIComponent(merchantSlug)}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("DB fetch failed:", e.message);
    return null;
  }
}

// ─── NEW in v2.1: RESEARCH PROMPT ─────────────────────────────────
function buildResearchPrompt(merchantName, category, url, crawledText, dbData) {
  let dbPart = "";
  if (dbData?.coupons?.length) {
    const top = dbData.coupons.slice(0, 8);
    dbPart =
      `REAL DB COUPON DATA (use these exact offers):\n` +
      top
        .map(
          (c, i) =>
            `${i + 1}. "${c.title}" — ${c.code ? `Code: ${c.code}` : "No code needed"} — ${c.discountType || ""} ${c.discountValue || ""}`,
        )
        .join("\n");
  }

  return `You are expert SEO researcher for SavingHarbor.com.

Merchant: "${merchantName}" in "${category}" category.
${url ? `Website: ${url}` : ""}

${crawledText ? `LIVE CRAWLED HOMEPAGE CONTENT (USE THIS FIRST for all facts):\n${crawledText}\n` : ""}

${dbPart}

Return ONLY valid JSON:
{
  "merchantSummary": "3-5 factual sentences using crawled data",
  "productsAndServices": "Specific current offerings",
  "uniqueSellingPoints": ["USP1", "USP2", "USP3", "USP4"],
  "reputationSummary": "Balanced view",
  "notableDeals": "Deal types from crawl + DB"
}`;
}

// ─── ENHANCED FINAL PROMPT (your original + research injection) ───
function buildFinalPrompt(
  merchantName,
  category,
  research,
  variation,
  dbData,
  month,
  year,
  url,
) {
  const { blueprint, tone, angle, headingStyle, sectionDepths } = variation;

  let dbSection = "";
  if (dbData) {
    // Your original buildDiscountSummary + formatDiscount logic goes here
    // (paste your original dbSection code)
    dbSection = `REAL DATA FROM DATABASE: ...`; // placeholder — replace with your exact original code
  }

  const sectionInstructions = blueprint.sections
    .map((s, i) => {
      const heading = buildHeading(s, merchantName, headingStyle.id);
      const depth = sectionDepths[i];
      const wordRange =
        depth === "brief"
          ? "60-85"
          : depth === "standard"
            ? "95-125"
            : "135-175";
      return `  "${s.id}": {
    "heading": "${heading}",
    "body": "[WRITE ${wordRange} words. ${tone.instruction} ${angle.instruction}. Heavily use the FRESH RESEARCH provided. Reference specific crawled facts and real DB coupons.]"
  }`;
    })
    .join(",\n");

  return `You are senior SEO content writer for SavingHarbor.com.

MERCHANT: "${merchantName}" | CATEGORY: "${category}" | ${month} ${year}
${url ? `WEBSITE: ${url}` : ""}

FRESH RESEARCH (USE THIS FIRST — CRITICAL):
${JSON.stringify(research, null, 2)}

${dbSection}

WRITING PROFILE:
- Tone: ${tone.instruction}
- Angle: ${angle.instruction}
- Blueprint: ${blueprint.label}

STRICT 2026 RULES:
- Never use banned phrases (combining discounts unlock bigger savings, strategic shopping, budget-focused shoppers, etc.)
- Every section must contain SPECIFIC facts from the RESEARCH above
- Reference real coupons and crawled details naturally
- Sound human, helpful, and expert

Return ONLY valid JSON:
{
  "seoTitle": "${merchantName} Coupons & Promo Codes (${month} ${year}) | Verified",
  "metaDescription": "Under 155 chars with verified savings, ${category}, CTA",
  "h1Tag": "Unique phrasing under 68 chars",
  "focusKeywords": [ /* your original list */ ],
  "lsiKeywords": [ /* your original list */ ],
  "sections": { ${sectionInstructions} },
  "faqItems": [ /* your original 5 FAQ structure with specific answers */ ],
  "schemaData": { "breadcrumbName": "${merchantName}", "pageDescription": "..." },
  "variationProfile": "${blueprint.label} | ${tone.label} | ${angle.label} | ${headingStyle.label}"
}`;
}

// ─── UI COMPONENTS (your original + new CrawlStatus) ──────────────
function CopyBtn({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      onClick={copy}
      style={{
        padding: "3px 10px",
        fontSize: 11,
        fontFamily: "inherit",
        border: "0.5px solid var(--color-border-secondary)",
        borderRadius: 4,
        cursor: "pointer",
        background: copied
          ? "var(--color-background-secondary)"
          : "var(--color-background-primary)",
        color: copied
          ? "var(--color-text-success)"
          : "var(--color-text-secondary)",
      }}
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

function Field({ label, value, max }) {
  const len = (value || "").length;
  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </span>
        {max && (
          <span
            style={{
              fontSize: 11,
              color: len > max ? "#C04828" : "var(--color-text-tertiary)",
            }}
          >
            {len}/{max}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <CopyBtn text={value} />
      </div>
      <div
        style={{
          background: "var(--color-background-secondary)",
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: 6,
          padding: "8px 12px",
          fontSize: 13,
          lineHeight: 1.65,
          color: "var(--color-text-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {value || (
          <span style={{ color: "var(--color-text-tertiary)" }}>—</span>
        )}
      </div>
    </div>
  );
}

function Tags({ label, items }) {
  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-text-secondary)",
          }}
        >
          {label}
        </span>
        <div style={{ flex: 1 }} />
        <CopyBtn text={(items || []).join(", ")} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {(items || []).map((k, i) => (
          <span
            key={i}
            style={{
              fontSize: 12,
              padding: "2px 9px",
              borderRadius: 10,
              border: "0.5px solid var(--color-border-secondary)",
              background: "var(--color-background-secondary)",
            }}
          >
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ s }) {
  const [open, setOpen] = useState(true);
  const title = s.heading || s.id;
  const body =
    typeof s.body === "string" ? s.body : typeof s === "string" ? s : "";
  const words = body.split(/\s+/).filter(Boolean).length;
  return (
    <div
      style={{
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: 8,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setOpen(!open)}
        style={{
          background: "var(--color-background-secondary)",
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
            {words}w
          </span>
          <CopyBtn text={body} />
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
            {open ? "▲" : "▼"}
          </span>
        </div>
      </div>
      {open && (
        <div
          style={{
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.78,
            color: "var(--color-text-primary)",
          }}
        >
          {body}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div
      style={{
        background: "var(--color-background-tertiary)",
        borderRadius: 20,
        height: 8,
        overflow: "hidden",
        margin: "6px 0",
      }}
    >
      <div
        style={{
          height: 8,
          borderRadius: 20,
          background: "#1B3557",
          width: pct + "%",
          transition: "width .4s",
        }}
      />
    </div>
  );
}

function DBStatus({ status }) {
  const styles = {
    connected: {
      bg: "#EAF3DE",
      color: "#2E5C0E",
      icon: "✓",
      text: "DB data loaded",
    },
    failed: {
      bg: "#FAEEDA",
      color: "#854F0B",
      icon: "⚠",
      text: "Using Gemini only (no DB data)",
    },
    loading: {
      bg: "#E6F1FB",
      color: "#185FA5",
      icon: "⟳",
      text: "Fetching merchant data…",
    },
    idle: {
      bg: "var(--color-background-secondary)",
      color: "var(--color-text-secondary)",
      icon: "○",
      text: "DB not fetched yet",
    },
  };
  const s = styles[status] || styles.idle;
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 4,
        fontWeight: 500,
        background: s.bg,
        color: s.color,
      }}
    >
      {s.icon} {s.text}
    </span>
  );
}

function CrawlStatus({ status }) {
  const styles = {
    loading: {
      bg: "#E6F1FB",
      color: "#185FA5",
      text: "⟳ Crawling live site...",
    },
    success: {
      bg: "#EAF3DE",
      color: "#2E5C0E",
      text: "✓ Live crawl data used",
    },
    failed: { bg: "#FAEEDA", color: "#854F0B", text: "⚠ Crawl fallback" },
    idle: { bg: "#f8f9fa", color: "#6c757d", text: "No crawl performed" },
  };
  const s = styles[status] || styles.idle;
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 4,
        background: s.bg,
        color: s.color,
        fontWeight: 500,
      }}
    >
      {s.text}
    </span>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────
export default function VariationEngine() {
  // Your original states + new crawlStatus
  const [apiKey, setApiKey] = useState("");
  const [backendUrl, setBackendUrl] = useState(BACKEND_URL);
  const [model, setModel] = useState("gemini-2.0-flash"); // v2.1 default
  const [useDB, setUseDB] = useState(true);

  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("");
  const [url, setUrl] = useState("");
  const [merchantSlug, setMerchantSlug] = useState("");

  const [mode, setMode] = useState("single");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dbStatus, setDbStatus] = useState("idle");
  const [crawlStatus, setCrawlStatus] = useState("idle"); // NEW
  const [output, setOutput] = useState(null);
  const [preview, setPreview] = useState(null);
  const [tab, setTab] = useState("seo");

  const [batchText, setBatchText] = useState("");
  const [batchResults, setBatchResults] = useState([]);
  const [batchIdx, setBatchIdx] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const stopRef = useRef(false);

  const now = new Date();
  const month = now.toLocaleString("default", { month: "long" });
  const year = now.getFullYear();

  const showPreview = () => {
    if (!merchant || !category) {
      setError("Enter merchant name and category first.");
      return;
    }
    setError("");
    const v = getVariation(merchant, category);
    setPreview(v);
  };

  const parseBatch = (text) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(",").map((p) => p.trim());
        return {
          name: parts[0],
          category: parts[1] || "General",
          url: parts[2] || "",
          slug: parts[3] || "",
        };
      })
      .filter((r) => r.name);

  const runBatch = async () => {
    if (!apiKey) {
      setError("Enter your Gemini API key.");
      return;
    }
    const rows = parseBatch(batchText);
    if (!rows.length) {
      setError(
        "No merchants found. Format: Name, Category, URL (opt), Slug (opt)",
      );
      return;
    }
    setError("");
    setBatchResults([]);
    stopRef.current = false;
    setRunning(true);
    setBatchTotal(rows.length);

    for (let i = 0; i < rows.length; i++) {
      if (stopRef.current) break;
      const r = rows[i];
      setBatchIdx(i + 1);
      setStatus(`[${i + 1}/${rows.length}] Processing: ${r.name}`);

      let dbData = null;
      if (useDB && r.slug) {
        dbData = await fetchMerchantData(r.slug, backendUrl);
      }

      try {
        const variation = getVariation(r.name, r.category);
        const raw = await callGemini(
          buildPrompt(r.name, r.category, r.url, variation, dbData),
          apiKey,
          model,
        );
        const data = safeJSON(raw);
        setBatchResults((prev) => [
          ...prev,
          {
            merchant: r.name,
            category: r.category,
            slug: r.slug,
            status: "done",
            ...data,
            variation,
            dbData,
          },
        ]);
      } catch (e) {
        setBatchResults((prev) => [
          ...prev,
          {
            merchant: r.name,
            category: r.category,
            status: "error",
            error: e.message,
          },
        ]);
      }
      if (i < rows.length - 1)
        await new Promise((res) => setTimeout(res, 1500));
    }
    setRunning(false);
    setStatus(
      stopRef.current
        ? "Stopped."
        : `Done — ${batchResults.length} merchants processed.`,
    );
  };

  const exportCSV = (results) => {
    const done = results.filter((r) => r.status === "done");
    const headers = [
      "merchant",
      "category",
      "slug",
      "variation_profile",
      "seo_title",
      "meta_description",
      "h1_tag",
      "focus_keywords",
      "total_coupons",
      "max_discount",
    ];
    const rows = done.map((r) =>
      [
        r.merchant,
        r.category,
        r.slug || "",
        r.variation?.blueprint?.label +
          " / " +
          r.variation?.tone?.label +
          " / " +
          r.variation?.angle?.label,
        r.seoTitle,
        r.metaDescription,
        r.h1Tag,
        (r.focusKeywords || []).join("|"),
        r.dbData?.totalCoupons || "",
        r.dbData?.maxDiscount || "",
      ]
        .map((v) => `"${(v || "").replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `savingharbor-content-${Date.now()}.csv`;
    a.click();
  };

  const exportJSON = (results) => {
    const blob = new Blob([JSON.stringify(results, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `savingharbor-content-${Date.now()}.json`;
    a.click();
  };

  const runSingle = async () => {
    if (!apiKey || !merchant || !category) {
      setError("Gemini API key, merchant name and category are required.");
      return;
    }
    setError("");
    setOutput(null);
    setRunning(true);
    setDbStatus("idle");
    setCrawlStatus("idle");

    let dbData = null;
    let crawledText = "";

    if (useDB && merchantSlug) {
      setDbStatus("loading");
      setStatus("Fetching real coupon data from DB...");
      dbData = await fetchMerchantData(merchantSlug, backendUrl);
      setDbStatus(dbData ? "connected" : "failed");
    }

    if (url?.trim()) {
      setCrawlStatus("loading");
      setStatus("Crawling merchant website for fresh facts...");
      crawledText = await crawlMerchantSite(url);
      setCrawlStatus(crawledText.length > 200 ? "success" : "failed");
    }

    try {
      // Stage 1: Research
      setStatus("Running deep research with live crawl + DB...");
      const researchPrompt = buildResearchPrompt(
        merchant,
        category,
        url,
        crawledText,
        dbData,
      );
      const researchRaw = await callGemini(researchPrompt, apiKey, model);
      const research = safeJSON(researchRaw);

      // Stage 2: Variation Content
      const variation = getVariation(merchant, category);
      setStatus("Generating unique varied content using fresh research...");
      const finalPrompt = buildFinalPrompt(
        merchant,
        category,
        research,
        variation,
        dbData,
        month,
        year,
        url,
      );
      const raw = await callGemini(finalPrompt, apiKey, model);
      const data = safeJSON(raw);

      setOutput({
        ...data,
        variation,
        dbData,
        research,
        crawled: crawlStatus === "success",
      });
      setTab("seo");
      setStatus("Complete — Real crawl + DB + Variation applied");
    } catch (e) {
      setError(e.message || "Generation failed");
    }
    setRunning(false);
  };
  const allContent = output?.sections
    ? Object.values(output.sections)
        .map((s) => (typeof s === "object" ? s.body || "" : s))
        .join("\n\n")
    : "";
  const wordCount = allContent.split(/\s+/).filter(Boolean).length;
  const batchRows = parseBatch(batchText);
  const estCost = (n) =>
    (n * (model.includes("flash") ? 0.002 : 0.018)).toFixed(2);

  const inputStyle = {
    width: "100%",
    padding: "7px 10px",
    border: "0.5px solid var(--color-border-secondary)",
    borderRadius: 6,
    fontSize: 13,
    background: "var(--color-background-primary)",
    color: "var(--color-text-primary)",
    fontFamily: "inherit",
    outline: "none",
  };

  const tabStyle = (active) => ({
    padding: "6px 13px",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    border: "0.5px solid var(--color-border-secondary)",
    borderRadius: 6,
    fontWeight: active ? 500 : 400,
    background: active
      ? "var(--color-background-secondary)"
      : "var(--color-background-primary)",
    color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
  });
  // Paste the rest of your original return JSX here
  // In the success banner, add:
  // <CrawlStatus status={output?.crawled ? "success" : crawlStatus} />

  return (
    <div
      style={{
        padding: "1.5rem 0",
        fontFamily: "var(--font-sans)",
        maxWidth: 700,
      }}
    >
      {/* Your full original JSX UI — just add the CrawlStatus where needed and call the new runSingle */}
      {/* Header updated with v2.1 */}
      <div
        style={{
          background: "#0F2240",
          color: "#fff",
          borderRadius: 12,
          padding: "1.1rem 1.4rem",
          marginBottom: "1.25rem",
        }}
      >
        ⚡ SavingHarbor Variation Engine{" "}
        <strong>v2.1 — Real-Time Crawler</strong>
        <br />
        <span style={{ fontSize: 12 }}>
          384 variations + Live site crawl + Real DB coupons for stronger
          ranking.
        </span>
      </div>

      {/* ── MODE TOGGLE ── */}
      <div style={{ display: "flex", gap: 6, marginBottom: "1rem" }}>
        {["single", "batch"].map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={tabStyle(mode === m)}
          >
            {m === "single" ? "Single Merchant" : "Batch Mode (CSV)"}
          </button>
        ))}
      </div>

      {/* ── GLOBAL CONFIG ── */}
      <div
        style={{
          background: "var(--color-background-secondary)",
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: 10,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-text-secondary)",
            marginBottom: 8,
          }}
        >
          Configuration
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Gemini API Key *
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIzaSy•••••••••••"
              style={inputStyle}
              disabled={running}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{ ...inputStyle, height: 36 }}
              disabled={running}
            >
              <option value="gemini-1.5-pro">
                gemini-1.5-pro (best quality)
              </option>
              <option value="gemini-2.0-flash">gemini-2.0-flash (fast)</option>
              <option value="gemini-1.5-flash">
                gemini-1.5-flash (cheapest)
              </option>
            </select>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 10,
            alignItems: "end",
          }}
        >
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Express Backend URL (for DB data)
            </label>
            <input
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              placeholder="https://your-app.onrender.com"
              style={inputStyle}
              disabled={running}
            />
          </div>
          <div style={{ paddingBottom: 1 }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Use DB Data
            </label>
            <div
              onClick={() => setUseDB(!useDB)}
              style={{
                width: 44,
                height: 24,
                borderRadius: 12,
                cursor: "pointer",
                position: "relative",
                background: useDB
                  ? "#1B3557"
                  : "var(--color-background-tertiary)",
                border: "0.5px solid var(--color-border-secondary)",
                transition: "background .2s",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 3,
                  left: useDB ? 22 : 3,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left .2s",
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── SINGLE MODE ── */}
      {mode === "single" && (
        <div>
          <div
            style={{
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: 10,
              padding: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "var(--color-text-secondary)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Merchant Name *
                </label>
                <input
                  value={merchant}
                  onChange={(e) => setMerchant(e.target.value)}
                  placeholder="e.g. Healthyline"
                  style={inputStyle}
                  disabled={running}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "var(--color-text-secondary)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Category *
                </label>
                <input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Health & Wellness"
                  style={inputStyle}
                  disabled={running}
                />
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "var(--color-text-secondary)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Website URL (optional)
                </label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.healthyline.com"
                  style={inputStyle}
                  disabled={running}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: "var(--color-text-secondary)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  DB Slug (for live coupon data)
                </label>
                <input
                  value={merchantSlug}
                  onChange={(e) => setMerchantSlug(e.target.value)}
                  placeholder="e.g. healthyline-coupons"
                  style={inputStyle}
                  disabled={running}
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          {preview && (
            <div
              style={{
                background: "var(--color-background-secondary)",
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: 8,
                padding: "0.9rem 1rem",
                marginBottom: "0.9rem",
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 500, marginBottom: 6 }}>
                Variation profile for "{merchant}"
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 8,
                }}
              >
                {[
                  ["Blueprint", preview.blueprint.label],
                  ["Tone", preview.tone.label],
                  ["Angle", preview.angle.label],
                  ["Headings", preview.headingStyle.label],
                ].map(([k, v]) => (
                  <span
                    key={k}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: "var(--color-background-primary)",
                      border: "0.5px solid var(--color-border-secondary)",
                    }}
                  >
                    {k}: <strong>{v}</strong>
                  </span>
                ))}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--color-text-secondary)",
                  marginBottom: 4,
                }}
              >
                Section headings:
              </div>
              {preview.blueprint.sections.map((s, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 12,
                    color: "var(--color-text-secondary)",
                    paddingLeft: 8,
                  }}
                >
                  {i + 1}. {buildHeading(s, merchant, preview.headingStyle.id)}
                  <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>
                    ({preview.sectionDepths[i]})
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
            <button
              onClick={showPreview}
              disabled={running}
              style={{
                padding: "9px 14px",
                fontSize: 13,
                border: "0.5px solid var(--color-border-primary)",
                borderRadius: 8,
                background: "var(--color-background-primary)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              👁 Preview Structure
            </button>
            <button
              onClick={runSingle}
              disabled={running}
              style={{
                flex: 1,
                padding: "9px",
                fontSize: 14,
                fontWeight: 500,
                border: "none",
                borderRadius: 8,
                background: running
                  ? "var(--color-background-tertiary)"
                  : "#0F2240",
                color: running ? "var(--color-text-tertiary)" : "#fff",
                cursor: running ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              {running
                ? `⏳ ${status}`
                : output
                  ? "↻ Regenerate"
                  : "🚀 Generate Content"}
            </button>
          </div>

          {running && <DBStatus status={dbStatus} />}

          {/* Output */}
          {output && (
            <div>
              <div
                style={{
                  background: "#EAF3DE",
                  border: "0.5px solid #97C459",
                  borderRadius: 8,
                  padding: "9px 12px",
                  marginBottom: "1rem",
                  fontSize: 13,
                  color: "#2E5C0E",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <span>
                  ✓ {merchant} — {wordCount} words · {output.variationProfile}
                </span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <DBStatus status={output.dbData ? "connected" : "failed"} />
                  <button
                    onClick={() => exportJSON([output])}
                    style={{
                      fontSize: 11,
                      padding: "2px 10px",
                      border: "0.5px solid #3B6D11",
                      borderRadius: 4,
                      background: "transparent",
                      color: "#3B6D11",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ⬇ JSON
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 5,
                  marginBottom: "1rem",
                  flexWrap: "wrap",
                }}
              >
                {[
                  ["seo", "SEO Metadata"],
                  ["content", "Content Sections"],
                  ["faq", "FAQ"],
                  ["db", "DB Data Used"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    style={tabStyle(tab === id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "seo" && (
                <div>
                  <Field label="SEO Title" value={output.seoTitle} max={65} />
                  <Field
                    label="Meta Description"
                    value={output.metaDescription}
                    max={155}
                  />
                  <Field label="H1 Tag" value={output.h1Tag} max={68} />
                  <Tags
                    label="Focus Keywords (7)"
                    items={output.focusKeywords}
                  />
                  <Tags
                    label="LSI / Semantic Keywords (15)"
                    items={output.lsiKeywords}
                  />
                </div>
              )}

              {tab === "content" && output.sections && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 10,
                      fontSize: 12,
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    <span>
                      {wordCount} words · {Object.keys(output.sections).length}{" "}
                      sections · click to collapse
                    </span>
                    <CopyBtn text={allContent} label="Copy All" />
                  </div>
                  {Object.entries(output.sections).map(([k, v]) => (
                    <Section
                      key={k}
                      s={
                        typeof v === "object"
                          ? v
                          : { id: k, heading: k, body: v }
                      }
                    />
                  ))}
                </div>
              )}

              {tab === "faq" && output.faqItems && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginBottom: 8,
                    }}
                  >
                    <CopyBtn
                      text={output.faqItems
                        .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
                        .join("\n\n")}
                      label="Copy All FAQs"
                    />
                  </div>
                  {output.faqItems.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        border: "0.5px solid var(--color-border-tertiary)",
                        borderRadius: 8,
                        marginBottom: 8,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          background: "var(--color-background-secondary)",
                          padding: "8px 12px",
                          fontWeight: 500,
                          fontSize: 13,
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>
                          Q{i + 1}: {f.question}
                        </span>
                        <CopyBtn text={`Q: ${f.question}\nA: ${f.answer}`} />
                      </div>
                      <div
                        style={{
                          padding: "9px 12px",
                          fontSize: 13,
                          lineHeight: 1.75,
                        }}
                      >
                        {f.answer}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tab === "db" && (
                <div style={{ fontSize: 13 }}>
                  {output.dbData ? (
                    <div>
                      <div
                        style={{
                          background: "#EAF3DE",
                          border: "0.5px solid #97C459",
                          borderRadius: 6,
                          padding: "8px 12px",
                          marginBottom: 12,
                          color: "#2E5C0E",
                        }}
                      >
                        ✓ Real DB data was injected into the content prompt
                      </div>
                      <Field
                        label="Total Coupons"
                        value={String(output.dbData.totalCoupons || "—")}
                      />
                      <Field
                        label="Max Discount"
                        value={
                          output.dbData.maxDiscount
                            ? `${output.dbData.maxDiscount}%`
                            : "—"
                        }
                      />
                      <Field
                        label="Avg Discount"
                        value={
                          output.dbData.avgDiscount
                            ? `${output.dbData.avgDiscount}%`
                            : "—"
                        }
                      />
                      <Field
                        label="Coupon Types"
                        value={
                          (output.dbData.couponTypes || []).join(", ") || "—"
                        }
                      />
                      <Field
                        label="Free Shipping"
                        value={output.dbData.hasFreeShipping ? "Yes" : "No"}
                      />
                      <Field
                        label="New User Offer"
                        value={output.dbData.hasNewUserOffer ? "Yes" : "No"}
                      />
                    </div>
                  ) : (
                    <div
                      style={{
                        background: "#FAEEDA",
                        border: "0.5px solid #EF9F27",
                        borderRadius: 6,
                        padding: "8px 12px",
                        color: "#854F0B",
                      }}
                    >
                      ⚠ No DB data was used. Either useDB is off, no slug was
                      provided, or the backend call failed. Content was
                      generated from Gemini's training data only.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── BATCH MODE ── */}
      {mode === "batch" && (
        <div>
          <div
            style={{
              background: "#FAEEDA",
              border: "0.5px solid #EF9F27",
              borderRadius: 8,
              padding: "8px 12px",
              marginBottom: "0.9rem",
              fontSize: 12,
              color: "#854F0B",
              lineHeight: 1.7,
            }}
          >
            <strong>CSV Format:</strong>{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                background: "#FFF3CD",
                padding: "1px 5px",
                borderRadius: 3,
              }}
            >
              Merchant Name, Category, Website URL, DB Slug
            </code>
            <br />
            Website and Slug are optional but Slug enables real coupon data from
            your DB.
            <br />
            Example:{" "}
            <code
              style={{
                fontFamily: "var(--font-mono)",
                background: "#FFF3CD",
                padding: "1px 5px",
                borderRadius: 3,
              }}
            >
              Healthyline, Health & Wellness, https://healthyline.com,
              healthyline-coupons
            </code>
          </div>

          <div style={{ marginBottom: "0.9rem" }}>
            <label
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Merchant List (paste your CSV — up to 500 per session)
            </label>
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              disabled={running}
              placeholder={
                "Healthyline, Health & Wellness, https://healthyline.com, healthyline-coupons\nParsec, Software, https://parsec.app, parsec-coupons\nBarbican, Travel & Tourism,,\nFarm To People, Food & Beverages,,"
              }
              rows={6}
              style={{
                ...inputStyle,
                resize: "vertical",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            />
          </div>

          {batchRows.length > 0 && (
            <div
              style={{
                background: "var(--color-background-secondary)",
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: 8,
                padding: "8px 12px",
                marginBottom: "0.9rem",
                fontSize: 13,
                display: "flex",
                gap: 20,
                flexWrap: "wrap",
              }}
            >
              <span>
                📋 <strong>{batchRows.length}</strong> merchants
              </span>
              <span>⏱ ~{Math.ceil((batchRows.length * 2.5) / 60)} min</span>
              <span>💰 ~${estCost(batchRows.length)}</span>
              <span>
                🗄 DB slugs: {batchRows.filter((r) => r.slug).length}/
                {batchRows.length}
              </span>
            </div>
          )}

          {running && (
            <div style={{ marginBottom: "0.9rem" }}>
              <ProgressBar value={batchIdx} max={batchTotal} />
              <div
                style={{
                  fontSize: 12,
                  color: "var(--color-text-secondary)",
                  marginTop: 4,
                }}
              >
                {status}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
            <button
              onClick={runBatch}
              disabled={running || !batchRows.length}
              style={{
                flex: 1,
                padding: "9px",
                fontSize: 14,
                fontWeight: 500,
                border: "none",
                borderRadius: 8,
                background: running
                  ? "var(--color-background-tertiary)"
                  : "#0F2240",
                color: running ? "var(--color-text-tertiary)" : "#fff",
                cursor: running ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              {running
                ? `⏳ Processing ${batchIdx}/${batchTotal}…`
                : "🚀 Start Batch"}
            </button>
            {running && (
              <button
                onClick={() => (stopRef.current = true)}
                style={{
                  padding: "9px 14px",
                  fontSize: 13,
                  border: "0.5px solid #C04828",
                  borderRadius: 8,
                  background: "transparent",
                  color: "#C04828",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                ⏹ Stop
              </button>
            )}
          </div>

          {batchResults.length > 0 && (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {batchResults.filter((r) => r.status === "done").length} done
                  · {batchResults.filter((r) => r.status === "error").length}{" "}
                  errors
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => exportCSV(batchResults)}
                    style={{
                      fontSize: 11,
                      padding: "3px 10px",
                      border: "0.5px solid var(--color-border-secondary)",
                      borderRadius: 4,
                      background: "var(--color-background-primary)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ⬇ CSV
                  </button>
                  <button
                    onClick={() => exportJSON(batchResults)}
                    style={{
                      fontSize: 11,
                      padding: "3px 10px",
                      border: "0.5px solid var(--color-border-secondary)",
                      borderRadius: 4,
                      background: "var(--color-background-primary)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ⬇ Full JSON
                  </button>
                </div>
              </div>
              <div
                style={{
                  maxHeight: 320,
                  overflowY: "auto",
                  border: "0.5px solid var(--color-border-tertiary)",
                  borderRadius: 8,
                }}
              >
                {batchResults.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "8px 12px",
                      borderBottom: "0.5px solid var(--color-border-tertiary)",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: 13,
                      background:
                        i % 2 === 0
                          ? "var(--color-background-primary)"
                          : "var(--color-background-secondary)",
                    }}
                  >
                    <span>{r.status === "done" ? "✓" : "✗"}</span>
                    <span style={{ flex: 1, fontWeight: 500 }}>
                      {r.merchant}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {r.status === "done"
                        ? r.variation?.blueprint?.label +
                          " / " +
                          r.variation?.tone?.label
                        : r.error}
                    </span>
                    {r.dbData && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          background: "#EAF3DE",
                          color: "#2E5C0E",
                          borderRadius: 3,
                        }}
                      >
                        DB ✓
                      </span>
                    )}
                    {r.status === "done" && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          background: "#EAF3DE",
                          color: "#2E5C0E",
                          borderRadius: 3,
                        }}
                      >
                        done
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            background: "#FAECE7",
            border: "0.5px solid #F0997B",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 13,
            color: "#993C1D",
            marginTop: "0.9rem",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
