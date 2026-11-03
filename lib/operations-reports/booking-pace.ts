/**
 * How a DM team stands against its booking goal for the shown range, the
 * Booked calls page's colour feedback (.impeccable/surfaces brief, Pace rules).
 *
 * The server's goal is the team's daily quota times the days in the range,
 * and the preset ranges run through today, so the goal already counts today
 * in full. Pace compares the bookings with the days that have finished:
 * a team is behind only when it booked fewer than its quota times the days
 * before today. Once the range is over, the whole goal is due.
 */

export type BookingPaceKind = "met" | "ahead" | "on_pace" | "behind" | "missed" | "no_goal";

export type BookingPace = {
  kind: BookingPaceKind;
  /** The team's goal for the range; null when it has no daily quota. */
  goal: number | null;
  booked: number;
  /** Bookings the finished days ask for (the whole goal once the range is over). */
  expected: number | null;
  /** booked − expected for ahead; expected − booked (behind) or goal − booked (missed). */
  gap: number;
  /** Bookings still needed to meet the goal; 0 once met. */
  toGo: number | null;
  /** booked ÷ goal, 0–1 (capped), for the ring; null without a goal. */
  share: number | null;
};

export type BookingPaceInput = {
  booked: number;
  dailyQuota: number | null;
  goal: number | null;
  /** Days in the range, today included when the range runs through today. */
  dayCount: number;
  /** True when the range includes today, so today has not finished yet. */
  includesToday: boolean;
};

export function bookingPace({ booked, dailyQuota, goal, dayCount, includesToday }: BookingPaceInput): BookingPace {
  if (goal === null || dailyQuota === null || goal <= 0) {
    return { kind: "no_goal", goal: null, booked, expected: null, gap: 0, toGo: null, share: null };
  }
  const share = Math.min(1, booked / goal);
  const toGo = Math.max(0, goal - booked);
  if (booked >= goal) {
    return { kind: "met", goal, booked, expected: goal, gap: 0, toGo: 0, share };
  }
  if (!includesToday) {
    return { kind: "missed", goal, booked, expected: goal, gap: goal - booked, toGo, share };
  }
  const finishedDays = Math.max(0, dayCount - 1);
  const expected = dailyQuota * finishedDays;
  if (booked < expected) {
    return { kind: "behind", goal, booked, expected, gap: expected - booked, toGo, share };
  }
  if (booked > expected && expected > 0) {
    return { kind: "ahead", goal, booked, expected, gap: booked - expected, toGo, share };
  }
  return { kind: "on_pace", goal, booked, expected, gap: 0, toGo, share };
}

/** The pace as words: "Goal met", "Ahead · +3", "Behind · 3 short", "Missed · 4 short", "On pace", "No goal". */
export function bookingPaceWord(pace: BookingPace) {
  switch (pace.kind) {
    case "met":
      return "Goal met";
    case "ahead":
      return `Ahead · +${pace.gap}`;
    case "on_pace":
      return "On pace";
    case "behind":
      return `Behind · ${pace.gap} short`;
    case "missed":
      return `Missed · ${pace.gap} short`;
    case "no_goal":
      return "No goal";
  }
}

/** Order for anything that ranks teams by how much they need attention: missed, behind, then the rest. */
export const BOOKING_PACE_SEVERITY: Record<BookingPaceKind, number> = {
  missed: 0,
  behind: 1,
  on_pace: 2,
  ahead: 3,
  met: 4,
  no_goal: 5,
};
