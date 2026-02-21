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
} from "@hubspot/ui-extensions";
import { hubspot } from "@hubspot/ui-extensions";

hubspot.extend<"settings">(({ context }) => <SettingsPage context={context} />);

const BACKEND_URL = "https://api.uspeh.co.uk";

type AnyObj = Record<string, any>;
type SourceOption = { value: string; label: string };

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

      <Tabs defaultSelected="sources">
        <Tab tabId="overview" title="Overview">
          <Flex direction="column" gap="medium">
            <Text>
              This app calculates the Marketing Contribution Percentage for each
              contact. It analyses the hs_latest_source property history to
              determine what percentage of source values came from marketing
              channels.
            </Text>
            <Text format={{ fontSize: "small" }}>
              Use the tabs to: configure which sources count as
              &quot;marketing&quot;, run the full database analysis, view
              real-time update status, and check the activity log.
            </Text>
            <Text format={{ fontSize: "small", color: "subtle" }}>
              Powered by uspeh
            </Text>
          </Flex>
        </Tab>

        <Tab tabId="sources" title="Configure Sources">
          <Flex direction="column" gap="large">
            <Text>
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

            <Text format={{ fontSize: "small", color: "subtle" }}>
              After saving, click &quot;Run Full Analysis&quot; on the Run
              Analysis tab to recalculate all contacts with the new settings.
              Future webhook updates will also use the new configuration.
            </Text>
          </Flex>
        </Tab>

        <Tab tabId="actions" title="Run Analysis">
          <Flex direction="column" gap="large">
            <Text>
              Run a full analysis across your entire contact database. The
              system processes all contacts in the background — you can
              navigate away and come back to check progress.
            </Text>

            <Text format={{ fontSize: "small" }}>
              This will:{"\n"}&bull; Create the &quot;Marketing Contribution
              Percentage&quot; property (if it doesn&apos;t exist){"\n"}&bull;
              Read each contact&apos;s full hs_latest_source property history
              {"\n"}&bull; Calculate the % based on your configured marketing
              sources{"\n"}&bull; Update each contact with the calculated
              percentage
            </Text>

            {!analysisAllowed && !analysisRunning && (
              <Flex direction="row" gap="small">
                <Tag variant="default">Up to date</Tag>
                <Text format={{ fontSize: "small" }}>
                  Analysis has been run with the current source settings.
                  Change your marketing source configuration to run again.
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
          </Flex>
        </Tab>

        <Tab tabId="realtime" title="Real-Time Updates">
          <Flex direction="column" gap="large">
            <Flex direction="row" gap="small">
              <Tag variant="success">Active</Tag>
              <Text format={{ fontWeight: "bold" }}>
                Real-time webhook is enabled
              </Text>
            </Flex>

            <Text>
              The app listens for changes to the hs_latest_source property on
              contacts. When a contact&apos;s traffic source changes, the
              Marketing Contribution Percentage is automatically recalculated
              using your current marketing source configuration.
            </Text>

            <Divider />

            <Text format={{ fontWeight: "bold" }}>How it works:</Text>
            <Text format={{ fontSize: "small" }}>
              1. HubSpot detects a change to hs_latest_source on a contact
              {"\n"}2. A webhook event is sent to the server{"\n"}3. The server
              fetches the contact&apos;s full source history{"\n"}4. It
              recalculates using your configured marketing sources{"\n"}5. The
              contact&apos;s property is updated automatically
            </Text>

            <Divider />

            <Text format={{ fontSize: "small", color: "subtle" }}>
              Tip: Configure your marketing sources first, then run the Full
              Analysis to set initial values. The webhook keeps everything up
              to date going forward.
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
      </Tabs>
    </Flex>
  );
};

export default SettingsPage;
