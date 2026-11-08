/**
 * Shared status labels and colours: meeting attendance, and each deal
 * position's chip. Colours come from the design tokens in app/globals.css,
 * never raw Tailwind palette classes (status-config.test.ts guards this).
 */

import type { DealPosition } from "../convex/opportunities/stages";

// ─── Meeting statuses ────────────────────────────────────────────────

export const MEETING_STATUSES = [
  "scheduled",
  "held",
  "canceled",
  "no_show",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

// ─── Deal position display config ────────────────────────────────────

type DealPositionVisualConfig = {
  /** Chip fill + ink classes, from the stage tokens in app/globals.css. */
  badgeClass: string;
};

/**
 * The colours of each place a screen shows a deal (docs/plans/phase-5-deal-status.md
 * §4.1), on the stage scale the closer pages use (`STAGE_TONE` in
 * `app/workspace/closer/meetings/_components/stage-tone.tsx`). Keyed by the
 * position, so a new one fails the typecheck until it has colours. Labels
 * come from `dealPositionLabel` in `convex/opportunities/stageLabels.ts`.
 */
export const dealPositionConfig: Record<DealPosition, DealPositionVisualConfig> = {
  qualified: { badgeClass: "bg-stage-held/15 text-stage-held-ink" },
  booked: { badgeClass: "bg-stage-booked/15 text-stage-booked-ink" },
  call_held: { badgeClass: "bg-stage-held/15 text-stage-held-ink" },
  follow_up: { badgeClass: "bg-stage-follow-up/15 text-stage-follow-up-ink" },
  won: { badgeClass: "bg-stage-won/15 text-stage-won-ink" },
  lost: { badgeClass: "bg-stage-lost/12 text-stage-lost-ink" },
};

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
