import { describe, expect, it } from "vitest";
import { bookingPace, bookingPaceWord } from "./booking-pace";

describe("bookingPace", () => {
  it("has no goal without a daily quota", () => {
    const pace = bookingPace({ booked: 4, dailyQuota: null, goal: null, dayCount: 3, includesToday: true });
    expect(pace.kind).toBe("no_goal");
    expect(bookingPaceWord(pace)).toBe("No goal");
    expect(pace.share).toBeNull();
  });

  it("meets the goal once bookings reach it, even mid-range", () => {
    const pace = bookingPace({ booked: 7, dailyQuota: 1, goal: 7, dayCount: 7, includesToday: true });
    expect(pace.kind).toBe("met");
    expect(pace.toGo).toBe(0);
    expect(pace.share).toBe(1);
  });

  it("expects only the finished days while the range runs through today", () => {
    // Wednesday of a Monday-start week: 3 days, 2 finished, quota 3 → 6 expected.
    expect(bookingPace({ booked: 6, dailyQuota: 3, goal: 9, dayCount: 3, includesToday: true }).kind).toBe("on_pace");
    const ahead = bookingPace({ booked: 8, dailyQuota: 3, goal: 9, dayCount: 3, includesToday: true });
    expect(ahead.kind).toBe("ahead");
    expect(bookingPaceWord(ahead)).toBe("Ahead · +2");
    const behind = bookingPace({ booked: 4, dailyQuota: 3, goal: 9, dayCount: 3, includesToday: true });
    expect(behind.kind).toBe("behind");
    expect(bookingPaceWord(behind)).toBe("Behind · 2 short");
    expect(behind.toGo).toBe(5);
  });

  it("never calls a team behind on Today, only on pace with bookings to go", () => {
    const pace = bookingPace({ booked: 0, dailyQuota: 4, goal: 4, dayCount: 1, includesToday: true });
    expect(pace.kind).toBe("on_pace");
    expect(pace.toGo).toBe(4);
  });

  it("calls a goal missed once the range is over", () => {
    const pace = bookingPace({ booked: 10, dailyQuota: 2, goal: 14, dayCount: 7, includesToday: false });
    expect(pace.kind).toBe("missed");
    expect(bookingPaceWord(pace)).toBe("Missed · 4 short");
  });
});
