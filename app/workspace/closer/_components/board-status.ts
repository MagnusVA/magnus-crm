import { meetingAttendanceDisplay, type MeetingStatus } from "@/lib/status-config";

/**
 * The one status word each call shows on the Today board.
 *
 * It reads the call's attendance through `meetingAttendanceDisplay`
 * (lib/status-config.ts), so "Not recorded" stays a display rule, then marks
 * the closer's next call:
 *
 * | Attendance (at `now`)           | Word           |
 * | ------------------------------- | -------------- |
 * | the next or live call           | Boarding       |
 * | scheduled, not yet ended        | On time        |
 * | scheduled, ended                | Not recorded   |
 * | held                            | Held           |
 * | no_show                         | No-show        |
 * | canceled                        | Canceled       |
 *
 * The next call is `getNextMeeting`'s: the soonest scheduled call on one of
 * the closer's deals that hasn't ended, so a call in progress keeps boarding
 * until its scheduled end, then reads "Not recorded" until an outcome lands.
 */
export type BoardStatus =
  | "boarding"
  | "on_time"
  | "not_recorded"
  | "held"
  | "no_show"
  | "canceled";

export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  boarding: "Boarding",
  on_time: "On time",
  not_recorded: "Not recorded",
  held: "Held",
  no_show: "No-show",
  canceled: "Canceled",
};

export function boardStatus(
  meeting: {
    _id: string;
    status: MeetingStatus;
    scheduledAt: number;
    durationMinutes: number;
  },
  nextMeetingId: string | null,
  now: number,
): BoardStatus {
  const attendance = meetingAttendanceDisplay(meeting, now);
  if (attendance === "scheduled") {
    return meeting._id === nextMeetingId ? "boarding" : "on_time";
  }
  return attendance;
}

/**
 * The boarding countdown: minutes to the start, "Live" once it has started.
 * `value` is the condensed figure and `unit` its small suffix.
 */
export function boardingCountdown(scheduledAt: number, now: number) {
  const minutes = Math.ceil((scheduledAt - now) / 60_000);
  if (minutes <= 0) return { value: "Live", unit: "", label: "Call in progress" };
  if (minutes < 60) {
    return { value: String(minutes), unit: "min", label: `Starts in ${minutes} min` };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return {
      value: rest === 0 ? `${hours}` : `${hours}:${String(rest).padStart(2, "0")}`,
      unit: "h",
      label: `Starts in ${hours} h ${rest} min`,
    };
  }
  const days = Math.floor(hours / 24);
  return { value: String(days), unit: days === 1 ? "day" : "days", label: `Starts in ${days} ${days === 1 ? "day" : "days"}` };
}

/** Calendly's location type as the call's gate. */
export function gateLabel(locationType: string | undefined): string | null {
  switch (locationType) {
    case undefined:
      return null;
    case "zoom":
      return "Zoom";
    case "google_conference":
      return "Meet";
    case "microsoft_teams_conference":
      return "Teams";
    case "webex_conference":
      return "Webex";
    case "gotomeeting":
      return "GoTo";
    case "outbound_call":
    case "inbound_call":
      return "Phone";
    case "physical":
      return "In person";
    default:
      return "Link";
  }
}
