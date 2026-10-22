import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { LIVE_QUERY_BYTE_BUDGET } from "../lib/liveQueryBounds";
import {
  slackMemberIdentity,
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import { dealPositionValidator } from "../opportunities/dealLabelValidators";
import {
  dealPosition,
  isAllowedStageOutcome,
  stageOfPosition,
  type DealPosition,
} from "../opportunities/stages";
import { requireTenantUser } from "../requireTenantUser";
import { loadQualificationRowCredits } from "./qualificationCredit";

type QualificationRowDoc = Doc<"operationsQualificationRows">;

type QualificationFilterArgs = {
  tenantId: Id<"tenants">;
  // The deal's position, through the row's copied stage and outcome
  // (docs/plans/phase-5-deal-status.md §6.6).
  positionFilter?: DealPosition;
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  slackUserId?: string;
  qualifiedAfter?: number;
  qualifiedBefore?: number;
};

function assertSinglePrimaryFilter(args: QualificationFilterArgs) {
  const primaryFilterCount = [
    args.positionFilter,
    args.bookingProgramId,
    args.soldProgramId,
    args.slackUserId,
  ].filter(Boolean).length;

  if (primaryFilterCount > 1) {
    throw new Error("Select only one primary qualification filter at a time.");
  }
}

function qualificationRowsQuery(ctx: QueryCtx, args: QualificationFilterArgs) {
  assertSinglePrimaryFilter(args);

  if (args.positionFilter) {
    const { stage, outcome } = stageOfPosition(args.positionFilter);
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_dealStage_and_dealOutcome_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("dealStage", stage)
          .eq("dealOutcome", outcome);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore === undefined
          ? ranged
          : ranged.lt("qualifiedAt", args.qualifiedBefore);
      });
  }

  if (args.bookingProgramId) {
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_bookingProgramId_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("bookingProgramId", args.bookingProgramId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore === undefined
          ? ranged
          : ranged.lt("qualifiedAt", args.qualifiedBefore);
      });
  }

  if (args.soldProgramId) {
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_soldProgramId_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("soldProgramId", args.soldProgramId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore === undefined
          ? ranged
          : ranged.lt("qualifiedAt", args.qualifiedBefore);
      });
  }

  if (args.slackUserId) {
    const slackUserId = args.slackUserId;
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_slackUserId_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("slackUserId", slackUserId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore === undefined
          ? ranged
          : ranged.lt("qualifiedAt", args.qualifiedBefore);
      });
  }

  return ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_tenantId_and_qualifiedAt", (q) => {
      const base = q.eq("tenantId", args.tenantId);
      const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
      return args.qualifiedBefore === undefined
        ? ranged
        : ranged.lt("qualifiedAt", args.qualifiedBefore);
    });
}

/** The position of the deal the row copied, or null when it copied none. */
function rowPosition(row: QualificationRowDoc): DealPosition | null {
  const { dealStage, dealOutcome } = row;
  return dealStage !== undefined &&
    dealOutcome !== undefined &&
    isAllowedStageOutcome(dealStage, dealOutcome)
    ? dealPosition(dealStage, dealOutcome)
    : null;
}

function slackUserLabel(user: Doc<"slackUsers"> | null | undefined) {
  return (
    user?.displayName?.trim() ||
    user?.realName?.trim() ||
    user?.username?.trim() ||
    user?.slackUserId
  );
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

async function enrichQualificationRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: QualificationRowDoc[],
) {
  const eventIds = [...new Set(rows.map((row) => row.qualificationEventId))];
  const leadIds = [
    ...new Set(rows.map((row) => row.leadId).filter((id): id is Id<"leads"> => Boolean(id))),
  ];
  const userIds = [
    ...new Set(
      rows
        .map((row) => row.assignedCloserId)
        .filter((id): id is Id<"users"> => Boolean(id)),
    ),
  ];
  const slackUserIds = [...new Set(rows.map((row) => row.slackUserId))];

  const [events, leads, users, slackUsers, creditFor] = await Promise.all([
    Promise.all(eventIds.map((id) => ctx.db.get("slackQualificationEvents", id))),
    Promise.all(leadIds.map((id) => ctx.db.get("leads", id))),
    Promise.all(userIds.map((id) => ctx.db.get("users", id))),
    Promise.all(
      slackUserIds.map((slackUserId) =>
        ctx.db
          .query("slackUsers")
          .withIndex("by_tenantId_and_slackUserId", (q) =>
            q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
          )
          .unique(),
      ),
    ),
    loadQualificationRowCredits(ctx, tenantId, rows),
  ]);

  const eventById = new Map(events.filter(isNonNull).map((event) => [event._id, event]));
  const leadById = new Map(leads.filter(isNonNull).map((lead) => [lead._id, lead]));
  const userById = new Map(users.filter(isNonNull).map((user) => [user._id, user]));
  const slackUserBySlackId = new Map(
    slackUsers
      .filter(isNonNull)
      .map((user) => [user.slackUserId, user]),
  );

  return await Promise.all(rows.map(async (row) => {
    const event = eventById.get(row.qualificationEventId);
    const lead = row.leadId ? leadById.get(row.leadId) : undefined;
    const assignedCloser = row.assignedCloserId
      ? userById.get(row.assignedCloserId)
      : undefined;
    const slackUser = slackUserBySlackId.get(row.slackUserId);

    return {
      ...row,
      dealPosition: rowPosition(row),
      // The deal's first booking credit: its team, DM closer and resolution.
      ...creditFor(row),
      fullNameSnapshot: event?.fullNameSnapshot ?? "Unknown lead",
      handleSnapshot: event?.handleSnapshot ?? "",
      platform: event?.platform ?? "other_social",
      leadLabel: lead
        ? leadDisplayFromShape({
            fullName: lead.fullName,
            email: lead.email,
            leadId: lead._id,
          })
        : event?.fullNameSnapshot ?? "Unknown lead",
      slackUserLabel: slackUserLabel(slackUser),
      slackUser: slackMemberIdentity(slackUser, `slack:${row.slackUserId}`),
      assignedCloserName:
        assignedCloser?.fullName ?? assignedCloser?.email ?? undefined,
      assignedCloser: assignedCloser
        ? await userMemberIdentity(ctx, assignedCloser)
        : unknownMemberIdentity("Unassigned", "unknown"),
    };
  }));
}

export const listQualificationQueue = query({
  args: {
    paginationOpts: paginationOptsValidator,
    positionFilter: v.optional(dealPositionValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    qualifiedAfter: v.optional(v.number()),
    qualifiedBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const result = await qualificationRowsQuery(ctx, {
      tenantId,
      positionFilter: args.positionFilter,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      slackUserId: args.slackUserId,
      qualifiedAfter: args.qualifiedAfter,
      qualifiedBefore: args.qualifiedBefore,
    })
      .order("desc")
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: Math.min(args.paginationOpts.numItems, 1),
        maximumRowsRead: 1,
        maximumBytesRead: LIVE_QUERY_BYTE_BUDGET,
      });

    return {
      ...result,
      page: await enrichQualificationRows(ctx, tenantId, result.page),
    };
  },
});

export const searchQualificationQueue = query({
  args: {
    searchTerm: v.string(),
    positionFilter: v.optional(dealPositionValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    qualifiedAfter: v.optional(v.number()),
    qualifiedBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertSinglePrimaryFilter({ tenantId, ...args });

    const term = args.searchTerm.trim();
    if (term.length < 2) {
      return [];
    }

    const rows = await ctx.db
      .query("operationsQualificationRows")
      .withSearchIndex("search_qualification_rows", (q) => {
        let search = q.search("searchText", term).eq("tenantId", tenantId);
        if (args.positionFilter) {
          const { stage, outcome } = stageOfPosition(args.positionFilter);
          search = search.eq("dealStage", stage).eq("dealOutcome", outcome);
        }
        if (args.bookingProgramId) {
          search = search.eq("bookingProgramId", args.bookingProgramId);
        }
        if (args.soldProgramId) {
          search = search.eq("soldProgramId", args.soldProgramId);
        }
        if (args.slackUserId) {
          search = search.eq("slackUserId", args.slackUserId);
        }
        return search;
      })
      .take(50);

    const filtered = rows.filter((row) => {
      if (args.qualifiedAfter !== undefined && row.qualifiedAt < args.qualifiedAfter) {
        return false;
      }
      return args.qualifiedBefore === undefined || row.qualifiedAt < args.qualifiedBefore;
    });

    return await enrichQualificationRows(ctx, tenantId, filtered);
  },
});

export const listQualificationFilterOptions = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const [programs, slackUsers, closers] = await Promise.all([
      ctx.db
        .query("tenantPrograms")
        .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", tenantId))
        .take(200),
      ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("users")
        .withIndex("by_tenantId_and_isActive", (q) =>
          q.eq("tenantId", tenantId).eq("isActive", true),
        )
        .take(300),
    ]);

    return {
      programs: programs
        .filter((program) => program.archivedAt === undefined)
        .map((program) => ({ id: program._id, name: program.name })),
      slackUsers: slackUsers.map((user) => ({
        id: user.slackUserId,
        name: slackUserLabel(user) ?? user.slackUserId,
        identity: slackMemberIdentity(user, `slack:${user.slackUserId}`),
      })),
      closers: await Promise.all(closers
        .filter((user) => user.role === "closer")
        .map(async (user) => ({
          id: user._id,
          name: user.fullName ?? user.email,
          identity: await userMemberIdentity(ctx, user),
        }))),
    };
  },
});
