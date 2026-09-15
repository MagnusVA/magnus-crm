import type { NormalizedReportRange, ScalarRecord } from "./contracts";
import { finalizeAggregateRecord } from "./reducers";

export const summaryDefaults: Record<string, ScalarRecord> = {
  lead_gen_summary: {
    submissions: 0,
    uniqueProspects: 0,
    duplicates: 0,
    scheduledHours: 0,
    workersActive: 0,
  },
  qualifications_summary: { totalQualified: 0, dailyQuota: null, target: null },
  booked_calls_summary: { totalBooked: 0, totalTarget: null },
  sales_calls_summary: { booked: 0, showed: 0, canceled: 0, noShows: 0 },
};

export async function finalizeReportRow(
  section: string,
  row: { rowKey: string; fields: ScalarRecord },
  range: NormalizedReportRange,
  lookup: (section: string, rowKey: unknown) => Promise<ScalarRecord>,
) {
  const dimensionSections: Record<string, string> = {
    lead_gen_worker: "lead_gen_worker_dimension",
    lead_gen_team: "team_dimension",
    qualification_opener: "slack_user_dimension",
    booked_closer: "dm_closer_dimension",
    booking_team: "team_dimension",
    sales_closer: "user_dimension",
    sales_program: "program_dimension",
  };
  const dimension = dimensionSections[section]
    ? await lookup(dimensionSections[section], row.rowKey)
    : {};
  const fields =
    section === "lead_gen_worker"
      ? { ...(summaryDefaults[section] ?? {}), ...row.fields, ...dimension }
      : { ...(summaryDefaults[section] ?? {}), ...dimension, ...row.fields };
  let relatedFields: ScalarRecord | undefined;
  if (section === "qualification_opener") {
    fields.label ??= fields.slackUserId ?? "Unknown qualifier";
    fields.slackUsername ??= null;
  }
  if (section === "booked_closer") {
    fields.label ??= fields.dmCloserId ?? "Unknown closer";
    fields.hourlyRateMinor ??= null;
    relatedFields = await lookup("booked_closer_schedule", row.rowKey);
    const team = await lookup("team_dimension", fields.teamId);
    fields.teamLabel = team.label ?? "Unassigned";
  }
  if (section === "booking_team") {
    // The live dashboard only includes teams present in the current registry.
    // Unattributed bookings and bookings attributed to deleted teams still
    // contribute to the global total, but do not create goal-team rows.
    if (typeof fields.teamId !== "string") return null;
  }
  if (section === "sales_summary_money") {
    relatedFields = await lookup("sales_calls_summary", "main");
  }
  if (section === "sales_closer_money") {
    const closerId = fields.closerId;
    const closer = await lookup("user_dimension", closerId);
    Object.assign(fields, closer, row.fields);
    relatedFields = await lookup("sales_closer", closerId);
  }
  if (section === "sales_program_money") {
    const programId = fields.programId;
    const program = await lookup("program_dimension", programId);
    Object.assign(fields, program, row.fields);
    relatedFields = await lookup("sales_program", programId);
  }
  if (
    [
      "lead_gen_worker",
      "lead_gen_team_worker",
      "lead_gen_team_source",
      "lead_gen_team_origin",
      "lead_gen_daily_summary",
      "raw_submission",
    ].includes(section)
  ) {
    const team = await lookup("team_dimension", fields.teamId);
    fields.teamLabel = team.label ?? "No Team";
  }
  if (
    section === "raw_submission" ||
    section === "lead_gen_daily_summary" ||
    section === "lead_gen_team_worker"
  ) {
    const worker = await lookup("lead_gen_worker_dimension", fields.workerId);
    fields.workerLabel =
      worker.label ?? fields.workerId ?? "Unknown specialist";
    fields.workerEmail = worker.email ?? "";
    fields.isActive = worker.isActive ?? false;
  }
  if (section === "raw_qualification") {
    const qualifier = await lookup("slack_user_dimension", fields.slackUserId);
    fields.qualifierLabel =
      qualifier.label ?? fields.slackUserId ?? "Unknown qualifier";
  }
  if (section === "lead_gen_source") fields.source = row.rowKey;
  const result = finalizeAggregateRecord({
    section,
    rowKey: row.rowKey,
    fields,
    range,
    ...(relatedFields ? { relatedFields } : {}),
  });
  if (!result) return null;
  if (
    [
      "lead_gen_team_worker",
      "lead_gen_team_source",
      "lead_gen_team_origin",
    ].includes(section)
  )
    result.groupKey = String(fields.teamId ?? "unassigned");
  if (section === "sales_closer_money")
    result.groupKey = String(fields.closerId ?? "unknown");
  if (section === "sales_program_money")
    result.groupKey = String(fields.programId ?? "none");
  return result;
}
