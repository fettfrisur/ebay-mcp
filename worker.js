// eBay.de → MCP server for Claude (Cloudflare Worker, no dependencies) — v2.0
// Secrets: EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID), ACCESS_KEY (long random string)
// Connector URL: https://<your-worker>.workers.dev/mcp
//   with request header x-api-key: <ACCESS_KEY> (or Authorization: Bearer <ACCESS_KEY>)
// Only requests from Anthropic's egress range (160.79.104.0/21) are accepted,
// unless the variable ALLOW_ALL_IPS is set to "true" (for testing).
// Nothing from eBay is stored: only OAuth app tokens are kept in memory until they expire.
// Tool results are plain text written for Claude to read, not JSON.

const API = "https://api.ebay.com";
const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const FEEDBACK_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.feedback.readonly";
const DEFAULT_ZIP = "70173";
const MAX_REP_SELLERS = 20; // 2 Feedback API calls per seller; keeps one search under 50 subrequests
const tokens = {};

// ---------- eBay plumbing ----------

class EbayError extends Error {
  constructor(message, status, kind) { super(message); this.status = status; this.kind = kind; }
}

async function getToken(env, scope) {
  const t = tokens[scope];
  if (t && Date.now() < t.expires - 60_000) return t.value;
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent(scope),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new EbayError(`eBay token error ${res.status}: ${body.slice(0, 300)}`, res.status, body.includes("invalid_scope") ? "scope" : "token");
  }
  const data = await res.json();
  tokens[scope] = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function ebayGet(env, path, { zip = DEFAULT_ZIP, scope = BROWSE_SCOPE } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: {
        Authorization: `Bearer ${await getToken(env, scope)}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_DE",
        "Accept-Language": "de-DE",
        "X-EBAY-C-ENDUSERCTX": "contextualLocation=" + encodeURIComponent(`country=DE,zip=${zip}`),
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    if (e instanceof EbayError) throw e;
    throw new EbayError(String(e.message || e), 0, e.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try { const j = JSON.parse(body); msg = j.errors?.[0]?.longMessage || j.errors?.[0]?.message || j.message || msg; } catch {}
    throw new EbayError(`HTTP ${res.status}: ${msg}`, res.status, "http");
  }
  return res.json();
}

// Human-readable reason why a Feedback API lookup failed
function feedbackFailure(e) {
  if (e.kind === "scope") return "Feedback API scope not granted to this eBay app";
  if (e.kind === "token") return `eBay token request failed, HTTP ${e.status}`;
  if (e.kind === "timeout") return "eBay Feedback API timed out";
  if (e.kind === "network") return "eBay Feedback API unreachable";
  if (e.status === 429) return "eBay Feedback API quota exceeded";
  if (e.status === 401 || e.status === 403) return `eBay Feedback API refused access, HTTP ${e.status}`;
  if (e.status === 404) return "seller not found by eBay Feedback API";
  if (e.status >= 500) return `eBay Feedback API unavailable, HTTP ${e.status}`;
  return `eBay Feedback API error: ${e.message}`;
}

// ---------- formatting helpers ----------

const num = (v) => (v == null ? null : Number(v));
const eur = (p) => {
  if (!p) return null;
  const v = Number(p.value).toFixed(2);
  return p.currency === "EUR" ? `${v} €` : `${v} ${p.currency}`;
};
const cleanUrl = (u) => (u ? u.split("?")[0] : "");
const oneLine = (s, max) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ago = (p) => (p?.value != null ? `${plural(p.value, String(p.unit || "").toLowerCase())} ago` : "date unknown");
const berlin = (iso) => {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Berlin", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(",", "") + " Berlin time";
};
const accountType = (t) => (t === "BUSINESS" ? "business seller" : t === "INDIVIDUAL" ? "private seller" : null);

function priceLine(i) {
  const opts = i.buyingOptions || [];
  const parts = [];
  if (opts.includes("AUCTION")) {
    const bid = eur(i.currentBidPrice) || eur(i.price);
    parts.push(`current bid: ${bid} (auction, ${plural(i.bidCount ?? 0, "bid")}${i.itemEndDate ? ", ends " + berlin(i.itemEndDate) : ""})`);
    if (opts.includes("FIXED_PRICE") && i.price) parts.push(`or buy now: ${eur(i.price)}`);
  } else {
    const how = opts.includes("BEST_OFFER") ? "fixed price, offers accepted" : "fixed price";
    parts.push(`price: ${eur(i.price)} (${how})`);
  }
  parts.push(`condition: ${i.condition || "unknown"}`);
  return parts.join(" · ");
}

function shippingText(opts) {
  const o = opts?.[0];
  if (!o) return null;
  if (o.shippingCostType === "CALCULATED" && !o.shippingCost) return "shipping: calculated at checkout";
  if (!o.shippingCost) return null;
  return Number(o.shippingCost.value) === 0 ? "shipping: free" : `shipping: ${eur(o.shippingCost)}`;
}

function locationLine(i, zip, pickupOnly) {
  const parts = [];
  const pc = i.itemLocation?.postalCode;
  const city = i.itemLocation?.city;
  parts.push(`location: ${[pc ? `postcode ${pc}` : null, city].filter(Boolean).join(" ") || "unknown"}`);
  if (i.distanceFromPickupLocation) parts.push(`${i.distanceFromPickupLocation.value} ${i.distanceFromPickupLocation.unitOfMeasure} from ${zip}`);
  if (pickupOnly) parts.push("local pickup offered");
  const ship = shippingText(i.shippingOptions);
  if (ship) parts.push(ship);
  return parts.join(" · ");
}

// ---------- seller reputation ----------

function distribution(summaryResp) {
  // returns { "365": {pos, neu, neg}, ... } for ratings received as a seller
  const out = {};
  for (const s of summaryResp?.feedbackRatingSummary || []) {
    for (const r of s.ratingSummaryByRatingType || []) {
      if (r.userRoleType !== "SELLER") continue; // ratings received as seller
      const d = { pos: 0, neu: 0, neg: 0 };
      for (const v of r.feedbackRatingValueDistribution || []) {
        if (v.value === "POSITIVE") d.pos = v.count;
        if (v.value === "NEUTRAL") d.neu = v.count;
        if (v.value === "NEGATIVE") d.neg = v.count;
      }
      out[String(r.period?.value)] = d;
    }
  }
  return out;
}

function distText(d) {
  if (!d) return "no data";
  const total = d.pos + d.neu + d.neg;
  if (total === 0) return "no ratings";
  const pct = d.pos + d.neg > 0 ? ` (${((100 * d.pos) / (d.pos + d.neg)).toFixed(1)}% positive)` : "";
  return `${d.pos} pos / ${d.neu} neu / ${d.neg} neg${pct}`;
}

function feedbackEntryLines(e, indent) {
  const item = e.orderLineItemSummary || {};
  const meta = [ago(e.feedbackEnteredPeriod)];
  if (item.listingTitle) meta.push(`item "${oneLine(item.listingTitle, 70)}"${item.listingPrice ? ", " + eur(item.listingPrice) : ""}`);
  const text = e.feedbackComment?.commentTextRemovedPerPolicy ? "[comment removed by eBay policy]" : `"${oneLine(e.feedbackComment?.commentText, 280)}"`;
  const lines = [`${indent}${String(e.commentType || "").toLowerCase()} (${meta.join(", ")}): ${text}`];
  if (e.replyComment?.commentText) lines.push(`${indent}  seller replied: "${oneLine(e.replyComment.commentText, 200)}"`);
  if (e.followupComment?.commentText) lines.push(`${indent}  buyer follow-up: "${oneLine(e.followupComment.commentText, 200)}"`);
  return lines;
}

const feedbackPath = (user, filters, extra = {}) => {
  const q = new URLSearchParams({ user_id: user, feedback_type: "FEEDBACK_RECEIVED", ...extra });
  if (filters.length) q.set("filter", filters.join(","));
  return `/commerce/feedback/v1/feedback?${q}`;
};

// Compact reputation block used inside search results and item details
async function reputationLines(env, seller, indent = "    ") {
  const who = [`seller: ${seller.username || "unknown"}`];
  if (seller.feedbackScore != null) who.push(`score ${seller.feedbackScore}`);
  const acct = accountType(seller.sellerAccountType);
  if (acct) who.push(acct);
  if (!seller.username) return [indent + who.join(" · ") + " · seller rep: unavailable (eBay did not return a username)"];
  const user = seller.username;
  const [sum, neg] = await Promise.allSettled([
    ebayGet(env, `/commerce/feedback/v1/feedback_rating_summary?${new URLSearchParams({ user_id: user, filter: "ratingType:OVERALL_EXPERIENCE" })}`, { scope: FEEDBACK_SCOPE }),
    ebayGet(env, feedbackPath(user, ["role:SELLER", "commentType:NEGATIVE"], { sort: "TIME", limit: "25" }), { scope: FEEDBACK_SCOPE }),
  ]);
  if (sum.status === "rejected" && neg.status === "rejected") {
    return [indent + who.join(" · ") + ` · seller rep: unavailable (${feedbackFailure(sum.reason)})`];
  }
  const lines = [];
  const rep = [];
  if (sum.status === "fulfilled") rep.push(`last 12 mo: ${distText(distribution(sum.value)["365"])}`);
  else rep.push(`last 12 mo: unavailable (${feedbackFailure(sum.reason)})`);
  if (neg.status === "fulfilled") {
    const n = neg.value.pagination?.total ?? (neg.value.feedbackEntries || []).length;
    rep.push(`lifetime negatives: ${n === 0 ? "none" : n}`);
  } else rep.push(`lifetime negatives: unavailable (${feedbackFailure(neg.reason)})`);
  lines.push(indent + who.join(" · "));
  lines.push(indent + "  " + rep.join(" · "));
  const latest = neg.status === "fulfilled" ? neg.value.feedbackEntries?.[0] : null;
  if (latest) lines.push(...feedbackEntryLines(latest, indent + "  latest "));
  return lines;
}

// ---------- tools ----------

const CONDITIONS = { new: "1000", used: "3000", refurbished: "2000|2010|2020|2030|2500", for_parts: "7000" };
const SORT_LABEL = { price: "price ↑", "-price": "price ↓", newlyListed: "newest first", endingSoonest: "ending soonest", distance: "nearest first" };

async function searchItems(env, a) {
  if (!a.query || !String(a.query).trim()) throw new Error("query is required, e.g. \"Pixel 6a\"");
  const zip = a.postal_code || DEFAULT_ZIP;
  const limit = Math.max(1, Math.min(Number(a.limit) || 20, 50));
  const f = ["itemLocationCountry:DE"];
  if (a.min_price != null || a.max_price != null) f.push(`price:[${a.min_price ?? ""}..${a.max_price ?? ""}]`, "priceCurrency:EUR");
  if (a.condition && a.condition !== "any") {
    if (!CONDITIONS[a.condition]) throw new Error(`unknown condition "${a.condition}"; use any, new, used, refurbished or for_parts`);
    f.push(`conditionIds:{${CONDITIONS[a.condition]}}`);
  }
  if (a.buy_it_now_only) f.push("buyingOptions:{FIXED_PRICE}");
  if (a.radius_km) f.push("pickupCountry:DE", `pickupPostalCode:${zip}`, `pickupRadius:${a.radius_km}`, "pickupRadiusUnit:km", "deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP}");
  const q = new URLSearchParams({ q: a.query, filter: f.join(","), limit: String(limit) });
  if (a.sort) q.set("sort", a.sort);
  if (a.category_id) q.set("category_ids", a.category_id);
  const data = await ebayGet(env, `/buy/browse/v1/item_summary/search?${q}`, { zip });
  const items = data.itemSummaries || [];

  const head = [`eBay.de search "${a.query}"`];
  head.push(`condition: ${a.condition || "any"}`);
  if (a.min_price != null) head.push(`min ${a.min_price} €`);
  if (a.max_price != null) head.push(`max ${a.max_price} €`);
  if (a.category_id) head.push(`category ${a.category_id}`);
  if (a.radius_km) head.push(`local pickup within ${a.radius_km} km of ${zip}`);
  if (a.buy_it_now_only) head.push("buy-now only");
  head.push(`sort: ${SORT_LABEL[a.sort] || "best match"}`);
  head.push(`showing ${items.length} of ${data.total ?? items.length}`);
  const out = [head.join(" · ")];
  if (!items.length) {
    out.push("", "No listings found. Try fewer filters, a higher max price, or a broader query.");
    return out.join("\n");
  }

  // one reputation lookup per distinct seller, in parallel, capped
  const sellers = [...new Set(items.map((i) => i.seller?.username).filter(Boolean))];
  const looked = sellers.slice(0, MAX_REP_SELLERS);
  const repMap = new Map(await Promise.all(looked.map(async (u) => {
    const s = items.find((i) => i.seller?.username === u).seller;
    return [u, await reputationLines(env, s).catch((e) => [`    seller: ${u} · seller rep: unavailable (${feedbackFailure(e)})`])];
  })));
  const shown = new Set();

  items.forEach((i, idx) => {
    out.push("");
    out.push(`[${idx + 1}] ${oneLine(i.title, 120)}`);
    out.push(`    ${priceLine(i)}`);
    out.push(`    ${locationLine(i, zip, !!a.radius_km)}`);
    const u = i.seller?.username;
    if (u && shown.has(u)) {
      out.push(`    seller: ${u} (reputation shown above)`);
    } else if (u && repMap.has(u)) {
      out.push(...repMap.get(u));
      shown.add(u);
    } else if (u) {
      const s = i.seller;
      out.push(`    seller: ${u} · score ${s.feedbackScore ?? "?"} · seller rep: skipped (more than ${MAX_REP_SELLERS} distinct sellers in this search; use get_seller_feedback for this one)`);
    } else {
      out.push("    seller: unknown");
    }
    out.push(`    item id: ${i.itemId} · ${cleanUrl(i.itemWebUrl)}`);
    if (i.image?.imageUrl) out.push(`    photo: ${i.image.imageUrl}`);
  });
  if (sellers.length > MAX_REP_SELLERS) out.push("", `note: reputation looked up for the first ${MAX_REP_SELLERS} of ${sellers.length} sellers.`);
  return out.join("\n");
}

async function getItem(env, a) {
  if (!a.item_id) throw new Error("item_id is required, e.g. v1|198741885103|0 (from search results)");
  const i = await ebayGet(env, `/buy/browse/v1/item/${encodeURIComponent(a.item_id)}`);
  const out = [oneLine(i.title, 200)];
  out.push(priceLine(i));
  if (i.conditionDescription) out.push(`seller's condition note: "${oneLine(i.conditionDescription, 500)}"`);
  out.push(locationLine(i, DEFAULT_ZIP, false));
  const rt = i.returnTerms;
  if (rt) out.push(rt.returnsAccepted ? `returns: accepted${rt.returnPeriod ? ` within ${rt.returnPeriod.value} ${String(rt.returnPeriod.unit).toLowerCase()}s` : ""}${rt.returnShippingCostPayer ? `, return shipping paid by ${String(rt.returnShippingCostPayer).toLowerCase()}` : ""}` : "returns: not accepted");
  if (i.seller) out.push(...(await reputationLines(env, i.seller, "")));
  const aspects = i.localizedAspects || [];
  if (aspects.length) {
    out.push("", "specs:");
    for (const x of aspects.slice(0, 40)) out.push(`  ${x.name}: ${oneLine(x.value, 150)}`);
  }
  const desc = (i.description || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const text = i.shortDescription ? i.shortDescription : desc;
  if (text) out.push("", `description: ${oneLine(text, 2500)}`);
  const photos = [i.image?.imageUrl, ...(i.additionalImages || []).map((x) => x.imageUrl)].filter(Boolean).slice(0, 5);
  if (photos.length) out.push("", "photos:", ...photos.map((p) => `  ${p}`));
  out.push("", `item id: ${i.itemId} · ${cleanUrl(i.itemWebUrl)}`);
  return out.join("\n");
}

const TOPICS = ["shipping", "service", "packaging", "description", "seller-satisfaction", "overall-satisfaction", "refund", "inventory", "customer loyalty", "seller-other", "quality", "price", "condition", "fit", "appearance", "dimensions", "usage", "product-satisfaction", "product-other", "extras"];

async function sellerFeedback(env, a) {
  const user = String(a.username || "").trim();
  if (!user) throw new Error("username is required (shown as 'seller:' in search results)");
  const type = a.comment_type || "negative";
  const filters = ["role:SELLER"]; // eBay's role filter is the rated user's role: feedback received as a seller
  if (type !== "all") {
    if (!["positive", "neutral", "negative"].includes(type)) throw new Error("comment_type must be negative, neutral, positive or all");
    filters.push(`commentType:${type.toUpperCase()}`);
  }
  if (a.period_days) {
    if (![7, 30, 90, 180, 365].includes(Number(a.period_days))) throw new Error("period_days must be 7, 30, 90, 180 or 365 (omit for lifetime)");
    filters.push(`period:${a.period_days}`);
  }
  if (a.topic) {
    if (!TOPICS.includes(a.topic)) throw new Error(`unknown topic; use one of: ${TOPICS.join(", ")}`);
    filters.push(`topics:${a.topic}`);
  }
  const limit = Math.max(25, Math.min(Number(a.limit) || 25, 200));
  const offset = Math.max(0, Number(a.offset) || 0);
  const sort = a.sort === "relevance" ? "RELEVANCE" : "TIME";

  const [sum, list] = await Promise.allSettled([
    ebayGet(env, `/commerce/feedback/v1/feedback_rating_summary?${new URLSearchParams({ user_id: user, filter: "ratingType:OVERALL_EXPERIENCE" })}`, { scope: FEEDBACK_SCOPE }),
    ebayGet(env, feedbackPath(user, filters, { sort, limit: String(limit), offset: String(offset) }), { scope: FEEDBACK_SCOPE }),
  ]);
  const out = [`seller feedback for ${user} (received as seller)`];
  if (sum.status === "fulfilled") {
    const d = distribution(sum.value);
    out.push("ratings by period:");
    for (const p of ["30", "180", "365"]) out.push(`  last ${p} days: ${distText(d[p])}`);
  } else out.push(`ratings by period: unavailable (${feedbackFailure(sum.reason)})`);
  out.push("");
  if (list.status === "rejected") {
    out.push(`comments: unavailable (${feedbackFailure(list.reason)})`);
    return out.join("\n");
  }
  const entries = list.value.feedbackEntries || [];
  const total = list.value.pagination?.total ?? entries.length;
  const desc = [type === "all" ? "all comments" : `${type} comments`, a.period_days ? `last ${a.period_days} days` : "lifetime"];
  if (a.topic) desc.push(`topic: ${a.topic}`);
  desc.push(sort === "TIME" ? "newest first" : "most relevant first");
  out.push(`${desc.join(" · ")} · ${total} total · showing ${entries.length ? `${offset + 1}–${offset + entries.length}` : "none"}`);
  entries.forEach((e, k) => {
    out.push("");
    const lines = feedbackEntryLines(e, "");
    out.push(`[${offset + k + 1}] ${lines[0]}`, ...lines.slice(1).map((l) => "    " + l.trim()));
    const buyer = e.providerUserDetail;
    if (buyer?.feedbackScore != null) out.push(`    from buyer with score ${buyer.feedbackScore}`);
  });
  if (offset + entries.length < total) out.push("", `more available: call again with offset ${offset + entries.length}`);
  return out.join("\n");
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: "search_ebay",
    title: "Search eBay.de listings",
    annotations: { title: "Search eBay.de listings", ...READ_ONLY },
    description: "Search live listings on eBay.de (items located in Germany). Each result includes price, condition, location/distance, shipping, and the seller's reputation (last 12 months, lifetime negatives, latest negative comment). Set radius_km to only get sellers offering local pickup near postal_code.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords, e.g. 'Pixel 6a'" },
        min_price: { type: "number", description: "EUR" },
        max_price: { type: "number", description: "EUR" },
        condition: { type: "string", enum: ["any", "new", "used", "refurbished", "for_parts"], description: "used = working used items only; for_parts = broken/spares" },
        buy_it_now_only: { type: "boolean" },
        postal_code: { type: "string", description: "Default 70173 (Stuttgart)" },
        radius_km: { type: "number", description: "Local-pickup radius; omit to include shipped items" },
        sort: { type: "string", enum: ["price", "-price", "newlyListed", "endingSoonest", "distance"] },
        category_id: { type: "string", description: "eBay.de category, e.g. 9355 = Handys & Smartphones" },
        limit: { type: "number", description: "1-50, default 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_ebay_item",
    title: "Get eBay listing details",
    annotations: { title: "Get eBay listing details", ...READ_ONLY },
    description: "Get full details of one eBay listing: condition note, returns policy, shipping, item specs (e.g. OS version, storage), description, photos, and the seller's reputation.",
    inputSchema: { type: "object", properties: { item_id: { type: "string", description: "item id from search results, e.g. v1|198741885103|0" } }, required: ["item_id"] },
  },
  {
    name: "get_seller_feedback",
    title: "Get eBay seller feedback",
    annotations: { title: "Get eBay seller feedback", ...READ_ONLY },
    description: "Deep dive into the feedback an eBay user received as a seller: ratings for the last 30/180/365 days plus individual buyer comments with item title, price, date and the seller's replies. Filter by comment type, period and topic; page with offset.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "eBay username, as shown after 'seller:' in results" },
        comment_type: { type: "string", enum: ["negative", "neutral", "positive", "all"], description: "default negative" },
        period_days: { type: "number", enum: [7, 30, 90, 180, 365], description: "omit for lifetime" },
        topic: { type: "string", enum: TOPICS, description: "eBay's AI topic filter, e.g. condition, description, shipping" },
        sort: { type: "string", enum: ["newest", "relevance"], description: "default newest" },
        limit: { type: "number", description: "25-200, default 25" },
        offset: { type: "number", description: "for paging, default 0" },
      },
      required: ["username"],
    },
  },
];

// ---------- MCP / HTTP ----------

function fromAnthropic(ip) {
  // Anthropic's published outbound range for MCP connectors: 160.79.104.0/21 = 160.79.104.0 - 160.79.111.255
  const p = (ip || "").split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 160 && p[1] === 79 && p[2] >= 104 && p[2] <= 111;
}

const OPENAI_EGRESS_URL = "https://openai.com/chatgpt-connectors.json";
let openAiRanges = null;
let openAiRangesUntil = 0;
function ipv4ToInt(ip) {
  const p = String(ip || "").split(".");
  if (p.length !== 4 || p.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
  return p.reduce((n, x) => ((n << 8) | +x) >>> 0, 0);
}
function inCidr(ip, cidr) {
  const [network, bitsText] = String(cidr).split("/");
  const bits = Number(bitsText);
  const a = ipv4ToInt(ip), b = ipv4ToInt(network);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
async function fromOpenAI(ip) {
  if (ipv4ToInt(ip) === null) return false;
  if (!openAiRanges || Date.now() >= openAiRangesUntil) {
    try {
      const response = await fetch(OPENAI_EGRESS_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("egress list unavailable");
      const data = await response.json();
      const ranges = data.prefixes?.map(p => p.ipv4Prefix).filter(x => typeof x === "string");
      if (!ranges?.length) throw new Error("egress list invalid");
      openAiRanges = ranges;
      openAiRangesUntil = Date.now() + 3600000;
    } catch { return false; }
  }
  return openAiRanges.some(cidr => inCidr(ip, cidr));
}
async function authorized(request, env, url) {
  const key = env.ACCESS_KEY;
  if (!key) return false;
  const ip = request.headers.get("cf-connecting-ip");
  if (url.pathname === "/mcp") {
    if (env.ALLOW_ALL_IPS !== "true" && !fromAnthropic(ip)) return false;
    const h = request.headers;
    return h.get("x-api-key") === key || h.get("authorization") === `Bearer ${key}`;
  }
  if (url.pathname === `/mcp/${encodeURIComponent(key)}`) {
    return env.ALLOW_ALL_IPS === "true" || await fromOpenAI(ip);
  }
  return false;
}

const rpcError = (id, code, message) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const HANDLERS = { search_ebay: searchItems, get_ebay_item: getItem, get_seller_feedback: sellerFeedback };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!await authorized(request, env, url)) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    let msg;
    try { msg = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications
    const reply = (result) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: msg.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ebay-de", version: "2.0.3" },
        });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const { name, arguments: args = {} } = msg.params || {};
        const fn = HANDLERS[name];
        if (!fn) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        try {
          return reply({ content: [{ type: "text", text: await fn(env, args) }] });
        } catch (e) {
          const why = e instanceof EbayError ? `eBay request failed (${e.message})` : String(e.message || e);
          return reply({ content: [{ type: "text", text: `Error: ${why}` }], isError: true });
        }
      }
      default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  },
};
