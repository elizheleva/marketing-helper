import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Button,
  Flex,
  Text,
  Tabs,
  Tab,
  Divider,
  Tag,
  Checkbox,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableFooter,
  Select,
  DateInput,
} from "@hubspot/ui-extensions";
import { hubspot } from "@hubspot/ui-extensions";

hubspot.extend<"settings">(({ context }) => <SettingsPage context={context} />);

const BACKEND_URL = "https://api.uspeh.co.uk";

type AnyObj = Record<string, any>;
type SourceOption = { value: string; label: string };

// ---- MCF Types & Constants ----
type McfPath = {
  path: string[];
  pathKey: string;
  conversions: number;
  conversionValue: number;
  currencies: string[];
};

type McfResult = {
  paths: McfPath[];
  totalConversions: number;
  totalContacts: number;
  thresholdPct: number;
  thresholdCount: number;
  conversionType: string;
  startDate: string;
  endDate: string;
  refreshedAt: string;
  currencies: string[];
  mixedCurrencies: boolean;
  channelLabels?: Record<string, string>;
};

type DateVal = { year: number; month: number; date: number };

const APP_VERSION = "1.0.1";

const CHANNEL_LABELS: Record<string, string> = {
  ORGANIC_SEARCH: "Organic Search",
  PAID_SEARCH: "Paid Search",
  EMAIL_MARKETING: "Email Marketing",
  SOCIAL_MEDIA: "Organic Social",
  REFERRALS: "Referrals",
  OTHER_CAMPAIGNS: "Other Campaigns",
  PAID_SOCIAL: "Paid Social",
  DISPLAY_ADS: "Display Ads",
  DIRECT_TRAFFIC: "Direct Traffic",
  OFFLINE: "Offline Sources",
  OTHER: "Other",
  AI_REFERRALS: "AI Referrals",
  UNKNOWN: "Unknown",
};

const CHANNEL_TAG_VARIANT: Record<string, "default" | "success" | "warning" | "danger"> = {
  ORGANIC_SEARCH: "success",
  PAID_SEARCH: "warning",
  EMAIL_MARKETING: "danger",
  SOCIAL_MEDIA: "success",
  REFERRALS: "default",
  OTHER_CAMPAIGNS: "warning",
  PAID_SOCIAL: "warning",
  DISPLAY_ADS: "danger",
  DIRECT_TRAFFIC: "default",
  OFFLINE: "default",
  OTHER: "default",
  AI_REFERRALS: "default",
  UNKNOWN: "default",
};

const CONVERSION_TYPES = [
  { label: "Form Submission (first-ever)", value: "form_submission" },
  { label: "Meeting Booked (first-ever)", value: "meeting_booked" },
  { label: "Deal Created (first-ever)", value: "deal_created" },
  { label: "Closed-Won Deal (first-ever)", value: "closed_won" },
];

const THRESHOLD_OPTIONS = [
  { label: "1%", value: "1" },
  { label: "5%", value: "5" },
  { label: "10% (default)", value: "10" },
  { label: "15%", value: "15" },
  { label: "20%", value: "20" },
  { label: "25%", value: "25" },
];

function toDateVal(d: Date): DateVal {
  return { year: d.getFullYear(), month: d.getMonth(), date: d.getDate() };
}

function fromDateVal(dv: DateVal): Date {
  return new Date(dv.year, dv.month, dv.date);
}

const SettingsPage = ({ context }: AnyObj) => {
  // --- Analysis state ---
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisAllowed, setAnalysisAllowed] = useState(true);
  const [statusInfo, setStatusInfo] = useState<AnyObj | null>(null);
  const pollingRef = useRef(false);

  // --- Source configuration state ---
  const [allSources, setAllSources] = useState<SourceOption[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesMessage, setSourcesMessage] = useState("");
  const [sourcesSaving, setSourcesSaving] = useState(false);

  // --- Log state ---
  const [lastAnalysisRun, setLastAnalysisRun] = useState<string | null>(null);
  const [lastSourcesUpdated, setLastSourcesUpdated] = useState<string | null>(
    null
  );

  // --- MCF (Paths) state ---
  const now = new Date();
  const [mcfConversionType, setMcfConversionType] = useState("form_submission");
  const [mcfThreshold, setMcfThreshold] = useState("10");
  const [mcfStartDate, setMcfStartDate] = useState<DateVal>(
    toDateVal(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000))
  );
  const [mcfEndDate, setMcfEndDate] = useState<DateVal>(toDateVal(now));
  const [mcfRunning, setMcfRunning] = useState(false);
  const [mcfMessage, setMcfMessage] = useState("");
  const [mcfResult, setMcfResult] = useState<McfResult | null>(null);
  const [mcfLoadingResult, setMcfLoadingResult] = useState(false);
  const mcfPollingRef = useRef(false);

  // ========================================
  // On mount: load sources + check job status
  // ========================================
  useEffect(() => {
    loadSources();
    checkStatus();
  }, []);

  /**
   * Load the marketing source configuration.
   */
  const loadSources = async () => {
    try {
      const resp = await hubspot.fetch(
        `${BACKEND_URL}/api/marketing-sources`,
        { method: "GET" }
      );
      const data = await resp.json();
      if (data.success) {
        setAllSources(data.allSources || []);
        setSelectedSources(data.selectedSources || []);
      }
    } catch (e: any) {
      console.error("Failed to load sources:", e);
    } finally {
      setSourcesLoading(false);
    }
  };

  /**
   * Check the current status of any running/completed analysis.
   * If a job is running, starts polling automatically.
   */
  const checkStatus = async () => {
    try {
      const resp = await hubspot.fetch(
        `${BACKEND_URL}/api/calculate-contribution/status`,
        { method: "GET" }
      );
      const data = await resp.json();

      setStatusInfo(data);
      setLastAnalysisRun(data.lastAnalysisRun || null);
      setLastSourcesUpdated(data.lastSourcesUpdated || null);
      setAnalysisAllowed(data.analysisAllowed !== false);

      if (data.status === "running") {
        setAnalysisRunning(true);
        setAnalysisMessage(data.message || "Processing...");
        // Start polling if not already
        if (!pollingRef.current) {
          pollingRef.current = true;
          startPolling();
        }
      } else if (data.status === "completed") {
        setAnalysisRunning(false);
        setAnalysisMessage(data.message || "");
      } else if (data.status === "error") {
        setAnalysisRunning(false);
        setAnalysisMessage(`Error: ${data.error || "Unknown error"}`);
      }
    } catch (e: any) {
      console.error("Failed to check status:", e);
    }
  };

  /**
   * Poll the status endpoint every 3 seconds while a job is running.
   */
  const startPolling = () => {
    const poll = async () => {
      try {
        const resp = await hubspot.fetch(
          `${BACKEND_URL}/api/calculate-contribution/status`,
          { method: "GET" }
        );
        const data = await resp.json();

        setStatusInfo(data);
        setLastAnalysisRun(data.lastAnalysisRun || null);
        setLastSourcesUpdated(data.lastSourcesUpdated || null);

        if (data.status === "running") {
          setAnalysisMessage(data.message || "Processing...");
          setTimeout(poll, 3000);
        } else {
          // Job finished
          pollingRef.current = false;
          setAnalysisRunning(false);
          setAnalysisAllowed(data.analysisAllowed !== false);
          if (data.status === "completed") {
            setAnalysisMessage(data.message || "Analysis complete!");
          } else if (data.status === "error") {
            setAnalysisMessage(`Error: ${data.error || "Unknown error"}`);
          }
        }
      } catch (e: any) {
        pollingRef.current = false;
        setAnalysisRunning(false);
        setAnalysisMessage(
          `Error checking status: ${e?.message || "Unknown error"}`
        );
      }
    };

    setTimeout(poll, 3000);
  };

  /**
   * Kick off the full analysis.
   */
  const runFullAnalysis = async () => {
    setAnalysisRunning(true);
    setAnalysisMessage("Starting analysis...");
    setStatusInfo(null);

    try {
      const response = await hubspot.fetch(
        `${BACKEND_URL}/api/calculate-contribution`,
        { method: "POST", body: {} }
      );

      const result = await response.json();

      if (!result.success) {
        setAnalysisRunning(false);
        setAnalysisMessage(result.message || "Failed to start analysis.");
        return;
      }

      if (result.status === "blocked") {
        setAnalysisRunning(false);
        setAnalysisAllowed(false);
        setAnalysisMessage(result.message);
        return;
      }

      setAnalysisMessage(result.message || "Analysis started...");

      // Start polling for progress
      if (!pollingRef.current) {
        pollingRef.current = true;
        startPolling();
      }
    } catch (error: any) {
      const detail =
        error?.message ||
        (typeof error === "string" ? error : "") ||
        "Failed to start analysis";
      setAnalysisMessage(`Error: ${detail}`);
      setAnalysisRunning(false);
    }
  };

  /**
   * Toggle a source on/off.
   */
  const toggleSource = (sourceValue: string, checked: boolean) => {
    setSelectedSources((prev) => {
      if (checked) {
        return [...prev, sourceValue];
      } else {
        return prev.filter((s) => s !== sourceValue);
      }
    });
  };

  /**
   * Save the selected marketing sources.
   */
  const saveSources = async () => {
    setSourcesSaving(true);
    setSourcesMessage("");
    try {
      const resp = await hubspot.fetch(
        `${BACKEND_URL}/api/marketing-sources`,
        { method: "POST", body: { selectedSources } }
      );
      const data = await resp.json();
      if (data.success) {
        setSourcesMessage(data.message);
        // Sources changed — unlock the Run Analysis button
        setAnalysisAllowed(true);
        setLastSourcesUpdated(new Date().toISOString());
      } else {
        throw new Error(data.message || "Failed to save");
      }
    } catch (e: any) {
      setSourcesMessage(`Error: ${e?.message || "Failed to save sources"}`);
    } finally {
      setSourcesSaving(false);
    }
  };

  /**
   * Format a timestamp for display.
   */
  const formatTimestamp = (ts: string | null): string => {
    if (!ts) return "Never";
    const d = new Date(ts);
    return d.toLocaleString();
  };

  // ========================================
  // MCF Functions
  // ========================================

  /** Load cached MCF results for the current conversion type. */
  const loadMcfResult = async (convType?: string) => {
    setMcfLoadingResult(true);
    try {
      const ct = convType || mcfConversionType;
      const resp = await hubspot.fetch(
        `${BACKEND_URL}/api/mcf/result?conversionType=${ct}`,
        { method: "GET" }
      );
      const data = await resp.json();
      if (data.success && data.paths && data.paths.length > 0) {
        setMcfResult(data as McfResult);
      } else {
        setMcfResult(null);
      }
    } catch (e: any) {
      console.error("MCF: Failed to load results:", e);
    } finally {
      setMcfLoadingResult(false);
    }
  };

  /** Check MCF job status; if running, start polling. */
  const checkMcfStatus = async () => {
    try {
      const resp = await hubspot.fetch(
        `${BACKEND_URL}/api/mcf/status`,
        { method: "GET" }
      );
      const data = await resp.json();
      if (data.status === "running") {
        setMcfRunning(true);
        setMcfMessage(data.message || "Processing...");
        if (!mcfPollingRef.current) {
          mcfPollingRef.current = true;
          pollMcfStatus();
        }
      } else if (data.status === "completed") {
        setMcfRunning(false);
        setMcfMessage(data.message || "");
        loadMcfResult();
      }
    } catch (e: any) {
      console.error("MCF: status check error:", e);
    }
  };

  /** Poll MCF status every 3s while a job is running. */
  const pollMcfStatus = () => {
    const poll = async () => {
      try {
        const resp = await hubspot.fetch(
          `${BACKEND_URL}/api/mcf/status`,
          { method: "GET" }
        );
        const data = await resp.json();

        if (data.status === "running") {
          setMcfMessage(data.message || "Processing...");
          setTimeout(poll, 3000);
        } else {
          mcfPollingRef.current = false;
          setMcfRunning(false);
          setMcfMessage(
            data.status === "error"
              ? `Error: ${data.error || "Unknown"}`
              : data.message || "Complete!"
          );
          // Refresh results
          loadMcfResult();
        }
      } catch (e: any) {
        mcfPollingRef.current = false;
        setMcfRunning(false);
        setMcfMessage(`Error polling status: ${e?.message || "Unknown"}`);
      }
    };
    setTimeout(poll, 3000);
  };

  /** Start an MCF refresh job. */
  const startMcfRefresh = async () => {
    setMcfRunning(true);
    setMcfMessage("Starting MCF analysis...");
    setMcfResult(null);

    try {
      const startD = fromDateVal(mcfStartDate);
      const endD = fromDateVal(mcfEndDate);

      const resp = await hubspot.fetch(
        `${BACKEND_URL}/api/mcf/refresh`,
        {
          method: "POST",
          body: {
            conversionType: mcfConversionType,
            startDate: startD.toISOString(),
            endDate: endD.toISOString(),
            thresholdPct: parseInt(mcfThreshold, 10),
          },
        }
      );
      const data = await resp.json();

      if (!data.success) {
        setMcfRunning(false);
        setMcfMessage(data.message || "Failed to start.");
        return;
      }

      setMcfMessage(data.message || "Analysis started...");
      if (!mcfPollingRef.current) {
        mcfPollingRef.current = true;
        pollMcfStatus();
      }
    } catch (e: any) {
      setMcfRunning(false);
      setMcfMessage(`Error: ${e?.message || "Failed to start MCF analysis"}`);
    }
  };

  /** Render a conversion path as UA-style pills with chevrons. */
  const renderPathPills = (path: string[]) => (
    <Flex direction="row" gap="extra-small" wrap="wrap" align="center">
      {path.map((channel: string, idx: number) => (
        <React.Fragment key={idx}>
          {idx > 0 && (
            <Text format={{ fontSize: "small", color: "subtle" }}>{" › "}</Text>
          )}
          <Tag variant={CHANNEL_TAG_VARIANT[channel] || "default"}>
            {CHANNEL_LABELS[channel] || channel}
          </Tag>
        </React.Fragment>
      ))}
    </Flex>
  );

  // Load MCF results and check status on mount
  useEffect(() => {
    checkMcfStatus();
    loadMcfResult();
  }, []);

  // Determine button state
  const buttonDisabled = analysisRunning || !analysisAllowed;
  const buttonLabel = analysisRunning
    ? "Processing..."
    : !analysisAllowed
      ? "Analysis up to date"
      : "Run Full Analysis";

  return (
    <Flex direction="column" gap="large">
      <Text format={{ fontWeight: "bold", fontSize: "xlarge" }}>
        Marketing Helper Settings
      </Text>

      <Tabs defaultSelected="overview">
        <Tab tabId="overview" title="Overview">
          <Flex direction="column" gap="medium">
            <Text format={{ fontWeight: "bold" }}>
              What Marketing Helper does
            </Text>

            <Text format={{ fontWeight: "demibold" }}>
              Marketing Contribution Percentage
            </Text>
            <Text format={{ fontSize: "small" }}>
              &bull; Calculates the percentage of a contact&apos;s traffic source history that came from marketing channels{"\n"}
              &bull; You choose which HubSpot traffic sources count as &quot;marketing&quot; (e.g. Organic Search, Paid Social, Email Marketing){"\n"}
              &bull; A custom contact property (&quot;Marketing Contribution Percentage&quot;) is created and kept up to date{"\n"}
              &bull; Run a one-time bulk analysis across your entire database, then real-time webhooks keep every contact current as new source data arrives
            </Text>

            <Divider />

            <Text format={{ fontWeight: "demibold" }}>
              Conversion Paths (MCF)
            </Text>
            <Text format={{ fontSize: "small" }}>
              &bull; Inspired by Google Analytics UA &quot;Top Conversion Paths&quot; report{"\n"}
              &bull; Pick a conversion type (Form submission, Meeting booked, Deal created, or Closed-won deal) and a date range{"\n"}
              &bull; The app finds every first-ever conversion in that period, reconstructs the contact&apos;s full traffic-source journey leading up to it, and groups the results into ranked paths{"\n"}
              &bull; Paths are displayed as pill-style channel labels with conversion counts and values
            </Text>

            <Divider />

            <Text format={{ fontWeight: "demibold" }}>
              How to get started
            </Text>
            <Text format={{ fontSize: "small" }}>
              1. Go to the Data Analysis tab and select which traffic sources you consider &quot;marketing&quot;, then save{"\n"}
              2. Click &quot;Run Full Analysis&quot; to calculate the Marketing Contribution Percentage for all existing contacts{"\n"}
              3. Real-time webhooks will automatically recalculate whenever a contact&apos;s traffic source changes{"\n"}
              4. Use the Paths (MCF) tab to explore conversion journeys for any time period
            </Text>

            <Divider />
            <Text format={{ fontSize: "small", color: "subtle" }}>
              Powered by uspeh &middot; v{APP_VERSION}
            </Text>
          </Flex>
        </Tab>

        <Tab tabId="analysis" title="Data Analysis">
          <Flex direction="column" gap="large">
            {/* ---- Configure Sources section ---- */}
            <Text format={{ fontWeight: "bold" }}>
              Configure Marketing Sources
            </Text>
            <Text format={{ fontSize: "small" }}>
              Select which traffic sources should be counted as
              &quot;marketing&quot; when calculating the Marketing Contribution
              Percentage. Any source not selected will be treated as
              non-marketing.
            </Text>

            {sourcesLoading ? (
              <Text format={{ fontSize: "small", color: "subtle" }}>
                Loading source options...
              </Text>
            ) : (
              <Flex direction="column" gap="small">
                {allSources.map((source) => (
                  <Checkbox
                    key={source.value}
                    checked={selectedSources.includes(source.value)}
                    onChange={(checked: boolean) =>
                      toggleSource(source.value, checked)
                    }
                  >
                    {source.label}
                  </Checkbox>
                ))}
              </Flex>
            )}

            <Flex direction="row" gap="small">
              <Button
                onClick={saveSources}
                disabled={sourcesSaving || sourcesLoading}
                variant="primary"
              >
                {sourcesSaving ? "Saving..." : "Save Source Settings"}
              </Button>
              <Text format={{ fontSize: "small", color: "subtle" }}>
                {selectedSources.length} source(s) selected as marketing
              </Text>
            </Flex>

            {sourcesMessage && (
              <Text
                format={{
                  color: sourcesMessage.startsWith("Error")
                    ? "error"
                    : "success",
                }}
              >
                {sourcesMessage}
              </Text>
            )}

            <Divider />

            {/* ---- Run Analysis section ---- */}
            <Text format={{ fontWeight: "bold" }}>
              Run Full Analysis
            </Text>
            <Text format={{ fontSize: "small" }}>
              Processes every contact in the background. You can navigate away
              and return to check progress. The analysis will:{"\n"}
              &bull; Create the &quot;Marketing Contribution Percentage&quot; property if it doesn&apos;t exist{"\n"}
              &bull; Read each contact&apos;s full hs_latest_source history{"\n"}
              &bull; Calculate the percentage based on your selected marketing sources above{"\n"}
              &bull; Update each contact with the result
            </Text>

            {!analysisAllowed && !analysisRunning && (
              <Flex direction="row" gap="small">
                <Tag variant="default">Up to date</Tag>
                <Text format={{ fontSize: "small" }}>
                  Analysis has been run with the current source settings.
                  Change your marketing source configuration above and save to run again.
                </Text>
              </Flex>
            )}

            <Button
              onClick={runFullAnalysis}
              disabled={buttonDisabled}
              variant="primary"
            >
              {buttonLabel}
            </Button>

            {analysisRunning &&
              statusInfo &&
              statusInfo.status === "running" && (
                <Flex direction="column" gap="small">
                  <Tag variant="warning">Running</Tag>
                  <Text format={{ fontSize: "small" }}>
                    {statusInfo.processed} contacts processed &middot;{" "}
                    {statusInfo.updated} updated &middot;{" "}
                    {statusInfo.failed} failed
                  </Text>
                </Flex>
              )}

            {analysisMessage && (
              <Text
                format={{
                  color: analysisMessage.startsWith("Error")
                    ? "error"
                    : "success",
                }}
              >
                {analysisMessage}
              </Text>
            )}

            <Divider />

            {/* ---- Real-time updates info ---- */}
            <Flex direction="row" gap="small">
              <Tag variant="success">Active</Tag>
              <Text format={{ fontWeight: "bold" }}>
                Real-time updates enabled
              </Text>
            </Flex>
            <Text format={{ fontSize: "small" }}>
              A webhook automatically recalculates the Marketing Contribution
              Percentage whenever a contact&apos;s hs_latest_source changes.
              No action required — once you&apos;ve configured your sources
              and run the initial analysis, everything stays up to date.
            </Text>
          </Flex>
        </Tab>

        <Tab tabId="log" title="Activity Log">
          <Flex direction="column" gap="large">
            <Text format={{ fontWeight: "bold" }}>Activity Log</Text>

            <Flex direction="column" gap="medium">
              <Flex direction="column" gap="extra-small">
                <Text format={{ fontWeight: "bold", fontSize: "small" }}>
                  Last source configuration change
                </Text>
                <Text>
                  {lastSourcesUpdated
                    ? formatTimestamp(lastSourcesUpdated)
                    : "Never (using default sources)"}
                </Text>
              </Flex>

              <Divider />

              <Flex direction="column" gap="extra-small">
                <Text format={{ fontWeight: "bold", fontSize: "small" }}>
                  Last full analysis run
                </Text>
                <Text>
                  {lastAnalysisRun
                    ? formatTimestamp(lastAnalysisRun)
                    : "Never"}
                </Text>
                {statusInfo &&
                  (statusInfo.status === "completed" ||
                    statusInfo.lastAnalysisRun) && (
                    <Text format={{ fontSize: "small", color: "subtle" }}>
                      Processed: {statusInfo.processed || 0} &middot; Updated:{" "}
                      {statusInfo.updated || 0} &middot; Zero-history:{" "}
                      {statusInfo.skippedNoHistory || 0} &middot; Failed:{" "}
                      {statusInfo.failed || 0}
                    </Text>
                  )}
              </Flex>

              <Divider />

              <Flex direction="column" gap="extra-small">
                <Text format={{ fontWeight: "bold", fontSize: "small" }}>
                  Current status
                </Text>
                {analysisRunning ? (
                  <Flex direction="row" gap="small">
                    <Tag variant="warning">Running</Tag>
                    <Text>
                      {statusInfo?.processed || 0} contacts processed
                    </Text>
                  </Flex>
                ) : analysisAllowed ? (
                  <Flex direction="row" gap="small">
                    <Tag variant="default">Pending</Tag>
                    <Text>
                      Source configuration has changed — analysis available
                    </Text>
                  </Flex>
                ) : (
                  <Flex direction="row" gap="small">
                    <Tag variant="success">Up to date</Tag>
                    <Text>
                      Analysis matches current source configuration
                    </Text>
                  </Flex>
                )}
              </Flex>
            </Flex>

            <Divider />

            <Text format={{ fontSize: "small", color: "subtle" }}>
              Note: Changing the marketing source configuration may impact
              reporting. The timestamp above records when the configuration
              was last modified so you can track any reporting changes.
            </Text>
          </Flex>
        </Tab>

        {/* ==================== MCF PATHS TAB ==================== */}
        <Tab tabId="mcf" title="Paths (MCF)">
          <Flex direction="column" gap="large">
            <Text format={{ fontWeight: "bold" }}>
              Top Conversion Paths
            </Text>
            <Text format={{ fontSize: "small" }}>
              Replicates Google Analytics UA Multi-Channel Funnels &ldquo;Top
              Conversion Paths&rdquo;. Select a conversion type and date range,
              then refresh to see which traffic-source journeys lead to
              conversions.
            </Text>

            <Divider />

            {/* ---- Filters ---- */}
            <Flex direction="column" gap="medium">
              <Select
                label="Conversion Type"
                name="mcfConversionType"
                value={mcfConversionType}
                onChange={(val: string) => {
                  setMcfConversionType(val);
                  loadMcfResult(val);
                }}
                options={CONVERSION_TYPES}
              />

              <Flex direction="row" gap="medium">
                <DateInput
                  label="Start Date"
                  name="mcfStartDate"
                  value={mcfStartDate}
                  onChange={(val: any) => {
                    if (val) setMcfStartDate(val);
                  }}
                  format="standard"
                />
                <DateInput
                  label="End Date"
                  name="mcfEndDate"
                  value={mcfEndDate}
                  onChange={(val: any) => {
                    if (val) setMcfEndDate(val);
                  }}
                  format="standard"
                />
              </Flex>

              <Select
                label="Min Path Share (threshold)"
                name="mcfThreshold"
                value={mcfThreshold}
                onChange={(val: string) => setMcfThreshold(val)}
                options={THRESHOLD_OPTIONS}
                description="Only show paths representing at least this % of total conversions."
              />
            </Flex>

            <Flex direction="row" gap="small">
              <Button
                onClick={startMcfRefresh}
                disabled={mcfRunning}
                variant="primary"
              >
                {mcfRunning ? "Refreshing..." : "Refresh Paths"}
              </Button>
              {mcfResult && (
                <Text format={{ fontSize: "small", color: "subtle" }}>
                  Last refreshed: {formatTimestamp(mcfResult.refreshedAt)}
                </Text>
              )}
            </Flex>

            {/* ---- Status / progress ---- */}
            {mcfRunning && (
              <Flex direction="row" gap="small">
                <Tag variant="warning">Running</Tag>
                <Text format={{ fontSize: "small" }}>{mcfMessage}</Text>
              </Flex>
            )}

            {!mcfRunning && mcfMessage && (
              <Text
                format={{
                  color: mcfMessage.startsWith("Error") ? "error" : "success",
                }}
              >
                {mcfMessage}
              </Text>
            )}

            <Divider />

            {/* ---- Mixed currencies warning ---- */}
            {mcfResult?.mixedCurrencies && (
              <Flex direction="row" gap="small">
                <Tag variant="warning">Mixed Currencies</Tag>
                <Text format={{ fontSize: "small" }}>
                  Conversion values include multiple currencies (
                  {mcfResult.currencies.join(", ")}). Values shown are raw sums
                  without currency conversion.
                </Text>
              </Flex>
            )}

            {/* ---- Results summary ---- */}
            {mcfResult && (
              <Flex direction="column" gap="small">
                <Text format={{ fontSize: "small" }}>
                  {mcfResult.totalConversions} total conversion(s) from{" "}
                  {mcfResult.totalContacts} contacts scanned.
                  Showing {mcfResult.paths.length} path(s) with{" "}
                  {"\u2265"}{mcfResult.thresholdCount} conversions (
                  {mcfResult.thresholdPct}% threshold).
                </Text>
              </Flex>
            )}

            {/* ---- MCF Table ---- */}
            {mcfLoadingResult && !mcfResult && (
              <Text format={{ fontSize: "small", color: "subtle" }}>
                Loading results...
              </Text>
            )}

            {mcfResult && mcfResult.paths.length > 0 && (
              <Table bordered={true} paginated={mcfResult.paths.length > 10} pageCount={Math.ceil(mcfResult.paths.length / 10)}>
                <TableHead>
                  <TableRow>
                    <TableHeader width="max">
                      MCF Channel Grouping Path
                    </TableHeader>
                    <TableHeader width="min" align="right">
                      Conversions
                    </TableHeader>
                    <TableHeader width="min" align="right">
                      Conv. Value
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mcfResult.paths.map((p) => (
                    <TableRow key={p.pathKey}>
                      <TableCell width="max">
                        {renderPathPills(p.path)}
                      </TableCell>
                      <TableCell width="min" align="right">
                        {p.conversions}
                      </TableCell>
                      <TableCell width="min" align="right">
                        {p.conversionValue > 0
                          ? p.currencies.length === 1
                            ? `${p.currencies[0]} ${p.conversionValue.toLocaleString()}`
                            : p.conversionValue.toLocaleString()
                          : "\u2014"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableHeader>Total</TableHeader>
                    <TableHeader align="right">
                      {mcfResult.paths.reduce((s, p) => s + p.conversions, 0)}
                    </TableHeader>
                    <TableHeader align="right">
                      {mcfResult.paths.reduce((s, p) => s + p.conversionValue, 0) > 0
                        ? mcfResult.paths
                            .reduce((s, p) => s + p.conversionValue, 0)
                            .toLocaleString()
                        : "\u2014"}
                    </TableHeader>
                  </TableRow>
                </TableFooter>
              </Table>
            )}

            {mcfResult && mcfResult.paths.length === 0 && !mcfRunning && (
              <Flex direction="column" gap="small">
                <Text format={{ fontSize: "small", color: "subtle" }}>
                  No qualifying paths found. Try lowering the threshold, changing
                  the conversion type, or expanding the date range.
                </Text>
              </Flex>
            )}

            {!mcfResult && !mcfRunning && !mcfLoadingResult && (
              <Text format={{ fontSize: "small", color: "subtle" }}>
                Click &ldquo;Refresh Paths&rdquo; to analyse your
                contacts&rsquo; conversion journeys.
              </Text>
            )}
          </Flex>
        </Tab>
      </Tabs>

      <Divider />
      <Text format={{ fontSize: "small", color: "subtle" }}>
        Marketing Helper v{APP_VERSION}
      </Text>
    </Flex>
  );
};

export default SettingsPage;
