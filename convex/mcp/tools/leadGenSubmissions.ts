import { v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction, internalQuery } from "../../_generated/server";
import { addBusinessDays, businessDayStart } from "../../../lib/businessDay";
import { mcpCaptureFlag, mcpCaptureFlagValidator } from "../../leadGen/captureFlags";
import { listRawSubmissionExportPageCore } from "../../leadGen/exports";
import {
  decodeLeadGenCursor,
  encodeLeadGenCursor,
  trimLeadGenText,
} from "../../leadGen/floor";
import {
  leadGenOriginKindValidator,
  leadGenSourceValidator,
} from "../../leadGen/validators";
import { rejectRequest } from "../../lib/observability/errors";
import {
  mcpCallerValidator,
  requireMcpAdmin,
} from "../guard";
import {
  leadGenRangeArgs,
  resolveLeadGenRange,
  type LeadGenActionCaller,
  leadGenActionCallerValidator,
  leadGenActionCaller,
} from "../leadGenShared";
import { formatLocal } from "../time";

export const submissionsArgs = {
  ...leadGenRangeArgs,
  workerId: v.optional(v.id("leadGenWorkers")),
  teamId: v.optional(v.id("attributionTeams")),
  source: v.optional(leadGenSourceValidator),
  cursor: v.optional(v.string()),
};

const suppliedText = v.object({
  text: v.string(),
  personSupplied: v.literal(true),
});
const submissionValidator = v.object({
  flag: v.optional(mcpCaptureFlagValidator),
  submissionId: v.id("leadGenSubmissions"),
  handle: v.union(suppliedText, v.null()),
  workerId: v.id("leadGenWorkers"),
  worker: v.union(v.string(), v.null()),
  teamId: v.union(v.id("attributionTeams"), v.null()),
  team: v.union(v.string(), v.null()),
  source: leadGenSourceValidator,
  origin: v.object({
    kind: leadGenOriginKindValidator,
    value: v.union(suppliedText, v.null()),
  }),
  submittedAt: v.string(),
  voidedAt: v.union(v.string(), v.null()),
  voidedByUserId: v.union(v.id("users"), v.null()),
  voidReason: v.union(suppliedText, v.null()),
  textTruncated: v.boolean(),
});
type Submission = Infer<typeof submissionValidator>;
const pageValidator = v.object({
  rows: v.array(submissionValidator),
  isDone: v.boolean(),
  cursor: v.string(),
});
type SubmissionPage = Infer<typeof pageValidator>;

/** The action checks admin reading before work and before returning its result. */
export const authorize = internalQuery({
  args: { caller: mcpCallerValidator },
  returns: leadGenActionCallerValidator,
  handler: async (ctx, { caller }): Promise<LeadGenActionCaller> => {
    const me = await requireMcpAdmin(ctx, caller, { permission: "lead-gen:view-all" });
    return leadGenActionCaller(ctx, me);
  },
});

/** Separate transactions are required for successive native export pages. */
export const readPage = internalQuery({
  args: {
    caller: mcpCallerValidator,
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    workerId: v.optional(v.id("leadGenWorkers")),
    teamId: v.optional(v.id("attributionTeams")),
    source: v.optional(leadGenSourceValidator),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  returns: pageValidator,
  handler: async (
    ctx,
    { caller, cursor, numItems, ...args },
  ): Promise<SubmissionPage> => {
    const me = await requireMcpAdmin(ctx, caller, { permission: "lead-gen:view-all" });
    // Refuse foreign filter IDs explicitly, including a filter on an empty range.
    if (args.workerId) {
      const worker = await ctx.db.get("leadGenWorkers", args.workerId);
      if (!worker || worker.tenantId !== me.tenantId) {
        throw rejectRequest(
          "lead_gen.worker_not_found",
          "That specialist isn't in this workspace.",
        );
      }
    }
    if (args.teamId) {
      const team = await ctx.db.get("attributionTeams", args.teamId);
      if (!team || team.tenantId !== me.tenantId) {
        throw rejectRequest(
          "lead_gen.team_not_found",
          "That team isn't in this workspace.",
        );
      }
    }
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 2) {
      throw rejectRequest(
        "lead_gen.invalid_page_size",
        "Read one or two raw rows per query.",
      );
    }
    const page = await listRawSubmissionExportPageCore(ctx, {
      tenantId: me.tenantId,
      ...args,
      descending: true,
      paginationOpts: { cursor, numItems },
    });
    const rows: Submission[] = [];
    for (const row of page.page) {
      // A shared text budget keeps even multilingual rows inside 64 KiB per result.
      let remaining = 1500;
      let textTruncated = false;
      const text = (value: string | null) => {
        if (value === null) return null;
        const trimmed = trimLeadGenText(value, Math.min(500, remaining));
        remaining -=
          new TextEncoder().encode(JSON.stringify(trimmed)).length - 2;
        textTruncated ||= trimmed !== value;
        return trimmed;
      };
      const supplied = (value: string | null) => {
        const safe = text(value);
        return safe === null
          ? null
          : { text: safe, personSupplied: true as const };
      };
      const submission = await ctx.db.get(
        "leadGenSubmissions",
        row.submissionId,
      );
      const flag = row.flag ? mcpCaptureFlag(row.flag, me.timeZone) : null;
      if (flag) {
        // The added reason shares the existing per-row text budget.
        text(flag.reason.text);
        textTruncated ||= flag.reason.truncated;
      }
      rows.push({
        ...(flag && { flag }),
        submissionId: row.submissionId,
        handle: supplied(row.normalizedHandle),
        workerId: row.workerId,
        worker: text(row.workerDisplayName),
        teamId: row.teamId,
        team: text(row.teamName),
        source: row.source,
        origin: { kind: row.originKind, value: supplied(row.originValue) },
        submittedAt: formatLocal(row.submittedAt, me.timeZone),
        voidedAt:
          row.voidedAt === null ? null : formatLocal(row.voidedAt, me.timeZone),
        voidedByUserId:
          submission?.tenantId === me.tenantId
            ? (submission.voidedByUserId ?? null)
            : null,
        voidReason: supplied(row.voidReason),
        textTruncated,
      });
    }
    return { rows, isDone: page.isDone, cursor: page.continueCursor };
  },
});

// At most 64 native pages (128 scanned submissions plus bounded joins), and
// one wall-clock deadline for the whole action, including empty filtered pages.
const MAX_PAGE_READS = 64;
const MAX_READ_MS = 2500;

export const list = internalAction({
  args: { caller: mcpCallerValidator, ...submissionsArgs },
  returns: v.object({
    rows: v.array(submissionValidator),
    timeZone: v.string(),
    asOf: v.string(),
    range: v.object({ startDayKey: v.string(), endDayKey: v.string() }),
    isPartial: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    { caller, cursor, workerId, teamId, source, ...rangeArgs },
  ) => {
    const startedAt = Date.now();
    const authorized: LeadGenActionCaller = await ctx.runQuery(
      internal.mcp.tools.leadGenSubmissions.authorize,
      { caller },
    );
    const range = resolveLeadGenRange(rangeArgs, authorized.todayDayKey, {
      maxDays: 120,
    });
    const startTimestamp = businessDayStart(
      range.startDayKey,
      authorized.businessDay,
    );
    const endTimestamp =
      businessDayStart(
        addBusinessDays(range.endDayKey, 1),
        authorized.businessDay,
      ) - 1;
    const scope = JSON.stringify([
      "submissions",
      authorized.tenantId,
      startTimestamp,
      endTimestamp,
      workerId ?? null,
      teamId ?? null,
      source ?? null,
    ]);
    let nextCursor = decodeLeadGenCursor(cursor, scope);
    const rows: Submission[] = [];
    let isDone = false;
    for (let reads = 0; reads < MAX_PAGE_READS && rows.length < 25; reads++) {
      // Always execute one guarded page so foreign filters cannot evade validation.
      if (reads > 0 && Date.now() - startedAt >= MAX_READ_MS) break;
      const page: SubmissionPage = await ctx.runQuery(
        internal.mcp.tools.leadGenSubmissions.readPage,
        {
          caller,
          startTimestamp,
          endTimestamp,
          workerId,
          teamId,
          source,
          cursor: nextCursor,
          numItems: Math.min(2, 25 - rows.length),
        },
      );
      rows.push(...page.rows);
      nextCursor = page.cursor;
      isDone = page.isDone;
      if (isDone) break;
    }
    // A revoked user receives no accumulated result, even after the final page.
    const finalAccess: LeadGenActionCaller = await ctx.runQuery(
      internal.mcp.tools.leadGenSubmissions.authorize,
      { caller },
    );
    if (
      finalAccess.tenantId !== authorized.tenantId ||
      finalAccess.timeZone !== authorized.timeZone ||
      JSON.stringify(finalAccess.businessDay) !==
        JSON.stringify(authorized.businessDay)
    ) {
      throw rejectRequest(
        "lead_gen.context_changed",
        "Your workspace or time zone changed. Run the tool again.",
      );
    }
    return {
      rows,
      timeZone: authorized.timeZone,
      asOf: formatLocal(startedAt, authorized.timeZone),
      range: { startDayKey: range.startDayKey, endDayKey: range.endDayKey },
      isPartial: !isDone,
      cursor: isDone ? null : encodeLeadGenCursor(scope, nextCursor!),
    };
  },
});
