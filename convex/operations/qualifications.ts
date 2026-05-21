import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { opportunityStatusValidator } from "../opportunities/validators";
import { requireTenantUser } from "../requireTenantUser";

type QualificationRowDoc = Doc<"operationsQualificationRows">;

type QualificationFilterArgs = {
  tenantId: Id<"tenants">;
  statusFilter?: Doc<"opportunities">["status"];
  bookingProgramId?: Id<"tenantPrograms">;
  soldProgramId?: Id<"tenantPrograms">;
  slackUserId?: string;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  qualifiedAfter?: number;
  qualifiedBefore?: number;
};

function assertSinglePrimaryFilter(args: QualificationFilterArgs) {
  const primaryFilterCount = [
    args.statusFilter,
    args.bookingProgramId,
    args.soldProgramId,
    args.slackUserId,
    args.attributionTeamId,
    args.dmCloserId,
  ].filter(Boolean).length;

  if (primaryFilterCount > 1) {
    throw new Error("Select only one primary qualification filter at a time.");
  }
}

function qualificationRowsQuery(ctx: QueryCtx, args: QualificationFilterArgs) {
  assertSinglePrimaryFilter(args);

  if (args.statusFilter) {
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_opportunityStatus_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("opportunityStatus", args.statusFilter);
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

  if (args.attributionTeamId) {
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_attributionTeamId_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("attributionTeamId", args.attributionTeamId);
        const ranged = base.gte("qualifiedAt", args.qualifiedAfter ?? 0);
        return args.qualifiedBefore === undefined
          ? ranged
          : ranged.lt("qualifiedAt", args.qualifiedBefore);
      });
  }

  if (args.dmCloserId) {
    return ctx.db
      .query("operationsQualificationRows")
      .withIndex("by_tenantId_and_dmCloserId_and_qualifiedAt", (q) => {
        const base = q
          .eq("tenantId", args.tenantId)
          .eq("dmCloserId", args.dmCloserId);
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
  const teamIds = [
    ...new Set(
      rows
        .map((row) => row.attributionTeamId)
        .filter((id): id is Id<"attributionTeams"> => Boolean(id)),
    ),
  ];
  const dmCloserIds = [
    ...new Set(
      rows
        .map((row) => row.dmCloserId)
        .filter((id): id is Id<"dmClosers"> => Boolean(id)),
    ),
  ];
  const userIds = [
    ...new Set(
      rows
        .map((row) => row.assignedCloserId)
        .filter((id): id is Id<"users"> => Boolean(id)),
    ),
  ];
  const slackUserIds = [...new Set(rows.map((row) => row.slackUserId))];

  const [events, leads, teams, dmClosers, users, slackUsers] = await Promise.all([
    Promise.all(eventIds.map((id) => ctx.db.get(id))),
    Promise.all(leadIds.map((id) => ctx.db.get(id))),
    Promise.all(teamIds.map((id) => ctx.db.get(id))),
    Promise.all(dmCloserIds.map((id) => ctx.db.get(id))),
    Promise.all(userIds.map((id) => ctx.db.get(id))),
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
  ]);

  const eventById = new Map(events.filter(isNonNull).map((event) => [event._id, event]));
  const leadById = new Map(leads.filter(isNonNull).map((lead) => [lead._id, lead]));
  const teamById = new Map(teams.filter(isNonNull).map((team) => [team._id, team]));
  const dmCloserById = new Map(
    dmClosers.filter(isNonNull).map((dmCloser) => [dmCloser._id, dmCloser]),
  );
  const userById = new Map(users.filter(isNonNull).map((user) => [user._id, user]));
  const slackUserBySlackId = new Map(
    slackUsers
      .filter(isNonNull)
      .map((user) => [user.slackUserId, user]),
  );

  return rows.map((row) => {
    const event = eventById.get(row.qualificationEventId);
    const lead = row.leadId ? leadById.get(row.leadId) : undefined;
    const team = row.attributionTeamId
      ? teamById.get(row.attributionTeamId)
      : undefined;
    const dmCloser = row.dmCloserId
      ? dmCloserById.get(row.dmCloserId)
      : undefined;
    const assignedCloser = row.assignedCloserId
      ? userById.get(row.assignedCloserId)
      : undefined;

    return {
      ...row,
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
      slackUserLabel: slackUserLabel(slackUserBySlackId.get(row.slackUserId)),
      attributionTeamName: team?.displayName,
      dmCloserName: dmCloser?.displayName,
      assignedCloserName:
        assignedCloser?.fullName ?? assignedCloser?.email ?? undefined,
    };
  });
}

export const listQualificationQueue = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(opportunityStatusValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
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
      statusFilter: args.statusFilter,
      bookingProgramId: args.bookingProgramId,
      soldProgramId: args.soldProgramId,
      slackUserId: args.slackUserId,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
      qualifiedAfter: args.qualifiedAfter,
      qualifiedBefore: args.qualifiedBefore,
    })
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await enrichQualificationRows(ctx, tenantId, result.page),
    };
  },
});

export const searchQualificationQueue = query({
  args: {
    searchTerm: v.string(),
    statusFilter: v.optional(opportunityStatusValidator),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    soldProgramId: v.optional(v.id("tenantPrograms")),
    slackUserId: v.optional(v.string()),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
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
        if (args.statusFilter) {
          search = search.eq("opportunityStatus", args.statusFilter);
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
        if (args.attributionTeamId) {
          search = search.eq("attributionTeamId", args.attributionTeamId);
        }
        if (args.dmCloserId) {
          search = search.eq("dmCloserId", args.dmCloserId);
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

    const [programs, slackUsers, attributionTeams, dmClosers, closers] = await Promise.all([
      ctx.db
        .query("tenantPrograms")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(200),
      ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(300),
      ctx.db
        .query("attributionTeams")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
        .take(200),
      ctx.db
        .query("dmClosers")
        .withIndex("by_tenantId_and_teamId", (q) => q.eq("tenantId", tenantId))
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
      })),
      attributionTeams: attributionTeams
        .filter((team) => team.isActive)
        .map((team) => ({ id: team._id, name: team.displayName })),
      dmClosers: dmClosers
        .filter((closer) => closer.isActive)
        .map((closer) => ({ id: closer._id, name: closer.displayName })),
      closers: closers
        .filter((user) => user.role === "closer")
        .map((user) => ({
          id: user._id,
          name: user.fullName ?? user.email,
        })),
    };
  },
});
