import type { Doc } from "@/convex/_generated/dataModel";

export function EndDayStatus({ report }: { report: Doc<"endOfDayReports"> }) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: report.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(report.periodEnd);
  const status =
    report.slackStatus === "posted"
      ? `posted to #${report.slackChannelName ?? report.slackChannelId}`
      : report.slackStatus === "pending"
        ? "posting to Slack…"
        : report.slackStatus === "failed"
          ? "Slack post failed. Your report is saved."
          : "saved · No Slack channel is set";
  return (
    <>
      Day ended {time} · {status}
    </>
  );
}
