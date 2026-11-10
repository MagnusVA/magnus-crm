import type { Doc } from "../_generated/dataModel";
import { formatAmountMinor } from "../../lib/format-currency";

const safe = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rate = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;

export function shiftLabel(
  start: number,
  end: number,
  timeZone: string,
): string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${format.format(start)} to ${format.format(end)}`;
}

/** The scene 12/13 Slack post. All calculations come from the saved snapshot. */
export function buildEndOfDayMessage(
  report: Doc<"endOfDayReports">,
  closerName: string,
  businessZone: string,
) {
  const n = report.numbers;
  const parts = [
    `*${safe(closerName)}* · shift ${shiftLabel(report.periodStart, report.periodEnd, report.timeZone)}`,
  ];
  if (businessZone !== report.timeZone)
    parts.push(
      `${shiftLabel(report.periodStart, report.periodEnd, businessZone)} · business-day time`,
    );
  if (report.previousDayUnclosed)
    parts.push(
      "Previous day was never closed. This report covers the last 24 hours.",
    );
  for (const [title, callType, group] of [
    ["New calls", "new", n.newCalls],
    ["Follow-up calls", "follow_up", n.followUpCalls],
  ] as const) {
    const lines = [
      `*${title}*`,
      `Scheduled ${group.scheduled} · Held ${group.held} · No-show ${group.noShow} · Canceled ${group.canceled} · Not recorded ${group.notRecorded}`,
    ];
    for (const [kind, label] of [
      ["won", "Won"],
      ["deposit", "Deposits"],
      ["lost", "Lost"],
      ["follow_up", "Follow-up"],
    ] as const) {
      const people = n.people.filter(
        (person) => person.callType === callType && person.kind === kind,
      );
      lines.push(`${label} ${people.length}`);
      for (const person of people) {
        const amounts =
          person.amounts ??
          (person.amountMinor !== undefined && person.currency
            ? [
                {
                  amountMinor: person.amountMinor,
                  currency: person.currency,
                  program: person.program ?? "",
                  paymentType: person.paymentType ?? "",
                },
              ]
            : []);
        const detail = amounts
          .map(
            (amount) =>
              `${formatAmountMinor(amount.amountMinor, amount.currency)} ${amount.paymentType === "pif" ? "PIF" : safe(amount.paymentType)}${amount.program ? `, ${safe(amount.program)}` : ""}`,
          )
          .join("; ");
        lines.push(
          `• ${safe(person.name)}${detail ? `: ${detail}` : person.program ? ` · ${safe(person.program)}` : ""}`,
        );
      }
    }
    lines.push(
      `Show rate ${rate(group.showRate)}${callType === "new" ? ` · Close rate, first calls ${n.closeRate.won} of ${n.closeRate.cohort}` : ""}`,
    );
    if (callType === "follow_up")
      lines.push(
        `Call-backs due ${n.callbacks.due} · Done ${n.callbacks.done} · Pending ${n.callbacks.pending}`,
      );
    parts.push(lines.join("\n"));
  }
  parts.push(
    `*Money*\n${n.money.length ? n.money.map((money) => `${safe(money.currency)} · Cash ${formatAmountMinor(money.cashMinor, money.currency)} · Deposits ${formatAmountMinor(money.depositsMinor, money.currency)}`).join("\n") : "Cash 0 · Deposits 0"}\nOverran ${n.overran}`,
  );
  if (report.gaps.length)
    parts.push(
      `Still open:\n${report.gaps.map((gap) => `• ${safe(gap.label)}`).join("\n")}`,
    );
  if (report.narrativeMarkdown) parts.push(safe(report.narrativeMarkdown));
  if (report.note)
    parts.push(
      `Note from ${safe(closerName.split(/\s+/)[0])}: ${safe(report.note)}`,
    );
  parts.push(
    report.endedVia === "agent"
      ? `Numbers from Magnus. Lines by ${safe(report.agentClient ?? "your AI assistant")}, confirmed by ${safe(closerName.split(/\s+/)[0])}.`
      : "Numbers from Magnus. Ended in Magnus.",
  );
  const text = parts.join("\n\n");
  // Section blocks cap at 3,000 characters. Split at lines where possible.
  const chunks: string[] = [];
  for (const part of parts) {
    for (let offset = 0; offset < part.length; ) {
      const end = Math.min(offset + 2800, part.length);
      const lineEnd = part.lastIndexOf("\n", end);
      const cut = end < part.length && lineEnd > offset ? lineEnd : end;
      chunks.push(part.slice(offset, cut));
      offset = cut + (part[cut] === "\n" ? 1 : 0);
    }
  }
  if (chunks.length > 48 || text.length > 39_000)
    throw new Error("Slack end-of-day message is too long");
  return {
    text,
    blocks: chunks.map((chunk) => ({
      type: "section",
      text: { type: "mrkdwn", text: chunk, verbatim: true },
    })),
  };
}
