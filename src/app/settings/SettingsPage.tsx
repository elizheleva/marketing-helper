import React, { useState, useEffect, useCallback } from "react";
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
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [statusInfo, setStatusInfo] = useState<AnyObj | null>(null);

  // Source configuration state
  const [allSources, setAllSources] = useState<SourceOption[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesMessage, setSourcesMessage] = useState("");
  const [sourcesSaving, setSourcesSaving] = useState(false);

  /**
   * Load the current marketing source configuration on mount.
   */
  useEffect(() => {
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
    loadSources();
  }, []);

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
        {
          method: "POST",
          body: { selectedSources },
        }
      );
      const data = await resp.json();
      if (data.success) {
        setSourcesMessage(data.message);
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
   * Poll the status endpoint until the job is complete.
   */
  const pollStatus = useCallback(async () => {
    const poll = async () => {
      try {
        const resp = await hubspot.fetch(
          `${BACKEND_URL}/api/calculate-contribution/status`,
          { method: "GET" }
        );
        const data = await resp.json();
        setStatusInfo(data);

        if (data.status === "running") {
          setMessage(
            `Processing... ${data.processed} contacts done so far.`
          );
          setTimeout(poll, 3000);
        } else if (data.status === "completed") {
          setMessage(
            `Done! Processed ${data.processed} contacts. Updated: ${data.updated}, Zero-history: ${data.skippedNoHistory}, Failed: ${data.failed}.`
          );
          setLoading(false);
        } else if (data.status === "error") {
          setMessage(`Error: ${data.error}`);
          setLoading(false);
        } else {
          setLoading(false);
        }
      } catch (e: any) {
        setMessage(`Error checking status: ${e?.message || "Unknown error"}`);
        setLoading(false);
      }
    };

    await poll();
  }, []);

  /**
   * Kick off the full analysis.
   */
  const runFullAnalysis = async () => {
    setLoading(true);
    setMessage("Starting analysis...");
    setStatusInfo(null);

    try {
      const response = await hubspot.fetch(
        `${BACKEND_URL}/api/calculate-contribution`,
        {
          method: "POST",
          body: {},
        }
      );

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || "Failed to start analysis");
      }

      if (result.status === "running") {
        setMessage(result.message);
      } else {
        setMessage("Analysis started! Tracking progress...");
      }

      setTimeout(() => pollStatus(), 2000);
    } catch (error: any) {
      const detail =
        error?.message ||
        (typeof error === "string" ? error : "") ||
        "Failed to start analysis";
      setMessage(`Error: ${detail}`);
      setLoading(false);
    }
  };

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
              You can configure which traffic sources count as
              &quot;marketing&quot; in the Configure Sources tab.
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
          </Flex>
        </Tab>

        <Tab tabId="actions" title="Run Analysis">
          <Flex direction="column" gap="large">
            <Text>
              Click the button below to calculate Marketing Contribution
              Percentage for your entire contact database. The system processes
              all contacts in the background.
            </Text>

            <Text format={{ fontSize: "small" }}>
              This will:{"\n"}&bull; Create the &quot;Marketing Contribution
              Percentage&quot; property (if it doesn&apos;t exist){"\n"}&bull;
              Read each contact&apos;s full hs_latest_source property history
              (including the initial value){"\n"}&bull; Calculate the % based on
              your configured marketing sources{"\n"}&bull; Update each contact
              with the calculated percentage{"\n"}&bull; Automatically continue
              until all contacts are processed
            </Text>

            <Button
              onClick={runFullAnalysis}
              disabled={loading}
              variant="primary"
            >
              {loading ? "Processing..." : "Run Full Analysis"}
            </Button>

            {loading && statusInfo && statusInfo.status === "running" && (
              <Flex direction="column" gap="small">
                <Text format={{ fontSize: "small", color: "subtle" }}>
                  {statusInfo.processed} contacts processed &middot;{" "}
                  {statusInfo.updated} updated &middot; {statusInfo.failed}{" "}
                  failed
                </Text>
              </Flex>
            )}

            {message && (
              <Text
                format={{
                  color: message.startsWith("Error") ? "error" : "success",
                }}
              >
                {message}
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
              The app is configured to listen for changes to the
              hs_latest_source property on contacts. When a contact&apos;s
              traffic source changes, the Marketing Contribution Percentage is
              automatically recalculated using your configured marketing
              sources.
            </Text>

            <Divider />

            <Text format={{ fontWeight: "bold" }}>How it works:</Text>
            <Text format={{ fontSize: "small" }}>
              1. HubSpot detects a change to hs_latest_source on a contact
              {"\n"}2. A webhook event is sent to your server{"\n"}3. The server
              fetches the contact&apos;s full source history{"\n"}4. It
              recalculates the marketing contribution percentage{"\n"}5. The
              contact&apos;s property is updated automatically
            </Text>

            <Divider />

            <Text format={{ fontSize: "small", color: "subtle" }}>
              Tip: Configure your marketing sources first, then run the Full
              Analysis to set initial values. The webhook keeps everything up to
              date going forward.
            </Text>
          </Flex>
        </Tab>
      </Tabs>
    </Flex>
  );
};

export default SettingsPage;
