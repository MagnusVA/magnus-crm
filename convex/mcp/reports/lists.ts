import { v, type Infer } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { canonicalJson } from "../../analytics/keys";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { expectedError, rejectRequest } from "../../lib/observability/errors";
import { readOpenDeals, readOwedCalls } from "../../reports/pipeline";
import { readLog, type LogEntry } from "../../reports/log";
import { readDealChain, readDealNames } from "../../reports/attribution";
import { readMemberProfile } from "../../reports/member";
import { readFieldCatalog } from "../../reports/formFields";
import { resolveMemberFilter } from "../../reports/lib/access";
import { creditIdentityValidator, currencyAmountsValidator } from "../../reports/lib/creditFacts";
import { pipelineNextStep } from "../../reports/lib/pipelineNextStep";
import { openStageValidator } from "../../reports/lib/validators";
import { dealAttributionRoleValidator } from "../../lib/attribution/validators";
import { loadInTenant, mcpCallerValidator, requireMcpAdmin, normalizeMcpId } from "../guard";
import { limitOf, paths, text, textValidator, type Admin } from "../admin/reads/common";
import { appLink } from "../admin/prepare";
import { rangeValidator } from "./contracts";
import { planAssistantSources } from "../../../lib/assistantReportPlan";
import { resolveLeadGenRange } from "../leadGenShared";
import { businessDateForInstant } from "../../../lib/businessDay";
import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";

const listValidator = v.union(
  v.literal("pipeline_open_deals"), v.literal("pipeline_owed_calls"),
  v.literal("log"), v.literal("member_log"), v.literal("deal_credits"), v.literal("report_fields"),
);
const entityTypeValidator = v.union(
  v.literal("customer"), v.literal("enrollment"), v.literal("followUp"),
  v.literal("lead"), v.literal("meeting"), v.literal("opportunity"),
  v.literal("payment"), v.literal("user"), v.literal("slackInstallation"),
);
export const reportListArgs = {
  list: listValidator,
  range: v.optional(rangeValidator),
  teamMemberId: v.optional(v.string()),
  actorUserId: v.optional(v.string()),
  entityType: v.optional(entityTypeValidator),
  memberId: v.optional(v.string()),
  opportunityId: v.optional(v.string()),
  limit: v.optional(v.number()),
  cursor: v.optional(v.string()),
};
type Args = Omit<Infer<typeof _reportListArgsValidator>, "teamMemberId" | "actorUserId" | "memberId" | "opportunityId"> & {
  teamMemberId?: Id<"teamMembers">; actorUserId?: Id<"users">; memberId?: Id<"teamMembers">; opportunityId?: Id<"opportunities">;
};
const _reportListArgsValidator = v.object(reportListArgs);
const nullableNumber = v.union(v.number(), v.null());
const nullableText = v.union(textValidator, v.null());
const linkFields = { openInMagnus: v.string() };
const identityValidator = v.object({
  ...creditIdentityValidator.fields,
  name: textValidator,
  ...linkFields,
});
const rowValidator = v.union(
  v.object({
    kind: v.literal("deal"), opportunityId: v.id("opportunities"), stage: openStageValidator,
    createdAt: v.number(), leadName: textValidator, closerName: nullableText,
    nextMeetingAt: nullableNumber, task: v.union(v.object({ at: nullableNumber }), v.null()),
    ageDays: v.number(), nextStep: v.union(v.object({ kind: v.union(v.literal("call"), v.literal("task")), at: nullableNumber }), v.null()), ...linkFields,
  }),
  v.object({
    kind: v.literal("owed_call"), meetingId: v.id("meetings"), opportunityId: v.id("opportunities"),
    scheduledAt: v.number(), endsAt: v.number(), closerId: v.id("users"), closerName: textValidator,
    leadName: textValidator, ageDays: v.number(), ...linkFields,
  }),
  v.object({
    kind: v.literal("event"), _id: v.id("domainEvents"), occurredAt: v.number(),
    entityType: entityTypeValidator, entityId: v.string(), actorUserId: v.union(v.id("users"), v.null()),
    teamMemberId: v.union(v.id("teamMembers"), v.null()), actorName: nullableText,
    eventType: textValidator, label: textValidator, source: v.string(),
    fromStatus: nullableText, toStatus: nullableText, personOpenInMagnus: v.union(v.string(), v.null()), ...linkFields,
  }),
  v.object({
    kind: v.literal("credit"), id: v.id("dealAttributions"), role: dealAttributionRoleValidator,
    ...identityValidator.fields, sourceKind: textValidator, attributedAt: v.number(),
    meetingId: v.union(v.id("meetings"), v.null()), creditedFor: currencyAmountsValidator,
    meetingOpenInMagnus: v.union(v.string(), v.null()),
  }),
  v.object({
    kind: v.literal("meeting"), id: v.id("meetings"), scheduledAt: v.number(), status: v.string(),
    closer: identityValidator, moved: v.boolean(), rebooked: v.boolean(),
    replacesMeetingId: v.union(v.id("meetings"), v.null()), replacesOpenInMagnus: v.union(v.string(), v.null()), ...linkFields,
  }),
  v.object({
    kind: v.literal("payment"), id: v.id("paymentRecords"), amountMinor: v.number(), currency: v.string(),
    type: v.string(), status: v.string(), closer: v.union(identityValidator, v.null()), recordedAt: v.number(), ...linkFields,
  }),
  v.object({
    kind: v.literal("field"), id: v.id("eventTypeFieldCatalog"), fieldKey: v.string(), currentLabel: textValidator,
    eventTypeConfigId: v.id("eventTypeConfigs"), eventTypeName: nullableText, firstSeenAt: v.number(),
    lastSeenAt: v.number(), valueType: nullableText, ...linkFields,
  }),
);
const answerValidator = v.object({
  list: listValidator, rows: v.array(rowValidator), isPartial: v.boolean(),
  cursor: v.union(v.string(), v.null()), reasons: v.array(v.string()),
  asOf: v.number(), endedBy: v.optional(v.number()),
  window: v.optional(v.object({ startDate: v.number(), endDate: v.number() })),
  sourceIsPartial: v.boolean(), openInMagnus: v.string(),
  deal: v.optional(v.object({ opportunityId: v.id("opportunities"), stage: v.string(), outcome: v.string(), personName: textValidator, ...linkFields })),
  dealNames: v.optional(v.array(v.object({ opportunityId: v.id("opportunities"), name: textValidator, ...linkFields }))),
});
type Answer = Infer<typeof answerValidator>;
type Row = Infer<typeof rowValidator>;

// The raw page cursor stays bound to its tenant, list and filters. asOf freezes
// both the owed-call cutoff and relative-date log windows across continuations.
type Cursor = { version: 1; tenantId: string; key: string; asOf: number; position: string | number };
function invalidCursor(): never {
  throw rejectRequest("mcp.invalid_cursor", "That cursor does not match this list or its filters. Use the returned cursor with the same list and filters, or start again without it.");
}
function decodeCursor(raw: string | undefined, tenantId: Id<"tenants">, key: string): Cursor {
  if (raw === undefined) return { version: 1, tenantId, key, asOf: Date.now(), position: 0 };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidCursor();
    const c = value as Cursor;
    if (Object.keys(c).sort().join(",") !== "asOf,key,position,tenantId,version" ||
      c.version !== 1 || c.tenantId !== tenantId || c.key !== key || !Number.isFinite(c.asOf) ||
      !(typeof c.position === "string" && c.position.length > 0 || typeof c.position === "number" && Number.isSafeInteger(c.position) && c.position >= 0)) invalidCursor();
    return c;
  } catch { return invalidCursor(); }
}
function continuation(cursor: Cursor, position: string | number, isDone: boolean) {
  return isDone ? null : JSON.stringify({ ...cursor, position });
}
function memberLink(id: string) { return appLink(`/workspace/reports/people/${id}`); }

/** Only the columns visible in Log, never its free-form metadata or notes. */
function logRow(entry: LogEntry, fallback: string): Row {
  const by = entry.source === "closer" ? "closer" : entry.source === "admin" ? "admin" : "integration";
  // Legacy events may have non-record strings in entityId. Only IDs enter links.
  const safeId = /^[a-zA-Z0-9]+$/.test(entry.entityId) && entry.entityId.length <= 64;
  const recordLink = safeId ? entry.entityType === "meeting" ? paths.meeting(entry.entityId)
    : entry.entityType === "opportunity" ? paths.deal(entry.entityId)
    : entry.entityType === "lead" ? paths.person(entry.entityId)
    : null : null;
  return {
    kind: "event", _id: entry._id, occurredAt: entry.occurredAt, entityType: entry.entityType,
    entityId: safeId ? entry.entityId : "", actorUserId: entry.actorUserId ?? null,
    teamMemberId: entry.teamMemberId ?? null, actorName: entry.actorName === null ? null : text(entry.actorName, "person", 120),
    eventType: text(entry.eventType, by, 120), label: text(entry.label, by, 240), source: entry.source,
    fromStatus: entry.fromStatus ? text(entry.fromStatus, by, 120) : null,
    toStatus: entry.toStatus ? text(entry.toStatus, by, 120) : null,
    openInMagnus: recordLink ?? fallback,
    personOpenInMagnus: entry.leadId && entry.entityType !== "lead" ? paths.person(entry.leadId) : null,
  };
}
async function memberFilters(ctx: QueryCtx, me: Admin, args: Args) {
  const memberId = args.list === "member_log" ? args.memberId : args.teamMemberId;
  if (args.list === "member_log" && !memberId) throw rejectRequest("mcp.invalid_argument", "memberId is required for member_log.");
  if (memberId) await loadInTenant(ctx, me, "teamMembers", memberId);
  await resolveMemberFilter(ctx, memberId, me);
  let actorUserId = args.actorUserId;
  if (actorUserId) {
    const actor = await loadInTenant(ctx, me, "users", actorUserId);
    if (memberId && actor.teamMemberId !== memberId) throw rejectRequest("mcp.invalid_filter", "actorUserId and the member filter must name the same team member.");
  } else if (args.list === "member_log") {
    // The member page supplies the linked login as well as the member. This
    // includes older login-only events and member-tagged system actions.
    const profile = await readMemberProfile(ctx, me.tenantId, memberId!);
    actorUserId = profile?.userId ?? undefined;
  }
  return { teamMemberId: memberId, actorUserId };
}

export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...reportListArgs }, returns: answerValidator,
  handler: async (ctx, { caller, ...raw }): Promise<Answer> => {
    const me = await requireMcpAdmin(ctx, caller, { permission: "reports:view" });
    const args: Args = { ...raw,
      teamMemberId: raw.teamMemberId === undefined ? undefined : normalizeMcpId(ctx, "teamMembers", raw.teamMemberId, "teamMemberId"),
      actorUserId: raw.actorUserId === undefined ? undefined : normalizeMcpId(ctx, "users", raw.actorUserId, "actorUserId"),
      memberId: raw.memberId === undefined ? undefined : normalizeMcpId(ctx, "teamMembers", raw.memberId, "memberId"),
      opportunityId: raw.opportunityId === undefined ? undefined : normalizeMcpId(ctx, "opportunities", raw.opportunityId, "opportunityId"),
    };
    const limit = limitOf(args.limit);
    const isLog = args.list === "log" || args.list === "member_log";
    if (args.memberId && args.list !== "member_log" || args.opportunityId && args.list !== "deal_credits" ||
      (args.teamMemberId || args.actorUserId || args.entityType || args.range) && !isLog ||
      args.teamMemberId && args.list === "member_log") {
      throw expectedError("mcp.invalid_filter", "Use range, teamMemberId, actorUserId and entityType with log; memberId with member_log; opportunityId with deal_credits.");
    }
    const { limit: _limit, cursor: _cursor, ...filters } = args;
    void _limit; void _cursor;
    const key = canonicalJson(filters);
    const cursor = decodeCursor(args.cursor, me.tenantId, key);
    const paged = isLog || args.list === "pipeline_open_deals" || args.list === "pipeline_owed_calls";
    if (args.cursor && (paged ? typeof cursor.position !== "string" : typeof cursor.position !== "number")) invalidCursor();
    const path = args.list === "report_fields" ? "/workspace/reports/scorecard"
      : args.list === "deal_credits" ? "/workspace/reports/attribution"
      : args.list === "member_log" ? `/workspace/reports/people/${args.memberId}`
      : isLog ? "/workspace/reports/log" : "/workspace/reports/pipeline";
    const openInMagnus = appLink(path);
    const base: Omit<Answer, "rows" | "isPartial" | "cursor" | "reasons"> = {
      list: args.list, asOf: cursor.asOf, sourceIsPartial: false, openInMagnus,
    };
    let logArgs;
    if (isLog) {
      const members = await memberFilters(ctx, me, args);
      const day = await getTenantBusinessDay(ctx, me.tenantId);
      const range = args.range ?? { kind: "preset", preset: "today" };
      if (range.kind === "custom") resolveLeadGenRange({ startDate: range.startDate, endDate: range.endDateInclusive }, businessDateForInstant(Date.now(), day), { maxDays: 36600 });
      const { resolvedRange: resolved } = planAssistantSources({
        range, day, now: cursor.asOf, page: "log", warehousePages: [],
      });
      base.window = { startDate: resolved.fromMs, endDate: resolved.toMs };
      logArgs = { ...base.window, ...members, entityType: args.entityType };
    }
    let allRows: Row[] = [];
    if (args.list === "deal_credits") {
      if (!args.opportunityId) throw rejectRequest("mcp.invalid_argument", "opportunityId is required for deal_credits.");
      await loadInTenant(ctx, me, "opportunities", args.opportunityId);
      const chain = await readDealChain(ctx, me.tenantId, args.opportunityId);
      const names = await readDealNames(ctx, me.tenantId, [args.opportunityId]);
      base.deal = { opportunityId: chain.opportunityId, stage: chain.stage, outcome: chain.outcome,
        personName: text(chain.personName, "person", 120), openInMagnus: paths.deal(chain.opportunityId) };
      base.dealNames = names.map(row => ({ ...row, name: text(row.name, "person", 120), openInMagnus: paths.deal(row.opportunityId) }));
      base.sourceIsPartial = chain.isTruncated;
      const identity = (person: Infer<typeof creditIdentityValidator>) => ({ ...person, name: text(person.name, "person", 120),
        openInMagnus: person.teamMemberId ? memberLink(person.teamMemberId) : openInMagnus });
      allRows = [
        ...chain.credits.map(row => ({ ...row, ...identity(row), kind: "credit" as const, sourceKind: text(row.sourceKind, "integration", 120),
          meetingOpenInMagnus: row.meetingId ? paths.meeting(row.meetingId) : null })),
        ...chain.meetings.map(row => ({ ...row, kind: "meeting" as const, closer: identity(row.closer), openInMagnus: paths.meeting(row.id),
          replacesOpenInMagnus: row.replacesMeetingId ? paths.meeting(row.replacesMeetingId) : null })),
        ...chain.payments.map(row => ({ ...row, kind: "payment" as const, closer: row.closer ? identity(row.closer) : null, openInMagnus: paths.payment(row.id) })),
      ];
    } else if (args.list === "report_fields") {
      allRows = (await readFieldCatalog(ctx, me.tenantId)).map(row => ({ ...row, kind: "field", currentLabel: text(row.currentLabel, "integration", 240),
        eventTypeName: row.eventTypeName === null ? null : text(row.eventTypeName, "integration", 120),
        valueType: row.valueType === null ? null : text(row.valueType, "integration", 120), openInMagnus }));
    }
    // If the gateway envelope is too large, re-read a shorter source page.
    // Never slice a paginated result and advance past rows we did not return.
    for (let count = limit; ; count = Math.max(1, Math.floor(count / 2))) {
      let rows: Row[], next: string | null;
      let scanLimited = false;
      const paginationOpts = { numItems: count, cursor: typeof cursor.position === "string" ? cursor.position : null };
      if (paged) {
        try {
          if (args.list === "pipeline_open_deals") {
            const page = await readOpenDeals(ctx, me.tenantId, { paginationOpts });
            rows = page.page.map(row => ({ ...row, kind: "deal", leadName: text(row.leadName, "person", 120),
              closerName: row.closerName === null ? null : text(row.closerName, "person", 120),
              ageDays: Math.max(0, (cursor.asOf - row.createdAt) / 86_400_000), nextStep: pipelineNextStep(row, cursor.asOf), openInMagnus: paths.deal(row.opportunityId) }));
            next = continuation(cursor, page.continueCursor, page.isDone);
          } else if (args.list === "pipeline_owed_calls") {
            base.endedBy = cursor.asOf;
            const page = await readOwedCalls(ctx, me.tenantId, { paginationOpts, endedBy: cursor.asOf });
            rows = page.page.map(row => ({ ...row, kind: "owed_call", closerName: text(row.closerName, "person", 120), leadName: text(row.leadName, "person", 120),
              ageDays: Math.max(0, (cursor.asOf - row.endsAt) / 86_400_000), openInMagnus: paths.meeting(row.meetingId) }));
            next = continuation(cursor, page.continueCursor, page.isDone);
          } else {
            const page = await readLog(ctx, me.tenantId, { ...logArgs!, paginationOpts });
            scanLimited = page.pageStatus === "SplitRequired";
            rows = page.page.map(row => logRow(row, openInMagnus));
            next = continuation(cursor, page.continueCursor, page.isDone);
          }
        } catch (error) {
          // Invalid raw Convex cursors must not disclose platform details.
          if (args.cursor && error instanceof Error && /cursor|JSON/i.test(error.message)) invalidCursor();
          throw error;
        }
      } else {
        const offset = typeof cursor.position === "number" ? cursor.position : 0;
        if (offset > allRows.length) invalidCursor();
        rows = allRows.slice(offset, offset + count);
        next = continuation(cursor, offset + rows.length, offset + rows.length >= allRows.length);
      }
      const reasons = [...(base.sourceIsPartial ? ["source_read_limit"] : []), ...(next ? [scanLimited || rows.length === 0 ? "scan_limit" : "more_rows"] : [])];
      const answer = { ...base, rows, cursor: next, isPartial: base.sourceIsPartial || next !== null, reasons };
      if (gatewayAnswerBytes(answer) <= MAX_ASSISTANT_ANSWER_BYTES) return answer;
      if (count === 1) throw expectedError("mcp.answer_size_limit", "This row exceeds the answer limit. Open the report in Magnus.");
    }
  },
});
