#!/usr/bin/env node
/**
 * Unit tests for MCF (Multi-Channel Funnel) helper functions.
 * Run: node test-mcf.js
 *
 * Tests:
 *  1. Path collapse (consecutive duplicate removal)
 *  2. Threshold filtering
 *  3. Conversion timestamp selection (date parsing)
 *  4. Aggregation determinism
 */

// ---- Copy of the pure functions from server.js ----

function buildConversionPath(sourceHistory, conversionTimestamp, lookbackDays) {
  const lookbackMs = (lookbackDays || 90) * 24 * 60 * 60 * 1000;
  const windowStart = conversionTimestamp - lookbackMs;

  const entries = (sourceHistory || [])
    .filter((e) => {
      const ts = Number(e.timestamp || 0);
      return ts >= windowStart && ts <= conversionTimestamp;
    })
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

  if (entries.length === 0) return ["UNKNOWN"];

  const rawPath = entries
    .map((e) => String(e.value || "").trim().toUpperCase())
    .filter(Boolean);

  const collapsed = [];
  for (const step of rawPath) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== step) {
      collapsed.push(step);
    }
  }

  return collapsed.length > 0 ? collapsed : ["UNKNOWN"];
}

function pathToKey(pathArray) {
  return pathArray.join(">");
}

// ---- Test helpers ----

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));
  assert(a === b, `${message} — got ${a}, expected ${b}`);
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
  }
  return obj;
}

// ---- Tests ----

console.log("\n=== 1. Path Collapse ===\n");

{
  // A→A→B should collapse to A→B
  const history = [
    { timestamp: "100", value: "ORGANIC_SEARCH" },
    { timestamp: "200", value: "ORGANIC_SEARCH" },
    { timestamp: "300", value: "DIRECT_TRAFFIC" },
  ];
  const path = buildConversionPath(history, 400, 90);
  assertDeepEqual(
    path,
    ["ORGANIC_SEARCH", "DIRECT_TRAFFIC"],
    "A→A→B collapses to A→B"
  );
}

{
  // A→B→A should NOT collapse (non-consecutive)
  const history = [
    { timestamp: "100", value: "ORGANIC_SEARCH" },
    { timestamp: "200", value: "DIRECT_TRAFFIC" },
    { timestamp: "300", value: "ORGANIC_SEARCH" },
  ];
  const path = buildConversionPath(history, 400, 90);
  assertDeepEqual(
    path,
    ["ORGANIC_SEARCH", "DIRECT_TRAFFIC", "ORGANIC_SEARCH"],
    "A→B→A stays A→B→A (non-consecutive)"
  );
}

{
  // A→A→A→B→B→C should collapse to A→B→C
  const history = [
    { timestamp: "100", value: "PAID_SEARCH" },
    { timestamp: "200", value: "PAID_SEARCH" },
    { timestamp: "300", value: "PAID_SEARCH" },
    { timestamp: "400", value: "EMAIL_MARKETING" },
    { timestamp: "500", value: "EMAIL_MARKETING" },
    { timestamp: "600", value: "REFERRALS" },
  ];
  const path = buildConversionPath(history, 700, 90);
  assertDeepEqual(
    path,
    ["PAID_SEARCH", "EMAIL_MARKETING", "REFERRALS"],
    "A×3→B×2→C collapses to A→B→C"
  );
}

{
  // Single entry
  const history = [{ timestamp: "100", value: "DIRECT_TRAFFIC" }];
  const path = buildConversionPath(history, 200, 90);
  assertDeepEqual(path, ["DIRECT_TRAFFIC"], "Single entry stays as-is");
}

{
  // Empty history → UNKNOWN
  const path = buildConversionPath([], 200, 90);
  assertDeepEqual(path, ["UNKNOWN"], "Empty history → [UNKNOWN]");
}

{
  // Case normalization
  const history = [
    { timestamp: "100", value: "organic_search" },
    { timestamp: "200", value: "Organic_Search" },
  ];
  const path = buildConversionPath(history, 300, 90);
  assertDeepEqual(
    path,
    ["ORGANIC_SEARCH"],
    "Case variants collapse (uppercased)"
  );
}

console.log("\n=== 2. Lookback Window Filtering ===\n");

{
  // Only entries within lookback window should be included
  const convTs = 1000000;
  const lookbackMs = 90 * 24 * 60 * 60 * 1000;
  const tooEarly = convTs - lookbackMs - 1;
  const inWindow = convTs - lookbackMs + 1000;

  const history = [
    { timestamp: String(tooEarly), value: "PAID_SEARCH" },
    { timestamp: String(inWindow), value: "ORGANIC_SEARCH" },
    { timestamp: String(convTs - 1000), value: "DIRECT_TRAFFIC" },
  ];
  const path = buildConversionPath(history, convTs, 90);
  assertDeepEqual(
    path,
    ["ORGANIC_SEARCH", "DIRECT_TRAFFIC"],
    "Entries outside lookback window are excluded"
  );
}

{
  // Entries after conversion time are excluded
  const history = [
    { timestamp: "100", value: "ORGANIC_SEARCH" },
    { timestamp: "300", value: "PAID_SEARCH" },
    { timestamp: "500", value: "DIRECT_TRAFFIC" }, // after conv time
  ];
  const path = buildConversionPath(history, 400, 90);
  assertDeepEqual(
    path,
    ["ORGANIC_SEARCH", "PAID_SEARCH"],
    "Entries after conversionTime are excluded"
  );
}

console.log("\n=== 3. Threshold Filtering ===\n");

{
  // Simulate threshold filtering logic
  const pathCounts = {
    "A>B": { conversions: 15 },
    "C>D": { conversions: 3 },
    "E": { conversions: 8 },
    "F>G>H": { conversions: 1 },
  };
  const totalConversions = 27;
  const thresholdPct = 10;
  const minCount = Math.max(1, Math.ceil(totalConversions * (thresholdPct / 100)));

  const qualifying = Object.entries(pathCounts)
    .filter(([, v]) => v.conversions >= minCount)
    .map(([k, v]) => ({ key: k, conversions: v.conversions }))
    .sort((a, b) => b.conversions - a.conversions);

  assert(minCount === 3, `10% of 27 → min count = 3 (got ${minCount})`);
  assert(qualifying.length === 3, `3 paths qualify (A>B=15, E=8, C>D=3)`);
  assert(
    qualifying[0].key === "A>B" && qualifying[0].conversions === 15,
    "Highest path is A>B with 15"
  );
  assert(!qualifying.find((q) => q.key === "F>G>H"), "F>G>H (1) is excluded");
}

{
  // Edge case: 0 conversions
  const totalConversions = 0;
  const thresholdPct = 10;
  const minCount = Math.max(1, Math.ceil(totalConversions * (thresholdPct / 100)));
  assert(minCount === 1, `0 conversions → min count = 1 (floor)`);
}

console.log("\n=== 4. pathToKey ===\n");

{
  assertDeepEqual(
    pathToKey(["ORGANIC_SEARCH", "DIRECT_TRAFFIC"]),
    "ORGANIC_SEARCH>DIRECT_TRAFFIC",
    "pathToKey joins with >"
  );
  assertDeepEqual(pathToKey(["UNKNOWN"]), "UNKNOWN", "Single-step key");
  assertDeepEqual(pathToKey([]), "", "Empty path → empty key");
}

console.log("\n=== 5. Aggregation Determinism ===\n");

{
  // Same input produces same output regardless of insertion order
  const histories = [
    [
      { timestamp: "100", value: "ORGANIC_SEARCH" },
      { timestamp: "200", value: "DIRECT_TRAFFIC" },
    ],
    [
      { timestamp: "150", value: "ORGANIC_SEARCH" },
      { timestamp: "250", value: "DIRECT_TRAFFIC" },
    ],
    [
      { timestamp: "100", value: "PAID_SEARCH" },
    ],
  ];

  function aggregate(inputs) {
    const counts = {};
    for (const hist of inputs) {
      const path = buildConversionPath(hist, 300, 90);
      const key = pathToKey(path);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  const run1 = aggregate(histories);
  const run2 = aggregate([...histories].reverse());
  const run3 = aggregate(histories);

  assertDeepEqual(run1, run2, "Same result regardless of input order");
  assertDeepEqual(run1, run3, "Same result on repeated runs");
  assert(
    run1["ORGANIC_SEARCH>DIRECT_TRAFFIC"] === 2,
    "ORGANIC→DIRECT counted twice"
  );
  assert(run1["PAID_SEARCH"] === 1, "PAID_SEARCH counted once");
}

// ---- Summary ----
console.log(`\n=============================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`=============================\n`);

process.exit(failed > 0 ? 1 : 0);
