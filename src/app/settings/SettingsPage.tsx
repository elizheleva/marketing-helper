import React, { useState } from "react";
import {
  Button,
  Flex,
  Text,
  Tabs,
  Tab,
  Divider,
  Tag,
} from "@hubspot/ui-extensions";
import { hubspot } from "@hubspot/ui-extensions";

hubspot.extend<"settings">(({ context }) => <SettingsPage context={context} />);

const BACKEND_URL = "https://api.uspeh.co.uk";
const BATCH_LIMIT = 300;

type AnyObj = Record<string, any>;

const SettingsPage = ({ context }: AnyObj) => {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [batchProgress, setBatchProgress] = useState({
    totalProcessed: 0,
    totalUpdated: 0,
    totalSkipped: 0,
    totalFailed: 0,
    batchNumber: 0,
    done: false,
  });

  /**
   * Run the full analysis across the entire database.
   * Automatically paginates through all contacts in batches.
   */
  const runFullAnalysis = async () => {
    setLoading(true);
    setMessage("Starting analysis...");
    setBatchProgress({
      totalProcessed: 0,
      totalUpdated: 0,
      totalSkipped: 0,
      totalFailed: 0,
      batchNumber: 0,
      done: false,
    });

    let afterCursor: string | null = null;
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let batchNumber = 0;
    let propertyCreated = false;

    try {
      // Keep calling until there are no more contacts
      do {
        batchNumber++;
        setMessage(
          `Processing batch ${batchNumber} (${totalProcessed} contacts so far)...`
        );

        const response = await hubspot.fetch(
          `${BACKEND_URL}/api/calculate-contribution`,
          {
            method: "POST",
            body: { after: afterCursor },
          }
        );

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.message || "Batch processing failed");
        }

        totalProcessed += result.processed || 0;
        totalUpdated += result.updated || 0;
        totalSkipped += result.skippedNoHistory || 0;
        totalFailed += result.failed || 0;
        if (result.propertyCreated) propertyCreated = true;

        afterCursor = result.nextAfter || null;

        setBatchProgress({
          totalProcessed,
          totalUpdated,
          totalSkipped,
          totalFailed,
          batchNumber,
          done: !afterCursor,
        });
      } while (afterCursor);

      // All done
      const parts: string[] = [];
      if (propertyCreated) parts.push("Created property.");
      parts.push(
        `Processed ${totalProcessed} contacts across ${batchNumber} batch(es).`
      );
      parts.push(`Updated: ${totalUpdated}.`);
      parts.push(`Zero-history: ${totalSkipped}.`);
      if (totalFailed > 0) parts.push(`Failed: ${totalFailed}.`);

      setMessage(`Done! ${parts.join(" ")}`);
    } catch (error: any) {
      const detail =
        error?.message ||
        (typeof error === "string" ? error : "") ||
        "Failed to run analysis";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flex direction="column" gap="large">
      <Text format={{ fontWeight: "bold", fontSize: "xlarge" }}>
        Marketing Contribution Settings
      </Text>

      <Tabs defaultSelected="actions">
        <Tab tabId="overview" title="Overview">
          <Flex direction="column" gap="medium">
            <Text>
              This app calculates the Marketing Contribution Percentage for each
              contact. It analyses the hs_latest_source property history to
              determine what percentage of source changes came from marketing
              channels (organic search, paid search, email marketing, social
              media, referrals, paid social, display ads, etc.)
            </Text>
            <Text format={{ fontSize: "small", color: "subtle" }}>
              Powered by uspeh
            </Text>
          </Flex>
        </Tab>

        <Tab tabId="actions" title="Run Analysis">
          <Flex direction="column" gap="large">
            <Text>
              Click the button below to calculate Marketing Contribution
              Percentage for your entire contact database. The system
              automatically paginates through all contacts in batches of{" "}
              {BATCH_LIMIT}.
            </Text>

            <Text format={{ fontSize: "small" }}>
              This will:{"\n"}&bull; Create the &quot;Marketing Contribution
              Percentage&quot; property (if it doesn&apos;t exist){"\n"}&bull;
              Read each contact&apos;s hs_latest_source property history{"\n"}
              &bull; Calculate the % of marketing-attributed source changes
              {"\n"}&bull; Update each contact with the calculated percentage
              {"\n"}&bull; Automatically continue until all contacts are
              processed
            </Text>

            <Button
              onClick={runFullAnalysis}
              disabled={loading}
              variant="primary"
            >
              {loading ? "Processing..." : "Run Full Analysis"}
            </Button>

            {loading && batchProgress.batchNumber > 0 && (
              <Flex direction="column" gap="small">
                <Text format={{ fontSize: "small", color: "subtle" }}>
                  Batch {batchProgress.batchNumber} &middot;{" "}
                  {batchProgress.totalProcessed} contacts processed &middot;{" "}
                  {batchProgress.totalUpdated} updated
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
              automatically recalculated.
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
              Tip: Run the Full Analysis first to set initial values for all
              existing contacts, then the webhook keeps everything up to date
              going forward.
            </Text>
          </Flex>
        </Tab>
      </Tabs>
    </Flex>
  );
};

export default SettingsPage;
