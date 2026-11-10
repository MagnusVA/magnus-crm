import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { lookupHandle, mergeLookups, stageLabel, verdictLine, type HandleLookup } from "../../leadGen/handleLookup";
import { captureFlag, findCaptureFlag, mcpCaptureFlag, mcpCaptureFlagValidator } from "../../leadGen/captureFlags";
import { trimLeadGenText } from "../../leadGen/floor";
import { visibleContactAgain } from "../../lib/contactAgain";
import { leadGenOriginKindValidator, leadGenSourceValidator } from "../../leadGen/validators";
import { rejectRequest } from "../../lib/observability/errors";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpAdmin, requireMcpUser, type McpUser, withMcpCursorErrors } from "../guard";
import { formatLocal } from "../time";

/**
 * `magnus_check_handles`: a read-only check of up to 10 handles
 * (docs/plans/lead-gen-assistant.md §2, row 2). Lead gens and admins share
 * it. A lead gen learns whether a capture was theirs or a teammate's and
 * nothing else about who; an admin gets the captures themselves.
 */
export const MAX_HANDLES = 10;
const CAPTURES_PER_HANDLE = 5;
const CAPTURES_PER_PAGE = 25;
const MAX_TEXT = 500;

export const checkHandlesArgs = {
  handles: v.array(v.string()),
  cursor: v.optional(v.string()),
};

const verdictValidator = v.union(
  v.literal("new"),
  v.literal("known"),
  v.literal("captured_before"),
  v.literal("not_a_fit"),
  v.literal("do_not_contact"),
  v.literal("conflict"),
  v.literal("invalid"),
);

const captureValidator = v.object({
  flag: v.optional(mcpCaptureFlagValidator),
  submissionId: v.id("leadGenSubmissions"),
  specialist: v.string(),
  team: v.union(v.string(), v.null()),
  capturedAt: v.string(),
  source: leadGenSourceValidator,
  originKind: leadGenOriginKindValidator,
  origin: v.union(v.string(), v.null()),
  voided: v.boolean(),
  voidedAt: v.optional(v.string()),
  voidReason: v.optional(v.string()),
  truncated: v.optional(v.boolean()),
});

const resultValidator = v.object({
  contactAgain: v.optional(v.object({ date: v.string(), note: v.optional(v.object({ text: v.string(), personSupplied: v.literal(true), truncated: v.boolean() })) })),
  input: v.string(),
  inputs: v.array(v.string()),
  handle: v.union(v.string(), v.null()),
  verdict: verdictValidator,
  summary: v.string(),
  stage: v.union(v.string(), v.null()),
  disposition: v.union(v.string(), v.null()),
  // Lead gens only.
  capturedBy: v.optional(v.union(v.literal("you"), v.literal("a teammate"), v.literal("you and a teammate"), v.null())),
  // Admins only.
  captures: v.optional(v.array(captureValidator)),
  moreCaptures: v.optional(v.boolean()),
});

function trim(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT ? { text: `${text.slice(0, MAX_TEXT)}…`, truncated: true } : { text, truncated: false };
}

async function capturedBy(
  ctx: QueryCtx,
  me: McpUser,
  myWorkerId: Id<"leadGenWorkers"> | null,
  prospect: Doc<"leadGenProspects"> | null,
) {
  if (!prospect || prospect.contactAttemptCount === 0) return null;
  const mine = myWorkerId
    ? await ctx.db
        .query("leadGenSubmissions")
        .withIndex("by_tenantId_and_prospectId_and_workerId", (q) =>
          q.eq("tenantId", me.tenantId).eq("prospectId", prospect._id).eq("workerId", myWorkerId),
        )
        .first()
    : null;
  if (!mine) return "a teammate" as const;
  return prospect.distinctWorkerCount > 1 ? ("you and a teammate" as const) : ("you" as const);
}

function captureRows(ctx: QueryCtx, me: McpUser) {
  const workers = new Map<Id<"leadGenWorkers">, string>();
  const teams = new Map<Id<"attributionTeams">, string | null>();
  return async (submission: Doc<"leadGenSubmissions">) => {
    let specialist = workers.get(submission.workerId);
    if (specialist === undefined) {
      const worker = await ctx.db.get("leadGenWorkers", submission.workerId);
      specialist = worker?.displayName ?? worker?.email ?? "Unknown";
      workers.set(submission.workerId, specialist);
    }
    let team: string | null = null;
    if (submission.teamId) {
      const cached = teams.get(submission.teamId);
      team = cached !== undefined ? cached : ((await ctx.db.get("attributionTeams", submission.teamId))?.displayName ?? null);
      teams.set(submission.teamId, team);
    }
    const origin = submission.originValue ? trim(submission.originValue) : null;
    const reason = submission.voidReason ? trim(submission.voidReason) : null;
    const flag = await findCaptureFlag(ctx, me.tenantId, submission._id);
    return {
      ...(flag && { flag: mcpCaptureFlag(captureFlag(flag), me.timeZone) }),
      submissionId: submission._id,
      specialist,
      team,
      capturedAt: formatLocal(submission.submittedAt, me.timeZone),
      source: submission.source,
      originKind: submission.originKind,
      origin: origin?.text ?? null,
      voided: submission.voidedAt !== undefined,
      ...(submission.voidedAt !== undefined && { voidedAt: formatLocal(submission.voidedAt, me.timeZone) }),
      ...(reason && { voidReason: reason.text }),
      ...((origin?.truncated || reason?.truncated) && { truncated: true }),
    };
  };
}

export const check = internalQuery({
  args: { caller: mcpCallerValidator, ...checkHandlesArgs },
  returns: v.object({
    results: v.array(resultValidator),
    saved: v.literal(false),
    note: v.string(),
    // Admins, one handle: the next page of its captures.
    capturesCursor: v.optional(v.union(v.string(), v.null())),
  }),
  handler: async (ctx, { caller, handles, cursor }) => {
    const user = await requireMcpUser(ctx, caller, [...LEAD_GEN_ROLES, "tenant_master", "tenant_admin"]);
    const me = user.role === "lead_generator"
      ? user
      : await requireMcpAdmin(ctx, caller, { permission: "lead-gen:view-all" });
    const isAdmin = me.role !== "lead_generator";
    if (handles.length < 1 || handles.length > MAX_HANDLES) {
      throw rejectRequest("handles.count", `Pass 1 to ${MAX_HANDLES} handles in one call.`);
    }
    if (cursor !== undefined && (!isAdmin || handles.length !== 1)) {
      throw rejectRequest("handles.cursor", "cursor continues one handle's captures. Pass that handle alone.");
    }

    const lookups: HandleLookup[] = [];
    for (const input of handles) lookups.push(await lookupHandle(ctx, me.tenantId, input));
    const merged = mergeLookups(lookups);

    const myWorker = isAdmin
      ? null
      : await ctx.db
          .query("leadGenWorkers")
          .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", me.tenantId).eq("userId", me.userId))
          .unique();
    const toRow = captureRows(ctx, me);
    const single = isAdmin && handles.length === 1;
    let capturesCursor: string | null | undefined;

    const results = [];
    for (const lookup of merged) {
      if (!lookup.valid) {
        results.push({
          input: lookup.input,
          inputs: [lookup.input],
          handle: null,
          verdict: "invalid" as const,
          summary: lookup.reason,
          stage: null,
          disposition: null,
        });
        continue;
      }
      const contact = lookup.lead ? visibleContactAgain(lookup.lead) : null;
      const row = {
        inputs: lookups.filter((candidate) => candidate.valid && candidate.dedupeKey === lookup.dedupeKey).map((candidate) => candidate.input),
        ...(contact && { contactAgain: { date: contact.date,
          ...(isAdmin && { note: { text: trimLeadGenText(contact.note), personSupplied: true as const, truncated: trimLeadGenText(contact.note) !== contact.note } }) } }),
        input: lookup.input,
        handle: lookup.handle,
        verdict: lookup.verdict,
        summary: verdictLine(lookup),
        stage: lookup.lead ? stageLabel(lookup.lead.lifecycleStage) : null,
        disposition: lookup.lead?.disposition ?? null,
      };
      if (!isAdmin) {
        results.push({ ...row, capturedBy: await capturedBy(ctx, me, myWorker?._id ?? null, lookup.prospect) });
        continue;
      }
      const prospect = lookup.prospect;
      if (!prospect) {
        results.push({ ...row, captures: [], moreCaptures: false });
        if (single) capturesCursor = null;
        continue;
      }
      const newestFirst = ctx.db
        .query("leadGenSubmissions")
        .withIndex("by_tenantId_and_prospectId_and_submittedAt", (q) =>
          q.eq("tenantId", me.tenantId).eq("prospectId", prospect._id),
        )
        .order("desc");
      if (single) {
        // One native paginated read a query: only the one-handle call pages.
        const page = await withMcpCursorErrors("handles.invalid_cursor", () => newestFirst.paginate({ numItems: CAPTURES_PER_PAGE, cursor: cursor ?? null }));
        capturesCursor = page.isDone ? null : page.continueCursor;
        results.push({
          ...row,
          captures: await Promise.all(page.page.map(toRow)),
          moreCaptures: !page.isDone,
        });
        continue;
      }
      const newest = await newestFirst.take(CAPTURES_PER_HANDLE + 1);
      results.push({
        ...row,
        captures: await Promise.all(newest.slice(0, CAPTURES_PER_HANDLE).map(toRow)),
        moreCaptures: newest.length > CAPTURES_PER_HANDLE,
      });
    }

    return {
      results,
      saved: false as const,
      note: "Nothing was saved or counted.",
      ...(single && { capturesCursor: capturesCursor ?? null }),
    };
  },
});
