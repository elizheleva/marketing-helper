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

// All possible hs_latest_source values in HubSpot
const ALL_SOURCES = [
  { value: "ORGANIC_SEARCH", label: "Organic Search" },
  { value: "PAID_SEARCH", label: "Paid Search" },
  { value: "EMAIL_MARKETING", label: "Email Marketing" },
  { value: "SOCIAL_MEDIA", label: "Social Media" },
  { value: "REFERRALS", label: "Referrals" },
  { value: "OTHER_CAMPAIGNS", label: "Other Campaigns" },
  { value: "PAID_SOCIAL", label: "Paid Social" },
  { value: "DISPLAY_ADS", label: "Display Ads" },
  { value: "DIRECT_TRAFFIC", label: "Direct Traffic" },
  { value: "OFFLINE", label: "Offline Sources" },
  { value: "OTHER", label: "Other" },
];

// Default marketing sources (used if portal hasn't configured their own)
const DEFAULT_MARKETING_SOURCES = [
  "ORGANIC_SEARCH",
  "PAID_SEARCH",
  "EMAIL_MARKETING",
  "SOCIAL_MEDIA",
  "REFERRALS",
  "OTHER_CAMPAIGNS",
  "PAID_SOCIAL",
  "DISPLAY_ADS",
];

// ---- Portal Config (per-portal marketing source selections) ----
const PORTAL_CONFIG_PATH = process.env.PORTAL_CONFIG_PATH || "./data/portal-config.json";

function loadPortalConfig() {
  try {
    if (!fs.existsSync(PORTAL_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(PORTAL_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function savePortalConfig(config) {
  fs.writeFileSync(PORTAL_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function getMarketingSources(portalId) {
  const config = loadPortalConfig();
  const portalSources = config[String(portalId)]?.marketingSources;
  if (Array.isArray(portalSources)) {
    return new Set(portalSources);
  }
  return new Set(DEFAULT_MARKETING_SOURCES);
}

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
 * Compute marketing contribution % based on source history entries.
 * Includes the very first value (not just changes).
 * @param {Array} historyEntries - property history entries
 * @param {Set} marketingSources - set of source values considered "marketing"
 */
function computeMarketingContribution(historyEntries, marketingSources) {
  const entries = [...(historyEntries || [])].sort((a, b) => {
    return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  });

  if (entries.length === 0) {
    return { percent: 0, totalChanges: 0, marketingChanges: 0 };
  }

  let totalChanges = 0;
  let marketingChanges = 0;

  // Start from index 0 to include the very first traffic source value
  for (let i = 0; i < entries.length; i++) {
    const newValue = String(entries[i]?.value ?? "").trim();
    if (!newValue) continue; // skip empty values
    totalChanges++;
    if (marketingSources.has(newValue)) marketingChanges++;
  }

  const percent = totalChanges > 0 ? marketingChanges / totalChanges : 0;
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
 * Uses the portal's configured marketing sources.
 */
async function processContact(portalId, contactId) {
  const marketingSources = getMarketingSources(portalId);

  const data = await hubspotApi(
    portalId,
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?propertiesWithHistory=${SOURCE_PROPERTY}`,
    { method: "GET" }
  );

  const history =
    data?.propertiesWithHistory?.[SOURCE_PROPERTY] || [];

  const { percent, totalChanges } = computeMarketingContribution(history, marketingSources);
  const value = totalChanges === 0 ? 0 : parseFloat(percent.toFixed(4));

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
// In-memory job status tracker
const jobStatus = {};

app.post("/api/calculate-contribution", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  // If a job is already running for this portal, don't start another
  if (jobStatus[portalId]?.running) {
    return res.json({
      success: true,
      message: `Analysis already in progress. ${jobStatus[portalId].processed} contacts processed so far...`,
      status: "running",
      ...jobStatus[portalId],
    });
  }

  // Respond immediately — processing happens in the background
  jobStatus[portalId] = { running: true, processed: 0, updated: 0, failed: 0, skippedNoHistory: 0, startedAt: new Date().toISOString() };
  res.json({ success: true, message: "Analysis started! Check status on the Status tab.", status: "started" });

  // Background processing
  try {
    await ensurePropertyExists(portalId);

    let after = undefined;

    while (true) {
      // Fetch a batch of contacts
      const contactIds = [];
      let batchPages = 0;

      while (contactIds.length < BATCH_LIMIT && batchPages < 3) {
        let url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=${PAGE_SIZE}`;
        if (after) url += `&after=${encodeURIComponent(after)}`;

        const data = await hubspotApi(portalId, url, { method: "GET" });
        const results = Array.isArray(data?.results) ? data.results : [];

        for (const r of results) {
          if (r?.id) contactIds.push(String(r.id));
        }

        after = data?.paging?.next?.after;
        batchPages++;
        if (!after || results.length === 0) break;
      }

      if (contactIds.length === 0) break;

      // Process each contact in this batch
      for (const contactId of contactIds) {
        try {
          const result = await processContact(portalId, contactId);
          if (result.totalChanges === 0) {
            jobStatus[portalId].skippedNoHistory++;
          } else {
            jobStatus[portalId].updated++;
          }
        } catch (e) {
          console.error(`Failed contact ${contactId}:`, e.message);
          jobStatus[portalId].failed++;
        }
        jobStatus[portalId].processed++;
      }

      console.log(`Portal ${portalId}: processed ${jobStatus[portalId].processed} contacts so far...`);

      if (!after) break; // No more contacts
    }

    jobStatus[portalId].running = false;
    jobStatus[portalId].completedAt = new Date().toISOString();
    console.log(`Portal ${portalId}: Analysis complete!`, jobStatus[portalId]);
  } catch (e) {
    console.error("Background calculation error:", e);
    jobStatus[portalId].running = false;
    jobStatus[portalId].error = e.message;
  }
});

// Status endpoint so the settings page can poll for progress
app.get("/api/calculate-contribution/status", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const status = jobStatus[portalId];
  if (!status) {
    return res.json({ success: true, status: "idle", message: "No analysis has been run yet." });
  }

  const statusLabel = status.running ? "running" : (status.error ? "error" : "completed");
  return res.json({
    success: true,
    status: statusLabel,
    processed: status.processed,
    updated: status.updated,
    skippedNoHistory: status.skippedNoHistory,
    failed: status.failed,
    startedAt: status.startedAt,
    completedAt: status.completedAt || null,
    error: status.error || null,
    message: status.running
      ? `Processing... ${status.processed} contacts done so far.`
      : status.error
        ? `Error: ${status.error}`
        : `Complete! Processed ${status.processed} contacts. Updated: ${status.updated}, Zero-history: ${status.skippedNoHistory}, Failed: ${status.failed}.`,
  });
});

// ================================================================
// MARKETING SOURCES CONFIGURATION
// Let each portal choose which traffic sources count as "marketing"
// ================================================================
app.get("/api/marketing-sources", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const config = loadPortalConfig();
  const portalSources = config[String(portalId)]?.marketingSources;
  const selectedSources = Array.isArray(portalSources) ? portalSources : DEFAULT_MARKETING_SOURCES;

  return res.json({
    success: true,
    allSources: ALL_SOURCES,
    selectedSources,
  });
});

app.post("/api/marketing-sources", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const { selectedSources } = req.body || {};
  if (!Array.isArray(selectedSources)) {
    return res.status(400).json({ success: false, message: "selectedSources must be an array" });
  }

  // Validate that all provided sources are valid
  const validValues = new Set(ALL_SOURCES.map((s) => s.value));
  const invalid = selectedSources.filter((s) => !validValues.has(s));
  if (invalid.length > 0) {
    return res.status(400).json({ success: false, message: `Invalid sources: ${invalid.join(", ")}` });
  }

  const config = loadPortalConfig();
  config[String(portalId)] = {
    ...(config[String(portalId)] || {}),
    marketingSources: selectedSources,
    updatedAt: new Date().toISOString(),
  };
  savePortalConfig(config);

  return res.json({
    success: true,
    message: `Saved ${selectedSources.length} marketing sources. Run analysis again to recalculate with the new settings.`,
    selectedSources,
  });
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
