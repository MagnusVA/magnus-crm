import type { TestConvex } from "convex-test";
import type { FunctionReference } from "convex/server";
import { expect } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import type schema from "../convex/schema";
import type { ResolvedAnalyticsRange } from "../lib/analyticsRange";

/** Fields each view leaves out (clickhouse/migrations/0002_views.sql). */
const VIEW_OMITTED_FIELDS: Partial<Record<TableNames, readonly string[]>> = {
  meetings: ["notes"],
  paymentRecords: ["note"],
  opportunities: ["notes", "hostCalendlyEmail", "manualCreationKey"],
  leadGenSubmissions: ["clientSubmissionKey"],
  leadGenProspects: ["dedupeKey", "normalizedHandle", "rawHandle", "profileUrl"],
  slackQualificationEvents: ["handleSnapshot"],
  operationsQualificationRows: ["searchText"],
  followUps: ["reminderNote", "completionNote", "schedulingLinkUrl"],
  leads: ["email", "phone", "socialHandles", "searchText", "customFields", "customFieldLabels"],
  users: ["email", "workosUserId", "workosInvitationId", "calendlyUserUri", "customProfilePictureStorageId", "profilePictureUrl"],
  leadGenWorkers: ["email", "workosUserId", "profilePictureUrl", "customProfilePictureStorageId"],
  slackUsers: ["avatarUrl"],
};

function snake(name: string) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The status a meeting's projection bucket holds, as `contributionStatusSql`
 * computes it: a canceled meeting another meeting replaced is `moved`.
 */
export function projectedMeetingStatus(
  meeting: { _id: string; status: string },
  meetings: ReadonlyArray<{ rescheduledFromMeetingId?: string }>,
): string {
  return meeting.status === "canceled" && meetings.some((other) => other.rescheduledFromMeetingId === meeting._id)
    ? "moved"
    : meeting.status;
}

/**
 * The row an `analytics.*` view returns for a Convex document: the inverse of
 * `docFromRow` (convex/analytics/rows.ts), without the fields the table's
 * view leaves out. Number fields ending in `At`, and `heldUntil`, become
 * `*_ms` columns, as in clickhouse/migrations/0002_views.sql.
 */
export function rowFromDoc(table: TableNames, doc: Record<string, unknown>): Record<string, unknown> {
  const omitted = VIEW_OMITTED_FIELDS[table] ?? [];
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined || omitted.includes(key)) continue;
    if (key === "_id") row.id = value;
    else if (key === "_creationTime") row.creation_time_ms = value;
    else if (value !== null && typeof value === "object") row[`${snake(key)}_json`] = JSON.stringify(value);
    else if (typeof value === "number" && (key.endsWith("At") || key === "heldUntil")) row[`${snake(key)}_ms`] = value;
    else row[snake(key)] = value;
  }
  return row;
}

/** Apply the SQL's named queries and projections before exercising a finalizer. */
export function projectWarehouseRows(
  rows: Record<string, Array<Record<string, unknown>>>,
  columns: Record<string, readonly string[] | null>,
): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(Object.entries(columns).map(([name, selected]) => [name,
    (rows[name] ?? []).map(row => selected === null ? row : Object.fromEntries(
      selected.filter(column => column in row).map(column => [column, row[column]]),
    )),
  ]));
}

/** A projection fixture must exercise each selected field, including optional fields. */
export function expectProjectionValues(
  rows: Record<string, Array<Record<string, unknown>>>,
  columns: Record<string, readonly string[] | null>,
) {
  for (const [name, selected] of Object.entries(columns)) {
    for (const column of selected ?? []) expect(
      (rows[name] ?? []).some(row => row[column] !== undefined && row[column] !== null && row[column] !== "" && row[column] !== 0),
      `${name}.${column} needs a non-default fixture value`,
    ).toBe(true);
  }
}

/**
 * Asserts a report's ClickHouse path answers exactly what its Convex reader
 * answers for the same documents. `rows` are what the report's SQL would
 * return (build them with `rowFromDoc`); the test proves the shared builder
 * and the row mapping agree, and the production parity run
 * (`pnpm analytics:parity`) proves the SQL selects the same rows.
 */
export async function expectSameAnswer(args: {
  t: TestConvex<typeof schema>;
  identity: { subject: string; org_id: string };
  tenantId: Id<"tenants">;
  reportId: string;
  live: FunctionReference<"query">;
  liveArgs: Record<string, unknown>;
  filters: Record<string, unknown>;
  range: ResolvedAnalyticsRange;
  rows: Record<string, Array<Record<string, unknown>>>;
}) {
  const live = await args.t.withIdentity(args.identity).query(args.live, args.liveArgs);
  const payloadJson = await args.t.query(internal.analytics.results.previewFinalize, {
    reportId: args.reportId,
    tenantId: args.tenantId,
    filtersJson: JSON.stringify(args.filters),
    range: args.range,
    rowsJson: JSON.stringify(args.rows),
  });
  expect(JSON.parse(payloadJson)).toEqual(JSON.parse(JSON.stringify(live)));
  return live;
}
