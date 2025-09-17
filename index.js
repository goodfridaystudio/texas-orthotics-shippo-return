const express = require("express");
const app = express();

app.use(express.json());

// === Shopify Admin API creds ===
const SHOP = "texas-orthotics.myshopify.com";            // <-- replace with your shop domain
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
if (!SHOPIFY_TOKEN) {
  throw new Error("Missing SHOPIFY_TOKEN env var");
}
  // <-- replace with your Admin API access token

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
// OPTIONAL: keep your tag name in one place
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

    // 1) Pull metadata (if Shippo provided it), otherwise use fallback env vars
const meta = safeJson(evt?.data?.metadata);
let fulfillmentId = (meta?.kit_fulfillment_id || process.env.FALLBACK_FULFILLMENT_ID || "").trim();
let orderGid = (meta?.shopify_order_gid || meta?.shopify_order_id || process.env.FALLBACK_ORDER_GID || "").trim();



    if (!fulfillmentId) {
      console.error("❌ Missing kit_fulfillment_id in Shippo metadata");
      return res.sendStatus(200);
    }

    // 2) If order GID isn't in metadata, look it up from the fulfillment
    if (!orderGid) {
      const q = `
        query($id: ID!) {
          node(id: $id) {
            ... on Fulfillment {
              id
              order { id }
            }
          }
        }`;
      const data = await shopifyGQL(q, { id: fulfillmentId });
      orderGid = data?.node?.order?.id;
      if (!orderGid) {
        console.error("❌ Could not resolve order GID from fulfillment:", fulfillmentId);
        return res.sendStatus(200);
      }
    }

// 3) Add a tag to the order (so your email template can key off order.tags)
await shopifyGQL(
  `
  mutation {
    tagsAdd(id: "${orderGid}", tags: ["${KIT_RETURN_TAG}"]) {
      userErrors { field message }
    }
  }`
);
console.log("🏷️ Tag added to order:", orderGid, KIT_RETURN_TAG);


// 4) Update tracking on the kit fulfillment and SEND the native Shopify email
//    We set company to "Kit Return" so your Liquid IF condition matches.
await shopifyGQL(
  `
  mutation {
    fulfillmentTrackingInfoUpdateV2(
      fulfillmentId: "${fulfillmentId}",
      trackingInfoInput: {
  number: "${tracking || "KIT-RETURN"}",
  company: "Kit Return"
  ${evt?.data?.tracking_url ? `, url: "${evt.data.tracking_url}"` : ""}
},

      notifyCustomer: true
    ) {
      fulfillment { id }
      userErrors { field message }
    }
  }`
);

    console.log("📧 Native Shopify notification sent for fulfillment:", fulfillmentId);

    // 5) (Optional) Also record a Delivered event on the fulfillment timeline
    await shopifyGQL(
      `
      mutation($input: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $input) {
          userErrors { field message }
        }
      }`,
      {
        input: {
          fulfillmentId,
          status: "DELIVERED",
          happenedAt: evt?.data?.tracking_status?.status_date || new Date().toISOString(),
          message: "Impression kit returned"
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
