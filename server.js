// server.js
// HubSpot OAuth installer + Marketing Contribution backend
// BACKEND_VERSION: bump when deploying (no legacy firstDealByContact)
const BACKEND_VERSION = "1.1.9";

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

// ---- MCF (Multi-Channel Funnel) Constants ----
const MCF_RESULTS_PATH = process.env.MCF_RESULTS_PATH || "./data/mcf-results.json";

const CHANNEL_LABELS = {
  ORGANIC_SEARCH: "Organic Search",
  PAID_SEARCH: "Paid Search",
  EMAIL_MARKETING: "Email Marketing",
  SOCIAL_MEDIA: "Organic Social",
  REFERRALS: "Referrals",
  OTHER_CAMPAIGNS: "Other Campaigns",
  DIRECT_TRAFFIC: "Direct Traffic",
  OFFLINE: "Offline Sources",
  PAID_SOCIAL: "Paid Social",
  AI_REFERRALS: "AI Referrals",
};

// MCF: First-ever meeting only
const CONVERSION_TYPE_OPTIONS = [
  { value: "meeting_booked", label: "First-ever meeting" },
];

// All possible hs_latest_source values in HubSpot (matches native property options exactly)
const ALL_SOURCES = [
  { value: "ORGANIC_SEARCH", label: "Organic Search" },
  { value: "PAID_SEARCH", label: "Paid Search" },
  { value: "EMAIL_MARKETING", label: "Email Marketing" },
  { value: "SOCIAL_MEDIA", label: "Organic Social" },
  { value: "REFERRALS", label: "Referrals" },
  { value: "OTHER_CAMPAIGNS", label: "Other Campaigns" },
  { value: "DIRECT_TRAFFIC", label: "Direct Traffic" },
  { value: "OFFLINE", label: "Offline Sources" },
  { value: "PAID_SOCIAL", label: "Paid Social" },
  { value: "AI_REFERRALS", label: "AI Referrals" },
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

function removePortalData(portalId) {
  const key = String(portalId || "").trim();
  if (!key) return;

  // Remove OAuth tokens
  try {
    const tokenStore = loadTokenStore();
    if (tokenStore[key]) {
      delete tokenStore[key];
      saveTokenStore(tokenStore);
    }
  } catch (e) {
    console.warn(`Failed to remove token store data for portal ${key}:`, e.message);
  }

  // Remove portal-specific config
  try {
    const cfg = loadPortalConfig();
    if (cfg[key]) {
      delete cfg[key];
      savePortalConfig(cfg);
    }
  } catch (e) {
    console.warn(`Failed to remove portal config for portal ${key}:`, e.message);
  }

  // Remove in-memory job states
  try {
    if (jobStatus[key]) delete jobStatus[key];
  } catch (_) { /* ignore */ }
  try {
    if (mcfJobStatus[key]) delete mcfJobStatus[key];
  } catch (_) { /* ignore */ }

  // Remove persisted MCF cache entries for this portal
  try {
    const results = loadMcfResults();
    let changed = false;
    for (const cacheKey of Object.keys(results)) {
      if (cacheKey.startsWith(`${key}:`)) {
        delete results[cacheKey];
        changed = true;
      }
    }
    if (changed) saveMcfResults(results);
  } catch (e) {
    console.warn(`Failed to remove MCF cache for portal ${key}:`, e.message);
  }
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

// ================================================================
// MCF HELPERS
// ================================================================

function loadMcfResults() {
  try {
    if (!fs.existsSync(MCF_RESULTS_PATH)) return {};
    return JSON.parse(fs.readFileSync(MCF_RESULTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveMcfResults(data) {
  fs.writeFileSync(MCF_RESULTS_PATH, JSON.stringify(data, null, 2), "utf8");
}

/** Rate-limited HubSpot API call with exponential backoff retries. */
async function hubspotApiWithRetry(portalId, url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await hubspotApi(portalId, url, options);
    } catch (e) {
      if (e.status === 429 && attempt < maxRetries) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        console.log(`Rate limited (${url}), retrying in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

function msDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse timestamp from HubSpot (ISO string or ms number) to milliseconds. */
function parseHistoryTimestamp(val) {
  if (val == null || val === "") return 0;
  if (typeof val === "number" && !isNaN(val)) return val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Build a conversion path from hs_latest_source history.
 * Includes ALL entries before the conversion timestamp (no lookback limit).
 * This captures the full journey leading to conversion.
 * Collapses consecutive duplicate sources.
 * HubSpot returns timestamps as ISO strings; must parse before comparing.
 */
function buildConversionPath(sourceHistory, conversionTimestamp) {
  const convTs = typeof conversionTimestamp === "number" ? conversionTimestamp : parseHistoryTimestamp(conversionTimestamp);
  const entries = (sourceHistory || [])
    .filter((e) => {
      const ts = parseHistoryTimestamp(e.timestamp);
      return ts > 0 && ts <= convTs;
    })
    .sort((a, b) => parseHistoryTimestamp(a.timestamp) - parseHistoryTimestamp(b.timestamp));

  if (entries.length === 0) return ["UNKNOWN"];

  const rawPath = entries
    .map((e) => String(e.value || "").trim().toUpperCase())
    .filter(Boolean);

  // Collapse consecutive duplicates
  const collapsed = [];
  for (const step of rawPath) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== step) {
      collapsed.push(step);
    }
  }

  return collapsed.length > 0 ? collapsed : ["UNKNOWN"];
}

/** Create a stable string key for a path array. */
function pathToKey(pathArray) {
  return pathArray.join(">");
}

// ================================================================
// MCF CONVERSION-FIRST HELPERS
// DO NOT iterate over all contacts.
// Start from conversion events, extract contacts, verify first-ever.
// ================================================================

/**
 * Paginated CRM search. Returns all matching objects.
 * Automatically paginates through all results.
 */
async function searchObjects(portalId, objectType, filterGroups, properties, limit) {
  const results = [];
  let after = undefined;
  const pageSize = Math.min(limit || 100, 100);

  while (true) {
    const body = { filterGroups, properties, limit: pageSize };
    if (after) body.after = after;

    const data = await hubspotApiWithRetry(
      portalId,
      `https://api.hubapi.com/crm/v3/objects/${objectType}/search`,
      { method: "POST", body: JSON.stringify(body) }
    );

    results.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after || (data.results || []).length === 0) break;
    await msDelay(100);
  }

  return results;
}

/**
 * Batch read CRM objects by ID. Uses /crm/v3/objects/{type}/batch/read.
 * Returns array of objects with their properties.
 * Supports up to 100 IDs per call, auto-batches larger sets.
 */
async function batchReadObjects(portalId, objectType, ids, properties, propertiesWithHistory) {
  if (!ids || ids.length === 0) return [];
  const results = [];
  const batchSize = 100;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const body = {
      inputs: batch.map((id) => ({ id: String(id) })),
      properties: properties || [],
    };
    if (propertiesWithHistory && propertiesWithHistory.length > 0) {
      body.propertiesWithHistory = propertiesWithHistory;
    }

    try {
      const data = await hubspotApiWithRetry(
        portalId,
        `https://api.hubapi.com/crm/v3/objects/${objectType}/batch/read`,
        { method: "POST", body: JSON.stringify(body) }
      );
      results.push(...(data.results || []));
    } catch (e) {
      console.warn(`batchReadObjects(${objectType}) batch at ${i} failed:`, e.message);
      // Fallback: read individually
      for (const id of batch) {
        try {
          let url = `https://api.hubapi.com/crm/v3/objects/${objectType}/${id}?`;
          if (properties?.length) url += `properties=${properties.join(",")}`;
          if (propertiesWithHistory?.length) url += `&propertiesWithHistory=${propertiesWithHistory.join(",")}`;
          const obj = await hubspotApiWithRetry(portalId, url);
          results.push(obj);
        } catch (_) { /* skip individual failures */ }
      }
    }

    if (i + batchSize < ids.length) await msDelay(150);
  }

  return results;
}

/**
 * Batch get associations using CRM v4 batch API.
 * Returns a map: { fromId → [toId, ...] } (all IDs as strings).
 * Handles pagination when a single object has many associations.
 * Falls back to individual v3 calls if v4 fails.
 */
async function batchGetAssociations(portalId, fromType, fromIds, toType) {
  if (!fromIds || fromIds.length === 0) return {};
  const resultMap = {};
  const batchSize = 100;

  for (let i = 0; i < fromIds.length; i += batchSize) {
    const batch = fromIds.slice(i, i + batchSize).map((id) => String(id));
    let inputs = batch.map((id) => ({ id }));

    while (inputs.length > 0) {
      const body = { inputs };
      try {
        const data = await hubspotApiWithRetry(
          portalId,
          `https://api.hubapi.com/crm/v4/associations/${fromType}/${toType}/batch/read`,
          { method: "POST", body: JSON.stringify(body) }
        );
        inputs = [];
        for (const r of data.results || []) {
          const fromId = String(r.from?.id ?? r.from);
          const toIds = (r.to || []).map((t) => String(t.toObjectId ?? t.id ?? t)).filter(Boolean);
          if (!resultMap[fromId]) resultMap[fromId] = [];
          resultMap[fromId].push(...toIds);
          if (r.paging?.next?.after) {
            inputs.push({ id: fromId, after: r.paging.next.after });
          }
        }
        if (inputs.length > 0) await msDelay(150);
      } catch (e) {
        console.warn(`batchGetAssociations v4 ${fromType}->${toType} failed, falling back to v3:`, e.message);
        for (const id of batch) {
          try {
            const data = await hubspotApiWithRetry(
              portalId,
              `https://api.hubapi.com/crm/v3/objects/${fromType}/${id}/associations/${toType}?limit=500`,
              { method: "GET" }
            );
            resultMap[String(id)] = (data.results || []).map((r) => String(r.toObjectId || r.id));
          } catch (_) {
            resultMap[String(id)] = [];
          }
        }
        break;
      }
    }

    if (i + batchSize < fromIds.length) await msDelay(150);
  }

  return resultMap;
}

// ================================================================
// CONVERSION FINDER FUNCTIONS
// Each function:
//   1. Finds conversion events inside the reporting period
//   2. Extracts associated contacts
//   3. Filters to only contacts whose FIRST EVER conversion of that type
//      falls inside the reporting period
//   4. Returns { contactId, conversionTimestamp, conversionValue, currency }[]
// ================================================================

// ---- MEETING BOOKED (first-ever) ----
// 1. Search meetings created/booked in the reporting period
// 2. Batch-get associated contacts for those meetings
// 3. For each contact, batch-read ALL their meetings to check for earlier ones
// 4. If no earlier meeting exists → first-ever → qualifies
async function findMeetingBookedConversions(portalId, start, end, jobStatus) {
  jobStatus.message = "Step 1/3: Searching for meetings in reporting period...";

  const meetings = await searchObjects(
    portalId,
    "meetings",
    [{
      filters: [{
        propertyName: "hs_createdate",
        operator: "BETWEEN",
        value: String(start.getTime()),
        highValue: String(end.getTime()),
      }],
    }],
    ["hs_createdate", "hs_meeting_start_time", "hs_timestamp"]
  );

  if (meetings.length === 0) {
    jobStatus.message = "No meetings found in reporting period.";
    return [];
  }

  jobStatus.message = `Step 2/3: Found ${meetings.length} meetings. Getting associated contacts (batch)...`;

  // Batch-get associations: meeting → contacts
  const meetingIds = meetings.map((m) => m.id);
  const meetingAssocs = await batchGetAssociations(portalId, "meetings", meetingIds, "contacts");

  // Build contactMap: contactId → earliest meeting timestamp in period
  // Use String() for all IDs to avoid type mismatch (HubSpot may return numbers)
  const contactMap = {};
  for (const m of meetings) {
    const mTs = new Date(
      m.properties?.hs_meeting_start_time ||
      m.properties?.hs_timestamp ||
      m.properties?.hs_createdate ||
      m.createdAt
    ).getTime();

    const meetingKey = String(m.id);
    const contactIds = meetingAssocs[meetingKey] || [];
    for (const cId of contactIds) {
      const cKey = String(cId);
      if (!contactMap[cKey] || mTs < contactMap[cKey]) contactMap[cKey] = mTs;
    }
  }

  const uniqueContacts = Object.keys(contactMap);
  if (uniqueContacts.length === 0) {
    jobStatus.message = "No contacts associated with meetings in period.";
    return [];
  }

  jobStatus.message = `Step 3/3: Verifying first-ever meeting for ${uniqueContacts.length} contacts...`;

  // For each contact, get ALL their meeting IDs, then batch-read to check dates
  const conversions = [];
  const contactAssocs = await batchGetAssociations(portalId, "contacts", uniqueContacts, "meetings");

  for (let i = 0; i < uniqueContacts.length; i++) {
    const cId = uniqueContacts[i];
    try {
      const allMeetingIds = contactAssocs[cId] || [];
      // Batch-read all meetings for this contact
      const allMeetings = await batchReadObjects(portalId, "meetings", allMeetingIds, [
        "hs_createdate", "hs_meeting_start_time", "hs_timestamp",
      ]);

      let hasEarlier = false;
      for (const m of allMeetings) {
        const ts = new Date(
          m.properties?.hs_meeting_start_time ||
          m.properties?.hs_timestamp ||
          m.properties?.hs_createdate ||
          m.createdAt
        ).getTime();
        if (!isNaN(ts) && ts < start.getTime()) { hasEarlier = true; break; }
      }

      if (!hasEarlier) {
        conversions.push({
          objectType: "meeting_booked",
          contactId: cId,
          conversionTimestamp: contactMap[cId],
          conversionValue: 0,
          currency: null,
        });
      }
    } catch (e) {
      console.warn(`MCF: meeting check error contact ${cId}:`, e.message);
    }

    if ((i + 1) % 10 === 0) {
      jobStatus.message = `Step 3/3: Verified ${i + 1}/${uniqueContacts.length} contacts. ${conversions.length} qualifying so far.`;
      await msDelay(100);
    }
  }

  jobStatus.converting = conversions.length;
  jobStatus.message = `Found ${conversions.length} contacts with first-ever meeting in period.`;
  return conversions;
}

/**
 * Ensure the marketing_contribution_percentage property exists.
 * Property must be type "number" with numberDisplayHint "percentage" (not "formatted_number").
 */
async function ensurePropertyExists(portalId) {
  const propertyDefinition = {
    name: PROPERTY_NAME,
    label: "Marketing Contribution Percentage",
    description:
      "Percentage of hs_latest_source history changes attributed to marketing sources.",
    groupName: "contactinformation",
    type: "number",
    fieldType: "number",
    numberDisplayHint: "percentage",
    hidden: false,
    formField: false,
    displayOrder: -1,
  };

  const patchToNumberAndPercentage = () =>
    hubspotApi(
      portalId,
      `https://api.hubapi.com/crm/v3/properties/contacts/${PROPERTY_NAME}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          label: propertyDefinition.label,
          description: propertyDefinition.description,
          groupName: propertyDefinition.groupName,
          type: "number",
          fieldType: "number",
          numberDisplayHint: "percentage",
          hidden: propertyDefinition.hidden,
          formField: propertyDefinition.formField,
          displayOrder: propertyDefinition.displayOrder,
        }),
      }
    );

  try {
    const existing = await hubspotApi(
      portalId,
      `https://api.hubapi.com/crm/v3/properties/contacts/${PROPERTY_NAME}`,
      { method: "GET" }
    );

    // Ensure number type + percentage display (not formatted_number).
    const hasFormattedNumber =
      existing?.numberDisplayHint === "formatted_number" ||
      (existing?.type === "number" && !existing?.numberDisplayHint);
    const needsUpdate =
      existing?.type !== "number" ||
      existing?.fieldType !== "number" ||
      existing?.numberDisplayHint !== "percentage" ||
      hasFormattedNumber;

    if (needsUpdate) {
      await patchToNumberAndPercentage();
      return "updated";
    }

    return false; // already exists with number + percentage settings
  } catch (e) {
    if (e?.status !== 404) throw e;
  }

  await hubspotApi(
    portalId,
    "https://api.hubapi.com/crm/v3/properties/contacts",
    {
      method: "POST",
      body: JSON.stringify(propertyDefinition),
    }
  );
  // PATCH immediately after create to ensure numberDisplayHint "percentage" is applied
  // (some HubSpot APIs default to "formatted_number" on create).
  await patchToNumberAndPercentage();
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

// Version check (verify deployed code after updates)
app.get("/api/version", (_req, res) => {
  res.json({ version: BACKEND_VERSION });
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

function extractPortalIdFromDeauth(req) {
  const b = req.body || {};
  return (
    req.query.portalId ||
    req.query.portal_id ||
    req.query.hubId ||
    req.query.hub_id ||
    b.portalId ||
    b.portal_id ||
    b.hubId ||
    b.hub_id ||
    b.accountId ||
    b.account_id ||
    b.portal_id_from_scope ||
    null
  );
}

async function handleDeauthorize(req, res) {
  // Always acknowledge quickly to avoid uninstall failures in HubSpot UI.
  const portalId = extractPortalIdFromDeauth(req);
  if (portalId) {
    removePortalData(portalId);
    console.log(`Deauthorize callback processed for portal ${portalId}`);
  } else {
    console.warn("Deauthorize callback received without portal ID");
  }
  return res.status(200).json({ success: true, portalId: portalId || null });
}

// Deauthorization callback for uninstall flows.
// Configure this URL in HubSpot app settings:
//   https://api.uspeh.co.uk/oauth/deauthorize
app.all("/oauth/deauthorize", handleDeauthorize);

// ================================================================
// BATCH CALCULATION ENDPOINT
// Called from the settings page via hubspot.fetch()
// HubSpot adds ?portalId=xxx&userId=xxx&userEmail=xxx&appId=xxx
// ================================================================
// In-memory job status tracker (survives page navigations, not server restarts)
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

  // Check if analysis is needed (only allow if sources config changed since last run)
  const config = loadPortalConfig();
  const portalConfig = config[String(portalId)] || {};
  const lastAnalysisRun = portalConfig.lastAnalysisRun || null;
  const lastSourcesUpdated = portalConfig.updatedAt || null;

  // If analysis has been run and sources haven't changed since, block it
  if (lastAnalysisRun && lastSourcesUpdated && new Date(lastAnalysisRun) > new Date(lastSourcesUpdated)) {
    return res.json({
      success: false,
      status: "blocked",
      message: "Analysis has already been run with the current source configuration. Change your marketing source settings to run again.",
    });
  }

  // Respond immediately — processing happens in the background
  jobStatus[portalId] = { running: true, processed: 0, updated: 0, failed: 0, skippedNoHistory: 0, startedAt: new Date().toISOString() };
  res.json({ success: true, message: "Analysis started! Tracking progress...", status: "started" });

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

    // Persist lastAnalysisRun to portal config
    const updatedConfig = loadPortalConfig();
    updatedConfig[String(portalId)] = {
      ...(updatedConfig[String(portalId)] || {}),
      lastAnalysisRun: jobStatus[portalId].completedAt,
      lastAnalysisResult: {
        processed: jobStatus[portalId].processed,
        updated: jobStatus[portalId].updated,
        skippedNoHistory: jobStatus[portalId].skippedNoHistory,
        failed: jobStatus[portalId].failed,
      },
    };
    savePortalConfig(updatedConfig);
  } catch (e) {
    console.error("Background calculation error:", e);
    jobStatus[portalId].running = false;
    jobStatus[portalId].error = e.message;
  }
});

// Status endpoint — returns job progress + portal config timestamps
app.get("/api/calculate-contribution/status", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const config = loadPortalConfig();
  const portalConfig = config[String(portalId)] || {};
  const lastAnalysisRun = portalConfig.lastAnalysisRun || null;
  const lastSourcesUpdated = portalConfig.updatedAt || null;
  const lastAnalysisResult = portalConfig.lastAnalysisResult || null;

  // Determine if the Run Analysis button should be enabled
  // Enabled if: no analysis has ever run, OR sources were updated after the last analysis
  let analysisAllowed = true;
  if (lastAnalysisRun && lastSourcesUpdated) {
    analysisAllowed = new Date(lastSourcesUpdated) > new Date(lastAnalysisRun);
  } else if (lastAnalysisRun && !lastSourcesUpdated) {
    // Analysis has run but sources were never explicitly configured (used defaults)
    analysisAllowed = false;
  }

  // Check in-memory job status
  const job = jobStatus[portalId];

  if (job?.running) {
    return res.json({
      success: true,
      status: "running",
      processed: job.processed,
      updated: job.updated,
      skippedNoHistory: job.skippedNoHistory,
      failed: job.failed,
      startedAt: job.startedAt,
      message: `Processing... ${job.processed} contacts done so far.`,
      lastAnalysisRun,
      lastSourcesUpdated,
      analysisAllowed: false, // Can't run while already running
    });
  }

  if (job && !job.running) {
    const statusLabel = job.error ? "error" : "completed";
    return res.json({
      success: true,
      status: statusLabel,
      processed: job.processed,
      updated: job.updated,
      skippedNoHistory: job.skippedNoHistory,
      failed: job.failed,
      startedAt: job.startedAt,
      completedAt: job.completedAt || null,
      error: job.error || null,
      message: job.error
        ? `Error: ${job.error}`
        : `Complete! Processed ${job.processed} contacts. Updated: ${job.updated}, Zero-history: ${job.skippedNoHistory}, Failed: ${job.failed}.`,
      lastAnalysisRun,
      lastSourcesUpdated,
      analysisAllowed,
    });
  }

  // No in-memory job — check persisted data
  if (lastAnalysisRun && lastAnalysisResult) {
    return res.json({
      success: true,
      status: "completed",
      processed: lastAnalysisResult.processed,
      updated: lastAnalysisResult.updated,
      skippedNoHistory: lastAnalysisResult.skippedNoHistory,
      failed: lastAnalysisResult.failed,
      completedAt: lastAnalysisRun,
      message: `Last analysis completed on ${new Date(lastAnalysisRun).toLocaleString()}. Processed ${lastAnalysisResult.processed} contacts.`,
      lastAnalysisRun,
      lastSourcesUpdated,
      analysisAllowed,
    });
  }

  return res.json({
    success: true,
    status: "idle",
    message: "No analysis has been run yet.",
    lastAnalysisRun: null,
    lastSourcesUpdated,
    analysisAllowed: true,
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
// MCF (MULTI-CHANNEL FUNNEL) PATHS ENDPOINTS
// Replicates UA "Top Conversion Paths" behaviour.
// ================================================================
const mcfJobStatus = {};

function parseMcfWindow(startDate, endDate) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_RANGE_DAYS = 183; // rolling ~6 months max
  const now = new Date();

  const parsedEnd = endDate ? new Date(endDate) : now;
  if (Number.isNaN(parsedEnd.getTime())) {
    return { error: "Invalid endDate" };
  }
  const end = parsedEnd > now ? now : parsedEnd;

  const parsedStart = startDate
    ? new Date(startDate)
    : new Date(end.getTime() - 90 * DAY_MS);
  if (Number.isNaN(parsedStart.getTime())) {
    return { error: "Invalid startDate" };
  }
  const start = parsedStart;

  if (start > end) {
    return { error: "Start date must be before end date." };
  }

  const maxRangeStart = new Date(end.getTime() - MAX_RANGE_DAYS * DAY_MS);
  if (start < maxRangeStart) {
    return { error: "Date range cannot exceed the last 6 months (rolling)." };
  }

  return { start, end };
}

async function getMcfConversionsForType(portalId, conversionType, start, end, jobStatus) {
  if (conversionType !== "meeting_booked") return [];
  return findMeetingBookedConversions(portalId, start, end, jobStatus);
}

/** POST /api/mcf/refresh — start a background MCF analysis job.
 *  CONVERSION-FIRST approach:
 *    1. Find conversion events in reporting period (deals/meetings/forms)
 *    2. Extract associated contacts
 *    3. Filter to contacts whose FIRST EVER conversion of that type is in the period
 *    4. For qualifying contacts only: pull full hs_latest_source history,
 *       truncate at conversion timestamp, build ordered paths
 *    5. Aggregate and return ranked paths
 *
 *  DOES NOT iterate over all contacts — only touches converting entities.
 */
app.post("/api/mcf/refresh", async (req, res) => {
  const body = req.body || {};
  const portalId = req.query.portalId || body.portalId || body.portal_id;
  if (!portalId) {
    return res.status(400).json({
      success: false,
      message: "Missing portalId. Ensure the settings page has access to the HubSpot account context.",
    });
  }

  const {
    conversionType = "meeting_booked",
    startDate,
    endDate,
  } = body;

  if (conversionType !== "meeting_booked") {
    return res.status(400).json({ success: false, message: "Only meeting_booked (first-ever meeting) is supported." });
  }

  const parsedWindow = parseMcfWindow(startDate, endDate);
  if (parsedWindow.error) {
    return res.status(400).json({ success: false, message: parsedWindow.error });
  }
  const { start, end } = parsedWindow;

  const jobKey = String(portalId);

  if (mcfJobStatus[jobKey]?.running) {
    return res.json({
      success: true,
      status: "running",
      message: mcfJobStatus[jobKey].message || "MCF analysis already running.",
      ...mcfJobStatus[jobKey],
    });
  }

  mcfJobStatus[jobKey] = {
    running: true,
    processed: 0,
    converting: 0,
    pathsBuilt: 0,
    startedAt: new Date().toISOString(),
    conversionType,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    message: "Starting conversion-first analysis...",
  };
  res.json({ success: true, status: "started", message: "MCF analysis started (conversion-first)." });

  // ---- Background job (conversion-first) ----
  (async () => {
    try {
      console.log(`MCF portal ${portalId}: Starting ${conversionType} analysis [${start.toISOString()} — ${end.toISOString()}]`);

      // ━━━ Phase 1: Find qualifying first-ever conversions ━━━
      // Each finder function:
      //   a) Searches conversion events in reporting period
      //   b) Extracts associated contacts
      //   c) Verifies the conversion is the FIRST EVER of that type for each contact
      //   d) Returns only qualifying { contactId, conversionTimestamp, conversionValue, currency }
      const conversions = await getMcfConversionsForType(
        portalId,
        conversionType,
        start,
        end,
        mcfJobStatus[jobKey]
      );

      mcfJobStatus[jobKey].converting = conversions.length;

      if (conversions.length === 0) {
        mcfJobStatus[jobKey].running = false;
        mcfJobStatus[jobKey].completedAt = new Date().toISOString();
        mcfJobStatus[jobKey].message = "Complete — no qualifying first-ever conversions found in the period.";
        mcfJobStatus[jobKey].result = {
          paths: [], totalConversions: 0, totalContacts: 0,
          conversionType,
          startDate: start.toISOString(), endDate: end.toISOString(),
          refreshedAt: new Date().toISOString(), currencies: [],
          mixedCurrencies: false, channelLabels: CHANNEL_LABELS,
        };
        // Persist empty result
        const allResults = loadMcfResults();
        allResults[`${portalId}:${conversionType}`] = mcfJobStatus[jobKey].result;
        saveMcfResults(allResults);
        return;
      }

      // ━━━ Phase 2: Build traffic source paths ━━━
      mcfJobStatus[jobKey].message = `Building paths for ${conversions.length} qualifying conversions...`;

      // Gather all contact IDs needed to build paths:
      // - contact-level events: conv.contactId
      // - deal-level events: conv.associatedContactIds[]
      const neededContactIdsSet = new Set();
      for (const conv of conversions) {
        if (conv.contactId) neededContactIdsSet.add(String(conv.contactId));
        for (const cId of conv.associatedContactIds || []) {
          neededContactIdsSet.add(String(cId));
        }
      }
      const uniqueContactIds = [...neededContactIdsSet];

      // Batch-read contacts with hs_latest_source history + display props
      const contactsWithHistory = await batchReadObjects(
        portalId, "contacts", uniqueContactIds,
        ["hs_latest_source", "email", "firstname", "lastname"],
        ["hs_latest_source"]
      );

      // Index by ID for fast lookup
      const contactHistoryMap = {};
      const contactDisplayMap = {};
      for (const c of contactsWithHistory) {
        contactHistoryMap[c.id] = c.propertiesWithHistory?.hs_latest_source || [];
        contactDisplayMap[c.id] = {
          email: c.properties?.email || "",
          firstname: c.properties?.firstname || "",
          lastname: c.properties?.lastname || "",
        };
      }

      // Build paths and aggregate; track eligible contacts per path
      const pathCounts = {};
      const eligibleContacts = [];
      let pathsBuilt = 0;

      for (const conv of conversions) {
        const contactIdsForEvent = conv.contactId
          ? [String(conv.contactId)]
          : (conv.associatedContactIds || []).map((id) => String(id));

        // Keep all contact paths, but do not duplicate conversion count/amount by contact.
        // Each conversion event contributes total weight=1 and total value once.
        const uniqueEventContacts = [...new Set(contactIdsForEvent)];
        const eventWeight = uniqueEventContacts.length > 0 ? 1 / uniqueEventContacts.length : 1;
        const eventValueWeight = (conv.conversionValue || 0) * eventWeight;

        if (uniqueEventContacts.length === 0) {
          const key = "UNKNOWN";
          if (!pathCounts[key]) {
            pathCounts[key] = { path: ["UNKNOWN"], conversions: 0, totalValue: 0, currencies: new Set() };
          }
          pathCounts[key].conversions += 1;
          pathCounts[key].totalValue += conv.conversionValue || 0;
          if (conv.currency) pathCounts[key].currencies.add(conv.currency);
          continue;
        }

        for (const contactId of uniqueEventContacts) {
          const sourceHistory = contactHistoryMap[contactId] || [];
          const path = buildConversionPath(sourceHistory, conv.conversionTimestamp);
          const key = pathToKey(path);

          if (!pathCounts[key]) {
            pathCounts[key] = { path, conversions: 0, totalValue: 0, currencies: new Set() };
          }
          pathCounts[key].conversions += eventWeight;
          pathCounts[key].totalValue += eventValueWeight;
          if (conv.currency) pathCounts[key].currencies.add(conv.currency);

          const disp = contactDisplayMap[contactId] || {};
          eligibleContacts.push({
            contactId,
            pathKey: key,
            conversionTimestamp: conv.conversionTimestamp,
            email: disp.email || "",
            firstname: disp.firstname || "",
            lastname: disp.lastname || "",
          });

          pathsBuilt++;
          if (pathsBuilt % 25 === 0) {
            mcfJobStatus[jobKey].pathsBuilt = pathsBuilt;
            mcfJobStatus[jobKey].message = `Building paths: ${pathsBuilt} contact-path evaluations done.`;
          }
        }
      }

      mcfJobStatus[jobKey].pathsBuilt = pathsBuilt;

      // ━━━ Phase 3: Rank paths (no threshold filter) ━━━
      const totalConversions = conversions.length;
      const topPaths = Object.values(pathCounts)
        .sort((a, b) => b.conversions - a.conversions || b.totalValue - a.totalValue)
        .map((p) => ({
          path: p.path,
          pathKey: pathToKey(p.path),
          conversions: Math.round(p.conversions * 10000) / 10000,
          sharePct: totalConversions > 0 ? Math.round((p.conversions / totalConversions) * 10000) / 100 : 0,
          conversionValue: Math.round(p.totalValue * 100) / 100,
          currencies: [...p.currencies],
        }));

      const allCurrencies = new Set();
      topPaths.forEach((p) => p.currencies.forEach((c) => allCurrencies.add(c)));

      const result = {
        paths: topPaths,
        eligibleContacts,
        totalConversions,
        totalContacts: uniqueContactIds.length,
        conversionType,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        refreshedAt: new Date().toISOString(),
        currencies: [...allCurrencies],
        mixedCurrencies: allCurrencies.size > 1,
        channelLabels: CHANNEL_LABELS,
      };

      // Persist to file
      const allResults = loadMcfResults();
      allResults[`${portalId}:${conversionType}`] = result;
      saveMcfResults(allResults);

      mcfJobStatus[jobKey].running = false;
      mcfJobStatus[jobKey].completedAt = new Date().toISOString();
      mcfJobStatus[jobKey].result = result;
      mcfJobStatus[jobKey].message = `Complete! ${totalConversions} first-ever conversions → ${topPaths.length} path(s) ranked.`;

      console.log(`MCF portal ${portalId}: DONE — ${totalConversions} conversions, ${topPaths.length} ranked paths.`);
    } catch (e) {
      console.error("MCF background error:", e);
      mcfJobStatus[jobKey].running = false;
      mcfJobStatus[jobKey].error = e.message;
      mcfJobStatus[jobKey].message = `Error: ${e.message}`;
    }
  })();
});

/** GET /api/mcf/status — poll progress of running MCF job. */
app.get("/api/mcf/status", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const job = mcfJobStatus[String(portalId)];

  if (job?.running) {
    return res.json({
      success: true,
      status: "running",
      converting: job.converting || 0,
      pathsBuilt: job.pathsBuilt || 0,
      startedAt: job.startedAt,
      conversionType: job.conversionType,
      message: job.message || "Processing...",
    });
  }

  if (job && !job.running) {
    return res.json({
      success: true,
      status: job.error ? "error" : "completed",
      converting: job.converting || 0,
      pathsBuilt: job.pathsBuilt || 0,
      completedAt: job.completedAt || null,
      error: job.error || null,
      conversionType: job.conversionType,
      message: job.message || (job.error
        ? `Error: ${job.error}`
        : `Complete! ${job.converting || 0} first-ever conversions, ${job.pathsBuilt || 0} paths built.`),
    });
  }

  return res.json({
    success: true,
    status: "idle",
    message: "No MCF analysis running. Click Refresh to start.",
  });
});

/** POST /api/mcf/clear-cache — clear cached MCF results for a portal so a fresh run is forced. */
app.post("/api/mcf/clear-cache", async (req, res) => {
  const portalId = req.query.portalId || req.body?.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }
  const key = String(portalId);
  // Clear in-memory result
  if (mcfJobStatus[key]) {
    delete mcfJobStatus[key].result;
  }
  // Clear persisted cache for this portal (all conversion types)
  const allResults = loadMcfResults();
  let changed = false;
  for (const k of Object.keys(allResults)) {
    if (k.startsWith(`${key}:`)) {
      delete allResults[k];
      changed = true;
    }
  }
  if (changed) saveMcfResults(allResults);
  return res.json({ success: true, message: "MCF cache cleared. Run a fresh analysis." });
});

/** GET /api/mcf/result — fetch cached MCF results. */
app.get("/api/mcf/result", async (req, res) => {
  const portalId = req.query.portalId;
  const conversionType = req.query.conversionType || "meeting_booked";
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  // Check in-memory first (freshest)
  const job = mcfJobStatus[String(portalId)];
  if (job?.result && job.result.conversionType === conversionType) {
    return res.json({ success: true, ...job.result });
  }

  // Fall back to persisted results
  const allResults = loadMcfResults();
  const cached = allResults[`${portalId}:${conversionType}`];

  if (cached) {
    return res.json({ success: true, ...cached });
  }

  return res.json({
    success: true,
    paths: [],
    totalConversions: 0,
    message: "No results available. Run a refresh first.",
  });
});

/** POST /api/mcf/debug-conversions — returns raw detected conversions for validation.
 *  Backend-only troubleshooting endpoint. Does not run path aggregation.
 */
app.post("/api/mcf/debug-conversions", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const {
    conversionType = "meeting_booked",
    startDate,
    endDate,
    limit = 200,
    offset = 0,
  } = req.body || {};

  if (conversionType !== "meeting_booked") {
    return res.status(400).json({ success: false, message: "Only meeting_booked is supported." });
  }

  const parsedWindow = parseMcfWindow(startDate, endDate);
  if (parsedWindow.error) {
    return res.status(400).json({ success: false, message: parsedWindow.error });
  }
  const { start, end } = parsedWindow;

  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const debugStatus = { message: "Collecting conversions...", processed: 0, converting: 0 };

  try {
    const conversions = await getMcfConversionsForType(
      portalId,
      conversionType,
      start,
      end,
      debugStatus
    );

    const ordered = [...conversions].sort((a, b) => {
      return Number(a.conversionTimestamp || 0) - Number(b.conversionTimestamp || 0);
    });

    const paged = ordered.slice(safeOffset, safeOffset + safeLimit);
    const rows = paged.map((c) => ({
      objectType: c.objectType || (c.contactId ? "contact_event" : "conversion_event"),
      objectId: c.objectId || null,
      objectName: c.objectName || null,
      contactId: c.contactId ? String(c.contactId) : null,
      associatedContactIds: (c.associatedContactIds || []).map((id) => String(id)),
      conversionTimestamp: Number(c.conversionTimestamp || 0),
      conversionDateIso: new Date(Number(c.conversionTimestamp || 0)).toISOString(),
      amount: Number(c.conversionValue || 0),
      currency: c.currency || null,
    }));

    const totals = ordered.reduce(
      (acc, c) => {
        const amount = Number(c.conversionValue || 0);
        acc.totalAmount += amount;
        const cur = c.currency || "NONE";
        acc.currencyTotals[cur] = (acc.currencyTotals[cur] || 0) + amount;
        return acc;
      },
      { totalAmount: 0, currencyTotals: {} }
    );

    return res.json({
      success: true,
      conversionType,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      detectedCount: ordered.length,
      returnedCount: rows.length,
      offset: safeOffset,
      limit: safeLimit,
      totalAmount: Math.round(totals.totalAmount * 100) / 100,
      currencyTotals: totals.currencyTotals,
      message: debugStatus.message || "OK",
      conversions: rows,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: `Debug conversion query failed: ${e.message}`,
    });
  }
});

/** POST /api/mcf/debug-contact — trace why specific contacts were excluded from MCF.
 *  Body: { contactIds: string[], startDate?, endDate? }
 *  Uses same date range as last MCF run if not provided, or last 90 days.
 */
app.post("/api/mcf/debug-contact", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const { contactIds = [] } = req.body || {};
  const ids = Array.isArray(contactIds) ? contactIds.map(String).filter(Boolean) : [];
  if (ids.length === 0) {
    return res.status(400).json({ success: false, message: "Provide contactIds array in body" });
  }
  if (ids.length > 20) {
    return res.status(400).json({ success: false, message: "Max 20 contactIds per request" });
  }

  let start, end;
  const parsed = parseMcfWindow(req.body?.startDate, req.body?.endDate);
  if (parsed.error) {
    const fallback = parseMcfWindow(
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );
    start = fallback.start;
    end = fallback.end;
  } else {
    start = parsed.start;
    end = parsed.end;
  }

  const results = [];
  const meetingProps = ["hs_createdate", "hs_meeting_start_time", "hs_timestamp", "createdAt"];

  for (const contactId of ids) {
    const trace = {
      contactId,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      qualified: false,
      reason: "",
      meetingsInPeriod: [],
      allMeetingsForContact: [],
      earlierMeetings: [],
      meetingsInPeriodLinkedToContact: [],
    };

    try {
      // 1. Get all meetings in the period (same search as main logic)
      const meetingsInPeriod = await searchObjects(
        portalId, "meetings",
        [{
          filters: [{
            propertyName: "hs_createdate",
            operator: "BETWEEN",
            value: String(start.getTime()),
            highValue: String(end.getTime()),
          }],
        }],
        meetingProps
      );

      // 2. Get meeting→contact associations for those meetings
      const meetingIdsInPeriod = meetingsInPeriod.map((m) => m.id);
      const meetingToContacts = await batchGetAssociations(portalId, "meetings", meetingIdsInPeriod, "contacts");

      // 3. Which meetings in period are linked to this contact?
      const linkedMeetingIds = [];
      for (const m of meetingsInPeriod) {
        const mContacts = meetingToContacts[m.id] || [];
        if (mContacts.includes(contactId)) linkedMeetingIds.push(m.id);
      }

      for (const m of meetingsInPeriod) {
        const ts = new Date(
          m.properties?.hs_meeting_start_time ||
          m.properties?.hs_timestamp ||
          m.properties?.hs_createdate ||
          m.createdAt
        ).getTime();
        trace.meetingsInPeriod.push({
          id: m.id,
          hs_createdate: m.properties?.hs_createdate,
          hs_meeting_start_time: m.properties?.hs_meeting_start_time,
          hs_timestamp: m.properties?.hs_timestamp,
          createdAt: m.createdAt,
          computedTs: ts,
          linkedToContact: (meetingToContacts[m.id] || []).includes(contactId),
        });
      }

      if (linkedMeetingIds.length === 0) {
        trace.reason = "No meetings in period are associated with this contact";
        results.push(trace);
        continue;
      }

      // 4. Get ALL meetings for this contact
      const contactToMeetings = await batchGetAssociations(portalId, "contacts", [contactId], "meetings");
      const allMeetingIds = contactToMeetings[contactId] || [];

      if (allMeetingIds.length === 0) {
        trace.reason = "Contact has no meeting associations (unexpected)";
        results.push(trace);
        continue;
      }

      const allMeetings = await batchReadObjects(portalId, "meetings", allMeetingIds, meetingProps);

      for (const m of allMeetings) {
        const ts = new Date(
          m.properties?.hs_meeting_start_time ||
          m.properties?.hs_timestamp ||
          m.properties?.hs_createdate ||
          m.createdAt
        ).getTime();
        const isEarlier = !isNaN(ts) && ts < start.getTime();
        trace.allMeetingsForContact.push({
          id: m.id,
          hs_createdate: m.properties?.hs_createdate,
          hs_meeting_start_time: m.properties?.hs_meeting_start_time,
          hs_timestamp: m.properties?.hs_timestamp,
          createdAt: m.createdAt,
          computedTs: ts,
          isEarlier,
        });
        if (isEarlier) trace.earlierMeetings.push({ id: m.id, computedTs: ts });
      }

      if (trace.earlierMeetings.length > 0) {
        trace.reason = `Contact has ${trace.earlierMeetings.length} meeting(s) before period start — not first-ever`;
      } else {
        trace.qualified = true;
        trace.reason = "Should qualify (no earlier meetings)";
      }
    } catch (e) {
      trace.reason = `Error: ${e.message}`;
    }
    results.push(trace);
  }

  return res.json({
    success: true,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    contacts: results,
  });
});

/** GET /api/mcf/conversion-types — returns available conversion type options. */
app.get("/api/mcf/conversion-types", async (_req, res) => {
  return res.json({ success: true, conversionTypes: CONVERSION_TYPE_OPTIONS });
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
