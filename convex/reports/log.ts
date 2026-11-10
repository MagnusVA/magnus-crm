import {
  paginationOptsValidator,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import schema from "../schema";
import { getEventLabel } from "../reporting/lib/eventLabels";
import {
  assertValidDateRange,
  getUserDisplayName,
} from "../reporting/lib/helpers";
import { requireTenantUser } from "../requireTenantUser";
import {
  MEMBER_REPORT_ROLES,
  REPORT_ADMIN_ROLES,
  resolveMemberFilter,
} from "./lib/access";

const entityType = v.union(
  v.literal("customer"),
  v.literal("enrollment"),
  v.literal("followUp"),
  v.literal("lead"),
  v.literal("meeting"),
  v.literal("opportunity"),
  v.literal("payment"),
  v.literal("user"),
  v.literal("slackInstallation"),
);
const logArgs = {
  startDate: v.number(),
  endDate: v.number(),
  actorUserId: v.optional(v.id("users")),
  teamMemberId: v.optional(v.id("teamMembers")),
  entityType: v.optional(entityType),
  paginationOpts: paginationOptsValidator,
};
export type LogEntry = Omit<Doc<"domainEvents">, "metadata"> & {
  metadata: Record<string, unknown> | null;
  actorName: string | null;
  label: string;
  iconHint: string;
};
export type ReportLog = PaginationResult<LogEntry>;
type LogArgs = {
  startDate: number;
  endDate: number;
  actorUserId?: Id<"users">;
  teamMemberId?: Id<"teamMembers">;
  entityType?: Doc<"domainEvents">["entityType"];
  paginationOpts: PaginationOptions;
};

/** Trusted callers must validate member/actor filters and authorize the tenant. */
export async function readLog(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  args: LogArgs,
): Promise<ReportLog> {
  assertValidDateRange(args.startDate, args.endDate);
  const database = stream(ctx.db, schema);
  // Both indexes include the tenant and occurrence time. Member logs use the
  // existing member index instead of scanning the tenant's entire timeline.
  const source = args.actorUserId
    ? database
        .query("domainEvents")
        .withIndex("by_tenantId_and_actorUserId_and_occurredAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("actorUserId", args.actorUserId!)
            .gte("occurredAt", args.startDate)
            .lt("occurredAt", args.endDate),
        )
    : args.teamMemberId
      ? database
          .query("domainEvents")
          .withIndex("by_tenantId_and_teamMemberId_and_occurredAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("teamMemberId", args.teamMemberId!)
              .gte("occurredAt", args.startDate)
              .lt("occurredAt", args.endDate),
          )
      : database
          .query("domainEvents")
          .withIndex("by_tenantId_and_occurredAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .gte("occurredAt", args.startDate)
              .lt("occurredAt", args.endDate),
          );
  const filtered = source
    .order("desc")
    .filterWith(
      async (event) =>
        (!args.entityType || event.entityType === args.entityType) &&
        (!args.actorUserId || event.actorUserId === args.actorUserId) &&
        (!args.teamMemberId ||
          event.teamMemberId === args.teamMemberId ||
          (event.teamMemberId === undefined && args.actorUserId !== undefined)),
    );
  // A member with a login: their own actions (above), plus events tagged
  // with the member that someone else or the system recorded, such as a
  // Slack qualification or a portal note. Merged by time, without the
  // login's events twice.
  const merged =
    args.actorUserId && args.teamMemberId
      ? mergedStream(
          [
            filtered,
            database
              .query("domainEvents")
              .withIndex("by_tenantId_and_teamMemberId_and_occurredAt", (q) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("teamMemberId", args.teamMemberId!)
                  .gte("occurredAt", args.startDate)
                  .lt("occurredAt", args.endDate),
              )
              .order("desc")
              .filterWith(
                async (event) =>
                  event.actorUserId !== args.actorUserId &&
                  (!args.entityType || event.entityType === args.entityType),
              ),
          ],
          ["occurredAt", "_creationTime"],
        )
      : filtered;
  const page = await merged
    .paginate({
      ...args.paginationOpts,
      numItems: Math.min(100, Math.max(1, args.paginationOpts.numItems)),
      maximumRowsRead: 500,
    });
  const actors = new Map<Id<"users">, string | null>();
  for (const id of new Set(
    page.page.flatMap((e) => (e.actorUserId ? [e.actorUserId] : [])),
  )) {
    const actor = await ctx.db.get("users", id);
    actors.set(
      id,
      actor?.tenantId === tenantId ? getUserDisplayName(actor) : null,
    );
  }
  return {
    ...page,
    page: page.page.map((event) => {
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(event.metadata ?? "null");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          metadata = parsed as Record<string, unknown>;
      } catch {
        /* Old events can carry invalid metadata. */
      }
      const label = getEventLabel(event.eventType);
      return {
        ...event,
        metadata,
        actorName: event.actorUserId
          ? (actors.get(event.actorUserId) ?? null)
          : null,
        label: label.verb,
        iconHint: label.iconHint,
      };
    }),
  };
}
const logResultValidator = v.object({
  page: v.array(
    v.object({
      ...schema.tables.domainEvents.validator.fields,
      _id: v.id("domainEvents"),
      _creationTime: v.number(),
      metadata: v.union(v.record(v.string(), v.any()), v.null()),
      actorName: v.union(v.string(), v.null()),
      label: v.string(),
      iconHint: v.string(),
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
});
export const listLog = query({
  returns: logResultValidator,
  args: logArgs,
  handler: async (ctx, args): Promise<ReportLog> => {
    const viewer = await requireTenantUser(ctx, [...REPORT_ADMIN_ROLES]);
    await resolveMemberFilter(ctx, args.teamMemberId, viewer);
    if (args.actorUserId && args.teamMemberId) {
      const actor = await ctx.db.get("users", args.actorUserId);
      if (
        actor?.tenantId !== viewer.tenantId ||
        actor.teamMemberId !== args.teamMemberId
      )
        throw new Error("Actor and member filters must name the same member.");
    }
    return await readLog(ctx, viewer.tenantId, args);
  },
});
export const listMemberLog = query({
  returns: logResultValidator,
  args: logArgs,
  handler: async (ctx, args): Promise<ReportLog> => {
    const viewer = await requireTenantUser(ctx, [...MEMBER_REPORT_ROLES]);
    const teamMemberId = await resolveMemberFilter(
      ctx,
      args.teamMemberId,
      viewer,
    );
    if (args.actorUserId && teamMemberId) {
      const actor = await ctx.db.get("users", args.actorUserId);
      if (
        actor?.tenantId !== viewer.tenantId ||
        actor.teamMemberId !== teamMemberId
      )
        throw new Error("You can only open this member's work log.");
    }
    return await readLog(ctx, viewer.tenantId, {
      ...args,
      ...(teamMemberId ? { teamMemberId } : {}),
    });
  },
});
