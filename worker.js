// eBay.de Browse API → MCP server (Cloudflare Worker, no dependencies)
// Secrets: EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID), ACCESS_KEY (long random string)
// Connector URL for Claude: https://<your-worker>.workers.dev/mcp
//   with request header x-api-key: <ACCESS_KEY> (or Authorization: Bearer <ACCESS_KEY>)
// Only requests from Anthropic's egress range (160.79.104.0/21) are accepted,
// unless the variable ALLOW_ALL_IPS is set to "true" (for testing).
// Nothing from eBay is stored: only the OAuth app token is kept in memory until it expires.

const API = "https://api.ebay.com";
let token = null;

async function getToken(env) {
  if (token && Date.now() < token.expires - 60_000) return token.value;
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`eBay token error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function ebayGet(env, path, zip = "70173") {
  const res = await fetch(API + path, {
    headers: {
      Authorization: `Bearer ${await getToken(env)}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_DE",
      "Accept-Language": "de-DE",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=" + encodeURIComponent(`country=DE,zip=${zip}`),
    },
  });
  if (!res.ok) throw new Error(`eBay API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Anthropic's published outbound range for MCP connectors: 160.79.104.0/21 = 160.79.104.0 - 160.79.111.255
function fromAnthropic(ip) {
  const p = (ip || "").split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 160 && p[1] === 79 && p[2] >= 104 && p[2] <= 111;
}

function authorized(request, env, url) {
  const key = env.ACCESS_KEY;
  if (!key) return false;
  if (url.pathname !== "/mcp") return false;
  const h = request.headers;
  return h.get("x-api-key") === key || h.get("authorization") === `Bearer ${key}`;
}

const money = (p) => p && `${p.value} ${p.currency}`;

async function searchItems(env, a) {
  const zip = a.postal_code || "70173";
  const f = ["itemLocationCountry:DE"];
  if (a.min_price != null || a.max_price != null) f.push(`price:[${a.min_price ?? ""}..${a.max_price ?? ""}]`, "priceCurrency:EUR");
  const CONDITIONS = { new: "1000", used: "3000", refurbished: "2000|2010|2020|2030|2500", for_parts: "7000" };
  if (CONDITIONS[a.condition]) f.push(`conditionIds:{${CONDITIONS[a.condition]}}`);
  if (a.buy_it_now_only) f.push("buyingOptions:{FIXED_PRICE}");
  if (a.radius_km) f.push("pickupCountry:DE", `pickupPostalCode:${zip}`, `pickupRadius:${a.radius_km}`,
    "pickupRadiusUnit:km", "deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP}");
  const q = new URLSearchParams({ q: a.query, filter: f.join(","), limit: String(Math.min(a.limit || 20, 50)) });
  if (a.sort) q.set("sort", a.sort);
  if (a.category_id) q.set("category_ids", a.category_id);
  const data = await ebayGet(env, `/buy/browse/v1/item_summary/search?${q}`, zip);
  return {
    total: data.total ?? 0,
    items: (data.itemSummaries || []).map((i) => ({
      id: i.itemId, title: i.title, price: money(i.price), current_bid: money(i.currentBidPrice),
      buying: i.buyingOptions?.join("/"), condition: i.condition,
      location: [i.itemLocation?.postalCode, i.itemLocation?.city].filter(Boolean).join(" "),
      distance: i.distanceFromPickupLocation && `${i.distanceFromPickupLocation.value} ${i.distanceFromPickupLocation.unitOfMeasure}`,
      seller: i.seller && `${i.seller.feedbackPercentage}% (${i.seller.feedbackScore})`,
      ends: i.itemEndDate, image: i.image?.imageUrl, url: i.itemWebUrl,
    })),
  };
}

async function getItem(env, a) {
  const i = await ebayGet(env, `/buy/browse/v1/item/${encodeURIComponent(a.item_id)}`);
  const desc = (i.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
  return {
    title: i.title, price: money(i.price), current_bid: money(i.currentBidPrice), condition: i.condition,
    condition_note: i.conditionDescription, specs: Object.fromEntries((i.localizedAspects || []).map((x) => [x.name, x.value])),
    location: [i.itemLocation?.postalCode, i.itemLocation?.city].filter(Boolean).join(" "),
    seller: i.seller && `${i.seller.username}, ${i.seller.feedbackPercentage}% (${i.seller.feedbackScore})`,
    ends: i.itemEndDate, description: i.shortDescription || desc,
    images: [i.image?.imageUrl, ...(i.additionalImages || []).map((x) => x.imageUrl)].filter(Boolean).slice(0, 5),
    url: i.itemWebUrl,
  };
}

const TOOLS = [
  {
    name: "search_ebay",
    title: "Search eBay.de listings",
    annotations: { title: "Search eBay.de listings", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Search live listings on eBay.de (items located in Germany). Set radius_km to only get sellers offering local pickup near postal_code.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords, e.g. 'Pixel 6a'" },
        min_price: { type: "number" }, max_price: { type: "number", description: "EUR" },
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
    annotations: { title: "Get eBay listing details", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Get full details of one eBay listing (specs such as OS version, condition note, description).",
    inputSchema: { type: "object", properties: { item_id: { type: "string" } }, required: ["item_id"] },
  },
];

const rpcError = (id, code, message) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.ALLOW_ALL_IPS !== "true" && !fromAnthropic(request.headers.get("cf-connecting-ip"))) return new Response("Forbidden", { status: 403 });
    if (!authorized(request, env, url)) return new Response("Not found", { status: 404 });
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
          serverInfo: { name: "ebay-de", version: "1.2.0" },
        });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const { name, arguments: args = {} } = msg.params || {};
        const fn = { search_ebay: searchItems, get_ebay_item: getItem }[name];
        if (!fn) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        try {
          return reply({ content: [{ type: "text", text: JSON.stringify(await fn(env, args), null, 1) }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
        }
      }
      default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  },
};
