/**
 * Meeting statuses, the attendance a screen shows, and their labels. Screens
 * colour status words with the design tokens in app/globals.css, never raw
 * Tailwind palette classes (status-config.test.ts guards this file).
 */

// ─── Meeting statuses ────────────────────────────────────────────────

export const MEETING_STATUSES = [
  "scheduled",
  "held",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ─── Meeting attendance ──────────────────────────────────────────────

export type MeetingAttendanceStatus = MeetingStatus | "not_recorded";

export function meetingAttendanceDisplay(
  meeting: { status: MeetingStatus; scheduledAt: number; durationMinutes: number },
  now: number,
): MeetingAttendanceStatus {
  return meeting.status === "scheduled" &&
    meeting.scheduledAt + meeting.durationMinutes * 60_000 <= now
    ? "not_recorded"
    : meeting.status;
}

type MeetingBlockConfig = {
  label: string;
};

/**
 * Each attendance's label. Screens colour the status word themselves, by
 * meaning (DESIGN.md: owed is amber, failed red, live ink, done slate).
 */
export const meetingStatusConfig: Record<MeetingAttendanceStatus, MeetingBlockConfig> = {
  scheduled: { label: "Scheduled" },
  held: { label: "Held" },
  canceled: { label: "Canceled" },
  no_show: { label: "No-show" },
  not_recorded: { label: "Not recorded" },
};

/** Meeting event history keeps its stored status but uses today's attendance label. */
export function meetingEventStatusLabel(eventType: string, status: string | null | undefined) {
  return eventType.startsWith("meeting.") &&
    (status === "completed" || status === "held")
    ? meetingStatusConfig.held.label
    : status;
}
