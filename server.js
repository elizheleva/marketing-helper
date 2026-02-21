// server.js
// HubSpot OAuth installer + Marketing Contribution backend

const express = require("express");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies (for hubspot.fetch and webhook payloads)
app.use(express.json());

// ---- Constants ----
const PROPERTY_NAME = "marketing_contribution_percentage";
const SOURCE_PROPERTY = "hs_latest_source";
const PAGE_SIZE = 100;
const BATCH_LIMIT = 300; // contacts per batch call

const MARKETING_SOURCES = new Set([
  "ORGANIC_SEARCH",
  "PAID_SEARCH",
  "EMAIL_MARKETING",
  "SOCIAL_MEDIA",
  "REFERRALS",
  "OTHER_CAMPAIGNS",
  "PAID_SOCIAL",
  "DISPLAY_ADS",
]);

// ---- Helpers ----
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || "./data/hubspot-tokens.json";

function loadTokenStore() {
  try {
    if (!fs.existsSync(TOKEN_STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveTokenStore(store) {
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/**
 * Get a valid access token for a portal, auto-refreshing if expired.
 */
async function getAccessToken(portalId) {
  const store = loadTokenStore();
  const record = store[String(portalId)];
  if (!record?.refresh_token) {
    throw new Error(`No tokens found for portal ${portalId}`);
  }

  // Check if token is still fresh (with 5-minute buffer)
  const savedAt = new Date(record.saved_at).getTime();
  const expiresAt = savedAt + (record.expires_in || 1800) * 1000;
  const now = Date.now();

  if (now < expiresAt - 5 * 60 * 1000) {
    return record.access_token;
  }

  // Token expired or about to expire — refresh it
  console.log(`Refreshing token for portal ${portalId}...`);
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: record.refresh_token,
  });

  const tokenResp = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(`Token refresh failed: ${errText}`);
  }

  const tokens = JSON.parse(await tokenResp.text());

  store[String(portalId)] = {
    ...record,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || record.refresh_token,
    expires_in: tokens.expires_in,
    scopes: tokens.scopes || record.scopes,
    saved_at: new Date().toISOString(),
  };
  saveTokenStore(store);

  return tokens.access_token;
}

/**
 * Make an authenticated HubSpot API request.
 */
async function hubspotApi(portalId, url, options = {}) {
  const accessToken = await getAccessToken(portalId);
  const resp = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const msg =
      (data && (data.message || data.error || data.status)) ||
      resp.statusText ||
      "HubSpot API request failed";
    const err = new Error(msg);
    err.status = resp.status;
    err.body = data;
    throw err;
  }

  return data;
}

/**
 * Compute marketing contribution % based on source history changes.
 */
function computeMarketingContribution(historyEntries) {
  const entries = [...(historyEntries || [])].sort((a, b) => {
    return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  });

  if (entries.length <= 1) {
    return { percent: 0, totalChanges: 0, marketingChanges: 0 };
  }

  let totalChanges = 0;
  let marketingChanges = 0;

  for (let i = 1; i < entries.length; i++) {
    const newValue = String(entries[i]?.value ?? "").trim();
    totalChanges++;
    if (MARKETING_SOURCES.has(newValue)) marketingChanges++;
  }

  const percent = totalChanges > 0 ? (marketingChanges / totalChanges) * 100 : 0;
  return { percent, totalChanges, marketingChanges };
}

/**
 * Ensure the marketing_contribution_percentage property exists.
 */
async function ensurePropertyExists(portalId) {
  try {
    await hubspotApi(
      portalId,
      `https://api.hubapi.com/crm/v3/properties/contacts/${PROPERTY_NAME}`,
      { method: "GET" }
    );
    return false; // already exists
  } catch (e) {
    if (e?.status !== 404) throw e;
  }

  await hubspotApi(
    portalId,
    "https://api.hubapi.com/crm/v3/properties/contacts",
    {
      method: "POST",
      body: JSON.stringify({
        name: PROPERTY_NAME,
        label: "Marketing Contribution Percentage",
        description:
          "Percentage of hs_latest_source history changes attributed to marketing sources.",
        groupName: "contactinformation",
        type: "number",
        fieldType: "number",
        hidden: false,
        formField: false,
        displayOrder: -1,
      }),
    }
  );
  return true; // created
}

/**
 * Process a single contact: fetch history, compute %, update property.
 */
async function processContact(portalId, contactId) {
  const data = await hubspotApi(
    portalId,
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?propertiesWithHistory=${SOURCE_PROPERTY}`,
    { method: "GET" }
  );

  const history =
    data?.propertiesWithHistory?.[SOURCE_PROPERTY] || [];

  const { percent, totalChanges } = computeMarketingContribution(history);
  const value = totalChanges === 0 ? 0 : parseFloat(percent.toFixed(2));

  await hubspotApi(
    portalId,
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        properties: { [PROPERTY_NAME]: value },
      }),
    }
  );

  return { contactId, percent: value, totalChanges };
}

// ---- Routes ----

// Health check
app.get("/", (_req, res) => {
  res.send("Server is running ✅");
});

// Install route: redirects to HubSpot OAuth consent
app.get("/install", (_req, res) => {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;
  const scopes = process.env.HUBSPOT_SCOPES || "oauth";

  if (!clientId || !redirectUri) {
    return res
      .status(500)
      .send("Missing HUBSPOT_CLIENT_ID or HUBSPOT_REDIRECT_URI env var");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: "test-" + Date.now(),
  });

  const authUrl = `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  return res.redirect(authUrl);
});

// Callback route: HubSpot redirects here with ?code=...
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res
      .status(500)
      .send(
        "Missing HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET / HUBSPOT_REDIRECT_URI"
      );
  }

  // Exchange code -> tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code: String(code),
  });

  const tokenResp = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const tokenText = await tokenResp.text();
  if (!tokenResp.ok) return res.status(400).send(tokenText);

  const tokens = JSON.parse(tokenText);

  const store = loadTokenStore();
  store[String(tokens.hub_id)] = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
    scopes: tokens.scopes,
    saved_at: new Date().toISOString(),
  };
  saveTokenStore(store);

  const appId = process.env.HUBSPOT_APP_ID || "27714105";
  const portalId = tokens.hub_id;

  const settingsUrl = `https://app.hubspot.com/integrations-settings/${portalId}/installed/framework/${appId}/general-settings`;
  return res.redirect(settingsUrl);
});

// Token refresh endpoint
app.get("/refresh", async (req, res) => {
  const hubId = req.query.hub_id;
  if (!hubId) return res.status(400).send("Missing hub_id");

  try {
    const token = await getAccessToken(hubId);
    res.send(`Refreshed ✅ Token ready for hub_id=${hubId}`);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// ================================================================
// BATCH CALCULATION ENDPOINT
// Called from the settings page via hubspot.fetch()
// HubSpot adds ?portalId=xxx&userId=xxx&userEmail=xxx&appId=xxx
// ================================================================
app.post("/api/calculate-contribution", async (req, res) => {
  try {
    const portalId = req.query.portalId;
    if (!portalId) {
      return res.status(400).json({ success: false, message: "Missing portalId" });
    }

    const afterCursor = req.body?.after || undefined;

    // Ensure custom property exists (only on first batch)
    let propertyCreated = false;
    if (!afterCursor) {
      propertyCreated = await ensurePropertyExists(portalId);
    }

    // Fetch contacts (one page of up to BATCH_LIMIT)
    const contactIds = [];
    let after = afterCursor;
    let nextAfter = null;

    while (contactIds.length < BATCH_LIMIT) {
      const remaining = BATCH_LIMIT - contactIds.length;
      const pageLimit = Math.min(PAGE_SIZE, remaining);

      let url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=${pageLimit}`;
      if (after) url += `&after=${encodeURIComponent(after)}`;

      const data = await hubspotApi(portalId, url, { method: "GET" });
      const results = Array.isArray(data?.results) ? data.results : [];

      for (const r of results) {
        if (r?.id) contactIds.push(String(r.id));
        if (contactIds.length >= BATCH_LIMIT) break;
      }

      after = data?.paging?.next?.after;
      if (!after || results.length === 0) break;
    }

    // If there are more contacts after this batch, save the cursor
    if (after && contactIds.length >= BATCH_LIMIT) {
      nextAfter = after;
    }

    // Process each contact
    let updated = 0;
    let skippedNoHistory = 0;
    let failed = 0;

    for (const contactId of contactIds) {
      try {
        const result = await processContact(portalId, contactId);
        if (result.totalChanges === 0) {
          skippedNoHistory++;
        } else {
          updated++;
        }
      } catch (e) {
        console.error(`Failed contact ${contactId}:`, e.message);
        failed++;
      }
    }

    const messageParts = [];
    if (propertyCreated) messageParts.push("Created property.");
    messageParts.push(`Processed ${contactIds.length} contacts in this batch.`);
    messageParts.push(`Updated: ${updated}.`);
    messageParts.push(`Zero-history: ${skippedNoHistory}.`);
    if (failed > 0) messageParts.push(`Failed: ${failed}.`);
    if (nextAfter) messageParts.push("More contacts remaining...");
    else messageParts.push("All contacts processed!");

    return res.json({
      success: true,
      message: messageParts.join(" "),
      processed: contactIds.length,
      updated,
      skippedNoHistory,
      failed,
      nextAfter, // null if done, string cursor if more to process
      propertyCreated,
    });
  } catch (e) {
    console.error("calculate-contribution error:", e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// ================================================================
// WEBHOOK HANDLER
// Receives HubSpot webhook events for hs_latest_source changes.
// Recalculates marketing contribution for the affected contact.
// ================================================================
app.post("/webhook/hs-latest-source", async (req, res) => {
  // Respond immediately to HubSpot (they expect 2xx within 5 seconds)
  res.status(200).send("OK");

  // Process events asynchronously
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const event of events) {
    try {
      const portalId = event.portalId;
      const contactId = event.objectId;

      if (!portalId || !contactId) {
        console.warn("Webhook event missing portalId or objectId:", event);
        continue;
      }

      console.log(
        `Webhook: recalculating contact ${contactId} (portal ${portalId})`
      );

      // Ensure property exists (in case it was deleted)
      await ensurePropertyExists(portalId);

      // Process the single contact
      const result = await processContact(portalId, String(contactId));
      console.log(
        `Webhook: updated contact ${contactId} → ${result.percent}%`
      );
    } catch (e) {
      console.error(`Webhook: error processing event:`, e.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Install: http://localhost:${PORT}/install`);
});
