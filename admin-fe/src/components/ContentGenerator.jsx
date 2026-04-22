/**
 * SavingHarbor — Content Architecture Variation Engine v2.4
 * Changes from v2.3:
 * - Worker-pool batch: N keys → N concurrent workers, zero idle time
 * - Smarter backoff: exponential 10s*2^attempt ±2s jitter (was flat 45s)
 * - Removed preemptive 1200ms RPM_DELAY — backoff only on real errors
 * - stopRef checked inside each worker (immediate halt, not end-of-store)
 * - Live per-worker status display (which key is on which store)
 * - batchIdx incremented via ref (race-safe across concurrent workers)
 */

import { useState, useRef, useCallback } from "react";

const BACKEND_URL = "https://admin-api.savingharbor.com";

// ─── CRAWL ────────────────────────────────────────────────────────
const crawlMerchantSite = async (url, backendUrl) => {
  if (!url?.trim()) return "";
  try {
    const res = await fetch(
      `${backendUrl}/api/seo/crawl?url=${encodeURIComponent(url.trim())}`,
      { signal: AbortSignal.timeout(15000) },
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
  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean.replace(/,(\s*[}\]])/g, "$1"));
}

// ─── DISCOUNT SUMMARY ─────────────────────────────────────────────
function formatDiscount(c) {
  if (!c) return null;
  if (c.discountType === "percent" && c.value) return `${c.value}% off`;
  if (c.discountType === "flat" && c.value)
    return `${c.currency || "$"}${c.value} off`;
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
  const topOffers = coupons.slice(0, 4).map(formatDiscount).filter(Boolean);
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

// ─── VARIATION ENGINE ─────────────────────────────────────────────
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
      "Write with confident domain expertise. Use specific facts and figures. Tone: a knowledgeable professional briefing a peer. No hedging.",
  },
  {
    id: "conversational",
    label: "Conversational Friend",
    instruction:
      "Write like a savvy friend who genuinely knows this brand. Warm, direct, naturally uses 'you'. No jargon. Real talk, not marketing copy.",
  },
  {
    id: "review",
    label: "Critical Reviewer",
    instruction:
      "Write like an independent reviewer who has studied this brand. Analytical, balanced — genuine strengths and honest caveats. Evidence-driven.",
  },
  {
    id: "guide",
    label: "Shopper's Guide",
    instruction:
      "Write as a practical buying guide. Structured, actionable, focused on value signals and red flags.",
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
  { id: "declarative", label: "Declarative" },
  { id: "question", label: "Question" },
  { id: "benefit", label: "Benefit-Led" },
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
          "How {m} Got Started",
          "The People Behind {m}",
          "What Drives {m}",
          "{m}: Brand Origins",
          "A Closer Look at {m}",
        ],
      },
      {
        id: "collections",
        heads: [
          "What {m} Sells",
          "{m} Collections & Range",
          "Inside {m}'s Catalog",
          "The Full {m} Lineup",
          "Exploring {m}'s Catalog",
          "What's Available at {m}",
          "{m} Product Overview",
          "Everything {m} Offers",
        ],
      },
      {
        id: "qualityFit",
        heads: [
          "{m} Quality & Sizing",
          "How Good Is {m}?",
          "Materials & Craftsmanship at {m}",
          "What to Expect from {m} Quality",
          "Does {m} Deliver on Quality?",
          "Fit, Feel & Finish at {m}",
          "{m} Construction Standards",
          "Judging {m} by Its Materials",
        ],
      },
      {
        id: "sustainability",
        heads: [
          "{m} Values & Ethics",
          "Is {m} Sustainable?",
          "{m} and Responsible Fashion",
          "How {m} Approaches Sustainability",
          "Environmental Standards at {m}",
          "{m}'s Ethical Commitments",
          "Does {m} Care About the Planet?",
          "The Sustainability Side of {m}",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Returns & Support",
          "How {m} Handles Issues",
          "Customer Service at {m}",
          "What Happens If Something Goes Wrong at {m}",
          "Getting Help from {m}",
          "{m} After-Purchase Experience",
          "Is {m} Easy to Deal With?",
          "Support & Returns at {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "Best {m} Sale Events",
          "When {m} Prices Drop",
          "How to Time Your {m} Purchase",
          "Finding the Best {m} Prices",
          "Saving Money at {m}",
          "{m} Discount Periods",
          "Catching {m} at Its Best Price",
          "Getting More for Less at {m}",
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
      {
        id: "company",
        heads: [
          "About {m}",
          "The {m} Brand",
          "Who Makes {m}",
          "The Story of {m}",
          "Who Is Behind {m}?",
          "{m}: Company Overview",
          "Understanding {m}",
          "What Kind of Company Is {m}?",
        ],
      },
      {
        id: "products",
        heads: [
          "{m} Product Range",
          "What {m} Makes",
          "The {m} Lineup",
          "Everything {m} Builds",
          "{m} Hardware & Software",
          "Exploring {m}'s Products",
          "What {m} Actually Sells",
          "The {m} Product Catalog",
        ],
      },
      {
        id: "innovation",
        heads: [
          "{m} Innovation & Features",
          "Why {m} Tech Stands Out",
          "What Makes {m} Different",
          "How {m} Pushes the Envelope",
          "{m}'s Technical Edge",
          "Where {m} Outperforms",
          "What Sets {m} Apart Technically",
          "The Engineering Behind {m}",
        ],
      },
      {
        id: "warranty",
        heads: [
          "{m} Warranty & Support",
          "After-Sales at {m}",
          "{m} Customer Care",
          "What {m} Covers Post-Purchase",
          "How {m} Handles Defects",
          "Is {m}'s Warranty Worth It?",
          "Support After Buying from {m}",
          "Getting Help with {m} Products",
        ],
      },
      {
        id: "reviews",
        heads: [
          "What Buyers Say About {m}",
          "{m} User Ratings",
          "Is {m} Worth Buying?",
          "Real Feedback on {m}",
          "How Customers Rate {m}",
          "Honest Opinions on {m}",
          "The {m} Verdict from Real Users",
          "Does {m} Live Up to the Hype?",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Best Deals",
          "When to Buy {m}",
          "How to Save on {m}",
          "Timing Your {m} Purchase",
          "Finding {m} at the Best Price",
          "Discount Opportunities at {m}",
          "Getting {m} for Less",
          "Smart Buying at {m}",
        ],
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
          "What {m} Is Trying to Achieve",
          "The Thinking Behind {m}",
          "Why {m} Exists",
          "What {m} Believes In",
          "{m}'s Approach to Wellness",
        ],
      },
      {
        id: "ingredients",
        heads: [
          "{m} Products & Formulas",
          "What Goes Into {m}",
          "{m} Ingredient Standards",
          "How {m} Formulates Its Products",
          "What Makes {m} Ingredients Different",
          "Inside {m}'s Formulations",
          "The Science of {m} Ingredients",
          "Quality Standards in {m} Products",
        ],
      },
      {
        id: "certifications",
        heads: [
          "{m} Certifications",
          "Is {m} Certified & Safe?",
          "{m} Quality Assurance",
          "Third-Party Verification at {m}",
          "Does {m} Have the Right Certifications?",
          "How {m} Proves Its Quality",
          "Trusting {m}: The Certification Story",
          "What {m}'s Certifications Mean",
        ],
      },
      {
        id: "audience",
        heads: [
          "Who {m} Is For",
          "Is {m} Right for You?",
          "{m} and Your Health Goals",
          "Finding Your Fit with {m}",
          "Who Benefits Most from {m}",
          "Is {m} the Right Choice?",
          "Matching Your Needs to {m}",
          "Who Should Use {m}?",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Support & Guidance",
          "Getting Help from {m}",
          "{m} Customer Community",
          "How {m} Supports Its Customers",
          "Is {m} There When You Need It?",
          "Resources & Support at {m}",
          "The {m} Customer Experience",
          "Help, FAQs & Community at {m}",
        ],
      },
      {
        id: "reviews",
        heads: [
          "Real {m} Customer Results",
          "What Health Shoppers Say About {m}",
          "{m} Reviews & Outcomes",
          "Honest {m} User Experiences",
          "How Real People Rate {m}",
          "What Customers Actually Experience with {m}",
          "{m} in the Real World",
          "Verified Feedback on {m}",
        ],
      },
      {
        id: "savings",
        heads: [
          "Smart Savings on {m}",
          "How to Pay Less for {m}",
          "{m} Coupon Strategy",
          "Getting {m} at a Better Price",
          "Reducing the Cost of {m}",
          "Finding {m} Discounts",
          "Saving Without Compromising on {m}",
          "The Best Way to Buy {m} for Less",
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
        heads: [
          "The {m} Story",
          "Where {m} Comes From",
          "How {m} Started",
          "The Origins of {m}",
          "Who Founded {m} and Why",
          "What Makes {m} Different from the Start",
          "The Journey Behind {m}",
          "Getting to Know {m}",
        ],
      },
      {
        id: "range",
        heads: [
          "{m} Products & Menu",
          "What You Can Get at {m}",
          "The {m} Range",
          "Everything on the {m} Menu",
          "Exploring {m}'s Product Line",
          "What {m} Offers",
          "The Full {m} Selection",
          "What's Available from {m}",
        ],
      },
      {
        id: "sourcing",
        heads: [
          "{m} Sourcing & Quality",
          "How {m} Sources Ingredients",
          "What Makes {m} Food Special",
          "Where {m} Gets Its Ingredients",
          "The {m} Quality Standard",
          "How {m} Maintains Freshness",
          "Is {m} Particular About Sourcing?",
          "The Supply Chain Behind {m}",
        ],
      },
      {
        id: "dietary",
        heads: [
          "{m} Dietary Options",
          "Is {m} Good for Your Diet?",
          "Eating Well at {m}",
          "Can You Eat {m} on a Restricted Diet?",
          "What Diets Does {m} Support?",
          "Navigating {m} for Your Dietary Needs",
          "{m} and Dietary Preferences",
          "Finding Your Fit in the {m} Range",
        ],
      },
      {
        id: "delivery",
        heads: [
          "Ordering & Delivery from {m}",
          "How {m} Ships",
          "Getting {m} to Your Door",
          "What to Expect When You Order from {m}",
          "The {m} Delivery Experience",
          "How Fast Does {m} Deliver?",
          "Ordering from {m}: What You Need to Know",
          "Shipping & Packaging at {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Deals & Bundles",
          "Saving on {m} Orders",
          "Best Time to Order from {m}",
          "Getting More Value from {m}",
          "How to Save When Shopping {m}",
          "Discount Opportunities at {m}",
          "Making {m} More Affordable",
          "Finding the Best {m} Prices",
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
        heads: [
          "About {m}",
          "{m} Brand Heritage",
          "The {m} Story",
          "Who Is {m}?",
          "A Brief History of {m}",
          "How {m} Built Its Reputation",
          "The Background of {m}",
          "What {m} Is Known For",
        ],
      },
      {
        id: "categories",
        heads: [
          "{m} Product Categories",
          "What {m} Sells",
          "Inside {m}'s Range",
          "Everything {m} Offers",
          "Exploring the {m} Catalog",
          "The Breadth of {m}'s Selection",
          "What Can You Buy at {m}?",
          "Products & Categories at {m}",
        ],
      },
      {
        id: "quality",
        heads: [
          "{m} Build Quality",
          "How Well Made Is {m}?",
          "Materials at {m}",
          "What to Expect from {m} Construction",
          "Is {m} Built to Last?",
          "Durability & Finish at {m}",
          "The Craftsmanship Behind {m}",
          "Testing {m}'s Quality Claims",
        ],
      },
      {
        id: "delivery",
        heads: [
          "{m} Delivery & Setup",
          "Getting Your {m} Order",
          "Shipping & Assembly at {m}",
          "How {m} Gets Products to You",
          "The {m} Delivery Experience",
          "What Happens After You Order from {m}",
          "Receiving & Setting Up {m} Products",
          "Lead Times & Logistics at {m}",
        ],
      },
      {
        id: "inspiration",
        heads: [
          "Homes Transformed by {m}",
          "{m} in Real Spaces",
          "What Customers Create with {m}",
          "Real Homes Featuring {m}",
          "How People Use {m} in Their Space",
          "Before & After with {m}",
          "Customer Spaces Featuring {m}",
          "See What {m} Looks Like in Real Homes",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Seasonal Sales",
          "Best {m} Prices",
          "When {m} Runs Promotions",
          "How to Get {m} for Less",
          "Finding Discounts at {m}",
          "The Best Times to Buy from {m}",
          "Saving on {m} Furniture & Decor",
          "Getting the Most Value from {m}",
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
          "What {m} Was Built to Fix",
          "Who Needs {m} and Why",
          "The Pain Point Behind {m}",
          "Understanding {m}'s Purpose",
          "Why Teams Turn to {m}",
        ],
      },
      {
        id: "features",
        heads: [
          "{m} Core Features",
          "What {m} Can Do",
          "Inside {m}: Key Capabilities",
          "The Tools {m} Puts in Your Hands",
          "Breaking Down {m}'s Feature Set",
          "What You Get with {m}",
          "How {m} Works in Practice",
          "A Feature-by-Feature Look at {m}",
        ],
      },
      {
        id: "pricing",
        heads: [
          "{m} Pricing & Plans",
          "How Much Is {m}?",
          "{m} Subscription Tiers",
          "What Does {m} Cost?",
          "Breaking Down {m} Pricing",
          "Is {m} Worth the Price?",
          "Comparing {m} Plans",
          "Finding the Right {m} Plan for You",
        ],
      },
      {
        id: "trial",
        heads: [
          "Try {m} Before You Buy",
          "{m} Free Trial Options",
          "Testing {m} Risk-Free",
          "Can You Try {m} for Free?",
          "How to Evaluate {m} Without Committing",
          "Getting Started with {m} for Free",
          "What the {m} Trial Includes",
          "Testing {m} Before Paying",
        ],
      },
      {
        id: "integrations",
        heads: [
          "{m} Integrations",
          "What {m} Connects With",
          "Building With {m}",
          "How {m} Fits Into Your Stack",
          "Tools That Work with {m}",
          "Expanding {m} with Integrations",
          "What {m} Plays Well With",
          "Connecting {m} to Your Workflow",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Support & Docs",
          "Getting Help with {m}",
          "Is {m} Well-Supported?",
          "What Happens When {m} Breaks?",
          "How {m} Handles Customer Issues",
          "Documentation & Help at {m}",
          "Is {m}'s Support Actually Good?",
          "Resources for {m} Users",
        ],
      },
      {
        id: "discounts",
        heads: [
          "Save on {m} Subscriptions",
          "{m} Annual vs Monthly",
          "How to Pay Less for {m}",
          "Getting {m} at a Discount",
          "Reducing Your {m} Bill",
          "{m} Pricing Hacks",
          "Is the {m} Annual Plan Worth It?",
          "Finding {m} Promo Codes",
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
        heads: [
          "About {m}",
          "What {m} Offers",
          "Services at {m}",
          "Who Is {m}?",
          "Understanding {m}",
          "The {m} Service Overview",
          "What Can You Do with {m}?",
          "An Introduction to {m}",
        ],
      },
      {
        id: "destinations",
        heads: [
          "{m} Destinations & Options",
          "Where {m} Takes You",
          "The {m} Experience",
          "What {m} Covers",
          "How Far {m} Can Take You",
          "Destinations Available Through {m}",
          "Exploring What {m} Offers",
          "The Range of {m} Travel Options",
        ],
      },
      {
        id: "booking",
        heads: [
          "How Booking at {m} Works",
          "Using {m}: Step by Step",
          "Planning With {m}",
          "How to Book Through {m}",
          "The {m} Booking Process",
          "Is {m} Easy to Book With?",
          "What to Expect When Booking {m}",
          "Step-by-Step: Booking on {m}",
        ],
      },
      {
        id: "policies",
        heads: [
          "{m} Cancellation Policy",
          "Flexibility at {m}",
          "If Plans Change with {m}",
          "What Happens If You Cancel with {m}?",
          "How Flexible Is {m}?",
          "Understanding {m}'s Refund Terms",
          "Changes & Cancellations at {m}",
          "The Fine Print at {m}",
        ],
      },
      {
        id: "reviews",
        heads: [
          "Traveller Reviews of {m}",
          "Real {m} Guest Experiences",
          "What People Say About {m}",
          "How Travellers Rate {m}",
          "Honest Opinions on {m}",
          "Verified {m} Customer Feedback",
          "What Real Guests Say About {m}",
          "Traveller Verdict on {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "{m} Best Offers",
          "Booking {m} at the Lowest Price",
          "{m} Early Bird Deals",
          "How to Save on {m} Travel",
          "Finding {m} Discount Codes",
          "Getting More Value from {m}",
          "The Best {m} Deals Right Now",
          "Smart Booking Tips for {m}",
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
        heads: [
          "About {m}",
          "Who Is {m}?",
          "Getting to Know {m}",
          "An Introduction to {m}",
          "What Is {m} All About?",
          "Understanding {m}",
          "The {m} Brand Explained",
          "What Makes {m} Tick?",
        ],
      },
      {
        id: "offerings",
        heads: [
          "What {m} Sells",
          "Products & Services at {m}",
          "{m} Offerings",
          "Everything {m} Has to Offer",
          "The Full {m} Range",
          "What You Can Buy at {m}",
          "Exploring the {m} Catalog",
          "What {m} Brings to the Table",
        ],
      },
      {
        id: "whyChoose",
        heads: [
          "Why Shop at {m}",
          "What Makes {m} Worth It",
          "The {m} Advantage",
          "Reasons to Choose {m}",
          "What {m} Does Better",
          "Making the Case for {m}",
          "Is {m} the Right Choice?",
          "Why Customers Keep Coming Back to {m}",
        ],
      },
      {
        id: "customerExp",
        heads: [
          "{m} Customer Experience",
          "Shopping at {m}",
          "What to Expect from {m}",
          "How It Feels to Shop at {m}",
          "The {m} Shopping Journey",
          "Buying from {m}: What to Know",
          "Is {m} a Good Place to Shop?",
          "From Browse to Checkout at {m}",
        ],
      },
      {
        id: "support",
        heads: [
          "{m} Customer Support",
          "Help at {m}",
          "How {m} Supports You",
          "Getting Assistance from {m}",
          "Is {m}'s Support Any Good?",
          "What Happens When You Need Help at {m}",
          "Reaching {m} When It Matters",
          "The Support Side of {m}",
        ],
      },
      {
        id: "deals",
        heads: [
          "Best {m} Deals",
          "How to Save at {m}",
          "Getting the Most from {m}",
          "Finding {m} Discounts",
          "Making Your {m} Budget Go Further",
          "Discount & Coupon Strategy for {m}",
          "When Does {m} Offer the Best Prices?",
          "Saving Smart at {m}",
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

const FAQ_QUESTION_TYPES = [
  {
    id: "savings",
    instruction:
      "Ask specifically about the maximum or typical discount available, referencing actual DB figures if present.",
  },
  {
    id: "howto",
    instruction:
      "Ask how to actually use a coupon code or deal at checkout on this specific store.",
  },
  {
    id: "validity",
    instruction:
      "Ask about expiry, terms, or conditions on the deals — e.g. which products are excluded.",
  },
  {
    id: "comparison",
    instruction:
      "Ask how this store's prices or deals compare to alternatives in the same category.",
  },
  {
    id: "trust",
    instruction:
      "Ask a credibility question — are the coupons verified, how often are they updated, who verifies them.",
  },
  {
    id: "product",
    instruction:
      "Ask something specific about a product line, feature, or service unique to this merchant from the research.",
  },
  {
    id: "shipping",
    instruction:
      "Ask about shipping costs, free shipping thresholds, or delivery times for this store.",
  },
  {
    id: "returns",
    instruction:
      "Ask about the return or refund policy — what's covered, how long, any conditions.",
  },
  {
    id: "stacking",
    instruction:
      "Ask whether multiple coupons or deals can be combined on a single order.",
  },
  {
    id: "newuser",
    instruction:
      "Ask if there's a specific first-order or new customer discount and what it covers.",
  },
  {
    id: "category",
    instruction:
      "Ask which product categories or items tend to have the best discounts at this store.",
  },
  {
    id: "frequency",
    instruction:
      "Ask how often new deals appear or how frequently the store runs promotions.",
  },
];

function getVariation(merchantName, category) {
  const h = stableHash(merchantName + "|" + category);
  const h2 = stableHash(merchantName + "|" + category + "|v2");
  const bp = detectBlueprint(category);
  const faqCount = 5 + (h2 % 4);
  const faqTypes = [];
  for (let i = 0; i < faqCount; i++) {
    const idx = (h2 >> (i * 4)) % FAQ_QUESTION_TYPES.length;
    const pick = FAQ_QUESTION_TYPES[(idx + i) % FAQ_QUESTION_TYPES.length];
    if (!faqTypes.find((f) => f.id === pick.id)) faqTypes.push(pick);
    else
      faqTypes.push(
        FAQ_QUESTION_TYPES[(idx + i + 1) % FAQ_QUESTION_TYPES.length],
      );
  }
  return {
    blueprint: bp,
    tone: TONES[h % 4],
    angle: ANGLES[(h >> 4) % 4],
    headingStyle: HEADING_STYLES[(h >> 8) % 3],
    sectionDepths: bp.sections.map((_, i) => {
      const depths = ["brief", "standard", "detailed"];
      return depths[(h2 >> (i * 3 + 1)) % 3];
    }),
    faqCount,
    faqTypes,
  };
}

// ─── DB / API HELPERS ─────────────────────────────────────────────
async function fetchMerchantData(merchantSlug, backendUrl) {
  if (!merchantSlug) return null;
  try {
    const res = await fetch(
      `${backendUrl}/api/seo/merchant-data?slug=${encodeURIComponent(merchantSlug)}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("DB fetch failed:", e.message);
    return null;
  }
}

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

// ─── PROMPTS ──────────────────────────────────────────────────────
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

function buildFinalPrompt(
  merchantName,
  category,
  research,
  variation,
  dbData,
  url,
) {
  const { blueprint, tone, angle, headingStyle, sectionDepths } = variation;
  const ds = buildDiscountSummary(dbData);
  const dbFacts = ds
    ? `
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
`
    : `\nNO DB DATA: Use research facts only. Do not invent discount figures.\n`;

  const sectionInstructions = blueprint.sections
    .map((s, i) => {
      const heading = buildHeading(s, merchantName, headingStyle.id);
      const depth = sectionDepths[i];
      const wordRange =
        depth === "brief"
          ? "65-90"
          : depth === "standard"
            ? "100-130"
            : "140-180";
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

H1 BANNED PATTERNS — never use these constructs:
- "${merchantName} Coupons & Promo Codes"
- "${merchantName} Coupons"
- "Save at ${merchantName}"
- "${merchantName} Discount Codes"
- "Best ${merchantName} Deals"
- Any H1 that could apply to any other store just by swapping the name
- H1 must reference something genuinely specific to ${merchantName} from the research or DB stats

FAQ RULES — READ CAREFULLY:
- Write exactly ${variation.faqCount} questions for this store
- Each question is assigned a specific TYPE below — follow the type instruction exactly
- BANNED question skeletons (never use):
  * "Does ${merchantName} offer coupons?"
  * "How do I use a ${merchantName} coupon?"
  * "What is the best ${merchantName} coupon?"
  * "Does ${merchantName} have a discount?"
  * Any question answerable for ANY store by just swapping the name
- Every answer must be 2-4 sentences and reference actual DB STATS or RESEARCH data
- Questions must be genuinely different from each other in structure and angle

ASSIGNED FAQ QUESTION TYPES FOR ${merchantName}:
${variation.faqTypes.map((f, i) => `Q${i + 1} [${f.id.toUpperCase()}]: ${f.instruction}`).join("\n")}

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
  "faqItems": ${JSON.stringify(
    Array.from({ length: variation.faqCount }, () => ({
      question: "...",
      answer: "...",
    })),
    null,
    4,
  )},
  "schemaData": {
    "breadcrumbName": "${merchantName}",
    "pageDescription": "..."
  },
  "variationProfile": "${blueprint.label} | ${tone.label} | ${angle.label} | ${headingStyle.label}"
}`;
}

// ─── CONTENT FORMATTERS ───────────────────────────────────────────
const sectionsToHtml = (sections) => {
  if (!sections) return "";
  return Object.values(sections)
    .map((s) => {
      const heading = typeof s === "object" ? s.heading : "";
      const body = typeof s === "object" ? s.body : s;
      return `${heading ? `<h2>${heading}</h2>` : ""}<p>${(body || "").replace(/\n/g, "</p><p>")}</p>`;
    })
    .join("\n");
};

const buildH2Blocks = (sections) => {
  if (!sections) return [];
  return Object.entries(sections).map(([key, s]) => ({
    id: key,
    heading: typeof s === "object" ? s.heading : key,
    body: typeof s === "object" ? s.body : s,
  }));
};

const buildH3Blocks = () => [];

// ─── UI COMPONENTS ────────────────────────────────────────────────
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

function StatusBadge({ bg, color, text }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 4,
        fontWeight: 500,
        background: bg,
        color,
      }}
    >
      {text}
    </span>
  );
}

function DBStatus({ status }) {
  const map = {
    connected: { bg: "#EAF3DE", color: "#2E5C0E", text: "✓ DB data loaded" },
    failed: { bg: "#FAEEDA", color: "#854F0B", text: "⚠ Gemini only (no DB)" },
    loading: { bg: "#E6F1FB", color: "#185FA5", text: "⟳ Fetching DB…" },
    idle: {
      bg: "var(--color-background-secondary)",
      color: "var(--color-text-secondary)",
      text: "○ DB not fetched",
    },
  };
  return <StatusBadge {...(map[status] || map.idle)} />;
}

function CrawlStatus({ status }) {
  const map = {
    loading: { bg: "#E6F1FB", color: "#185FA5", text: "⟳ Crawling…" },
    success: { bg: "#EAF3DE", color: "#2E5C0E", text: "✓ Live crawl used" },
    failed: { bg: "#FAEEDA", color: "#854F0B", text: "⚠ Crawl fallback" },
    idle: { bg: "#f8f9fa", color: "#6c757d", text: "No crawl" },
  };
  return <StatusBadge {...(map[status] || map.idle)} />;
}

function SaveStatus({ status }) {
  const map = {
    saving: { bg: "#E6F1FB", color: "#185FA5", text: "⟳ Saving to DB…" },
    saved: { bg: "#EAF3DE", color: "#2E5C0E", text: "✓ Saved to DB" },
    failed: { bg: "#FAECE7", color: "#993C1D", text: "✗ Save failed" },
    skipped: { bg: "#f8f9fa", color: "#6c757d", text: "— Not saved (no slug)" },
  };
  return <StatusBadge {...(map[status] || map.skipped)} />;
}

// ─── WORKER STATUS PANEL (new) ────────────────────────────────────
function WorkerPanel({ workers }) {
  // workers: { [keyIdx]: { store, stage, status } }
  const entries = Object.entries(workers);
  if (!entries.length) return null;
  return (
    <div
      style={{
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: "0.9rem",
      }}
    >
      <div
        style={{
          background: "var(--color-background-secondary)",
          padding: "6px 12px",
          fontSize: 11,
          fontWeight: 500,
          color: "var(--color-text-secondary)",
        }}
      >
        Worker Pool — {entries.length} keys active
      </div>
      {entries.map(([ki, w]) => (
        <div
          key={ki}
          style={{
            padding: "6px 12px",
            borderTop: "0.5px solid var(--color-border-tertiary)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
          }}
        >
          <span
            style={{
              width: 38,
              flexShrink: 0,
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            K{parseInt(ki) + 1}
          </span>
          <span
            style={{
              flex: 1,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {w.store || "—"}
          </span>
          <span
            style={{
              fontSize: 10,
              padding: "1px 7px",
              borderRadius: 3,
              whiteSpace: "nowrap",
              background:
                w.status === "idle"
                  ? "#f0f0f0"
                  : w.status === "error"
                    ? "#FAECE7"
                    : w.status === "done"
                      ? "#EAF3DE"
                      : "#E6F1FB",
              color:
                w.status === "idle"
                  ? "#6c757d"
                  : w.status === "error"
                    ? "#993C1D"
                    : w.status === "done"
                      ? "#2E5C0E"
                      : "#185FA5",
            }}
          >
            {w.stage || w.status}
          </span>
          {w.retrying && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 7px",
                borderRadius: 3,
                background: "#FFF3CD",
                color: "#856404",
              }}
            >
              retry {w.retryAttempt}/3
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────
export default function VariationEngine() {
  const [apiKey, setApiKey] = useState("");
  const [apiKeys, setApiKeys] = useState([""]);
  const [backendUrl, setBackendUrl] = useState(BACKEND_URL);
  const [model, setModel] = useState("gemini-3.1-flash-lite-preview");
  const [useDB, setUseDB] = useState(true);
  const [keyUsage, setKeyUsage] = useState({});

  // Worker pool state (new)
  const [workerStates, setWorkerStates] = useState({}); // { keyIdx: { store, stage, status, retrying, retryAttempt } }
  const deniedKeysRef = useRef(new Set());

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
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [output, setOutput] = useState(null);
  const [preview, setPreview] = useState(null);
  const [tab, setTab] = useState("seo");

  const [batchText, setBatchText] = useState("");
  const [batchResults, setBatchResults] = useState([]);
  const [batchDone, setBatchDone] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const stopRef = useRef(false);

  // ── Helpers ──
  const updateWorker = useCallback((keyIdx, patch) => {
    setWorkerStates((prev) => ({
      ...prev,
      [keyIdx]: { ...(prev[keyIdx] || {}), ...patch },
    }));
  }, []);

  const clearWorker = useCallback((keyIdx) => {
    setWorkerStates((prev) => {
      const next = { ...prev };
      delete next[keyIdx];
      return next;
    });
  }, []);

  const showPreview = () => {
    if (!merchant || !category) {
      setError("Enter merchant name and category first.");
      return;
    }
    setError("");
    setPreview(getVariation(merchant, category));
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

  // ── Single generate ──
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
    setSaveStatus("idle");
    let dbData = null,
      crawledText = "";
    if (useDB && merchantSlug) {
      setDbStatus("loading");
      setStatus("Fetching real coupon data from DB…");
      dbData = await fetchMerchantData(merchantSlug, backendUrl);
      setDbStatus(dbData ? "connected" : "failed");
    }
    if (dbData?.contentGenerated && !forceRegenerate) {
      setError(
        "Content already generated for this store. Enable 'Force Regenerate' to overwrite.",
      );
      setRunning(false);
      return;
    }
    if (url?.trim()) {
      setCrawlStatus("loading");
      setStatus("Crawling merchant website…");
      crawledText = await crawlMerchantSite(url, backendUrl);
      setCrawlStatus(crawledText.length > 200 ? "success" : "failed");
    }
    try {
      setStatus("Stage 1 — deep research…");
      const research = safeJSON(
        await callGeminiWithBackoff(
          buildResearchPrompt(merchant, category, url, crawledText, dbData),
          apiKey,
          model,
          0,
          null,
          null,
        ),
      );
      const variation = getVariation(merchant, category);
      setStatus("Stage 2 — generating content…");
      const data = safeJSON(
        await callGeminiWithBackoff(
          buildFinalPrompt(
            merchant,
            category,
            research,
            variation,
            dbData,
            url,
          ),
          apiKey,
          model,
          0,
          null,
          null,
        ),
      );
      const result = {
        ...data,
        variation,
        dbData,
        research,
        crawledUsed: crawlStatus === "success",
      };
      setOutput(result);
      setTab("seo");
      if (merchantSlug) {
        setSaveStatus("saving");
        setStatus("Saving content to DB…");
        const saveResult = await saveContentToDB(
          merchantSlug,
          {
            meta_title: data.seoTitle,
            meta_description: data.metaDescription,
            h1keyword: data.h1Tag,
            meta_keywords: (data.focusKeywords || []).join(", "),
            description_html: sectionsToHtml(data.sections),
            faqs: data.faqItems || [],
            coupon_h2_blocks: buildH2Blocks(data.sections),
            coupon_h3_blocks: buildH3Blocks(),
          },
          backendUrl,
        );
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

  // ─── BACKOFF (replaces callWithRetry — no key rotation args needed externally) ───
  // keyEntry: { k: string, i: number }
  // onRetry: optional callback(attempt, waitMs) for UI updates
  // onKeyDenied: optional callback(keyIdx)
  const callGeminiWithBackoff = async (
    prompt,
    apiKeyStr,
    modelStr,
    attempt = 0,
    onRetry,
    onKeyDenied,
  ) => {
    try {
      return await callGemini(prompt, apiKeyStr, modelStr);
    } catch (e) {
      const msg = (e.message || "").toLowerCase();
      const is429 = e.message?.includes("429") || msg.includes("quota");
      const isHighLoad =
        msg.includes("high demand") ||
        msg.includes("high load") ||
        msg.includes("experiencing high");
      const isDenied =
        msg.includes("denied access") ||
        msg.includes("project has been denied");
      const isServer = e.message?.includes("500") || e.message?.includes("503");
      const isRetryable = (is429 || isHighLoad || isServer) && !isDenied;

      if (isDenied) {
        onKeyDenied?.();
        throw new Error(`Key denied access — removed from rotation`);
      }
      if (isRetryable && attempt < 3) {
        // Exponential backoff: 10s, 20s, 40s ± up to 2s jitter
        const base = is429 ? 30000 : isHighLoad ? 10000 : 5000;
        const exp = base * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 4000) - 2000; // ±2s
        const wait = Math.max(3000, exp + jitter);
        onRetry?.(attempt + 1, wait);
        await new Promise((res) => setTimeout(res, wait));
        return callGeminiWithBackoff(
          prompt,
          apiKeyStr,
          modelStr,
          attempt + 1,
          onRetry,
          onKeyDenied,
        );
      }
      throw e;
    }
  };

  // ─── PROCESS ONE STORE (used by both single worker and retry) ───
  const processStore = async (r, keyEntry) => {
    let dbData = null,
      crawledText = "";
    if (useDB && r.slug) dbData = await fetchMerchantData(r.slug, backendUrl);
    if (dbData?.contentGenerated) return { skipped: true };
    if (r.url) crawledText = await crawlMerchantSite(r.url, backendUrl);

    const onRetry = (attempt, waitMs) => {
      updateWorker(keyEntry.i, {
        retrying: true,
        retryAttempt: attempt,
        stage: `retry ${attempt}/3 — ${Math.round(waitMs / 1000)}s`,
      });
    };
    const onKeyDenied = () => {
      deniedKeysRef.current.add(keyEntry.i);
      clearWorker(keyEntry.i);
    };

    updateWorker(keyEntry.i, {
      store: r.name,
      stage: "research",
      status: "running",
      retrying: false,
    });
    const researchRaw = await callGeminiWithBackoff(
      buildResearchPrompt(r.name, r.category, r.url, crawledText, dbData),
      keyEntry.k,
      model,
      0,
      onRetry,
      onKeyDenied,
    );
    const research = safeJSON(researchRaw);

    // Check stop between the two stages — earliest safe exit point
    if (stopRef.current) throw new Error("STOPPED");

    updateWorker(keyEntry.i, {
      store: r.name,
      stage: "content",
      status: "running",
      retrying: false,
    });
    const variation = getVariation(r.name, r.category);
    const dataRaw = await callGeminiWithBackoff(
      buildFinalPrompt(r.name, r.category, research, variation, dbData, r.url),
      keyEntry.k,
      model,
      0,
      onRetry,
      onKeyDenied,
    );
    const data = safeJSON(dataRaw);

    setKeyUsage((prev) => ({
      ...prev,
      [`key${keyEntry.i}`]: (prev[`key${keyEntry.i}`] || 0) + 2,
    }));

    let savedOk = null;
    if (r.slug) {
      updateWorker(keyEntry.i, { stage: "saving" });
      const saveResult = await saveContentToDB(
        r.slug,
        {
          meta_title: data.seoTitle,
          meta_description: data.metaDescription,
          h1keyword: data.h1Tag,
          meta_keywords: (data.focusKeywords || []).join(", "),
          description_html: sectionsToHtml(data.sections),
          faqs: data.faqItems || [],
          coupon_h2_blocks: buildH2Blocks(data.sections),
          coupon_h3_blocks: buildH3Blocks(),
        },
        backendUrl,
      );
      savedOk = !saveResult?.error;
    }

    return { ...data, variation, dbData, savedOk };
  };

  // ─── WORKER POOL BATCH (replaces serial for-loop) ────────────────
  const runBatch = async (rowsOverride = null) => {
    const validKeys = apiKeys
      .map((k, i) => ({ k: k.trim(), i }))
      .filter((x) => x.k);

    if (!validKeys.length) {
      setError("Add at least one Gemini API key for batch.");
      return;
    }

    const rows = rowsOverride || parseBatch(batchText);
    if (!rows.length) {
      setError(
        "No merchants found. Format: Name, Category, URL (opt), Slug (opt)",
      );
      return;
    }

    if (!rowsOverride) {
      setError("");
      setBatchResults([]);
      setBatchDone(0);
      setKeyUsage({});
      setWorkerStates({});
      deniedKeysRef.current = new Set();
    }

    stopRef.current = false;
    setRunning(true);
    setBatchTotal(rows.length);

    // Shared queue — index pointer advanced atomically via closure
    // JS is single-threaded so no true race on this counter
    let queueIdx = 0;
    const getNextRow = () => {
      if (queueIdx >= rows.length) return null;
      return rows[queueIdx++];
    };

    // One async worker per key
    const runWorker = async (keyEntry) => {
      while (true) {
        // Stop check at top of every iteration
        if (stopRef.current) {
          clearWorker(keyEntry.i);
          break;
        }

        // Deny check — key may have been denied mid-batch
        if (deniedKeysRef.current.has(keyEntry.i)) {
          clearWorker(keyEntry.i);
          break;
        }

        const row = getNextRow();
        if (!row) {
          clearWorker(keyEntry.i);
          break;
        } // queue exhausted

        updateWorker(keyEntry.i, {
          store: row.name,
          stage: "starting",
          status: "running",
          retrying: false,
        });

        try {
          const result = await processStore(row, keyEntry);

          if (stopRef.current) {
            // Store finished but stop was requested — still record result, then exit
            if (!result.skipped) {
              setBatchResults((prev) => [
                ...prev,
                {
                  merchant: row.name,
                  category: row.category,
                  slug: row.slug,
                  status: "done",
                  saved: result.savedOk,
                  keyUsed: keyEntry.i + 1,
                  ...result,
                },
              ]);
            }
            clearWorker(keyEntry.i);
            break;
          }

          setBatchResults((prev) => [
            ...prev,
            result.skipped
              ? {
                  merchant: row.name,
                  category: row.category,
                  slug: row.slug,
                  status: "skipped",
                }
              : {
                  merchant: row.name,
                  category: row.category,
                  slug: row.slug,
                  status: "done",
                  saved: result.savedOk,
                  keyUsed: keyEntry.i + 1,
                  ...result,
                },
          ]);
          setBatchDone((prev) => prev + 1);
          updateWorker(keyEntry.i, { stage: "done", status: "done" });
        } catch (e) {
          if (e.message === "STOPPED") {
            clearWorker(keyEntry.i);
            break;
          }

          setBatchResults((prev) => [
            ...prev,
            {
              merchant: row.name,
              category: row.category,
              url: row.url,
              slug: row.slug,
              status: "error",
              error: e.message,
              keyUsed: keyEntry.i + 1,
            },
          ]);
          setBatchDone((prev) => prev + 1);
          updateWorker(keyEntry.i, { stage: "error", status: "error" });

          // Brief pause after an error before this worker picks up the next store
          // Prevents hammering if something systemic is wrong
          if (!stopRef.current)
            await new Promise((res) => setTimeout(res, 2000));
        }
      }
    };

    // Launch all workers concurrently — one per valid key
    await Promise.allSettled(validKeys.map((keyEntry) => runWorker(keyEntry)));

    setRunning(false);
    setWorkerStates({});
    setStatus(stopRef.current ? "Stopped." : "Batch complete.");
  };

  // ── Retry only failed stores ──
  const retryFailed = () => {
    const failed = batchResults.filter((r) => r.status === "error");
    if (!failed.length) return;
    const rows = failed.map((r) => ({
      name: r.merchant,
      category: r.category,
      url: r.url || "",
      slug: r.slug || "",
    }));
    setBatchResults((prev) => prev.filter((r) => r.status !== "error"));
    runBatch(rows);
  };

  // ── Load pending ──
  const loadPending = async () => {
    setStatus("Loading pending stores from DB…");
    const data = await fetchPendingMerchants(backendUrl);
    if (!data?.merchants?.length) {
      setError("No pending stores found or backend unreachable.");
      setStatus("");
      return;
    }
    const csv = data.merchants
      .map(
        (m) =>
          `${m.name}, ${m.category || "General"}, ${m.webUrl || ""}, ${m.slug}`,
      )
      .join("\n");
    setBatchText(csv);
    setStatus(`Loaded ${data.merchants.length} pending stores.`);
  };

  // ── Exports ──
  const exportCSV = (results) => {
    const done = results.filter((r) => r.status === "done");
    const headers = [
      "merchant",
      "category",
      "slug",
      "saved",
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
        r.saved ? "yes" : "no",
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

  const exportFailedCSV = (results) => {
    const failed = results.filter((r) => r.status === "error");
    if (!failed.length) return;
    const headers = [
      "merchant",
      "category",
      "url",
      "slug",
      "error",
      "key_used",
    ];
    const rows = failed.map((r) =>
      [
        r.merchant,
        r.category,
        r.url || "",
        r.slug || "",
        r.error || "",
        r.keyUsed || "",
      ]
        .map((v) => `"${(v || "").replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `savingharbor-failed-${Date.now()}.csv`;
    a.click();
  };

  // ── Derived ──
  const allContent = output?.sections
    ? Object.values(output.sections)
        .map((s) => (typeof s === "object" ? s.body || "" : s))
        .join("\n\n")
    : "";
  const wordCount = allContent.split(/\s+/).filter(Boolean).length;
  const batchRows = parseBatch(batchText);
  const activeWorkerCount = Object.keys(workerStates).length;

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

  return (
    <div
      style={{
        padding: "1.5rem 0",
        fontFamily: "var(--font-sans)",
        maxWidth: 700,
      }}
    >
      {/* Header */}
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
        <strong>v2.4 — Worker Pool + Smart Backoff</strong>
        <br />
        <span style={{ fontSize: 12 }}>
          384 variations · Live crawl · Real DB coupons · N-key parallel workers
          · Exponential backoff
        </span>
      </div>

      {/* Mode toggle */}
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

      {/* Config */}
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

        {mode === "single" && (
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
                <option value="gemini-3.1-flash-lite-preview">
                  gemini-3.1-flash-lite-preview (500 RPD)
                </option>
                <option value="gemini-2.5-flash-lite">
                  gemini-2.5-flash-lite (20 RPD)
                </option>
                <option value="gemini-2.5-flash">
                  gemini-2.5-flash (20 RPD)
                </option>
              </select>
            </div>
          </div>
        )}

        {mode === "batch" && (
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--color-text-secondary)",
                }}
              >
                Gemini API Keys — Worker per Key (
                {apiKeys.filter((k) => k.trim()).length} active)
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => setApiKeys((prev) => [...prev, ""])}
                  disabled={running || apiKeys.length >= 10}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    border: "0.5px solid var(--color-border-secondary)",
                    borderRadius: 4,
                    background: "var(--color-background-primary)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  + Add Key
                </button>
                {apiKeys.length > 1 && (
                  <button
                    onClick={() => setApiKeys((prev) => prev.slice(0, -1))}
                    disabled={running}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      border: "0.5px solid #C04828",
                      borderRadius: 4,
                      background: "transparent",
                      color: "#C04828",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    − Remove
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {apiKeys.map((k, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--color-text-tertiary)",
                      width: 40,
                      flexShrink: 0,
                    }}
                  >
                    Key {i + 1}
                  </span>
                  <input
                    type="password"
                    value={k}
                    onChange={(e) =>
                      setApiKeys((prev) =>
                        prev.map((x, j) => (j === i ? e.target.value : x)),
                      )
                    }
                    placeholder="AIzaSy•••••••••••"
                    style={{ ...inputStyle, flex: 1 }}
                    disabled={running}
                  />
                  {keyUsage[`key${i}`] > 0 && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        background: "#E6F1FB",
                        color: "#185FA5",
                        borderRadius: 3,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {keyUsage[`key${i}`]} calls
                    </span>
                  )}
                  {deniedKeysRef.current.has(i) && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        background: "#FAECE7",
                        color: "#993C1D",
                        borderRadius: 3,
                        whiteSpace: "nowrap",
                      }}
                    >
                      denied
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
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
                <option value="gemini-3.1-flash-lite-preview">
                  gemini-3.1-flash-lite-preview (500 RPD/key)
                </option>
                <option value="gemini-2.5-flash-lite">
                  gemini-2.5-flash-lite (20 RPD/key)
                </option>
                <option value="gemini-2.5-flash">
                  gemini-2.5-flash (20 RPD/key)
                </option>
              </select>
            </div>
          </div>
        )}

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
              Backend URL
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
                  DB Slug (for live coupon data + save)
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

          {running && (
            <div
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 8,
                flexWrap: "wrap",
              }}
            >
              <DBStatus status={dbStatus} />
              <CrawlStatus status={crawlStatus} />
            </div>
          )}

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
                  <CrawlStatus
                    status={output.crawledUsed ? "success" : "idle"}
                  />
                  <SaveStatus status={saveStatus} />
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
                        ✓ Real DB data injected into content prompt
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
                      <Field
                        label="Top Offers"
                        value={
                          (output.dbData.coupons || [])
                            .map(formatDiscount)
                            .filter(Boolean)
                            .join(" · ") || "—"
                        }
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
                      ⚠ No DB data used. Enable "Use DB Data" and provide a
                      slug, or the backend call failed.
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
            Each key runs as an independent worker. N keys = N stores processed
            in parallel.
          </div>

          <div style={{ marginBottom: "0.9rem" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--color-text-secondary)",
                }}
              >
                Merchant List (up to 500 per session)
              </label>
              <button
                onClick={loadPending}
                disabled={running}
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  border: "0.5px solid #185FA5",
                  borderRadius: 4,
                  background: "#E6F1FB",
                  color: "#185FA5",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                ⬇ Load Pending Stores
              </button>
            </div>
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              disabled={running}
              placeholder={
                "Healthyline, Health & Wellness, https://healthyline.com, healthyline-coupons\nParsec, Software, https://parsec.app, parsec-coupons\nBarbican, Travel & Tourism,,"
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

          {batchRows.length > 0 && !running && (
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
              <span>
                🔑 <strong>{apiKeys.filter((k) => k.trim()).length}</strong>{" "}
                workers
              </span>
              <span>
                ⏱ ~
                {Math.ceil(
                  ((batchRows.length /
                    Math.max(apiKeys.filter((k) => k.trim()).length, 1)) *
                    25) /
                    60,
                )}{" "}
                min
              </span>
              <span>
                🗄 DB slugs: {batchRows.filter((r) => r.slug).length}/
                {batchRows.length}
              </span>
            </div>
          )}

          {/* Live worker panel */}
          {running && activeWorkerCount > 0 && (
            <WorkerPanel workers={workerStates} />
          )}

          {running && (
            <div style={{ marginBottom: "0.9rem" }}>
              <ProgressBar value={batchDone} max={batchTotal} />
              <div
                style={{
                  fontSize: 12,
                  color: "var(--color-text-secondary)",
                  marginTop: 4,
                }}
              >
                {batchDone}/{batchTotal} complete · {activeWorkerCount} workers
                active
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
            <button
              onClick={() => runBatch()}
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
                ? `⏳ Processing ${batchDone}/${batchTotal}…`
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
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    display: "flex",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: "#2E5C0E" }}>
                    ✓ {batchResults.filter((r) => r.status === "done").length}{" "}
                    done
                  </span>
                  <span
                    style={{
                      color:
                        batchResults.filter((r) => r.status === "error")
                          .length > 0
                          ? "#993C1D"
                          : "var(--color-text-secondary)",
                    }}
                  >
                    ✗ {batchResults.filter((r) => r.status === "error").length}{" "}
                    failed
                  </span>
                  {batchResults.filter((r) => r.status === "skipped").length >
                    0 && (
                    <span style={{ color: "#6c757d" }}>
                      ⏭{" "}
                      {
                        batchResults.filter((r) => r.status === "skipped")
                          .length
                      }{" "}
                      skipped
                    </span>
                  )}
                  <span>
                    💾 {batchResults.filter((r) => r.saved).length} saved
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {batchResults.filter((r) => r.status === "error").length >
                    0 &&
                    !running && (
                      <button
                        onClick={retryFailed}
                        style={{
                          fontSize: 11,
                          padding: "3px 10px",
                          border: "0.5px solid #185FA5",
                          borderRadius: 4,
                          background: "#E6F1FB",
                          color: "#185FA5",
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        ↻ Retry Failed (
                        {
                          batchResults.filter((r) => r.status === "error")
                            .length
                        }
                        )
                      </button>
                    )}
                  {batchResults.filter((r) => r.status === "error").length >
                    0 && (
                    <button
                      onClick={() => exportFailedCSV(batchResults)}
                      style={{
                        fontSize: 11,
                        padding: "3px 10px",
                        border: "0.5px solid #C04828",
                        borderRadius: 4,
                        background: "#FAECE7",
                        color: "#993C1D",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      ⬇ Failed CSV
                    </button>
                  )}
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
                    ⬇ JSON
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
                        r.status === "error"
                          ? "#FFF8F6"
                          : i % 2 === 0
                            ? "var(--color-background-primary)"
                            : "var(--color-background-secondary)",
                    }}
                  >
                    <span
                      style={{
                        color:
                          r.status === "done"
                            ? "#2E5C0E"
                            : r.status === "skipped"
                              ? "#6c757d"
                              : "#993C1D",
                      }}
                    >
                      {r.status === "done"
                        ? "✓"
                        : r.status === "skipped"
                          ? "⏭"
                          : "✗"}
                    </span>
                    <span style={{ flex: 1, fontWeight: 500 }}>
                      {r.merchant}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color:
                          r.status === "error"
                            ? "#993C1D"
                            : "var(--color-text-secondary)",
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.status === "done"
                        ? r.variation?.blueprint?.label +
                          " / " +
                          r.variation?.tone?.label
                        : r.error}
                    </span>
                    {r.status === "skipped" && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          background: "#f0f0f0",
                          color: "#6c757d",
                          borderRadius: 3,
                        }}
                      >
                        Already done
                      </span>
                    )}
                    {r.keyUsed && r.status !== "skipped" && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          background: "#f0f0f0",
                          color: "#555",
                          borderRadius: 3,
                        }}
                      >
                        K{r.keyUsed}
                      </span>
                    )}
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
                    {r.saved && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          background: "#EAF3DE",
                          color: "#2E5C0E",
                          borderRadius: 3,
                        }}
                      >
                        Saved ✓
                      </span>
                    )}
                    {r.saved === false && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          background: "#FAECE7",
                          color: "#993C1D",
                          borderRadius: 3,
                        }}
                      >
                        Save ✗
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!running && status && (
            <div
              style={{
                marginTop: "0.9rem",
                fontSize: 12,
                color: "var(--color-text-secondary)",
              }}
            >
              {status}
            </div>
          )}
        </div>
      )}

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
