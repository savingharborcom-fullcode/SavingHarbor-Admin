/**
 * SavingHarbor — Content Architecture Variation Engine v2.3
 * Changes from v2.2:
 * - Multi-key round-robin for batch — up to 10 Gemini keys, one key per store
 * - Key rotation UI in config panel
 * - Per-key usage counter displayed live during batch
 * - On 429, auto-rotates to next available key and retries once
 */

import { useState, useRef } from "react";

const BACKEND_URL = "https://admin-api.savingharbor.com";

// ─── CRAWL ────────────────────────────────────────────────────────
const crawlMerchantSite = async (url, backendUrl) => {
  if (!url?.trim()) return "";
  try {
    const res = await fetch(
      `${backendUrl}/api/seo/crawl?url=${encodeURIComponent(url.trim())}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) throw new Error(`Crawl proxy ${res.status}`);
    const data = await res.json();
    return data.text || "";
  } catch (err) {
    console.warn("Crawl failed:", err.message);
    return `CRAWL FAILED for ${url}`;
  }
};

// ─── GEMINI ───────────────────────────────────────────────────────
async function callGemini(prompt, apiKey, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.82, maxOutputTokens: 8192 },
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
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(clean.replace(/,(\s*[}\]])/g, "$1"));
}

// ─── DISCOUNT SUMMARY (built from scratch) ────────────────────────
function formatDiscount(c) {
  if (!c) return null;
  if (c.discountType === "percent" && c.value) return `${c.value}% off`;
  if (c.discountType === "flat" && c.value) return `${c.currency || "$"}${c.value} off`;
  return c.title || null;
}

function buildDiscountSummary(dbData) {
  if (!dbData) return null;

  const {
    totalCoupons = 0,
    totalDeals = 0,
    maxDiscount,
    avgDiscount,
    couponTypes = [],
    hasFreeShipping,
    hasNewUserOffer,
    coupons = [],
    name,
  } = dbData;

  // Top offers — pick up to 4 most meaningful
  const topOffers = coupons
    .slice(0, 4)
    .map(formatDiscount)
    .filter(Boolean);

  const lines = [];
  if (maxDiscount) lines.push(`Top discount: ${maxDiscount}% off`);
  if (avgDiscount) lines.push(`Average saving: ${avgDiscount}% off`);
  if (totalCoupons) lines.push(`Active coupons: ${totalCoupons}`);
  if (totalDeals) lines.push(`Deals (no code): ${totalDeals}`);
  if (hasFreeShipping) lines.push("Free shipping offer available");
  if (hasNewUserOffer) lines.push("New customer / first order offer available");
  if (couponTypes.length) lines.push(`Offer types: ${couponTypes.join(", ")}`);
  if (topOffers.length) lines.push(`Top offers: ${topOffers.join(" | ")}`);

  return {
    summary: lines.join("\n"),
    maxDiscount,
    avgDiscount,
    totalCoupons,
    totalDeals,
    hasFreeShipping,
    hasNewUserOffer,
    topOffers,
    couponTypes,
    name,
  };
}

// ─── VARIATION ENGINE (unchanged logic) ───────────────────────────
function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const TONES = [
  { id: "authoritative", label: "Authoritative Expert", instruction: "Write with confident domain expertise. Use specific facts and figures. Tone: a knowledgeable professional briefing a peer. No hedging." },
  { id: "conversational", label: "Conversational Friend", instruction: "Write like a savvy friend who genuinely knows this brand. Warm, direct, naturally uses 'you'. No jargon. Real talk, not marketing copy." },
  { id: "review", label: "Critical Reviewer", instruction: "Write like an independent reviewer who has studied this brand. Analytical, balanced — genuine strengths and honest caveats. Evidence-driven." },
  { id: "guide", label: "Shopper's Guide", instruction: "Write as a practical buying guide. Structured, actionable, focused on value signals and red flags." },
];

const ANGLES = [
  { id: "value", label: "Value & Savings", instruction: "Emphasise total value proposition — quality-to-price ratio, long-term savings, smart spending." },
  { id: "quality", label: "Quality & Trust", instruction: "Emphasise brand credibility, product quality, reliability, certifications, and track record." },
  { id: "community", label: "Community & Social Proof", instruction: "Emphasise customer experiences, community trust, real-world results, and collective wisdom." },
  { id: "discovery", label: "Discovery & Exploration", instruction: "Emphasise breadth of range, lesser-known gems, unique finds, and category exploration." },
];

const HEADING_STYLES = [
  { id: "declarative", label: "Declarative" },
  { id: "question", label: "Question" },
  { id: "benefit", label: "Benefit-Led" },
];

const BLUEPRINTS = [
  {
    id: "fashion", label: "Fashion & Apparel",
    keywords: ["cloth","fashion","apparel","shoes","bag","jewel","wear","style","dress","shirt"],
    sections: [
      { id: "brandStory", heads: ["The {m} Story","Behind the Brand: {m}","What {m} Stands For"] },
      { id: "collections", heads: ["What {m} Sells","{m} Collections & Range","Inside {m}'s Catalog"] },
      { id: "qualityFit", heads: ["{m} Quality & Sizing","How Good Is {m}?","Materials & Craftsmanship at {m}"] },
      { id: "sustainability", heads: ["{m} Values & Ethics","Is {m} Sustainable?","{m} and Responsible Fashion"] },
      { id: "support", heads: ["{m} Returns & Support","How {m} Handles Issues","Customer Service at {m}"] },
      { id: "deals", heads: ["Best {m} Sale Events","When {m} Prices Drop","How to Time Your {m} Purchase"] },
    ],
  },
  {
    id: "tech", label: "Tech & Electronics",
    keywords: ["tech","electronic","gadget","computer","laptop","phone","software","digital","hardware","device","camera","gaming"],
    sections: [
      { id: "company", heads: ["About {m}","The {m} Brand","Who Makes {m}"] },
      { id: "products", heads: ["{m} Product Range","What {m} Makes","The {m} Lineup"] },
      { id: "innovation", heads: ["{m} Innovation & Features","Why {m} Tech Stands Out","What Makes {m} Different"] },
      { id: "warranty", heads: ["{m} Warranty & Support","After-Sales at {m}","{m} Customer Care"] },
      { id: "reviews", heads: ["What Buyers Say About {m}","{m} User Ratings","Is {m} Worth Buying?"] },
      { id: "deals", heads: ["{m} Best Deals","When to Buy {m}","How to Save on {m}"] },
    ],
  },
  {
    id: "health", label: "Health & Wellness",
    keywords: ["health","wellness","vitamin","supplement","fitness","nutrition","organic","natural","beauty","skincare","yoga","gym"],
    sections: [
      { id: "mission", heads: ["{m} Mission & Philosophy","Why {m} Was Founded","The Science Behind {m}"] },
      { id: "ingredients", heads: ["{m} Products & Formulas","What Goes Into {m}","{m} Ingredient Standards"] },
      { id: "certifications", heads: ["{m} Certifications","Is {m} Certified & Safe?","{m} Quality Assurance"] },
      { id: "audience", heads: ["Who {m} Is For","Is {m} Right for You?","{m} and Your Health Goals"] },
      { id: "support", heads: ["{m} Support & Guidance","Getting Help from {m}","{m} Customer Community"] },
      { id: "reviews", heads: ["Real {m} Customer Results","What Health Shoppers Say About {m}","{m} Reviews & Outcomes"] },
      { id: "savings", heads: ["Smart Savings on {m}","How to Pay Less for {m}","{m} Coupon Strategy"] },
    ],
  },
  {
    id: "food", label: "Food & Beverage",
    keywords: ["food","drink","beverage","meal","coffee","tea","snack","grocery","restaurant","delivery","wine","chocolate"],
    sections: [
      { id: "story", heads: ["The {m} Story","Where {m} Comes From","How {m} Started"] },
      { id: "range", heads: ["{m} Products & Menu","What You Can Get at {m}","The {m} Range"] },
      { id: "sourcing", heads: ["{m} Sourcing & Quality","How {m} Sources Ingredients","What Makes {m} Food Special"] },
      { id: "dietary", heads: ["{m} Dietary Options","Is {m} Good for Your Diet?","Eating Well at {m}"] },
      { id: "delivery", heads: ["Ordering & Delivery from {m}","How {m} Ships","Getting {m} to Your Door"] },
      { id: "deals", heads: ["{m} Deals & Bundles","Saving on {m} Orders","Best Time to Order from {m}"] },
    ],
  },
  {
    id: "home", label: "Home & Garden",
    keywords: ["home","furniture","garden","decor","kitchen","bath","bedroom","outdoor","tool","lawn","plant","interior","appliance"],
    sections: [
      { id: "heritage", heads: ["About {m}","{m} Brand Heritage","The {m} Story"] },
      { id: "categories", heads: ["{m} Product Categories","What {m} Sells","Inside {m}'s Range"] },
      { id: "quality", heads: ["{m} Build Quality","How Well Made Is {m}?","Materials at {m}"] },
      { id: "delivery", heads: ["{m} Delivery & Setup","Getting Your {m} Order","Shipping & Assembly at {m}"] },
      { id: "inspiration", heads: ["Homes Transformed by {m}","{m} in Real Spaces","What Customers Create with {m}"] },
      { id: "deals", heads: ["{m} Seasonal Sales","Best {m} Prices","When {m} Runs Promotions"] },
    ],
  },
  {
    id: "software", label: "Software & SaaS",
    keywords: ["software","saas","app","platform","tool","subscription","cloud","api","automation","crm","analytics","plugin"],
    sections: [
      { id: "problem", heads: ["What Problem {m} Solves","Why {m} Exists","The Gap {m} Fills"] },
      { id: "features", heads: ["{m} Core Features","What {m} Can Do","Inside {m}: Key Capabilities"] },
      { id: "pricing", heads: ["{m} Pricing & Plans","How Much Is {m}?","{m} Subscription Tiers"] },
      { id: "trial", heads: ["Try {m} Before You Buy","{m} Free Trial Options","Testing {m} Risk-Free"] },
      { id: "integrations", heads: ["{m} Integrations","What {m} Connects With","Building With {m}"] },
      { id: "support", heads: ["{m} Support & Docs","Getting Help with {m}","Is {m} Well-Supported?"] },
      { id: "discounts", heads: ["Save on {m} Subscriptions","{m} Annual vs Monthly","How to Pay Less for {m}"] },
    ],
  },
  {
    id: "travel", label: "Travel & Services",
    keywords: ["travel","hotel","flight","tour","vacation","booking","resort","cruise","rental","insurance","ticket","adventure"],
    sections: [
      { id: "overview", heads: ["About {m}","What {m} Offers","Services at {m}"] },
      { id: "destinations", heads: ["{m} Destinations & Options","Where {m} Takes You","The {m} Experience"] },
      { id: "booking", heads: ["How Booking at {m} Works","Using {m}: Step by Step","Planning With {m}"] },
      { id: "policies", heads: ["{m} Cancellation Policy","Flexibility at {m}","If Plans Change with {m}"] },
      { id: "reviews", heads: ["Traveller Reviews of {m}","Real {m} Guest Experiences","What People Say About {m}"] },
      { id: "deals", heads: ["{m} Best Offers","Booking {m} at the Lowest Price","{m} Early Bird Deals"] },
    ],
  },
  {
    id: "general", label: "General",
    keywords: [],
    sections: [
      { id: "overview", heads: ["About {m}","Who Is {m}?","Getting to Know {m}"] },
      { id: "offerings", heads: ["What {m} Sells","Products & Services at {m}","{m} Offerings"] },
      { id: "whyChoose", heads: ["Why Shop at {m}","What Makes {m} Worth It","The {m} Advantage"] },
      { id: "customerExp", heads: ["{m} Customer Experience","Shopping at {m}","What to Expect from {m}"] },
      { id: "support", heads: ["{m} Customer Support","Help at {m}","How {m} Supports You"] },
      { id: "deals", heads: ["Best {m} Deals","How to Save at {m}","Getting the Most from {m}"] },
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
  const base = section.heads[h % section.heads.length].replace(/{m}/g, merchant);
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

// ─── DB FETCH ─────────────────────────────────────────────────────
async function fetchMerchantData(merchantSlug, backendUrl) {
  if (!merchantSlug) return null;
  try {
    const res = await fetch(
      `${backendUrl}/api/seo/merchant-data?slug=${encodeURIComponent(merchantSlug)}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("DB fetch failed:", e.message);
    return null;
  }
}

// ─── PENDING MERCHANTS ───────────────────────────────────────────
async function fetchPendingMerchants(backendUrl) {
  try {
    const res = await fetch(`${backendUrl}/api/seo/pending-merchants`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("Pending fetch failed:", e.message);
    return null;
  }
}

// ─── DB SAVE ──────────────────────────────────────────────────────
async function saveContentToDB(slug, content, backendUrl) {
  if (!slug) return { skipped: true, reason: "no slug" };
  try {
    const res = await fetch(`${backendUrl}/api/seo/merchant-content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, content }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Save failed ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    console.warn("Content save failed:", e.message);
    return { error: e.message };
  }
}

// ─── RESEARCH PROMPT ──────────────────────────────────────────────
function buildResearchPrompt(merchantName, category, url, crawledText, dbData) {
  const ds = buildDiscountSummary(dbData);
  const dbPart = ds
    ? `REAL DB COUPON DATA:\n${ds.summary}\n\nTop individual offers:\n${ds.topOffers.map((o, i) => `${i + 1}. ${o}`).join("\n")}`
    : "";

  return `You are an expert SEO researcher for SavingHarbor.com.

Merchant: "${merchantName}" | Category: "${category}"
${url ? `Website: ${url}` : ""}

${crawledText ? `LIVE CRAWLED HOMEPAGE (primary source for all facts):\n${crawledText}\n` : ""}
${dbPart ? `\n${dbPart}\n` : ""}

Return ONLY valid JSON — no preamble, no markdown fences:
{
  "merchantSummary": "3-5 factual sentences drawn directly from crawled content",
  "productsAndServices": "Specific current product lines and services, named where possible",
  "uniqueSellingPoints": ["specific USP from crawl/DB", "specific USP", "specific USP", "specific USP"],
  "reputationSummary": "Balanced, evidence-based view from crawled content",
  "notableDeals": "Specific deal types referencing actual DB coupon data"
}`;
}

// ─── FINAL CONTENT PROMPT (all 5 fixes applied) ───────────────────
function buildFinalPrompt(merchantName, category, research, variation, dbData, url) {
  const { blueprint, tone, angle, headingStyle, sectionDepths } = variation;
  const ds = buildDiscountSummary(dbData);

  // DB facts block — concrete numbers force unique, non-templated output
  const dbFacts = ds ? `
LIVE STORE STATS (mandatory — weave these into content naturally):
- Store: ${ds.name || merchantName}
- Active coupons: ${ds.totalCoupons}
- Deals (no code needed): ${ds.totalDeals}
- Top percentage discount: ${ds.maxDiscount ? `${ds.maxDiscount}%` : "not available"}
- Average saving: ${ds.avgDiscount ? `${ds.avgDiscount}%` : "not available"}
- Free shipping available: ${ds.hasFreeShipping ? "yes" : "no"}
- New customer offer: ${ds.hasNewUserOffer ? "yes" : "no"}
- Offer types in DB: ${ds.couponTypes.join(", ") || "various"}
- Individual top offers: ${ds.topOffers.join(" | ") || "see site"}
` : `\nNO DB DATA: Use research facts only. Do not invent discount figures.\n`;

  const sectionInstructions = blueprint.sections
    .map((s, i) => {
      const heading = buildHeading(s, merchantName, headingStyle.id);
      const depth = sectionDepths[i];
      const wordRange = depth === "brief" ? "65-90" : depth === "standard" ? "100-130" : "140-180";
      return `  "${s.id}": {
    "heading": "${heading}",
    "body": "WRITE ${wordRange} words. Apply tone: ${tone.instruction} Apply angle: ${angle.instruction} MANDATORY: Reference at least one specific fact from RESEARCH or DB STATS above. LSI keywords must appear naturally in this section — never clumped, never forced."
  }`;
    })
    .join(",\n");

  return `You are a senior SEO content writer for SavingHarbor.com.

MERCHANT: "${merchantName}" | CATEGORY: "${category}"
${url ? `WEBSITE: ${url}` : ""}

═══ FRESH RESEARCH (use this — do not invent) ═══
${JSON.stringify(research, null, 2)}

${dbFacts}

═══ WRITING RULES — ALL ARE MANDATORY ═══
TONE: ${tone.label} — ${tone.instruction}
ANGLE: ${angle.label} — ${angle.instruction}
BLUEPRINT: ${blueprint.label}

SEO TITLE RULES:
- Must include the store name + primary keyword (e.g. "coupons", "promo codes", "discount codes")
- If DB has a max discount, lead with it: e.g. "Up to 45% Off ${merchantName} Coupons & Promo Codes"
- NO month, NO year, NO date of any kind
- Under 65 characters
- Must sound like a human wrote it, not a template

META DESCRIPTION RULES:
- 140-155 characters
- Must reference the specific category (${category}), a concrete saving figure from DB if available, and end with a soft CTA
- Include at least 2 focus keywords naturally — not stuffed
- No AI filler phrases ("discover", "explore", "unlock", "best deals await")
- Must read like a human wrote it for a real shopper

H1 RULES:
- Completely different phrasing from the SEO title
- Must be unique to THIS store — reference something specific about ${merchantName} from the research
- Under 68 characters
- NO month, NO year

LSI/SEMANTIC KEYWORD INJECTION RULES:
- You will be given 15 LSI keywords in your output
- Every section body MUST contain 1-3 of these LSI keywords used in natural sentences
- Keywords must fit the sentence meaning — never bolded, never listed, never forced
- Spread them across all sections — not all in one place
- A reader should not be able to tell keywords were inserted

CONTENT UNIQUENESS RULES:
- Every section must reference at least one specific fact about ${merchantName} from RESEARCH or DB STATS
- Do not use generic statements that could apply to any store in the ${category} category
- The content must be identifiably about ${merchantName} — not a template with the name swapped in
- Banned phrases: "combining discounts", "strategic shopping", "budget-focused shoppers", "unlock savings", "smart shopper", "dive into", "look no further", "in today's world", "seamless experience", "game-changer"

DATE RULES:
- NO month names, NO year numbers, NO "current", NO "latest" in any field
- Time references must be evergreen: "regularly", "frequently", "often", "at checkout"

FAQ RULES:
- 5 questions — each must be specific to ${merchantName}, not generic
- Answers must reference actual DB stats or research facts
- Q1 must reference the top discount or coupon count from DB if available

Return ONLY valid JSON — no preamble, no markdown:
{
  "seoTitle": "...",
  "metaDescription": "...",
  "h1Tag": "...",
  "focusKeywords": ["kw1","kw2","kw3","kw4","kw5","kw6","kw7"],
  "lsiKeywords": ["lsi1","lsi2","lsi3","lsi4","lsi5","lsi6","lsi7","lsi8","lsi9","lsi10","lsi11","lsi12","lsi13","lsi14","lsi15"],
  "sections": {
${sectionInstructions}
  },
  "faqItems": [
    {"question": "...","answer": "..."},
    {"question": "...","answer": "..."},
    {"question": "...","answer": "..."},
    {"question": "...","answer": "..."},
    {"question": "...","answer": "..."}
  ],
  "schemaData": {
    "breadcrumbName": "${merchantName}",
    "pageDescription": "..."
  },
  "variationProfile": "${blueprint.label} | ${tone.label} | ${angle.label} | ${headingStyle.label}"
}`;
}

// ─── UI COMPONENTS ────────────────────────────────────────────────
function CopyBtn({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button onClick={copy} style={{ padding: "3px 10px", fontSize: 11, fontFamily: "inherit", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, cursor: "pointer", background: copied ? "var(--color-background-secondary)" : "var(--color-background-primary)", color: copied ? "var(--color-text-success)" : "var(--color-text-secondary)" }}>
      {copied ? "✓ Copied" : label}
    </button>
  );
}

function Field({ label, value, max }) {
  const len = (value || "").length;
  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>{label}</span>
        {max && <span style={{ fontSize: 11, color: len > max ? "#C04828" : "var(--color-text-tertiary)" }}>{len}/{max}</span>}
        <div style={{ flex: 1 }} />
        <CopyBtn text={value} />
      </div>
      <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 6, padding: "8px 12px", fontSize: 13, lineHeight: 1.65, color: "var(--color-text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {value || <span style={{ color: "var(--color-text-tertiary)" }}>—</span>}
      </div>
    </div>
  );
}

function Tags({ label, items }) {
  return (
    <div style={{ marginBottom: "0.9rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>{label}</span>
        <div style={{ flex: 1 }} />
        <CopyBtn text={(items || []).join(", ")} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {(items || []).map((k, i) => (
          <span key={i} style={{ fontSize: 12, padding: "2px 9px", borderRadius: 10, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)" }}>{k}</span>
        ))}
      </div>
    </div>
  );
}

function Section({ s }) {
  const [open, setOpen] = useState(true);
  const title = s.heading || s.id;
  const body = typeof s.body === "string" ? s.body : typeof s === "string" ? s : "";
  const words = body.split(/\s+/).filter(Boolean).length;
  return (
    <div style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
      <div onClick={() => setOpen(!open)} style={{ background: "var(--color-background-secondary)", padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{words}w</span>
          <CopyBtn text={body} />
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>
      {open && <div style={{ padding: "10px 12px", fontSize: 13, lineHeight: 1.78, color: "var(--color-text-primary)" }}>{body}</div>}
    </div>
  );
}

function ProgressBar({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ background: "var(--color-background-tertiary)", borderRadius: 20, height: 8, overflow: "hidden", margin: "6px 0" }}>
      <div style={{ height: 8, borderRadius: 20, background: "#1B3557", width: pct + "%", transition: "width .4s" }} />
    </div>
  );
}

function StatusBadge({ bg, color, text }) {
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, fontWeight: 500, background: bg, color }}>{text}</span>;
}

function DBStatus({ status }) {
  const map = {
    connected: { bg: "#EAF3DE", color: "#2E5C0E", text: "✓ DB data loaded" },
    failed: { bg: "#FAEEDA", color: "#854F0B", text: "⚠ Gemini only (no DB)" },
    loading: { bg: "#E6F1FB", color: "#185FA5", text: "⟳ Fetching DB…" },
    idle: { bg: "var(--color-background-secondary)", color: "var(--color-text-secondary)", text: "○ DB not fetched" },
  };
  const s = map[status] || map.idle;
  return <StatusBadge {...s} />;
}

function CrawlStatus({ status }) {
  const map = {
    loading: { bg: "#E6F1FB", color: "#185FA5", text: "⟳ Crawling…" },
    success: { bg: "#EAF3DE", color: "#2E5C0E", text: "✓ Live crawl used" },
    failed: { bg: "#FAEEDA", color: "#854F0B", text: "⚠ Crawl fallback" },
    idle: { bg: "#f8f9fa", color: "#6c757d", text: "No crawl" },
  };
  const s = map[status] || map.idle;
  return <StatusBadge {...s} />;
}

function SaveStatus({ status }) {
  const map = {
    saving: { bg: "#E6F1FB", color: "#185FA5", text: "⟳ Saving to DB…" },
    saved: { bg: "#EAF3DE", color: "#2E5C0E", text: "✓ Saved to DB" },
    failed: { bg: "#FAECE7", color: "#993C1D", text: "✗ Save failed" },
    skipped: { bg: "#f8f9fa", color: "#6c757d", text: "— Not saved (no slug)" },
  };
  const s = map[status] || map.skipped;
  return <StatusBadge {...s} />;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────
export default function VariationEngine() {
  const [apiKey, setApiKey] = useState("");         // used for single mode
  const [apiKeys, setApiKeys] = useState([""]);      // used for batch mode round-robin
  const [backendUrl, setBackendUrl] = useState(BACKEND_URL);
  const [model, setModel] = useState("gemini-3.1-flash-lite-preview");
  const [useDB, setUseDB] = useState(true);
  const [keyUsage, setKeyUsage] = useState({});      // { keyIndex: callCount }
  const keyIdxRef = useRef(0);                       // current round-robin pointer

  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("");
  const [url, setUrl] = useState("");
  const [merchantSlug, setMerchantSlug] = useState("");

  const [mode, setMode] = useState("single");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [dbStatus, setDbStatus] = useState("idle");
  const [crawlStatus, setCrawlStatus] = useState("idle");
  const [saveStatus, setSaveStatus] = useState("idle");
  const [output, setOutput] = useState(null);
  const [preview, setPreview] = useState(null);
  const [tab, setTab] = useState("seo");

  const [batchText, setBatchText] = useState("");
  const [batchResults, setBatchResults] = useState([]);
  const [batchIdx, setBatchIdx] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const stopRef = useRef(false);

  const showPreview = () => {
    if (!merchant || !category) { setError("Enter merchant name and category first."); return; }
    setError("");
    setPreview(getVariation(merchant, category));
  };

  const parseBatch = (text) =>
    text.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const parts = l.split(",").map((p) => p.trim());
        return { name: parts[0], category: parts[1] || "General", url: parts[2] || "", slug: parts[3] || "" };
      })
      .filter((r) => r.name);

  // ── Single generate + save ──
  const runSingle = async () => {
    if (!apiKey || !merchant || !category) { setError("Gemini API key, merchant name and category are required."); return; }
    setError(""); setOutput(null); setRunning(true);
    setDbStatus("idle"); setCrawlStatus("idle"); setSaveStatus("idle");

    let dbData = null;
    let crawledText = "";

    if (useDB && merchantSlug) {
      setDbStatus("loading");
      setStatus("Fetching real coupon data from DB…");
      dbData = await fetchMerchantData(merchantSlug, backendUrl);
      setDbStatus(dbData ? "connected" : "failed");
    }

    if (url?.trim()) {
      setCrawlStatus("loading");
      setStatus("Crawling merchant website…");
      crawledText = await crawlMerchantSite(url, backendUrl);
      setCrawlStatus(crawledText.length > 200 ? "success" : "failed");
    }

    try {
      setStatus("Stage 1 — deep research…");
      const research = safeJSON(await callGemini(buildResearchPrompt(merchant, category, url, crawledText, dbData), apiKey, model));

      const variation = getVariation(merchant, category);
      setStatus("Stage 2 — generating content…");
      const data = safeJSON(await callGemini(buildFinalPrompt(merchant, category, research, variation, dbData, url), apiKey, model));

      const result = { ...data, variation, dbData, research, crawledUsed: crawlStatus === "success" };
      setOutput(result);
      setTab("seo");

      // Save to DB
      if (merchantSlug) {
        setSaveStatus("saving");
        setStatus("Saving content to DB…");
        const saveResult = await saveContentToDB(merchantSlug, {
          meta_title: data.seoTitle,
          meta_description: data.metaDescription,
          h1keyword: data.h1Tag,
          meta_keywords: (data.focusKeywords || []).join(", "),
          description_html: sectionsToHtml(data.sections),
          faqs: data.faqItems || [],
          coupon_h2_blocks: buildH2Blocks(data.sections),
          coupon_h3_blocks: buildH3Blocks(data.sections),
        }, backendUrl);
        setSaveStatus(saveResult?.error ? "failed" : "saved");
      } else {
        setSaveStatus("skipped");
      }

      setStatus("Complete");
    } catch (e) {
      setError(e.message || "Generation failed");
    }
    setRunning(false);
  };

  // ── Round-robin key picker ──
  const getNextKey = () => {
    const valid = apiKeys.map((k, i) => ({ k: k.trim(), i })).filter((x) => x.k);
    if (!valid.length) return null;
    const pick = valid[keyIdxRef.current % valid.length];
    keyIdxRef.current = (keyIdxRef.current + 1) % valid.length;
    return pick;
  };

  // ── Gemini call with retry + key rotation ──
  const callWithRetry = async (prompt, keyEntry, attempt = 0) => {
    try {
      const result = await callGemini(prompt, keyEntry.k, model);
      setKeyUsage((prev) => ({ ...prev, [`key${keyEntry.i}`]: (prev[`key${keyEntry.i}`] || 0) + 1 }));
      return result;
    } catch (e) {
      const isQuota = e.message?.includes("429") || e.message?.toLowerCase().includes("quota");
      const isRetryable = isQuota || e.message?.includes("500") || e.message?.includes("503");

      if (isRetryable && attempt < 3) {
        // On quota — rotate key first, then wait
        let nextKey = keyEntry;
        if (isQuota) {
          const rotated = getNextKey();
          if (rotated && rotated.i !== keyEntry.i) {
            console.warn(`Key ${keyEntry.i + 1} quota — rotating to key ${rotated.i + 1}`);
            nextKey = rotated;
          }
        }
        const wait = isQuota ? 30000 : (attempt + 1) * 5000; // 30s on quota, 5/10/15s on server error
        setStatus(`Retry ${attempt + 1}/3 — waiting ${wait / 1000}s…`);
        await new Promise((res) => setTimeout(res, wait));
        return callWithRetry(prompt, nextKey, attempt + 1);
      }
      throw e;
    }
  };

  // ── Process one store ──
  const processStore = async (r, keyEntry) => {
    let dbData = null;
    let crawledText = "";

    if (useDB && r.slug) dbData = await fetchMerchantData(r.slug, backendUrl);
    if (r.url) crawledText = await crawlMerchantSite(r.url, backendUrl);

    const researchRaw = await callWithRetry(buildResearchPrompt(r.name, r.category, r.url, crawledText, dbData), keyEntry);
    const research = safeJSON(researchRaw);

    const variation = getVariation(r.name, r.category);
    const dataRaw = await callWithRetry(buildFinalPrompt(r.name, r.category, research, variation, dbData, r.url), keyEntry);
    const data = safeJSON(dataRaw);

    let savedOk = null;
    if (r.slug) {
      const saveResult = await saveContentToDB(r.slug, {
        meta_title: data.seoTitle,
        meta_description: data.metaDescription,
        h1keyword: data.h1Tag,
        meta_keywords: (data.focusKeywords || []).join(", "),
        description_html: sectionsToHtml(data.sections),
        faqs: data.faqItems || [],
        coupon_h2_blocks: buildH2Blocks(data.sections),
        coupon_h3_blocks: buildH3Blocks(data.sections),
      }, backendUrl);
      savedOk = !saveResult?.error;
    }

    return { ...data, variation, dbData, savedOk };
  };

  // ── Batch generate + save ──
  const runBatch = async (rowsOverride = null) => {
    const validKeys = apiKeys.map((k) => k.trim()).filter(Boolean);
    if (!validKeys.length) { setError("Add at least one Gemini API key for batch."); return; }
    const rows = rowsOverride || parseBatch(batchText);
    if (!rows.length) { setError("No merchants found. Format: Name, Category, URL (opt), Slug (opt)"); return; }

    if (!rowsOverride) {
      setError(""); setBatchResults([]); keyIdxRef.current = 0; setKeyUsage({});
    }
    stopRef.current = false;
    setRunning(true); setBatchTotal(rows.length);

    const RPM_DELAY = 4200; // 15 RPM = 1 per 4s — use 4.2s for safety margin

    for (let i = 0; i < rows.length; i++) {
      if (stopRef.current) break;
      const r = rows[i];
      setBatchIdx(i + 1);
      const keyEntry = getNextKey();
      setStatus(`[${i + 1}/${rows.length}] ${r.name} — key ${keyEntry.i + 1}`);

      try {
        const result = await processStore(r, keyEntry);
        setBatchResults((prev) => [...prev, { merchant: r.name, category: r.category, slug: r.slug, status: "done", saved: result.savedOk, keyUsed: keyEntry.i + 1, ...result }]);
      } catch (e) {
        setBatchResults((prev) => [...prev, { merchant: r.name, category: r.category, url: r.url, slug: r.slug, status: "error", error: e.message, keyUsed: keyEntry.i + 1 }]);
      }

      if (i < rows.length - 1) await new Promise((res) => setTimeout(res, RPM_DELAY));
    }

    setRunning(false);
    setStatus(stopRef.current ? "Stopped." : "Batch complete.");
  };

  // ── Retry only failed stores ──
  const retryFailed = () => {
    const failed = batchResults.filter((r) => r.status === "error");
    if (!failed.length) return;
    const rows = failed.map((r) => ({ name: r.merchant, category: r.category, url: r.url || "", slug: r.slug || "" }));
    // Remove failed entries from results so they get fresh slots
    setBatchResults((prev) => prev.filter((r) => r.status !== "error"));
    runBatch(rows);
  };

  // ── Load pending stores from DB ──
  const loadPending = async () => {
    setStatus("Loading pending stores from DB…");
    const data = await fetchPendingMerchants(backendUrl);
    if (!data?.merchants?.length) { setError("No pending stores found or backend unreachable."); setStatus(""); return; }
    const csv = data.merchants.map((m) => `${m.name}, ${m.category || "General"}, ${m.webUrl || ""}, ${m.slug}`).join("\n");
    setBatchText(csv);
    setStatus(`Loaded ${data.merchants.length} pending stores.`);
  };

  // ── Content formatters for DB save ──
  const sectionsToHtml = (sections) => {
    if (!sections) return "";
    return Object.values(sections).map((s) => {
      const heading = typeof s === "object" ? s.heading : "";
      const body = typeof s === "object" ? s.body : s;
      return `${heading ? `<h2>${heading}</h2>` : ""}<p>${(body || "").replace(/\n/g, "</p><p>")}</p>`;
    }).join("\n");
  };

  const buildH2Blocks = (sections) => {
    if (!sections) return [];
    return Object.entries(sections).map(([key, s]) => ({
      id: key,
      heading: typeof s === "object" ? s.heading : key,
      body: typeof s === "object" ? s.body : s,
    }));
  };

  const buildH3Blocks = (sections) => {
    // H3 blocks = FAQ formatted as sub-headings; extend as needed
    return [];
  };

  // ── Exports ──
  const exportCSV = (results) => {
    const done = results.filter((r) => r.status === "done");
    const headers = ["merchant","category","slug","saved","variation_profile","seo_title","meta_description","h1_tag","focus_keywords","total_coupons","max_discount"];
    const rows = done.map((r) =>
      [r.merchant, r.category, r.slug || "", r.saved ? "yes" : "no",
        r.variation?.blueprint?.label + " / " + r.variation?.tone?.label + " / " + r.variation?.angle?.label,
        r.seoTitle, r.metaDescription, r.h1Tag,
        (r.focusKeywords || []).join("|"),
        r.dbData?.totalCoupons || "", r.dbData?.maxDiscount || "",
      ].map((v) => `"${(v || "").replace(/"/g, '""')}"`).join(",")
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `savingharbor-content-${Date.now()}.csv`;
    a.click();
  };

  const exportJSON = (results) => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `savingharbor-content-${Date.now()}.json`;
    a.click();
  };

  const exportFailedCSV = (results) => {
    const failed = results.filter((r) => r.status === "error");
    if (!failed.length) return;
    const headers = ["merchant", "category", "url", "slug", "error", "key_used"];
    const rows = failed.map((r) =>
      [r.merchant, r.category, r.url || "", r.slug || "", r.error || "", r.keyUsed || ""]
        .map((v) => `"${(v || "").replace(/"/g, '""')}"`)
        .join(",")
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `savingharbor-failed-${Date.now()}.csv`;
    a.click();
  };

  // ── Derived ──
  const allContent = output?.sections
    ? Object.values(output.sections).map((s) => (typeof s === "object" ? s.body || "" : s)).join("\n\n")
    : "";
  const wordCount = allContent.split(/\s+/).filter(Boolean).length;
  const batchRows = parseBatch(batchText);
  const estCost = (n) => (n * (model.includes("flash") ? 0.004 : 0.036)).toFixed(2); // 2-stage = 2x calls

  const inputStyle = { width: "100%", padding: "7px 10px", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, fontSize: 13, background: "var(--color-background-primary)", color: "var(--color-text-primary)", fontFamily: "inherit", outline: "none" };
  const tabStyle = (active) => ({ padding: "6px 13px", fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, fontWeight: active ? 500 : 400, background: active ? "var(--color-background-secondary)" : "var(--color-background-primary)", color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)" });

  return (
    <div style={{ padding: "1.5rem 0", fontFamily: "var(--font-sans)", maxWidth: 700 }}>
      {/* Header */}
      <div style={{ background: "#0F2240", color: "#fff", borderRadius: 12, padding: "1.1rem 1.4rem", marginBottom: "1.25rem" }}>
        ⚡ SavingHarbor Variation Engine <strong>v2.2 — DB Save + LSI Injection</strong>
        <br />
        <span style={{ fontSize: 12 }}>384 variations · Live crawl · Real DB coupons · Auto-save to merchants table</span>
      </div>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: "1rem" }}>
        {["single", "batch"].map((m) => (
          <button key={m} onClick={() => setMode(m)} style={tabStyle(mode === m)}>
            {m === "single" ? "Single Merchant" : "Batch Mode (CSV)"}
          </button>
        ))}
      </div>

      {/* Config */}
      <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "1rem", marginBottom: "1rem" }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 8 }}>Configuration</div>

        {/* Single mode — one key */}
        {mode === "single" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Gemini API Key *</label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="AIzaSy•••••••••••" style={inputStyle} disabled={running} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} style={{ ...inputStyle, height: 36 }} disabled={running}>
                <option value="gemini-3.1-flash-lite-preview">gemini-3.1-flash-lite-preview (500 RPD)</option>
                <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (20 RPD)</option>
                <option value="gemini-2.5-flash">gemini-2.5-flash (20 RPD)</option>
              </select>
            </div>
          </div>
        )}

        {/* Batch mode — multi-key round-robin */}
        {mode === "batch" && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>
                Gemini API Keys — Round-Robin ({apiKeys.filter((k) => k.trim()).length} active)
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setApiKeys((prev) => [...prev, ""])} disabled={running || apiKeys.length >= 10}
                  style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit" }}>
                  + Add Key
                </button>
                {apiKeys.length > 1 && (
                  <button onClick={() => setApiKeys((prev) => prev.slice(0, -1))} disabled={running}
                    style={{ fontSize: 11, padding: "2px 8px", border: "0.5px solid #C04828", borderRadius: 4, background: "transparent", color: "#C04828", cursor: "pointer", fontFamily: "inherit" }}>
                    − Remove
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {apiKeys.map((k, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", width: 40, flexShrink: 0 }}>Key {i + 1}</span>
                  <input type="password" value={k} onChange={(e) => setApiKeys((prev) => prev.map((x, j) => j === i ? e.target.value : x))}
                    placeholder="AIzaSy•••••••••••" style={{ ...inputStyle, flex: 1 }} disabled={running} />
                  {keyUsage[`key${i}`] > 0 && (
                    <span style={{ fontSize: 10, padding: "1px 6px", background: "#E6F1FB", color: "#185FA5", borderRadius: 3, whiteSpace: "nowrap" }}>
                      {keyUsage[`key${i}`]} calls
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} style={{ ...inputStyle, height: 36 }} disabled={running}>
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                <option value="gemini-3.1-flash-lite-preview">gemini-3.1-flash-lite-preview (500 RPD/key)</option>
                <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (20 RPD/key)</option>
                <option value="gemini-2.5-flash">gemini-2.5-flash (20 RPD/key)</option>
              </select>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Backend URL</label>
            <input value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} placeholder="https://your-app.onrender.com" style={inputStyle} disabled={running} />
          </div>
          <div style={{ paddingBottom: 1 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Use DB Data</label>
            <div onClick={() => setUseDB(!useDB)} style={{ width: 44, height: 24, borderRadius: 12, cursor: "pointer", position: "relative", background: useDB ? "#1B3557" : "var(--color-background-tertiary)", border: "0.5px solid var(--color-border-secondary)", transition: "background .2s" }}>
              <div style={{ position: "absolute", top: 3, left: useDB ? 22 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
            </div>
          </div>
        </div>
      </div>

      {/* ── SINGLE MODE ── */}
      {mode === "single" && (
        <div>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "1rem", marginBottom: "1rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Merchant Name *</label>
                <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Healthyline" style={inputStyle} disabled={running} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Category *</label>
                <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Health & Wellness" style={inputStyle} disabled={running} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>Website URL (optional)</label>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.healthyline.com" style={inputStyle} disabled={running} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 4 }}>DB Slug (for live coupon data + save)</label>
                <input value={merchantSlug} onChange={(e) => setMerchantSlug(e.target.value)} placeholder="e.g. healthyline-coupons" style={inputStyle} disabled={running} />
              </div>
            </div>
          </div>

          {preview && (
            <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "0.9rem 1rem", marginBottom: "0.9rem", fontSize: 13 }}>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>Variation profile for "{merchant}"</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {[["Blueprint", preview.blueprint.label], ["Tone", preview.tone.label], ["Angle", preview.angle.label], ["Headings", preview.headingStyle.label]].map(([k, v]) => (
                  <span key={k} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)" }}>{k}: <strong>{v}</strong></span>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>Section headings:</div>
              {preview.blueprint.sections.map((s, i) => (
                <div key={i} style={{ fontSize: 12, color: "var(--color-text-secondary)", paddingLeft: 8 }}>
                  {i + 1}. {buildHeading(s, merchant, preview.headingStyle.id)}
                  <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>({preview.sectionDepths[i]})</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
            <button onClick={showPreview} disabled={running} style={{ padding: "9px 14px", fontSize: 13, border: "0.5px solid var(--color-border-primary)", borderRadius: 8, background: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit" }}>
              👁 Preview Structure
            </button>
            <button onClick={runSingle} disabled={running} style={{ flex: 1, padding: "9px", fontSize: 14, fontWeight: 500, border: "none", borderRadius: 8, background: running ? "var(--color-background-tertiary)" : "#0F2240", color: running ? "var(--color-text-tertiary)" : "#fff", cursor: running ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {running ? `⏳ ${status}` : output ? "↻ Regenerate" : "🚀 Generate Content"}
            </button>
          </div>

          {running && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              <DBStatus status={dbStatus} />
              <CrawlStatus status={crawlStatus} />
            </div>
          )}

          {output && (
            <div>
              <div style={{ background: "#EAF3DE", border: "0.5px solid #97C459", borderRadius: 8, padding: "9px 12px", marginBottom: "1rem", fontSize: 13, color: "#2E5C0E", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span>✓ {merchant} — {wordCount} words · {output.variationProfile}</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <DBStatus status={output.dbData ? "connected" : "failed"} />
                  <CrawlStatus status={output.crawledUsed ? "success" : "idle"} />
                  <SaveStatus status={saveStatus} />
                  <button onClick={() => exportJSON([output])} style={{ fontSize: 11, padding: "2px 10px", border: "0.5px solid #3B6D11", borderRadius: 4, background: "transparent", color: "#3B6D11", cursor: "pointer", fontFamily: "inherit" }}>⬇ JSON</button>
                </div>
              </div>

              <div style={{ display: "flex", gap: 5, marginBottom: "1rem", flexWrap: "wrap" }}>
                {[["seo", "SEO Metadata"], ["content", "Content Sections"], ["faq", "FAQ"], ["db", "DB Data Used"]].map(([id, label]) => (
                  <button key={id} onClick={() => setTab(id)} style={tabStyle(tab === id)}>{label}</button>
                ))}
              </div>

              {tab === "seo" && (
                <div>
                  <Field label="SEO Title" value={output.seoTitle} max={65} />
                  <Field label="Meta Description" value={output.metaDescription} max={155} />
                  <Field label="H1 Tag" value={output.h1Tag} max={68} />
                  <Tags label="Focus Keywords (7)" items={output.focusKeywords} />
                  <Tags label="LSI / Semantic Keywords (15)" items={output.lsiKeywords} />
                </div>
              )}

              {tab === "content" && output.sections && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 12, color: "var(--color-text-secondary)" }}>
                    <span>{wordCount} words · {Object.keys(output.sections).length} sections · click to collapse</span>
                    <CopyBtn text={allContent} label="Copy All" />
                  </div>
                  {Object.entries(output.sections).map(([k, v]) => (
                    <Section key={k} s={typeof v === "object" ? v : { id: k, heading: k, body: v }} />
                  ))}
                </div>
              )}

              {tab === "faq" && output.faqItems && (
                <div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                    <CopyBtn text={output.faqItems.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")} label="Copy All FAQs" />
                  </div>
                  {output.faqItems.map((f, i) => (
                    <div key={i} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
                      <div style={{ background: "var(--color-background-secondary)", padding: "8px 12px", fontWeight: 500, fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                        <span>Q{i + 1}: {f.question}</span>
                        <CopyBtn text={`Q: ${f.question}\nA: ${f.answer}`} />
                      </div>
                      <div style={{ padding: "9px 12px", fontSize: 13, lineHeight: 1.75 }}>{f.answer}</div>
                    </div>
                  ))}
                </div>
              )}

              {tab === "db" && (
                <div style={{ fontSize: 13 }}>
                  {output.dbData ? (
                    <div>
                      <div style={{ background: "#EAF3DE", border: "0.5px solid #97C459", borderRadius: 6, padding: "8px 12px", marginBottom: 12, color: "#2E5C0E" }}>
                        ✓ Real DB data injected into content prompt
                      </div>
                      <Field label="Total Coupons" value={String(output.dbData.totalCoupons || "—")} />
                      <Field label="Max Discount" value={output.dbData.maxDiscount ? `${output.dbData.maxDiscount}%` : "—"} />
                      <Field label="Avg Discount" value={output.dbData.avgDiscount ? `${output.dbData.avgDiscount}%` : "—"} />
                      <Field label="Coupon Types" value={(output.dbData.couponTypes || []).join(", ") || "—"} />
                      <Field label="Free Shipping" value={output.dbData.hasFreeShipping ? "Yes" : "No"} />
                      <Field label="New User Offer" value={output.dbData.hasNewUserOffer ? "Yes" : "No"} />
                      <Field label="Top Offers" value={(output.dbData.coupons || []).map(formatDiscount).filter(Boolean).join(" · ") || "—"} />
                    </div>
                  ) : (
                    <div style={{ background: "#FAEEDA", border: "0.5px solid #EF9F27", borderRadius: 6, padding: "8px 12px", color: "#854F0B" }}>
                      ⚠ No DB data used. Enable "Use DB Data" and provide a slug, or the backend call failed.
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
          <div style={{ background: "#FAEEDA", border: "0.5px solid #EF9F27", borderRadius: 8, padding: "8px 12px", marginBottom: "0.9rem", fontSize: 12, color: "#854F0B", lineHeight: 1.7 }}>
            <strong>CSV Format:</strong>{" "}
            <code style={{ fontFamily: "var(--font-mono)", background: "#FFF3CD", padding: "1px 5px", borderRadius: 3 }}>
              Merchant Name, Category, Website URL, DB Slug
            </code>
            <br />
            Slug enables DB coupon fetch AND auto-saves generated content. Use "Load Pending" to auto-fill stores with no content yet.
          </div>

          <div style={{ marginBottom: "0.9rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>Merchant List (up to 500 per session)</label>
              <button onClick={loadPending} disabled={running}
                style={{ fontSize: 11, padding: "3px 10px", border: "0.5px solid #185FA5", borderRadius: 4, background: "#E6F1FB", color: "#185FA5", cursor: "pointer", fontFamily: "inherit" }}>
                ⬇ Load Pending Stores
              </button>
            </div>
            <textarea value={batchText} onChange={(e) => setBatchText(e.target.value)} disabled={running}
              placeholder={"Healthyline, Health & Wellness, https://healthyline.com, healthyline-coupons\nParsec, Software, https://parsec.app, parsec-coupons\nBarbican, Travel & Tourism,,"}
              rows={6} style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12 }} />
          </div>

          {batchRows.length > 0 && (
            <div style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "8px 12px", marginBottom: "0.9rem", fontSize: 13, display: "flex", gap: 20, flexWrap: "wrap" }}>
              <span>📋 <strong>{batchRows.length}</strong> merchants</span>
              <span>⏱ ~{Math.ceil((batchRows.length * 4.2 * 2) / 60)} min</span>
              <span>🗄 DB slugs: {batchRows.filter((r) => r.slug).length}/{batchRows.length}</span>
            </div>
          )}

          {running && (
            <div style={{ marginBottom: "0.9rem" }}>
              <ProgressBar value={batchIdx} max={batchTotal} />
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 4 }}>{status}</div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
            <button onClick={() => runBatch()} disabled={running || !batchRows.length} style={{ flex: 1, padding: "9px", fontSize: 14, fontWeight: 500, border: "none", borderRadius: 8, background: running ? "var(--color-background-tertiary)" : "#0F2240", color: running ? "var(--color-text-tertiary)" : "#fff", cursor: running ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
              {running ? `⏳ Processing ${batchIdx}/${batchTotal}…` : "🚀 Start Batch"}
            </button>
            {running && (
              <button onClick={() => (stopRef.current = true)} style={{ padding: "9px 14px", fontSize: 13, border: "0.5px solid #C04828", borderRadius: 8, background: "transparent", color: "#C04828", cursor: "pointer", fontFamily: "inherit" }}>
                ⏹ Stop
              </button>
            )}
          </div>

          {batchResults.length > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 500, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ color: "#2E5C0E" }}>✓ {batchResults.filter((r) => r.status === "done").length} done</span>
                  <span style={{ color: batchResults.filter((r) => r.status === "error").length > 0 ? "#993C1D" : "var(--color-text-secondary)" }}>
                    ✗ {batchResults.filter((r) => r.status === "error").length} failed
                  </span>
                  <span>💾 {batchResults.filter((r) => r.saved).length} saved</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {batchResults.filter((r) => r.status === "error").length > 0 && !running && (
                    <button onClick={retryFailed} style={{ fontSize: 11, padding: "3px 10px", border: "0.5px solid #185FA5", borderRadius: 4, background: "#E6F1FB", color: "#185FA5", cursor: "pointer", fontFamily: "inherit" }}>
                      ↻ Retry Failed ({batchResults.filter((r) => r.status === "error").length})
                    </button>
                  )}
                  {batchResults.filter((r) => r.status === "error").length > 0 && (
                    <button onClick={() => exportFailedCSV(batchResults)} style={{ fontSize: 11, padding: "3px 10px", border: "0.5px solid #C04828", borderRadius: 4, background: "#FAECE7", color: "#993C1D", cursor: "pointer", fontFamily: "inherit" }}>⬇ Failed CSV</button>
                  )}
                  <button onClick={() => exportCSV(batchResults)} style={{ fontSize: 11, padding: "3px 10px", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit" }}>⬇ CSV</button>
                  <button onClick={() => exportJSON(batchResults)} style={{ fontSize: 11, padding: "3px 10px", border: "0.5px solid var(--color-border-secondary)", borderRadius: 4, background: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit" }}>⬇ JSON</button>
                </div>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8 }}>
                {batchResults.map((r, i) => (
                  <div key={i} style={{ padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 10, fontSize: 13, background: r.status === "error" ? "#FFF8F6" : i % 2 === 0 ? "var(--color-background-primary)" : "var(--color-background-secondary)" }}>
                    <span style={{ color: r.status === "done" ? "#2E5C0E" : "#993C1D" }}>{r.status === "done" ? "✓" : "✗"}</span>
                    <span style={{ flex: 1, fontWeight: 500 }}>{r.merchant}</span>
                    <span style={{ fontSize: 11, color: r.status === "error" ? "#993C1D" : "var(--color-text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.status === "done" ? r.variation?.blueprint?.label + " / " + r.variation?.tone?.label : r.error}
                    </span>
                    {r.keyUsed && <span style={{ fontSize: 10, padding: "1px 6px", background: "#f0f0f0", color: "#555", borderRadius: 3 }}>K{r.keyUsed}</span>}
                    {r.dbData && <span style={{ fontSize: 10, padding: "1px 6px", background: "#EAF3DE", color: "#2E5C0E", borderRadius: 3 }}>DB ✓</span>}
                    {r.saved && <span style={{ fontSize: 10, padding: "1px 6px", background: "#EAF3DE", color: "#2E5C0E", borderRadius: 3 }}>Saved ✓</span>}
                    {r.saved === false && <span style={{ fontSize: 10, padding: "1px 6px", background: "#FAECE7", color: "#993C1D", borderRadius: 3 }}>Save ✗</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!running && status && (
            <div style={{ marginTop: "0.9rem", fontSize: 12, color: "var(--color-text-secondary)" }}>{status}</div>
          )}
        </div>
      )}

      {error && (
        <div style={{ background: "#FAECE7", border: "0.5px solid #F0997B", borderRadius: 6, padding: "8px 12px", fontSize: 13, color: "#993C1D", marginTop: "0.9rem" }}>
          {error}
        </div>
      )}
    </div>
  );
}