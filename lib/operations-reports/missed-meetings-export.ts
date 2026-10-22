import type { MissedMeetingRow } from "../../convex/operations/missedMeetings";
import { SYSTEM_LOSS_REASON_LABELS } from "../../convex/opportunities/stages";
import { serializeCsv } from "../csv";

// The No-shows and cancellations page's export (docs/plans/phase-5-deal-status.md
// §6.5): the rows the filters show, up to 2,000.

export const MISSED_MEETINGS_EXPORT_CAP = 2000;

export const DEAL_SOURCE_LABELS: Record<MissedMeetingRow["source"], string> = {
  calendly: "Calendly",
  slack_qualified: "Slack",
  side_deal: "Side deal",
};

/**
 * Whether the page should read another page: until it holds one row past
 * the cap, which tells it the range holds more.
 */
export function needsMoreMissedMeetingRows(loaded: number, cap = MISSED_MEETINGS_EXPORT_CAP): boolean {
  return loaded <= cap;
}

/**
 * The rows newest loss first, up to `cap`, and whether the range holds more.
 * The pages come in order of the deals' latest activity, so the page sorts
 * what it read.
 */
export function capMissedMeetingRows<Row extends Pick<MissedMeetingRow, "lostAt" | "opportunityId">>(
  rows: Row[],
  cap = MISSED_MEETINGS_EXPORT_CAP,
): { rows: Row[]; truncated: boolean } {
  const sorted = [...rows].sort(
    (left, right) =>
      right.lostAt - left.lostAt || left.opportunityId.localeCompare(right.opportunityId),
  );
  return sorted.length > cap
    ? { rows: sorted.slice(0, cap), truncated: true }
    : { rows: sorted, truncated: false };
}

const iso = (timestamp: number | null) => (timestamp === null ? "" : new Date(timestamp).toISOString());

/** The rows as CSV, one line a deal. */
export function missedMeetingsCsv(rows: MissedMeetingRow[]): string {
  return serializeCsv([
    [
      "Name",
      "Instagram",
      "Email",
      "Phone",
      "Missed meeting",
      "Meeting at",
      "Closed at",
      "Source",
      "Closer",
      "Setter",
      "DM closer",
      "DM team",
      "Booked again",
      "Deal ID",
      "Person ID",
    ],
    ...rows.map((row) => [
      row.personName,
      row.instagramHandle,
      row.email,
      row.phone,
      SYSTEM_LOSS_REASON_LABELS[row.missedMeeting],
      iso(row.meetingAt),
      iso(row.lostAt),
      DEAL_SOURCE_LABELS[row.source],
      row.closerName,
      row.setterName,
      row.dmCloserName,
      row.dmTeamName,
      row.bookedAgain ? "Yes" : "No",
      row.opportunityId,
      row.leadId,
    ]),
  ]);
}
