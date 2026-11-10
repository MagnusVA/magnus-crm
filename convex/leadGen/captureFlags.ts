import { maskContactText } from "../lib/respark/people";
import { paginationOptsValidator } from "convex/server";
import { getConvexSize, v, type Value } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { LIVE_QUERY_BYTE_BUDGET } from "../lib/liveQueryBounds";
import type { Provenance } from "../mcp/guard";
import { formatLocal } from "../mcp/time";
import { trimLeadGenText } from "./floor";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";

export const flagStateValidator = v.union(
  v.literal("open"),
  v.literal("voided"),
  v.literal("dismissed"),
);
export const captureFlagValidator = v.object({
  flagId: v.id("leadGenCaptureFlags"),
  state: flagStateValidator,
  reason: v.string(),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
});
export type CaptureFlag = {
  flagId: Id<"leadGenCaptureFlags">;
  state: Doc<"leadGenCaptureFlags">["state"];
  reason: string;
  createdAt: number;
  resolvedAt?: number;
};
const suppliedText = v.object({
  text: v.string(),
  personSupplied: v.literal(true),
  truncated: v.boolean(),
});
export const mcpCaptureFlagValidator = v.object({
  flagId: v.id("leadGenCaptureFlags"),
  state: flagStateValidator,
  reason: suppliedText,
  createdAt: v.string(),
  resolvedAt: v.optional(v.string()),
});
export function mcpCaptureFlag(flag: CaptureFlag, timeZone: string) {
  // A lead gen's own words, but they come back through an AI provider: a
  // phone or an email typed into the reason is masked. Admins read it whole.
  const reason = trimLeadGenText(maskContactText(flag.reason, []));
  return {
    flagId: flag.flagId,
    state: flag.state,
    reason: {
      text: reason,
      personSupplied: true as const,
      truncated: reason !== flag.reason,
    },
    createdAt: formatLocal(flag.createdAt, timeZone),
    ...(flag.resolvedAt !== undefined && {
      resolvedAt: formatLocal(flag.resolvedAt, timeZone),
    }),
  };
}
export function captureFlag(row: Doc<"leadGenCaptureFlags">): CaptureFlag {
  return {
    flagId: row._id,
    state: row.state,
    reason: row.reason,
    createdAt: row.createdAt,
    ...(row.resolvedAt !== undefined && { resolvedAt: row.resolvedAt }),
  };
}
export function findCaptureFlag(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  submissionId: Id<"leadGenSubmissions">,
) {
  return ctx.db
    .query("leadGenCaptureFlags")
    .withIndex("by_tenantId_and_submissionId", (q) =>
      q.eq("tenantId", tenantId).eq("submissionId", submissionId),
    )
    .unique();
}
function noteText(text: string, label: string) {
  const value = text.trim();
  if (value.length < 3 || value.length > 500)
    throw new Error(`${label} must be 3 to 500 characters.`);
  return value;
}

export async function flagCaptureCore(
  ctx: MutationCtx,
  me: TenantUserResult,
  args: { submissionId: Id<"leadGenSubmissions">; reason: string },
  provenance: Provenance = { via: "web" },
) {
  if (me.role !== "lead_generator")
    throw new Error("Only a lead generator can flag their own capture.");
  const worker = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) =>
      q.eq("tenantId", me.tenantId).eq("userId", me.userId),
    )
    .unique();
  if (!worker?.isActive) throw new Error("Your lead gen access isn't active.");
  const submission = await ctx.db.get("leadGenSubmissions", args.submissionId);
  if (
    !submission ||
    submission.tenantId !== me.tenantId ||
    submission.workerId !== worker._id
  ) {
    throw new Error("You can only flag your own captures.");
  }
  const existing = await findCaptureFlag(ctx, me.tenantId, submission._id);
  if (existing) return { flag: captureFlag(existing), alreadyFlagged: true };
  if (submission.voidedAt !== undefined)
    throw new Error("This capture is already voided.");
  const reason = noteText(args.reason, "Reason");
  const now = Date.now();
  const flagId = await ctx.db.insert("leadGenCaptureFlags", {
    tenantId: me.tenantId,
    submissionId: submission._id,
    workerId: worker._id,
    createdByUserId: me.userId,
    reason,
    createdAt: now,
    state: "open",
  });
  await flagEvent(
    ctx,
    me,
    submission,
    "lead.capture_flagged",
    provenance,
    flagId,
  );
  return {
    flag: { flagId, state: "open" as const, reason, createdAt: now },
    alreadyFlagged: false,
  };
}

async function flagEvent(
  ctx: MutationCtx,
  me: { tenantId: Id<"tenants">; userId: Id<"users"> },
  submission: Doc<"leadGenSubmissions">,
  eventType: string,
  provenance: Provenance,
  flagId: Id<"leadGenCaptureFlags">,
) {
  const prospect = await ctx.db.get("leadGenProspects", submission.prospectId);
  const lead =
    prospect?.tenantId === me.tenantId && prospect.leadId
      ? await ctx.db.get("leads", prospect.leadId)
      : null;
  if (lead?.tenantId !== me.tenantId) return;
  await emitDomainEvent(ctx, {
    tenantId: me.tenantId,
    entityType: "lead",
    entityId: lead._id,
    leadId: lead._id,
    eventType,
    source: eventType === "lead.capture_flagged" ? "pipeline" : "admin",
    actorUserId: me.userId,
    metadata: { submissionId: submission._id, flagId, ...provenance },
  });
}

/** First terminal state wins, including an already-voided capture repair. */
export async function closeCaptureFlagAsVoided(
  ctx: MutationCtx,
  me: { tenantId: Id<"tenants">; userId: Id<"users"> },
  submissionId: Id<"leadGenSubmissions">,
) {
  const flag = await findCaptureFlag(ctx, me.tenantId, submissionId);
  if (flag?.state === "open")
    await ctx.db.patch("leadGenCaptureFlags", flag._id, {
      state: "voided",
      resolvedAt: Date.now(),
      resolvedByUserId: me.userId,
    });
}

export async function dismissCaptureFlagCore(
  ctx: MutationCtx,
  me: TenantUserResult,
  args: { flagId: Id<"leadGenCaptureFlags">; note: string },
) {
  if (me.role !== "tenant_admin" && me.role !== "tenant_master")
    throw new Error("Only an admin can dismiss a flag.");
  const flag = await ctx.db.get("leadGenCaptureFlags", args.flagId);
  if (!flag || flag.tenantId !== me.tenantId)
    throw new Error("Flag not found.");
  if (flag.state !== "open") return captureFlag(flag);
  const note = noteText(args.note, "Note");
  const submission = await ctx.db.get("leadGenSubmissions", flag.submissionId);
  if (!submission || submission.tenantId !== me.tenantId)
    throw new Error("Capture not found.");
  const resolvedAt = Date.now();
  await ctx.db.patch("leadGenCaptureFlags", flag._id, {
    state: "dismissed",
    resolvedAt,
    resolvedByUserId: me.userId,
    resolutionNote: note,
  });
  await flagEvent(
    ctx,
    me,
    submission,
    "lead.capture_flag_dismissed",
    { via: "web" },
    flag._id,
  );
  return { ...captureFlag(flag), state: "dismissed" as const, resolvedAt };
}

export const flagCapture = mutation({
  args: { submissionId: v.id("leadGenSubmissions"), reason: v.string() },
  returns: v.object({
    flag: captureFlagValidator,
    alreadyFlagged: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["lead_generator"]);
    return flagCaptureCore(ctx, me, args);
  },
});
export const dismiss = mutation({
  args: { flagId: v.id("leadGenCaptureFlags"), note: v.string() },
  returns: captureFlagValidator,
  handler: async (ctx, args) => {
    const me = await requireTenantUser(ctx, ["tenant_admin", "tenant_master"]);
    return dismissCaptureFlagCore(ctx, me, args);
  },
});
export const listOpen = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        ...captureFlagValidator.fields,
        submissionId: v.id("leadGenSubmissions"),
        handle: v.union(v.string(), v.null()),
        worker: v.union(v.string(), v.null()),
        voided: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const me = await requireTenantUser(ctx, ["tenant_admin", "tenant_master"]);
    const page = await ctx.db
      .query("leadGenCaptureFlags")
      .withIndex("by_tenantId_and_state_and_createdAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("state", "open"),
      )
      .order("asc")
      .paginate({
        ...paginationOpts,
        numItems: Math.min(25, Math.max(1, paginationOpts.numItems)),
        maximumRowsRead: 25,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });
    let bytesRead = 0;
    const charge = (document: unknown) => {
      if (document === null) return;
      bytesRead += getConvexSize(document as Value);
      if (bytesRead > LIVE_QUERY_BYTE_BUDGET) {
        // Refuse the whole page so its cursor cannot skip a flag we omitted.
        throw new Error(
          "These flagged captures are too large to load together. Try a smaller page.",
        );
      }
    };
    for (const flag of page.page) charge(flag);
    const rows = [];
    for (const flag of page.page) {
      const submission = await ctx.db.get(
        "leadGenSubmissions",
        flag.submissionId,
      );
      charge(submission);
      const valid = submission?.tenantId === me.tenantId ? submission : null;
      const prospect = valid
        ? await ctx.db.get("leadGenProspects", valid.prospectId)
        : null;
      charge(prospect);
      const worker = valid
        ? await ctx.db.get("leadGenWorkers", valid.workerId)
        : null;
      charge(worker);
      rows.push({
        ...captureFlag(flag),
        submissionId: flag.submissionId,
        handle:
          prospect?.tenantId === me.tenantId ? prospect.normalizedHandle : null,
        worker:
          worker?.tenantId === me.tenantId
            ? (worker.displayName ?? worker.email)
            : null,
        voided: valid?.voidedAt !== undefined,
      });
    }
    return { ...page, page: rows };
  },
});
