import { describe, expect, it } from "vitest";
import type {
  NormalizedReportRange,
  ReportContribution,
} from "./contracts";
import type { ReportSourceRow } from "./model";
import { finalizeAggregateRecord, reduceReportSourcePage } from "./reducers";
import { ReportAggregate } from "./aggregate";

const range: NormalizedReportRange = {
  input: {
    kind: "custom",
    startBusinessDate: "2026-01-01",
    endBusinessDateInclusive: "2026-01-31",
  },
  startBusinessDate: "2026-01-01",
  endBusinessDateInclusive: "2026-01-31",
  endBusinessDateExclusive: "2026-02-01",
  startTimestamp: 1_767_247_200_000,
  endTimestampExclusive: 1_769_925_600_000,
  startDayKey: "2026-01-01",
  endDayKeyExclusive: "2026-02-01",
  dayCount: 31,
  label: "Jan 1–31, 2026",
  boundary: "honduras_business_day",
};

function applyContributions(pages: ReportContribution[][]) {
  const aggregate = new ReportAggregate();
  for (const contributions of pages) aggregate.apply(contributions);
  return new Map([...aggregate.sections].flatMap(([section, rows]) =>
    [...rows].map(([key, fields]) => [`${section}/${key}`, fields] as const),
  ));
}

describe("operations report reducers", () => {
  it("deduplicates a worker/day schedule across page and source boundaries", () => {
    const rows: ReportSourceRow[] = [
      {
        kind: "lead_gen_daily",
        statKey: "one",
        workerId: "worker",
        teamId: "team",
        source: "instagram",
        dayKey: "2026-01-05",
        submissions: 3,
        uniqueProspects: 2,
        duplicates: 1,
        scheduledHours: 6,
      },
      {
        kind: "lead_gen_daily",
        statKey: "two",
        workerId: "worker",
        teamId: "team",
        source: "meta_business",
        dayKey: "2026-01-05",
        submissions: 4,
        uniqueProspects: 4,
        duplicates: 0,
        scheduledHours: 6,
      },
    ];
    const records = applyContributions(
      rows.map((row) =>
        reduceReportSourcePage({ sourceKey: "lead_gen_daily", range, rows: [row] }),
      ),
    );
    expect(records.get("lead_gen_summary/main")).toMatchObject({
      submissions: 7,
      uniqueProspects: 6,
      scheduledHours: 6,
    });
    expect(records.get("lead_gen_daily_summary/one")).toMatchObject({
      submissions: 3,
      workerId: "worker",
    });
    expect(records.get("lead_gen_team_worker/team:worker")).toMatchObject({
      submissions: 7,
      uniqueProspects: 6,
      scheduledHours: 6,
    });
    expect(records.get("lead_gen_team_source/team:instagram")).toMatchObject({
      submissions: 3,
      scheduledHours: 6,
    });
  });

  it("is invariant when an event ledger crosses a page boundary", () => {
    const rows: ReportSourceRow[] = Array.from({ length: 51 }, (_, index) => ({
      kind: "qualification_event" as const,
      eventId: `event-${index}`,
      submittedAt: index + 1,
      slackUserId: index % 2 === 0 ? "one" : "two",
      slackTeamId: "workspace",
      fullNameSnapshot: `Lead ${index}`,
      platform: "instagram",
      handleSnapshot: `lead${index}`,
      leadId: null,
      opportunityId: null,
      resultKind: index % 2 === 0 ? "created" : "updated",
    }));
    const whole = applyContributions([
      reduceReportSourcePage({ sourceKey: "qualification_events", range, rows }),
    ]);
    const paged = applyContributions([
      reduceReportSourcePage({ sourceKey: "qualification_events", range, rows: rows.slice(0, 25) }),
      reduceReportSourcePage({ sourceKey: "qualification_events", range, rows: rows.slice(25) }),
    ]);
    expect(paged).toEqual(whole);
    expect(paged.get("qualifications_summary/main")?.totalQualified).toBe(51);
  });

  it("keeps filtered-origin prospect/day uniqueness across pages", () => {
    const submission = (
      submissionId: string,
      submittedAt: number,
    ): ReportSourceRow => ({
      kind: "lead_gen_submission",
      submissionId,
      prospectId: "prospect",
      workerId: "worker",
      workerDisplayName: "Worker",
      workerEmail: "worker@example.com",
      userId: "user",
      teamId: "team",
      teamName: "Team",
      source: "instagram",
      originKind: "post",
      originValue: "https://instagram.com/p/example?tracking=one",
      originRankable: true,
      submittedAt,
      voidedAt: null,
      voidedByUserId: null,
      voidReason: null,
      normalizedHandle: null,
      rawHandle: null,
      profileUrl: null,
      clientSubmissionKey: null,
      createdAt: submittedAt,
    });
    const rows = [
      submission("one", range.startTimestamp),
      submission("two", range.startTimestamp + 1_000),
    ];
    const records = applyContributions(
      rows.map((row) =>
        reduceReportSourcePage({
          sourceKey: "lead_gen_filtered_origin_submissions",
          range,
          rows: [row],
        }),
      ),
    );
    expect(
      records.get("lead_gen_origin/instagram:https://instagram.com/p/example"),
    ).toMatchObject({ submissions: 2, uniqueProspects: 1, dayCount: 1 });
  });

  it("counts held status buckets once in every exported show rate", () => {
    const rows: ReportSourceRow[] = (["held", "held", "no_show", "scheduled", "canceled"] as const).map((meetingStatus) => ({
      kind: "sales_meeting_stat",
      meetingStatus,
      assignedCloserId: "closer",
      bookingProgramId: "program",
      count: 1,
      notRecorded: meetingStatus === "scheduled" ? 1 : 0,
    }));
    const records = applyContributions(rows.map((row) =>
      reduceReportSourcePage({ sourceKey: "sales_meeting_stats", range, rows: [row] }),
    ));
    for (const [section, rowKey] of [["sales_calls_summary", "main"], ["sales_closer", "closer"], ["sales_program", "program"]]) {
      const fields = records.get(`${section}/${rowKey}`)!;
      expect(fields).toMatchObject({ booked: 5, showed: 2, noShows: 1 });
      expect(finalizeAggregateRecord({ section, rowKey, fields, range })?.payload).toMatchObject({
        showUpRate: 2 / 3, resultsRecorded: 3, pastCalls: 4,
      });
    }
  });

  it.each(["sales_calls_summary", "sales_closer", "sales_program"])(
    "%s uses held / (held + no-show) and counts missing results",
    (section) => {
      const result = finalizeAggregateRecord({
        section,
        rowKey: "main",
        fields: { booked: 7, showed: 2, noShows: 1, canceled: 1, notRecorded: 2 },
        range: { ...range, boundary: "utc_day" },
      });
      expect(result?.payload).toMatchObject({
        showUpRate: 2 / 3,
        resultsRecorded: 3,
        pastCalls: 5,
      });
      expect(finalizeAggregateRecord({
        section,
        rowKey: "main",
        fields: { booked: 3, showed: 0, noShows: 0, canceled: 1, notRecorded: 2 },
        range: { ...range, boundary: "utc_day" },
      })?.payload).toMatchObject({ showUpRate: null, resultsRecorded: 0, pastCalls: 2 });
    },
  );

  it("keeps partial attendance when later source pages are complete", () => {
    const row: ReportSourceRow = {
      kind: "sales_meeting_stat", assignedCloserId: "closer", bookingProgramId: "program",
      meetingStatus: "scheduled", count: 2, notRecorded: 1,
    };
    const records = applyContributions([true, false].map((attendanceCountsPartial) =>
      reduceReportSourcePage({
        sourceKey: "sales_meeting_stats", range,
        rows: [{ ...row, attendanceCountsPartial }],
      }),
    ));
    for (const [section, rowKey] of [
      ["sales_calls_summary", "main"], ["sales_closer", "closer"], ["sales_program", "program"],
    ]) {
      expect(finalizeAggregateRecord({
        section, rowKey, fields: records.get(`${section}/${rowKey}`)!, range,
      })?.payload).toMatchObject({ attendanceCountsPartial: true, notRecorded: 2, pastCalls: 2 });
    }
  });

  it("keeps sales money in separate normalized currency buckets", () => {
    const payment = (
      paymentId: string,
      currency: string,
      amountMinor: number,
    ): ReportSourceRow => ({
      kind: "sales_payment",
      paymentId,
      recordedAt: range.startTimestamp,
      opportunityId: "opportunity",
      amountMinor,
      currency,
      paymentType: "final",
      programId: "program",
      programName: "Program",
      effectiveCloserId: "closer",
    });
    const records = applyContributions([
      reduceReportSourcePage({
        sourceKey: "sales_payments",
        range,
        rows: [
          payment("usd-one", "usd", 10_000),
          payment("eur-one", "EUR", 20_000),
        ],
      }),
    ]);

    expect(records.get("sales_calls_summary/main")).toBeUndefined();
    expect(records.get("sales_summary_money/USD")).toMatchObject({
      currency: "USD",
      paymentSalesCount: 1,
      cashCollectedMinor: 10_000,
    });
    expect(records.get("sales_summary_money/EUR")).toMatchObject({
      currency: "EUR",
      paymentSalesCount: 1,
      cashCollectedMinor: 20_000,
    });
    expect(records.get("sales_program_money/program:USD")).toMatchObject({
      programId: "program",
      currency: "USD",
      paymentSales: 1,
      paymentRevenueMinor: 10_000,
    });
    expect(records.get("sales_closer_money/closer:EUR")).toMatchObject({
      closerId: "closer",
      currency: "EUR",
      paymentSales: 1,
      paymentRevenueMinor: 20_000,
    });

    expect(
      finalizeAggregateRecord({
        section: "sales_summary_money",
        rowKey: "USD",
        fields: records.get("sales_summary_money/USD") ?? {},
        range: { ...range, boundary: "utc_day" },
      })?.payload,
    ).toEqual({
      currency: "USD",
      paymentSalesCount: 1,
      cashCollectedMinor: 10_000,
      avgCashPerSaleMinor: 10_000,
    });
    expect(
      finalizeAggregateRecord({
        section: "sales_closer_money",
        rowKey: "closer:EUR",
        fields: records.get("sales_closer_money/closer:EUR") ?? {},
        range,
      })?.payload,
    ).not.toHaveProperty("paymentCloseRate");
  });

  it("sums the close rate cohort across pages into the summary, closers and programs", () => {
    const deal = (
      opportunityId: string,
      closerId: string,
      bookingProgramId: string | null,
      won: boolean,
    ): ReportSourceRow => ({ kind: "sales_close_rate_deal", opportunityId, closerId, bookingProgramId, won });
    const records = applyContributions([
      reduceReportSourcePage({
        sourceKey: "sales_close_rate_cohort",
        range,
        rows: [deal("a", "carla", "program", true), deal("b", "beto", null, false)],
      }),
      reduceReportSourcePage({
        sourceKey: "sales_close_rate_cohort",
        range,
        rows: [deal("c", "carla", "program", false), deal("d", "carla", null, true)],
      }),
    ]);
    const finalized = (section: string, rowKey: string) =>
      finalizeAggregateRecord({ section, rowKey, fields: records.get(`${section}/${rowKey}`) ?? {}, range })?.payload;

    expect(finalized("sales_calls_summary", "main")).toMatchObject({ cohortDeals: 4, wonDeals: 2, closeRate: 0.5 });
    expect(finalized("sales_closer", "carla")).toMatchObject({ closerId: "carla", cohortDeals: 3, wonDeals: 2, closeRate: 2 / 3 });
    expect(finalized("sales_closer", "beto")).toMatchObject({ closerId: "beto", cohortDeals: 1, wonDeals: 0, closeRate: 0 });
    expect(finalized("sales_program", "program")).toMatchObject({ cohortDeals: 2, wonDeals: 1, closeRate: 0.5 });
    expect(finalized("sales_program", "none")).toMatchObject({ cohortDeals: 2, wonDeals: 1, closeRate: 0.5 });
    // A closer with calls and no cohort deals has no rate.
    expect(finalizeAggregateRecord({ section: "sales_closer", rowKey: "zed", fields: { booked: 2 }, range })?.payload)
      .toMatchObject({ cohortDeals: 0, wonDeals: 0, closeRate: null });
  });

  it("ranks origin rows by unique prospects", () => {
    const result = finalizeAggregateRecord({
      section: "lead_gen_origin",
      rowKey: "instagram:post",
      fields: { uniqueProspects: 4, submissions: 20 },
      range,
    });
    expect(result?.sortValue).toBe(4);
  });

  it("keeps schedule-only booked closers and filters inactive empty teams", () => {
    const scheduledRecords = applyContributions([
      reduceReportSourcePage({
        sourceKey: "dm_closer_schedules",
        range,
        rows: [
          {
            kind: "dm_closer_schedule",
            dmCloserId: "closer",
            weekday: "thursday",
            scheduledHours: 2,
          },
        ],
      }),
    ]);
    expect(scheduledRecords.get("booked_closer/closer")).toEqual({
      dmCloserId: "closer",
    });
    expect(
      finalizeAggregateRecord({
        section: "booked_closer",
        rowKey: "closer",
        fields: { label: "Closer" },
        relatedFields: { scheduledHours: 10 },
        range,
      })?.payload,
    ).toMatchObject({ booked: 0, scheduledHours: 10, bookedPerHour: 0 });
    expect(
      finalizeAggregateRecord({
        section: "booking_team",
        rowKey: "inactive",
        fields: { isActive: false, target: 10 },
        range,
      }),
    ).toBeNull();
  });

  it("counts a team-only booking toward its team and the goal, not a DM closer or the raw list", () => {
    const booking = (meetingId: string, dmCloserId: string | null, teamId: string) =>
      ({
        kind: "booked_meeting",
        meetingId,
        opportunityId: `deal-${meetingId}`,
        leadId: null,
        bookedAt: range.startTimestamp,
        scheduledAt: range.startTimestamp,
        meetingStatus: "scheduled",
        attendance: "Not recorded",
        dealStage: "booked",
        dealOutcome: "open",
        bookingProgramId: null,
        bookingProgramName: null,
        leadLabel: "Lead",
        leadHandle: null,
        initialSource: null,
        selfReportedIncome: null,
        attributionTeamId: teamId,
        attributionTeamLabel: "Team",
        dmCloserId,
        dmCloserLabel: dmCloserId ? "Closer" : null,
      }) satisfies ReportSourceRow;
    const records = applyContributions([
      reduceReportSourcePage({
        sourceKey: "booked_meetings",
        range,
        rows: [booking("withCloser", "closer", "north"), booking("teamOnly", null, "south")],
      }),
    ]);

    expect(records.get("booked_calls_summary/main")).toMatchObject({
      totalBooked: 1,
      teamOnlyBooked: 1,
    });
    expect(records.get("booked_closer/closer")).toMatchObject({ booked: 1 });
    expect(records.get("booking_team/north")).toMatchObject({ progress: 1 });
    expect(records.get("booking_team/south")).toMatchObject({ progress: 1 });
    expect(records.get("raw_booking/withCloser")).toMatchObject({
      meetingStatus: "scheduled",
      dealStage: "booked",
      dealOutcome: "open",
    });
    expect(records.get("raw_booking/withCloser")).not.toHaveProperty("opportunityStatus");
    expect(records.has("raw_booking/teamOnly")).toBe(false);
    expect([...records.keys()].filter((key) => key.startsWith("booked_closer/"))).toEqual([
      "booked_closer/closer",
    ]);
    expect(
      finalizeAggregateRecord({
        section: "booked_calls_summary",
        rowKey: "main",
        fields: records.get("booked_calls_summary/main")!,
        range,
      })?.payload,
    ).toMatchObject({ totalBooked: 1, progress: 2 });
  });

  it("computes long-range schedule occurrences without expanding the range", () => {
    const longRange = { ...range, dayCount: 10_000, endDayKeyExclusive: "2053-05-19" };
    const contributions = reduceReportSourcePage({
      sourceKey: "qualifier_schedules",
      range: longRange,
      rows: [{ kind: "qualifier_schedule", slackUserId: "q", weekday: "thursday", scheduledHours: 2 }],
    });
    const scheduled = contributions.find((item) => item.field === "scheduledHours");
    expect(scheduled?.value).toBe(2 * 1_429);
  });
});
