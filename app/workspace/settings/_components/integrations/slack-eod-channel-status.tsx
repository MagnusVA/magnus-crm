import type { InstallationStatus } from "@/convex/slack/channels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function SlackEodChannelStatus({
  status,
}: {
  status: Extract<InstallationStatus, { kind: "connected" }>;
}) {
  const error = status.eodReportChannelError;
  return (
    <>
      <dl className="text-sm">
        <dt className="text-muted-foreground">End-of-day reports</dt>
        <dd>
          {status.eodReportChannelName
            ? `#${status.eodReportChannelName}`
            : "Off"}
        </dd>
      </dl>
      {error && (
        <Alert
          variant={error.code === "not_in_channel" ? "default" : "destructive"}
        >
          <AlertTitle>End-of-day reports need attention</AlertTitle>
          <AlertDescription>
            {error.code === "not_in_channel"
              ? `Invite @Magnus to #${error.channelName ?? error.channelId}, then retry the saved report.`
              : "Pick an end-of-day channel, then retry the saved report. No fallback channel is used."}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
