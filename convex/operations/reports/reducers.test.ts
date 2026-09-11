import { describe, expect, it } from "vitest";
import type {
  NormalizedReportRange,
  ReportContribution,
  ScalarRecord,
} from "./contracts";
import type { ReportSourceRow } from "./model";
import { finalizeAggregateRecord, reduceReportSourcePage } from "./reducers";

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
  const records = new Map<string, ScalarRecord>();
  const dedupe = new Set<string>();
  for (const contributions of pages) {
    for (const contribution of contributions) {
      const key = `${contribution.section}/${contribution.rowKey}`;
      const fields = records.get(key) ?? {};
      if (contribution.operation === "set") {
        fields[contribution.field] = contribution.value;
      } else if (contribution.operation === "max") {
        const previous = fields[contribution.field];
        fields[contribution.field] =
          typeof previous === "number"
            ? Math.max(previous, contribution.value)
            : contribution.value;
      } else {
        if (contribution.operation === "uniqueSum") {
          const uniqueKey = `${key}/${contribution.field}/${contribution.dedupeKey}`;
          if (dedupe.has(uniqueKey)) continue;
          dedupe.add(uniqueKey);
        }
        const previous = fields[contribution.field];
        fields[contribution.field] =
          (typeof previous === "number" ? previous : 0) + contribution.value;
      }
      records.set(key, fields);
    }
  }
  return records;
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

  it("derives null-safe show-up rates and keeps legitimate rates above one", () => {
    const result = finalizeAggregateRecord({
      section: "sales_calls_summary",
      rowKey: "main",
      fields: {
        booked: 5,
        showed: 2,
        canceled: 4,
      },
      range: { ...range, boundary: "utc_day" },
    });
    expect(result?.payload).toMatchObject({
      totalCalls: 5,
      showUpRate: 2,
    });
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
        relatedFields: { showed: 2 },
        range: { ...range, boundary: "utc_day" },
      })?.payload,
    ).toMatchObject({
      currency: "USD",
      paymentSalesCount: 1,
      cashCollectedMinor: 10_000,
      closeRate: 0.5,
      avgCashPerSaleMinor: 10_000,
    });
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
