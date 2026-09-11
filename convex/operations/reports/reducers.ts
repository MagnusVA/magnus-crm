import { timestampToBusinessDateKey } from "../../reporting/lib/hondurasBusinessTime";
import { weekdayForBusinessDate, type Weekday } from "../../lib/workSchedule";
import { normalizeLeadGenOrigin } from "../../leadGen/normalization";
import type {
  NormalizedReportRange,
  ReportContribution,
  ReportResultWrite,
  ScalarRecord,
  ScalarValue,
} from "./contracts";
import type { ReportSourceRow } from "./model";

type MetricOperation = "sum" | "max";

function metric(
  section: string,
  rowKey: string,
  field: string,
  operation: MetricOperation,
  value: number,
): ReportContribution {
  return { section, rowKey, field, operation, value };
}

function set(
  section: string,
  rowKey: string,
  field: string,
  value: ScalarValue,
): ReportContribution {
  return { section, rowKey, field, operation: "set", value };
}

function uniqueSum(
  section: string,
  rowKey: string,
  field: string,
  value: number,
  dedupeKey: string,
): ReportContribution {
  return { section, rowKey, field, operation: "uniqueSum", value, dedupeKey };
}

function fieldsToSetContributions(
  section: string,
  rowKey: string,
  fields: ScalarRecord,
): ReportContribution[] {
  return Object.entries(fields).map(([field, value]) =>
    set(section, rowKey, field, value),
  );
}

function addPageMetric(
  pageMetrics: Map<string, number>,
  section: string,
  rowKey: string,
  field: string,
  value: number,
) {
  const key = `${section}\u0000${rowKey}\u0000${field}`;
  pageMetrics.set(key, (pageMetrics.get(key) ?? 0) + value);
}

function flushPageMetrics(pageMetrics: Map<string, number>) {
  return [...pageMetrics].map(([key, value]) => {
    const [section, rowKey, field] = key.split("\u0000");
    if (!section || rowKey === undefined || !field) {
      throw new Error("Invalid report metric key.");
    }
    return metric(section, rowKey, field, "sum", value);
  });
}

function weekdayCounts(range: NormalizedReportRange): Record<Weekday, number> {
  const counts: Record<Weekday, number> = {
    monday: 0,
    tuesday: 0,
    wednesday: 0,
    thursday: 0,
    friday: 0,
    saturday: 0,
    sunday: 0,
  };
  const wholeWeeks = Math.floor(range.dayCount / 7);
  for (const weekday of Object.keys(counts) as Weekday[]) {
    counts[weekday] = wholeWeeks;
  }
  const remainder = range.dayCount % 7;
  for (let offset = 0; offset < remainder; offset += 1) {
    const timestamp =
      Date.parse(`${range.startDayKey}T12:00:00.000Z`) +
      offset * 24 * 60 * 60 * 1_000;
    const dayKey = new Date(timestamp).toISOString().slice(0, 10);
    counts[weekdayForBusinessDate(dayKey)] += 1;
  }
  return counts;
}

function reduceLeadGenDaily(rows: ReportSourceRow[]) {
  const pageMetrics = new Map<string, number>();
  const unique: ReportContribution[] = [];
  for (const row of rows) {
    if (row.kind !== "lead_gen_daily") continue;
    unique.push(
      ...fieldsToSetContributions("lead_gen_daily_summary", row.statKey, {
        statKey: row.statKey,
        dayKey: row.dayKey,
        workerId: row.workerId,
        teamId: row.teamId,
        source: row.source,
        submissions: row.submissions,
        uniqueProspects: row.uniqueProspects,
        duplicates: row.duplicates,
        scheduledHours: row.scheduledHours,
      }),
    );
    const groups = [
      ["lead_gen_summary", "main"],
      ["lead_gen_worker", row.workerId],
      ["lead_gen_source", row.source],
      ["lead_gen_team", row.teamId ?? "unassigned"],
      [
        "lead_gen_team_worker",
        `${row.teamId ?? "unassigned"}:${row.workerId}`,
      ],
      [
        "lead_gen_team_source",
        `${row.teamId ?? "unassigned"}:${row.source}`,
      ],
    ] as const;
    for (const [section, rowKey] of groups) {
      if (section === "lead_gen_worker") {
        unique.push(set(section, rowKey, "workerId", row.workerId));
      } else if (section === "lead_gen_team") {
        unique.push(set(section, rowKey, "teamId", row.teamId));
        unique.push(
          uniqueSum(section, rowKey, "workerCount", 1, row.workerId),
        );
      } else if (section === "lead_gen_source") {
        unique.push(set(section, rowKey, "source", row.source));
      } else if (section === "lead_gen_team_worker") {
        unique.push(
          set(section, rowKey, "teamId", row.teamId),
          set(section, rowKey, "workerId", row.workerId),
        );
      } else if (section === "lead_gen_team_source") {
        unique.push(
          set(section, rowKey, "teamId", row.teamId),
          set(section, rowKey, "source", row.source),
        );
      }
      addPageMetric(pageMetrics, section, rowKey, "submissions", row.submissions);
      addPageMetric(
        pageMetrics,
        section,
        rowKey,
        "uniqueProspects",
        row.uniqueProspects,
      );
      addPageMetric(pageMetrics, section, rowKey, "duplicates", row.duplicates);
      unique.push(
        uniqueSum(
          section,
          rowKey,
          "scheduledHours",
          row.scheduledHours,
          `${row.workerId}:${row.dayKey}`,
        ),
      );
    }
    const teamSources =
      row.requestedSourceFilter && row.requestedSourceFilter !== "all"
        ? [row.requestedSourceFilter]
        : (["instagram", "meta_business"] as const);
    for (const source of teamSources) {
      const rowKey = `${row.teamId ?? "unassigned"}:${source}`;
      unique.push(
        set("lead_gen_team_source", rowKey, "teamId", row.teamId),
        set("lead_gen_team_source", rowKey, "source", source),
      );
    }
  }
  return [...flushPageMetrics(pageMetrics), ...unique];
}

function reduceLeadGenOrigins(rows: ReportSourceRow[], teamScoped: boolean) {
  const pageMetrics = new Map<string, number>();
  const metadata: ReportContribution[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind !== (teamScoped ? "lead_gen_team_origin" : "lead_gen_origin")) {
      continue;
    }
    const originRow = row as Extract<
      ReportSourceRow,
      { kind: "lead_gen_origin" | "lead_gen_team_origin" }
    >;
    const teamId = originRow.kind === "lead_gen_team_origin" ? originRow.teamId : null;
    const section = teamScoped ? "lead_gen_team_origin" : "lead_gen_origin";
    const rowKey = teamScoped
      ? `${teamId ?? "unassigned"}:${originRow.source}:${originRow.originKey}`
      : `${originRow.source}:${originRow.originKey}`;
    addPageMetric(pageMetrics, section, rowKey, "submissions", originRow.submissions);
    addPageMetric(
      pageMetrics,
      section,
      rowKey,
      "uniqueProspects",
      originRow.uniqueProspects,
    );
    addPageMetric(pageMetrics, section, rowKey, "dayCount", 1);
    if (!seen.has(rowKey)) {
      seen.add(rowKey);
      metadata.push(
        set(section, rowKey, "originKey", originRow.originKey),
        set(section, rowKey, "source", originRow.source),
        set(section, rowKey, "originKind", originRow.originKind),
        set(section, rowKey, "originValue", originRow.originValue),
      );
      if (teamScoped) metadata.push(set(section, rowKey, "teamId", teamId));
    }
  }
  return [...flushPageMetrics(pageMetrics), ...metadata];
}

function reduceLeadGenSubmission(row: Extract<ReportSourceRow, { kind: "lead_gen_submission" }>) {
  return fieldsToSetContributions("raw_submission", row.submissionId, {
    submissionId: row.submissionId,
    prospectId: row.prospectId,
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
    workerId: row.workerId,
    workerDisplayName: row.workerDisplayName,
    workerEmail: row.workerEmail,
    userId: row.userId,
    teamId: row.teamId,
    teamName: row.teamName,
    source: row.source,
    normalizedHandle: row.normalizedHandle,
    rawHandle: row.rawHandle,
    profileUrl: row.profileUrl,
    originKind: row.originKind,
    originValue: row.originValue,
    originRankable: row.originRankable,
    clientSubmissionKey: row.clientSubmissionKey,
    voidedAt: row.voidedAt,
    voidedByUserId: row.voidedByUserId,
    voidReason: row.voidReason,
  });
}

function reduceFilteredOriginSubmission(
  row: Extract<ReportSourceRow, { kind: "lead_gen_submission" }>,
) {
  if (row.voidedAt !== null || !row.originRankable || !row.originValue) return [];
  let normalized: ReturnType<typeof normalizeLeadGenOrigin>;
  try {
    normalized = normalizeLeadGenOrigin({
      originKind: row.originKind as "post" | "reel",
      originUrlOrLabel: row.originValue,
    });
  } catch {
    return [];
  }
  if (!normalized.originKey || !normalized.originValue) return [];
  const dayKey = timestampToBusinessDateKey(row.submittedAt);
  const sections = [
    {
      section: "lead_gen_origin",
      rowKey: `${row.source}:${normalized.originKey}`,
    },
    {
      section: "lead_gen_team_origin",
      rowKey: `${row.teamId ?? "unassigned"}:${row.source}:${normalized.originKey}`,
    },
  ];
  return sections.flatMap(({ section, rowKey }): ReportContribution[] => [
    metric(section, rowKey, "submissions", "sum", 1),
    uniqueSum(
      section,
      rowKey,
      "uniqueProspects",
      1,
      `${row.prospectId}:${dayKey}`,
    ),
    uniqueSum(section, rowKey, "dayCount", 1, dayKey),
    set(section, rowKey, "originKey", normalized.originKey!),
    set(section, rowKey, "source", row.source),
    set(section, rowKey, "originKind", row.originKind),
    set(section, rowKey, "originValue", normalized.originValue!),
    ...(section === "lead_gen_team_origin"
      ? [set(section, rowKey, "teamId", row.teamId)]
      : []),
  ]);
}

function reduceQualificationEvent(
  row: Extract<ReportSourceRow, { kind: "qualification_event" }>,
) {
  return [
    metric("qualifications_summary", "main", "totalQualified", "sum", 1),
    metric("qualification_opener", row.slackUserId, "qualified", "sum", 1),
    metric(
      "qualification_opener",
      row.slackUserId,
      "lastEventAt",
      "max",
      row.submittedAt,
    ),
    set("qualification_opener", row.slackUserId, "slackUserId", row.slackUserId),
    ...fieldsToSetContributions("raw_qualification", row.eventId, {
      eventId: row.eventId,
      submittedAt: row.submittedAt,
      slackUserId: row.slackUserId,
      slackTeamId: row.slackTeamId,
      qualifierLabel: row.slackUserId,
      fullNameSnapshot: row.fullNameSnapshot,
      platform: row.platform,
      handleSnapshot: row.handleSnapshot,
      leadId: row.leadId,
      opportunityId: row.opportunityId,
      resultKind: row.resultKind,
    }),
  ];
}

function reduceBookedMeeting(
  row: Extract<ReportSourceRow, { kind: "booked_meeting" }>,
) {
  const teamKey = row.attributionTeamId ?? "unassigned";
  return [
    metric("booked_calls_summary", "main", "totalBooked", "sum", 1),
    metric("booked_closer", row.dmCloserId, "booked", "sum", 1),
    set("booked_closer", row.dmCloserId, "dmCloserId", row.dmCloserId),
    metric("booking_team", teamKey, "progress", "sum", 1),
    ...fieldsToSetContributions("raw_booking", row.meetingId, {
      meetingId: row.meetingId,
      opportunityId: row.opportunityId,
      leadId: row.leadId,
      bookedAt: row.bookedAt,
      scheduledAt: row.scheduledAt,
      meetingStatus: row.meetingStatus,
      opportunityStatus: row.opportunityStatus,
      bookingProgramId: row.bookingProgramId,
      bookingProgramName: row.bookingProgramName,
      leadLabel: row.leadLabel,
      leadHandle: row.leadHandle,
      initialSource: row.initialSource,
      selfReportedIncome: row.selfReportedIncome,
      attributionTeamId: row.attributionTeamId,
      attributionTeamLabel: row.attributionTeamLabel,
      dmCloserId: row.dmCloserId,
      dmCloserLabel: row.dmCloserLabel,
    }),
  ];
}

function addMeetingStatusMetrics(
  pageMetrics: Map<string, number>,
  section: string,
  rowKey: string,
  status: string,
  count: number,
) {
  addPageMetric(pageMetrics, section, rowKey, "booked", count);
  if (status === "completed") addPageMetric(pageMetrics, section, rowKey, "showed", count);
  if (status === "canceled") addPageMetric(pageMetrics, section, rowKey, "canceled", count);
  if (status === "no_show") addPageMetric(pageMetrics, section, rowKey, "noShows", count);
}

function reduceSalesMeetingStats(rows: ReportSourceRow[]) {
  const pageMetrics = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "sales_meeting_stat") continue;
    addMeetingStatusMetrics(
      pageMetrics,
      "sales_calls_summary",
      "main",
      row.meetingStatus,
      row.count,
    );
    addMeetingStatusMetrics(
      pageMetrics,
      "sales_closer",
      row.assignedCloserId,
      row.meetingStatus,
      row.count,
    );
    addMeetingStatusMetrics(
      pageMetrics,
      "sales_program",
      row.bookingProgramId ?? "none",
      row.meetingStatus,
      row.count,
    );
  }
  return flushPageMetrics(pageMetrics);
}

function reduceSalesPayment(row: Extract<ReportSourceRow, { kind: "sales_payment" }>) {
  const contributions: ReportContribution[] = [
    metric("sales_calls_summary", "main", "paymentSalesCount", "sum", 1),
    metric(
      "sales_calls_summary",
      "main",
      "cashCollectedMinor",
      "sum",
      row.amountMinor,
    ),
    metric("sales_program", row.programId, "paymentSales", "sum", 1),
    metric(
      "sales_program",
      row.programId,
      "paymentRevenueMinor",
      "sum",
      row.amountMinor,
    ),
    set("sales_program", row.programId, "programId", row.programId),
    set("sales_program", row.programId, "label", row.programName),
    metric("sales_reconciliation", row.currency, "paymentSales", "sum", 1),
    metric(
      "sales_reconciliation",
      row.currency,
      "paymentRevenueMinor",
      "sum",
      row.amountMinor,
    ),
    set("sales_reconciliation", row.currency, "currency", row.currency),
    ...fieldsToSetContributions("raw_payment", row.paymentId, {
      paymentId: row.paymentId,
      recordedAt: row.recordedAt,
      opportunityId: row.opportunityId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      paymentType: row.paymentType,
      programId: row.programId,
      programName: row.programName,
      attributedCloserId: row.effectiveCloserId,
    }),
  ];
  const attributionField = row.effectiveCloserId ? "attributed" : "unattributed";
  contributions.push(
    metric("sales_reconciliation", row.currency, `${attributionField}Sales`, "sum", 1),
    metric(
      "sales_reconciliation",
      row.currency,
      `${attributionField}RevenueMinor`,
      "sum",
      row.amountMinor,
    ),
  );
  if (row.effectiveCloserId) {
    contributions.push(
      metric("sales_closer", row.effectiveCloserId, "paymentSales", "sum", 1),
      metric(
        "sales_closer",
        row.effectiveCloserId,
        "paymentRevenueMinor",
        "sum",
        row.amountMinor,
      ),
      set("sales_closer", row.effectiveCloserId, "closerId", row.effectiveCloserId),
    );
  }
  return contributions;
}

export function reduceReportSourcePage(args: {
  sourceKey: string;
  range: NormalizedReportRange;
  rows: ReportSourceRow[];
}): ReportContribution[] {
  const counts = weekdayCounts(args.range);
  switch (args.sourceKey) {
    case "lead_gen_daily":
      return reduceLeadGenDaily(args.rows);
    case "lead_gen_origins":
      return reduceLeadGenOrigins(args.rows, false);
    case "lead_gen_team_origins":
      return reduceLeadGenOrigins(args.rows, true);
    case "lead_gen_filtered_origin_submissions":
      return args.rows.flatMap((row) =>
        row.kind === "lead_gen_submission"
          ? reduceFilteredOriginSubmission(row)
          : [],
      );
    case "sales_meeting_stats":
      return reduceSalesMeetingStats(args.rows);
  }

  const result: ReportContribution[] = [];
  for (const row of args.rows) {
    switch (row.kind) {
      case "lead_gen_submission":
        result.push(...reduceLeadGenSubmission(row));
        break;
      case "lead_gen_worker":
        result.push(
          ...fieldsToSetContributions("lead_gen_worker_dimension", row.workerId, {
            workerId: row.workerId,
            label: row.label,
            email: row.email,
            teamId: row.teamId,
            isActive: row.isActive,
          }),
        );
        break;
      case "lead_gen_source_dimension":
        result.push(
          set("lead_gen_source", row.source, "source", row.source),
          metric("lead_gen_source", row.source, "submissions", "sum", 0),
        );
        break;
      case "lead_gen_schedule": {
        const occurrenceCount = counts[row.weekday as Weekday] ?? 0;
        result.push(
          set("lead_gen_schedule", row.workerId, "workerId", row.workerId),
          metric(
            "lead_gen_schedule",
            row.workerId,
            "rangeScheduledHours",
            "sum",
            row.scheduledHours * occurrenceCount,
          ),
        );
        break;
      }
      case "team": {
        result.push(
          ...fieldsToSetContributions("team_dimension", row.teamId, {
            teamId: row.teamId,
            label: row.label,
            isActive: row.isActive,
          }),
          ...fieldsToSetContributions("booking_team", row.teamId, {
            teamId: row.teamId,
            label: row.label,
            isActive: row.isActive,
            dailyQuota: row.bookingDailyQuota,
            target:
              row.bookingDailyQuota === null
                ? null
                : row.bookingDailyQuota * args.range.dayCount,
          }),
        );
        break;
      }
      case "tenant":
        result.push(
          set(
            "qualifications_summary",
            "main",
            "dailyQuota",
            row.slackQualificationDailyTeamQuota,
          ),
          set(
            "qualifications_summary",
            "main",
            "target",
            row.slackQualificationDailyTeamQuota === null
              ? null
              : row.slackQualificationDailyTeamQuota * args.range.dayCount,
          ),
        );
        break;
      case "qualification_event":
        result.push(...reduceQualificationEvent(row));
        break;
      case "slack_user":
        result.push(
          set("slack_user_dimension", row.slackUserId, "slackUserId", row.slackUserId),
          set("slack_user_dimension", row.slackUserId, "label", row.label),
        );
        break;
      case "qualifier_schedule": {
        const occurrenceCount = counts[row.weekday as Weekday] ?? 0;
        result.push(
          set("qualification_opener", row.slackUserId, "slackUserId", row.slackUserId),
          set("qualification_opener", row.slackUserId, "hasSchedule", true),
          metric(
            "qualification_opener",
            row.slackUserId,
            "scheduledHours",
            "sum",
            row.scheduledHours * occurrenceCount,
          ),
        );
        break;
      }
      case "booked_meeting":
        result.push(...reduceBookedMeeting(row));
        break;
      case "dm_closer":
        result.push(
          ...fieldsToSetContributions("dm_closer_dimension", row.dmCloserId, {
            dmCloserId: row.dmCloserId,
            label: row.label,
            teamId: row.teamId,
            isActive: row.isActive,
            hourlyRateMinor: row.hourlyRateMinor,
          }),
        );
        break;
      case "dm_closer_schedule": {
        const occurrenceCount = counts[row.weekday as Weekday] ?? 0;
        result.push(
          set("booked_closer", row.dmCloserId, "dmCloserId", row.dmCloserId),
          set("booked_closer_schedule", row.dmCloserId, "dmCloserId", row.dmCloserId),
          metric(
            "booked_closer_schedule",
            row.dmCloserId,
            "scheduledHours",
            "sum",
            row.scheduledHours * occurrenceCount,
          ),
        );
        break;
      }
      case "sales_call":
        result.push(
          ...fieldsToSetContributions("raw_call", row.meetingId, {
            meetingId: row.meetingId,
            opportunityId: row.opportunityId,
            assignedCloserId: row.assignedCloserId,
            scheduledAt: row.scheduledAt,
            status: row.status,
            bookingProgramId: row.bookingProgramId,
            bookingProgramName: row.bookingProgramName,
            soldProgramId: row.soldProgramId,
            soldProgramName: row.soldProgramName,
            leadId: row.leadId,
            leadLabel: row.leadLabel,
          }),
        );
        break;
      case "sales_payment":
        result.push(...reduceSalesPayment(row));
        break;
      case "user":
        if (row.role === "closer") {
          result.push(
            ...fieldsToSetContributions("user_dimension", row.userId, {
              closerId: row.userId,
              label: row.label,
              isActive: row.isActive,
            }),
          );
          if (row.isActive) {
            result.push(
              set("sales_closer", row.userId, "closerId", row.userId),
              set("sales_closer", row.userId, "isActive", true),
            );
          }
        }
        break;
      case "program":
        result.push(
          set("program_dimension", row.programId, "programId", row.programId),
          set("program_dimension", row.programId, "label", row.label),
        );
        break;
      case "lead_gen_daily":
      case "lead_gen_origin":
      case "lead_gen_team_origin":
      case "sales_meeting_stat":
        break;
    }
  }
  return result;
}

function numberField(fields: ScalarRecord, key: string) {
  const value = fields[key];
  return typeof value === "number" ? value : 0;
}

function nullableRate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

export function finalizeAggregateRecord(args: {
  section: string;
  rowKey: string;
  fields: ScalarRecord;
  range: NormalizedReportRange;
  relatedFields?: ScalarRecord;
}): ReportResultWrite | null {
  const payload: ScalarRecord = { ...args.fields };
  switch (args.section) {
    case "lead_gen_summary":
    case "lead_gen_worker":
    case "lead_gen_team":
    case "lead_gen_source":
    case "lead_gen_team_worker":
    case "lead_gen_team_source": {
      const submissions = numberField(payload, "submissions");
      payload.submissions = submissions;
      payload.uniqueProspects = numberField(payload, "uniqueProspects");
      payload.duplicates = numberField(payload, "duplicates");
      const scheduledHours = numberField(payload, "scheduledHours");
      payload.scheduledHours = scheduledHours;
      payload.leadsPerHour = nullableRate(submissions, scheduledHours);
      break;
    }
    case "qualifications_summary":
      payload.progress = numberField(payload, "totalQualified");
      payload.businessDayCount = args.range.dayCount;
      payload.qualifiedAfter = args.range.startTimestamp;
      payload.qualifiedBefore = args.range.endTimestampExclusive;
      break;
    case "qualification_opener": {
      const qualified = numberField(payload, "qualified");
      const hasSchedule = payload.hasSchedule === true;
      const scheduledHours = hasSchedule ? numberField(payload, "scheduledHours") : null;
      payload.qualified = qualified;
      payload.scheduledHours = scheduledHours;
      payload.qualifiedPerHour =
        scheduledHours !== null ? nullableRate(qualified, scheduledHours) : null;
      payload.lastEventAt = typeof payload.lastEventAt === "number" ? payload.lastEventAt : null;
      break;
    }
    case "booked_calls_summary":
      payload.progress = numberField(payload, "totalBooked");
      payload.businessDayCount = args.range.dayCount;
      payload.start = args.range.startTimestamp;
      payload.end = args.range.endTimestampExclusive;
      if (payload.totalTarget === undefined) payload.totalTarget = null;
      break;
    case "booked_closer": {
      const booked = numberField(payload, "booked");
      const scheduledHours = numberField(args.relatedFields ?? {}, "scheduledHours");
      if (booked === 0 && scheduledHours === 0) return null;
      payload.booked = booked;
      payload.scheduledHours = scheduledHours > 0 ? scheduledHours : null;
      payload.bookedPerHour = nullableRate(booked, scheduledHours);
      break;
    }
    case "booking_team": {
      const progress = numberField(payload, "progress");
      if (payload.isActive !== true && progress === 0) return null;
      payload.progress = progress;
      break;
    }
    case "sales_calls_summary": {
      const booked = numberField(payload, "booked");
      const canceled = numberField(payload, "canceled");
      const showed = numberField(payload, "showed");
      const paymentSales = numberField(payload, "paymentSalesCount");
      const revenue = numberField(payload, "cashCollectedMinor");
      payload.totalCalls = booked;
      payload.showUpRate = nullableRate(showed, booked - canceled);
      payload.closeRate = nullableRate(paymentSales, showed);
      payload.avgCashPerSaleMinor = nullableRate(revenue, paymentSales);
      payload.start = args.range.startTimestamp;
      payload.end = args.range.endTimestampExclusive;
      break;
    }
    case "sales_closer": {
      const booked = numberField(payload, "booked");
      const canceled = numberField(payload, "canceled");
      const showed = numberField(payload, "showed");
      const paymentSales = numberField(payload, "paymentSales");
      const revenue = numberField(payload, "paymentRevenueMinor");
      payload.booked = booked;
      payload.canceled = canceled;
      payload.noShows = numberField(payload, "noShows");
      payload.showed = showed;
      payload.paymentSales = paymentSales;
      payload.paymentRevenueMinor = revenue;
      payload.showUpRate = nullableRate(showed, booked - canceled);
      payload.paymentCloseRate = nullableRate(paymentSales, showed);
      payload.avgPaymentDealMinor = nullableRate(revenue, paymentSales);
      break;
    }
    case "sales_program": {
      const booked = numberField(payload, "booked");
      payload.booked = booked;
      payload.calls = booked;
      payload.showed = numberField(payload, "showed");
      payload.canceled = numberField(payload, "canceled");
      payload.noShows = numberField(payload, "noShows");
      payload.paymentSales = numberField(payload, "paymentSales");
      payload.paymentRevenueMinor = numberField(payload, "paymentRevenueMinor");
      break;
    }
    case "sales_reconciliation":
      payload.paymentSales = numberField(payload, "paymentSales");
      payload.paymentRevenueMinor = numberField(payload, "paymentRevenueMinor");
      payload.attributedSales = numberField(payload, "attributedSales");
      payload.attributedRevenueMinor = numberField(payload, "attributedRevenueMinor");
      payload.unattributedSales = numberField(payload, "unattributedSales");
      payload.unattributedRevenueMinor = numberField(
        payload,
        "unattributedRevenueMinor",
      );
      break;
  }
  if (args.section === "lead_gen_summary") {
    payload.startDayKey = args.range.startDayKey;
    payload.endDayKey = args.range.endBusinessDateInclusive;
    payload.start = args.range.startTimestamp;
    payload.end = args.range.endTimestampExclusive;
  }
  const sortValue =
    (args.section === "lead_gen_origin" ||
      args.section === "lead_gen_team_origin") &&
    typeof payload.uniqueProspects === "number"
      ? payload.uniqueProspects
      : typeof payload.submissions === "number"
      ? payload.submissions
      : typeof payload.qualified === "number"
        ? payload.qualified
        : typeof payload.booked === "number"
          ? payload.booked
          : typeof payload.paymentRevenueMinor === "number"
            ? payload.paymentRevenueMinor
            : undefined;
  return {
    section: args.section,
    rowKey: args.rowKey,
    payload,
    ...(sortValue === undefined ? {} : { sortValue }),
  };
}

export function businessDayKeyForRawSubmission(submittedAt: number) {
  return timestampToBusinessDateKey(submittedAt);
}
