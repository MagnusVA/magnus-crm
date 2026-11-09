import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { CallsSummary } from "@/convex/reports/calls";
import {
  buildCallsDocument,
  callsLedger,
  owedWords,
  recordTiming,
  showRateWays,
} from "@/app/workspace/reports/calls/_components/calls-data";
import { renderSummaryCsv } from "./export";

const attendance = (held: number, noShow: number, notRecorded: number) => ({ held, noShow, notRecorded });

function summary(overrides: Partial<CallsSummary> = {}): CallsSummary {
  return {
    counts: {
      scheduled: 231,
      moved: 31,
      canceled: 24,
      upcoming: 0,
      due: 207,
      held: 141,
      noShow: 52,
      notRecorded: 14,
      rebooked: 6,
      rebookedHeld: 4,
      rebookedNoShow: 1,
    },
    byType: { new: { due: 204, ...attendance(139, 51, 14) }, follow_up: { due: 3, ...attendance(2, 1, 0) } },
    leadTime: [
      { bucket: "same_day", ...attendance(10, 2, 1) },
      { bucket: "next_day", ...attendance(0, 0, 0) },
      { bucket: "2_3_days", ...attendance(5, 5, 0) },
      { bucket: "4_7_days", ...attendance(0, 0, 0) },
      { bucket: "8_plus_days", ...attendance(1, 0, 0) },
    ],
    noShowMarkers: { closer: 31, admin: 6, calendly: 15, unknown: 0 },
    noShowReasons: [{ reason: "no_response", count: 24 }],
    mode: { priority: attendance(100, 20, 4), standard: attendance(41, 32, 10) },
    recordMinutes: [10, 30, 2000],
    byDay: [{ dayKey: "2026-10-01", ...attendance(5, 1, 0), canceled: 1, moved: 2 }],
    owed: [
      {
        meetingId: "m1" as Id<"meetings">,
        opportunityId: "o1" as Id<"opportunities">,
        scheduledAt: Date.UTC(2026, 9, 29, 21),
        closerId: "u1" as Id<"users">,
        closerName: "Marco",
        leadName: "Avery",
        programName: "Foundations",
      },
    ],
    owedTotal: 14,
    partial: false,
    ...overrides,
  };
}

describe("Calls page shaping", () => {
  it("reconciles every slot into the ledger", () => {
    const ledger = callsLedger(summary().counts);
    expect(ledger.slots).toBe(262);
    expect(ledger.slotSteps.map((step) => step.value)).toEqual([31, 24, 0, 207]);
    expect(ledger.dueSteps.map((step) => step.value)).toEqual([141, 52, 14]);
    expect(ledger.sentence).toBe(
      "262 slots: 31 moved, 24 canceled, 0 still to come and 207 due. Of those due, 141 held, 52 no-show and 14 not recorded.",
    );
  });

  it("gives four show rates, each with Recorded beside it, and reads tiny follow-up counts in words", () => {
    const ways = showRateWays(summary());
    expect(ways.map((way) => way.key)).toEqual(["overall", "floor", "first", "followUp"]);
    expect(ways[0]).toMatchObject({ of: "141 of 193", recordedOf: "193 of 207" });
    expect(ways[0].rate).toBeCloseTo(141 / 193);
    expect(ways[1]).toMatchObject({ of: "141 of 207" });
    expect(ways[3]).toMatchObject({ of: "2 of 3", recordedOf: "3 of 3" });
    expect(ways[3].rate).toBeCloseTo(2 / 3);
  });

  it("says why a follow-up show rate has no base instead of 0 of 0", () => {
    const ways = showRateWays(summary({ byType: { new: { due: 1, ...attendance(1, 0, 0) }, follow_up: { due: 0, ...attendance(0, 0, 0) } } }));
    expect(ways[3]).toMatchObject({ rate: null, of: "No follow-up call has a result yet", recordedRate: null, recordedOf: "No follow-up calls due yet" });
  });

  it("words the owed list, and says when it stops at the oldest 200", () => {
    expect(owedWords(0, 0, "this week")).toEqual({ meta: "Nothing owed", footer: null, empty: "Every call due this week has a result." });
    expect(owedWords(1, 1, "today")).toMatchObject({ meta: "1 call with no result", footer: "This call is still owed a result." });
    expect(owedWords(14, 14, "today").footer).toBe("All 14 calls are still owed a result.");
    expect(owedWords(312, 200, "today").footer).toBe("Showing the oldest 200 of 312 calls still owed a result.");
  });

  it("takes the median time to record and counts results a day late", () => {
    expect(recordTiming([10, 30, 2000])).toEqual({ count: 3, median: 30, late: 1 });
    expect(recordTiming([])).toEqual({ count: 0, median: null, late: 0 });
  });

  it("exports the band, one table per card and the definitions", () => {
    const document = buildCallsDocument({
      summary: summary(),
      period: "Last month · Oct 1 – Oct 31",
      boundary: "Days run 1:00 am to 1:00 am",
      filters: "Every program, closer and call type",
      generatedAt: 0,
    });
    expect(document.summary.map((item) => item.label)).toEqual([
      "Calls scheduled",
      "Calls due",
      "Show rate",
      "Recorded",
      "Not recorded",
      "Moved",
      "Canceled",
    ]);
    expect(document.summary.find((item) => item.label === "Show rate")?.value).toBe("73.1%");
    expect(document.tables.map((table) => table.title)).toEqual([
      "Where every call went",
      "Show rate, four ways",
      "First calls by booking lead time",
      "Who marked the no-shows",
      "Why they didn't show",
      "Priority and Standard",
      "Rebooked and time to record",
      "By day",
      "Still owed a result (oldest 1 of 14)",
      "Definitions",
    ]);
    const csv = new TextDecoder().decode(renderSummaryCsv(document));
    expect(csv).toContain("Show rate,73.1%");
  });

  it("marks a partial answer in the export's filters line", () => {
    const document = buildCallsDocument({ summary: summary({ partial: true }), period: "", boundary: "", filters: "x", generatedAt: 0 });
    expect(document.filters).toBe("x · Partial: some calls couldn't be read");
  });
});
