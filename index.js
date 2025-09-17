const express = require("express");
const app = express();

app.use(express.json());

// === Shopify Admin API creds ===
const SHOP = "texas-orthotics.myshopify.com"; // your shop domain
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
if (!SHOPIFY_TOKEN) {
  throw new Error("Missing SHOPIFY_TOKEN env var");
}

// Minimal GraphQL helper
async function shopifyGQL(query, variables) {
  const resp = await fetch(`https://${SHOP}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    console.error("Shopify API error:", json);
    throw new Error("Shopify API error");
  }
  return json.data;
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// Shippo webhook endpoint
const KIT_RETURN_TAG = "kit_return_received";

console.log("FALLBACK_FULFILLMENT_ID =", process.env.FALLBACK_FULFILLMENT_ID);
console.log("FALLBACK_ORDER_GID =", process.env.FALLBACK_ORDER_GID);

app.post("/shippo/webhook", async (req, res) => {
  const evt = req.body;
  const status = evt?.data?.tracking_status?.status;
  const tracking = evt?.data?.tracking_number;

  try {
    // Only handle Shippo tracking updates that are delivered
    if (evt?.event !== "track_updated" || status !== "DELIVERED") {
      console.log("↪︎ Ignored webhook:", status || "no status");
      return res.sendStatus(200);
    }

    console.log("✅ DELIVERED detected for:", tracking);

    // 1) Resolve order/fulfillment IDs automatically (no manual lookups)
    const rawMeta = evt?.data?.metadata;
    const meta = (typeof rawMeta === "string" && rawMeta.trim().startsWith("{"))
      ? safeJson(rawMeta)
      : (safeJson(rawMeta) || {});

    // Prefer explicit IDs if present (from Shippo metadata), else env fallbacks for testing
    let orderGid = (meta.shopify_order_gid || meta.shopify_order_id || process.env.FALLBACK_ORDER_GID || "").trim();
    let fulfillmentId = (meta.kit_fulfillment_id || process.env.FALLBACK_FULFILLMENT_ID || "").trim();

    // If missing, try to parse "Order #1234" from Shippo's metadata string and look up via Shopify
    if ((!orderGid || !fulfillmentId) && typeof rawMeta === "string") {
      const m = rawMeta.match(/Order\s*#(\d+)/i);
      if (m && m[1]) {
        const orderName = `#${m[1]}`;
        const LOOKUP_QUERY = 
          query($q: String!) {
            orders(first: 1, query: $q) {
              edges {
                node {
                  id
                  fulfillments {
                    id
                    status
                    createdAt
                  }
                }
              }
            }
          };
        const d = await shopifyGQL(LOOKUP_QUERY, { q: `name:${orderName}` });
        const node = d?.orders?.edges?.[0]?.node;
        if (node?.id) {
          if (!orderGid) orderGid = (node.id || "").trim();
          // Pick the newest fulfillment (createdAt desc)
          const fulf = Array.isArray(node.fulfillments) ? [...node.fulfillments] : [];
          if (!fulfillmentId && fulf.length) {
            fulf.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            fulfillmentId = (fulf[0].id || "").trim();
          }
        }
      }
    }

    // Final guardrails
    if (!orderGid || !fulfillmentId) {
      console.error("❌ Could not resolve order/fulfillment automatically. metadata =", rawMeta);
      return res.sendStatus(200);
    }

    // 2) If order GID still isn't set (edge case), resolve from fulfillment
    if (!orderGid) {
      const q = 
        query($id: ID!) {
          node(id: $id) {
            ... on Fulfillment {
              id
              order { id }
            }
          }
        };
      const data = await shopifyGQL(q, { id: fulfillmentId });
      orderGid = (data?.node?.order?.id || "").trim();
      if (!orderGid) {
        console.error("❌ Could not resolve order GID from fulfillment:", fulfillmentId);
        return res.sendStatus(200);
      }
    }

    // 3) Add a tag to the order (so your email template can key off order.tags)
    await shopifyGQL(
      
      mutation {
        tagsAdd(id: "${orderGid}", tags: ["${KIT_RETURN_TAG}"]) {
          userErrors { field message }
        }
      }
    );
    console.log("🏷️ Tag added to order:", orderGid, KIT_RETURN_TAG);

    // 4) Update tracking on the kit fulfillment and SEND the native Shopify email
    // Build url fragment safely (omit when empty)
    const urlFragment = evt?.data?.tracking_url ? `, url: "${evt.data.tracking_url}"` : "";
    await shopifyGQL(
      
      mutation {
        fulfillmentTrackingInfoUpdateV2(
          fulfillmentId: "${fulfillmentId}",
          trackingInfoInput: {
            number: "${tracking || "KIT-RETURN"}",
            company: "Kit Return"${urlFragment}
          },
          notifyCustomer: true
        ) {
          fulfillment { id }
          userErrors { field message }
        }
      }
    );
    console.log("📧 Native Shopify notification sent for fulfillment:", fulfillmentId);

    // 5) (Optional) Also record a Delivered event on the fulfillment timeline
    const happenedAt = evt?.data?.tracking_status?.status_date || new Date().toISOString();
    await shopifyGQL(
      
      mutation {
        fulfillmentEventCreate(fulfillmentEvent: {
          fulfillmentId: "${fulfillmentId}",
          status: DELIVERED,
          happenedAt: "${happenedAt}",
          message: "Impression kit returned"
        }) {
          userErrors { field message }
        }
      }
    );
    console.log("🕒 Fulfillment Delivered event recorded.");

    res.sendStatus(200);
  } catch (err) {
    console.error("Shopify update failed:", err);
    res.sendStatus(500);
  }
});

// Health check (optional)
app.get("/", (req, res) => res.send("OK"));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
