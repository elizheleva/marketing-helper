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

// ---- MCF (Multi-Channel Funnel) Constants ----
const MCF_RESULTS_PATH = process.env.MCF_RESULTS_PATH || "./data/mcf-results.json";

const CHANNEL_LABELS = {
  ORGANIC_SEARCH: "Organic Search",
  PAID_SEARCH: "Paid Search",
  EMAIL_MARKETING: "Email Marketing",
  SOCIAL_MEDIA: "Social Media",
  REFERRALS: "Referrals",
  OTHER_CAMPAIGNS: "Other Campaigns",
  PAID_SOCIAL: "Paid Social",
  DISPLAY_ADS: "Display Ads",
  DIRECT_TRAFFIC: "Direct Traffic",
  OFFLINE: "Offline",
  OTHER: "Other",
};

const CONVERSION_TYPE_OPTIONS = [
  { value: "form_submission", label: "Form Submission (first-ever)" },
  { value: "meeting_booked", label: "Meeting Booked (first-ever)" },
  { value: "deal_created", label: "Deal Created (first-ever)" },
  { value: "closed_won", label: "Closed-Won Deal (first-ever)" },
];

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

// Pipeline cache — maps portalId → { stageIds: Set, fetchedAt: number }
const pipelineCache = {};

/** Get all closed-won deal stage IDs for a portal (cached 1 hour). */
async function getClosedWonStageIds(portalId) {
  const key = String(portalId);
  if (pipelineCache[key] && Date.now() - pipelineCache[key].fetchedAt < 3600000) {
    return pipelineCache[key].stageIds;
  }
  try {
    const data = await hubspotApiWithRetry(
      portalId,
      "https://api.hubapi.com/crm/v3/pipelines/deals"
    );
    const stageIds = new Set();
    for (const pipeline of data.results || []) {
      for (const stage of pipeline.stages || []) {
        const meta = stage.metadata || {};
        if (
          meta.isClosed === "true" &&
          parseFloat(meta.probability || "0") >= 1.0
        ) {
          stageIds.add(stage.id);
        }
      }
    }
    pipelineCache[key] = { stageIds, fetchedAt: Date.now() };
    return stageIds;
  } catch (e) {
    console.error(`Failed to fetch pipelines for portal ${portalId}:`, e.message);
    return new Set();
  }
}

// (getConversionTimestamp removed — replaced by conversion-first finder functions below)

/**
 * Build a conversion path from hs_latest_source history.
 * Includes ALL entries before the conversion timestamp (no lookback limit).
 * This captures the full journey leading to conversion.
 * Collapses consecutive duplicate sources.
 */
function buildConversionPath(sourceHistory, conversionTimestamp) {
  const entries = (sourceHistory || [])
    .filter((e) => {
      const ts = Number(e.timestamp || 0);
      return ts > 0 && ts <= conversionTimestamp;
    })
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

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
// Instead of scanning all contacts, start from the conversion objects
// (meetings, deals, form submissions) and work backwards to contacts.
// ================================================================

/**
 * Paginated CRM search. Returns all matching objects.
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
 * Get associated object IDs for a given CRM object.
 */
async function getAssociations(portalId, fromType, fromId, toType) {
  try {
    const data = await hubspotApiWithRetry(
      portalId,
      `https://api.hubapi.com/crm/v3/objects/${fromType}/${fromId}/associations/${toType}?limit=500`
    );
    return (data.results || []).map((r) => String(r.toObjectId || r.id));
  } catch (e) {
    console.warn(`MCF: getAssociations ${fromType}/${fromId}->${toType} failed:`, e.message);
    return [];
  }
}

// ---- Form Submission (first-ever) ----
// hs_first_conversion_date IS the first-ever date, so no extra checks needed.
async function findFormSubmissionConversions(portalId, start, end, jobStatus) {
  jobStatus.message = "Searching for form submissions in period...";

  const contacts = await searchObjects(
    portalId,
    "contacts",
    [{
      filters: [{
        propertyName: "hs_first_conversion_date",
        operator: "BETWEEN",
        value: String(start.getTime()),
        highValue: String(end.getTime()),
      }],
    }],
    ["hs_first_conversion_date"]
  );

  jobStatus.processed = contacts.length;
  jobStatus.message = `Found ${contacts.length} first-ever form submissions in period.`;

  const conversions = [];
  for (const c of contacts) {
    const d = c.properties?.hs_first_conversion_date;
    if (d) {
      const ts = new Date(d).getTime();
      if (!isNaN(ts)) {
        conversions.push({ contactId: c.id, conversionTimestamp: ts, conversionValue: 0, currency: null });
      }
    }
  }
  return conversions;
}

// ---- Meeting Booked (first-ever) ----
// 1) Search meetings in date range
// 2) Get associated contacts for those meetings
// 3) For each contact, check if they have any EARLIER meetings (outside the period)
// 4) If no earlier meetings → this is their first-ever → qualifies
async function findMeetingBookedConversions(portalId, start, end, jobStatus) {
  jobStatus.message = "Searching for meetings in period...";

  // Step 1: Find all meetings created within the date range
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

  jobStatus.message = `Found ${meetings.length} meetings. Getting associated contacts...`;

  // Step 2: Map meetings → contacts (keep earliest meeting per contact in period)
  const contactMap = {}; // contactId → earliest meeting timestamp in period
  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    const mTs = new Date(
      m.properties?.hs_meeting_start_time ||
      m.properties?.hs_timestamp ||
      m.properties?.hs_createdate ||
      m.createdAt
    ).getTime();

    const contactIds = await getAssociations(portalId, "meetings", m.id, "contacts");
    for (const cId of contactIds) {
      if (!contactMap[cId] || mTs < contactMap[cId]) contactMap[cId] = mTs;
    }
    if ((i + 1) % 10 === 0) { jobStatus.processed = i + 1; await msDelay(150); }
  }

  const uniqueContacts = Object.keys(contactMap);
  jobStatus.message = `${uniqueContacts.length} contacts with meetings. Checking first-ever...`;

  // Step 3: For each contact, verify no earlier meetings exist before the period
  const conversions = [];
  for (let i = 0; i < uniqueContacts.length; i++) {
    const cId = uniqueContacts[i];
    try {
      const allMeetingIds = await getAssociations(portalId, "contacts", cId, "meetings");
      let hasEarlier = false;

      for (const mId of allMeetingIds) {
        try {
          const mObj = await hubspotApiWithRetry(
            portalId,
            `https://api.hubapi.com/crm/v3/objects/meetings/${mId}?properties=hs_meeting_start_time,hs_timestamp,hs_createdate`
          );
          const ts = new Date(
            mObj.properties?.hs_meeting_start_time ||
            mObj.properties?.hs_timestamp ||
            mObj.properties?.hs_createdate ||
            mObj.createdAt
          ).getTime();
          if (!isNaN(ts) && ts < start.getTime()) { hasEarlier = true; break; }
        } catch (_) { /* skip */ }
      }

      if (!hasEarlier) {
        conversions.push({
          contactId: cId,
          conversionTimestamp: contactMap[cId],
          conversionValue: 0,
          currency: null,
        });
      }
    } catch (e) {
      console.warn(`MCF: meeting check error contact ${cId}:`, e.message);
    }
    if ((i + 1) % 5 === 0) await msDelay(150);
  }

  jobStatus.converting = conversions.length;
  jobStatus.message = `Found ${conversions.length} first-ever meeting bookings.`;
  return conversions;
}

// ---- Deal Created (first-ever) ----
// 1) Search deals created in date range
// 2) Get associated contacts for those deals
// 3) For each contact, check if they have any EARLIER deals (outside the period)
// 4) If no earlier deals → first-ever → qualifies
async function findDealCreatedConversions(portalId, start, end, jobStatus) {
  jobStatus.message = "Searching for deals created in period...";

  const deals = await searchObjects(
    portalId,
    "deals",
    [{
      filters: [{
        propertyName: "createdate",
        operator: "BETWEEN",
        value: String(start.getTime()),
        highValue: String(end.getTime()),
      }],
    }],
    ["createdate", "amount", "deal_currency_code"]
  );

  jobStatus.message = `Found ${deals.length} deals. Getting associated contacts...`;

  // Map deals → contacts (keep earliest deal per contact)
  const contactMap = {}; // cId → { ts, value, currency }
  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const dTs = new Date(deal.properties?.createdate || deal.createdAt).getTime();
    const dVal = parseFloat(deal.properties?.amount || "0") || 0;
    const dCur = deal.properties?.deal_currency_code || null;

    const contactIds = await getAssociations(portalId, "deals", deal.id, "contacts");
    for (const cId of contactIds) {
      if (!contactMap[cId] || dTs < contactMap[cId].ts) {
        contactMap[cId] = { ts: dTs, value: dVal, currency: dCur };
      }
    }
    if ((i + 1) % 10 === 0) { jobStatus.processed = i + 1; await msDelay(150); }
  }

  const uniqueContacts = Object.keys(contactMap);
  jobStatus.message = `${uniqueContacts.length} contacts with deals. Checking first-ever...`;

  // For each contact, verify no earlier deals exist before the period
  const conversions = [];
  for (let i = 0; i < uniqueContacts.length; i++) {
    const cId = uniqueContacts[i];
    try {
      const allDealIds = await getAssociations(portalId, "contacts", cId, "deals");
      let hasEarlier = false;

      for (const dId of allDealIds) {
        try {
          const dObj = await hubspotApiWithRetry(
            portalId,
            `https://api.hubapi.com/crm/v3/objects/deals/${dId}?properties=createdate`
          );
          const ts = new Date(dObj.properties?.createdate || dObj.createdAt).getTime();
          if (!isNaN(ts) && ts < start.getTime()) { hasEarlier = true; break; }
        } catch (_) { /* skip */ }
      }

      if (!hasEarlier) {
        const d = contactMap[cId];
        conversions.push({
          contactId: cId,
          conversionTimestamp: d.ts,
          conversionValue: d.value,
          currency: d.currency,
        });
      }
    } catch (e) {
      console.warn(`MCF: deal check error contact ${cId}:`, e.message);
    }
    if ((i + 1) % 5 === 0) await msDelay(150);
  }

  jobStatus.converting = conversions.length;
  jobStatus.message = `Found ${conversions.length} first-ever deal creations.`;
  return conversions;
}

// ---- Closed-Won Deal (first-ever) ----
// 1) Search deals in closed-won stages with closedate in range
// 2) Check dealstage history to confirm first closed-won timestamp is in range
// 3) Get associated contacts
// 4) For each contact, check if they have any EARLIER closed-won deals
// 5) If no earlier → first-ever → qualifies
async function findClosedWonConversions(portalId, start, end, jobStatus) {
  const closedWonStages = await getClosedWonStageIds(portalId);
  if (closedWonStages.size === 0) {
    jobStatus.message = "No closed-won stages found in pipelines.";
    return [];
  }

  jobStatus.message = "Searching for closed-won deals in period...";

  const deals = await searchObjects(
    portalId,
    "deals",
    [{
      filters: [
        { propertyName: "dealstage", operator: "IN", values: [...closedWonStages] },
        { propertyName: "closedate", operator: "BETWEEN", value: String(start.getTime()), highValue: String(end.getTime()) },
      ],
    }],
    ["createdate", "closedate", "amount", "deal_currency_code", "dealstage"]
  );

  jobStatus.message = `Found ${deals.length} closed-won deals. Checking stage history...`;

  // For each deal, confirm it first reached closed-won within the period
  const qualifyingDeals = [];
  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    try {
      const dh = await hubspotApiWithRetry(
        portalId,
        `https://api.hubapi.com/crm/v3/objects/deals/${deal.id}?properties=amount,deal_currency_code,closedate,dealstage&propertiesWithHistory=dealstage`
      );

      const history = [...(dh.propertiesWithHistory?.dealstage || [])].sort(
        (a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)
      );
      let cwTs = null;
      for (const e of history) {
        if (closedWonStages.has(e.value)) { cwTs = Number(e.timestamp); break; }
      }
      // Fallback to closedate
      if (!cwTs && dh.properties?.closedate) cwTs = new Date(dh.properties.closedate).getTime();

      if (cwTs && cwTs >= start.getTime() && cwTs <= end.getTime()) {
        qualifyingDeals.push({
          dealId: deal.id,
          closedWonTs: cwTs,
          value: parseFloat(dh.properties?.amount || "0") || 0,
          currency: dh.properties?.deal_currency_code || null,
        });
      }
    } catch (e) {
      console.warn(`MCF: skip deal ${deal.id} history:`, e.message);
    }
    if ((i + 1) % 10 === 0) { jobStatus.processed = i + 1; await msDelay(150); }
  }

  // Map qualifying deals → contacts
  const contactMap = {};
  for (const qd of qualifyingDeals) {
    const contactIds = await getAssociations(portalId, "deals", qd.dealId, "contacts");
    for (const cId of contactIds) {
      if (!contactMap[cId] || qd.closedWonTs < contactMap[cId].closedWonTs) {
        contactMap[cId] = qd;
      }
    }
  }

  // Check first-ever closed-won per contact
  const conversions = [];
  for (const [cId, qd] of Object.entries(contactMap)) {
    try {
      const allDealIds = await getAssociations(portalId, "contacts", cId, "deals");
      let hasEarlier = false;

      for (const dId of allDealIds) {
        if (dId === qd.dealId) continue;
        try {
          const d = await hubspotApiWithRetry(
            portalId,
            `https://api.hubapi.com/crm/v3/objects/deals/${dId}?properties=dealstage&propertiesWithHistory=dealstage`
          );
          const hist = d.propertiesWithHistory?.dealstage || [];
          for (const entry of hist) {
            if (closedWonStages.has(entry.value) && Number(entry.timestamp) < start.getTime()) {
              hasEarlier = true;
              break;
            }
          }
          if (hasEarlier) break;
        } catch (_) { /* skip */ }
      }

      if (!hasEarlier) {
        conversions.push({
          contactId: cId,
          conversionTimestamp: qd.closedWonTs,
          conversionValue: qd.value,
          currency: qd.currency,
        });
      }
    } catch (e) {
      console.warn(`MCF: closed-won check error contact ${cId}:`, e.message);
    }
  }

  jobStatus.converting = conversions.length;
  jobStatus.message = `Found ${conversions.length} first-ever closed-won deals.`;
  return conversions;
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

/** POST /api/mcf/refresh — start a background MCF analysis job.
 *  CONVERSION-FIRST approach: starts from conversions, works backwards to contacts.
 */
app.post("/api/mcf/refresh", async (req, res) => {
  const portalId = req.query.portalId;
  if (!portalId) {
    return res.status(400).json({ success: false, message: "Missing portalId" });
  }

  const {
    conversionType = "form_submission",
    startDate,
    endDate,
    thresholdPct = 10,
  } = req.body || {};

  const validTypes = ["form_submission", "meeting_booked", "deal_created", "closed_won"];
  if (!validTypes.includes(conversionType)) {
    return res.status(400).json({ success: false, message: `Invalid conversionType: ${conversionType}` });
  }

  const now = new Date();
  const end = endDate ? new Date(endDate) : now;
  const start = startDate
    ? new Date(startDate)
    : new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);

  const jobKey = String(portalId);

  if (mcfJobStatus[jobKey]?.running) {
    return res.json({
      success: true,
      status: "running",
      message: `MCF analysis already running. ${mcfJobStatus[jobKey].message || ""}`,
      ...mcfJobStatus[jobKey],
    });
  }

  mcfJobStatus[jobKey] = {
    running: true,
    processed: 0,
    converting: 0,
    startedAt: new Date().toISOString(),
    conversionType,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    thresholdPct,
    message: "Starting...",
  };
  res.json({ success: true, status: "started", message: "MCF analysis started!" });

  // ---- Background job (conversion-first) ----
  (async () => {
    try {
      // Step 1: Find qualifying first-ever conversions
      let conversions = [];
      switch (conversionType) {
        case "form_submission":
          conversions = await findFormSubmissionConversions(portalId, start, end, mcfJobStatus[jobKey]);
          break;
        case "meeting_booked":
          conversions = await findMeetingBookedConversions(portalId, start, end, mcfJobStatus[jobKey]);
          break;
        case "deal_created":
          conversions = await findDealCreatedConversions(portalId, start, end, mcfJobStatus[jobKey]);
          break;
        case "closed_won":
          conversions = await findClosedWonConversions(portalId, start, end, mcfJobStatus[jobKey]);
          break;
      }

      mcfJobStatus[jobKey].converting = conversions.length;
      mcfJobStatus[jobKey].message = `Found ${conversions.length} first-ever conversions. Building paths...`;

      // Step 2: For each converting contact, fetch source history and build path
      const pathCounts = {};
      const processedContacts = new Set();

      for (let i = 0; i < conversions.length; i++) {
        const conv = conversions[i];

        // A contact can only contribute one first-ever conversion
        if (processedContacts.has(conv.contactId)) continue;
        processedContacts.add(conv.contactId);

        try {
          const contactData = await hubspotApiWithRetry(
            portalId,
            `https://api.hubapi.com/crm/v3/objects/contacts/${conv.contactId}?propertiesWithHistory=hs_latest_source`
          );

          const sourceHistory = contactData.propertiesWithHistory?.hs_latest_source || [];
          const path = buildConversionPath(sourceHistory, conv.conversionTimestamp);
          const key = pathToKey(path);

          if (!pathCounts[key]) {
            pathCounts[key] = { path, conversions: 0, totalValue: 0, currencies: new Set() };
          }
          pathCounts[key].conversions++;
          pathCounts[key].totalValue += conv.conversionValue || 0;
          if (conv.currency) pathCounts[key].currencies.add(conv.currency);
        } catch (e) {
          console.warn(`MCF: path error contact ${conv.contactId}:`, e.message);
        }

        mcfJobStatus[jobKey].processed = processedContacts.size;
        if (processedContacts.size % 10 === 0) await msDelay(150);
      }

      // Step 3: Apply threshold
      const totalConversions = processedContacts.size;
      const threshNum = Math.max(1, Math.ceil(totalConversions * (thresholdPct / 100)));
      const topPaths = Object.values(pathCounts)
        .filter((p) => p.conversions >= threshNum)
        .sort((a, b) => b.conversions - a.conversions || b.totalValue - a.totalValue)
        .map((p) => ({
          path: p.path,
          pathKey: pathToKey(p.path),
          conversions: p.conversions,
          conversionValue: Math.round(p.totalValue * 100) / 100,
          currencies: [...p.currencies],
        }));

      const allCurrencies = new Set();
      topPaths.forEach((p) => p.currencies.forEach((c) => allCurrencies.add(c)));

      const result = {
        paths: topPaths,
        totalConversions,
        totalContacts: processedContacts.size,
        thresholdPct,
        thresholdCount: threshNum,
        conversionType,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        refreshedAt: new Date().toISOString(),
        currencies: [...allCurrencies],
        mixedCurrencies: allCurrencies.size > 1,
        channelLabels: CHANNEL_LABELS,
      };

      const allResults = loadMcfResults();
      allResults[`${portalId}:${conversionType}`] = result;
      saveMcfResults(allResults);

      mcfJobStatus[jobKey].running = false;
      mcfJobStatus[jobKey].completedAt = new Date().toISOString();
      mcfJobStatus[jobKey].result = result;
      mcfJobStatus[jobKey].message = `Complete! ${totalConversions} conversions, ${topPaths.length} qualifying paths.`;

      console.log(`MCF portal ${portalId}: DONE — ${totalConversions} conversions, ${topPaths.length} paths.`);
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
      processed: job.processed,
      converting: job.converting || 0,
      startedAt: job.startedAt,
      message: `Processing... ${job.processed} contacts scanned, ${job.converting || 0} conversions found.`,
    });
  }

  if (job && !job.running) {
    return res.json({
      success: true,
      status: job.error ? "error" : "completed",
      processed: job.processed,
      converting: job.converting || 0,
      completedAt: job.completedAt || null,
      error: job.error || null,
      message: job.error
        ? `Error: ${job.error}`
        : `Complete! ${job.processed} contacts scanned, ${job.converting || 0} conversions found.`,
    });
  }

  return res.json({
    success: true,
    status: "idle",
    message: "No MCF analysis running.",
  });
});

/** GET /api/mcf/result — fetch cached MCF results. */
app.get("/api/mcf/result", async (req, res) => {
  const portalId = req.query.portalId;
  const conversionType = req.query.conversionType || "form_submission";
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
