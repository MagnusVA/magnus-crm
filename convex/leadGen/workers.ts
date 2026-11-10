import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type QueryCtx } from "../_generated/server";
import { leadGenWorkerMemberIdentity } from "../lib/memberIdentity";
import { requireTenantUser } from "../requireTenantUser";
import {
  listSharedDmTeams,
  resolveLeadGenTeamIdForWrite,
  upsertSharedDmTeamFromName,
} from "./sharedTeams";
import { leadGenWeekdayValidator } from "./validators";
import { linkLeadGenWorkerTeamMember } from "../lib/teamMembers";
import { createLiveReadState, type LiveReadState } from "../lib/liveQueryBounds";
import { tenantBusinessToday } from "../lib/tenantBusinessDay";
import { rowsInForce } from "../lib/workSchedule";
import {
  readScheduleRows,
  validateScheduledHours,
  writeDatedWeek,
} from "../workSchedules/datedRows";

function displayNameForUser(user: Doc<"users">) {
  return user.fullName?.trim() || user.email;
}

export const syncWorkerProfileForUser = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get("users", userId);
    if (!user) return null;

    const existing = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) =>
        q.eq("tenantId", user.tenantId).eq("userId", user._id),
      )
      .unique();

    const shouldBeActive = user.role === "lead_generator" && user.isActive;
    const now = Date.now();

    if (!existing && user.role !== "lead_generator") {
      return null;
    }

    if (!existing) {
      const workerId = await ctx.db.insert("leadGenWorkers", {
        tenantId: user.tenantId,
        userId: user._id,
        workosUserId: user.workosUserId,
        email: user.email,
        displayName: displayNameForUser(user),
        customProfilePictureStorageId: user.customProfilePictureStorageId,
        profilePictureUrl: user.profilePictureUrl,
        isActive: shouldBeActive,
        createdAt: now,
        updatedAt: now,
      });
      await linkLeadGenWorkerTeamMember(ctx, workerId);
      return workerId;
    }

    await ctx.db.patch("leadGenWorkers", existing._id, {
      workosUserId: user.workosUserId,
      email: user.email,
      displayName: displayNameForUser(user),
      customProfilePictureStorageId: user.customProfilePictureStorageId,
      profilePictureUrl: user.profilePictureUrl,
      isActive: shouldBeActive,
      updatedAt: now,
    });

    return existing._id;
  },
});

type WorkerListArgs = { tenantId: Id<"tenants">; includeInactive?: boolean };
type WorkerPageArgs = WorkerListArgs & {
  teamId?: Id<"attributionTeams">;
  paginationOpts: { cursor: string | null; numItems: number };
};

/** Auth-free roster readers shared by the web and MCP. */
export function listWorkersCore(
  ctx: QueryCtx,
  args: WorkerPageArgs,
): ReturnType<typeof listWorkerPageCore>;
export function listWorkersCore(
  ctx: QueryCtx,
  args: WorkerListArgs,
): Promise<Doc<"leadGenWorkers">[]>;
export async function listWorkersCore(
  ctx: QueryCtx,
  args: WorkerListArgs & Partial<WorkerPageArgs>,
) {
  if (args.paginationOpts)
    return listWorkerPageCore(ctx, { ...args, ...args.paginationOpts });
  const rows = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", args.tenantId))
    .take(250);
  return rows
    .filter((worker) => args.includeInactive || worker.isActive)
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Native pagination avoids the web reader's legacy 250-worker ceiling. */
async function listWorkerPageCore(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    includeInactive?: boolean;
    teamId?: Id<"attributionTeams">;
    cursor: string | null;
    numItems: number;
  },
) {
  const rows = args.teamId
    ? ctx.db
        .query("leadGenWorkers")
        .withIndex("by_tenantId_and_teamId", (q) =>
          q.eq("tenantId", args.tenantId).eq("teamId", args.teamId),
        )
    : args.includeInactive
      ? ctx.db
          .query("leadGenWorkers")
          .withIndex("by_tenantId_and_userId", (q) =>
            q.eq("tenantId", args.tenantId),
          )
      : ctx.db
          .query("leadGenWorkers")
          .withIndex("by_tenantId_and_isActive", (q) =>
            q.eq("tenantId", args.tenantId).eq("isActive", true),
          );
  return rows.paginate({
    cursor: args.cursor,
    numItems: args.numItems,
    maximumRowsRead: 100,
    maximumBytesRead: 128 * 1024,
  });
}

type TeamPageArgs = WorkerListArgs & {
  paginationOpts: { cursor: string | null };
};
export function listTeamsCore(
  ctx: QueryCtx,
  args: TeamPageArgs,
): ReturnType<typeof listTeamPageCore>;
export function listTeamsCore(
  ctx: QueryCtx,
  args: WorkerListArgs,
): ReturnType<typeof listSharedDmTeams>;
export async function listTeamsCore(
  ctx: QueryCtx,
  args: WorkerListArgs & Partial<TeamPageArgs>,
) {
  if (args.paginationOpts)
    return listTeamPageCore(ctx, { ...args, ...args.paginationOpts });
  return listSharedDmTeams(ctx, args);
}

/** Paged team companion; filtering after the bounded page preserves empty-page cursors. */
async function listTeamPageCore(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    includeInactive?: boolean;
    cursor: string | null;
  },
) {
  const page = await ctx.db
    .query("attributionTeams")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
    .paginate({
      cursor: args.cursor,
      numItems: 25,
      maximumRowsRead: 25,
      maximumBytesRead: 128 * 1024,
    });
  return {
    ...page,
    page: page.page.filter((team) => args.includeInactive || team.isActive),
  };
}

export async function listWorkerSchedulesCore(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    workerId?: Id<"leadGenWorkers">;
    workerIds?: Id<"leadGenWorkers">[];
    today?: string;
    state?: LiveReadState;
  },
) {
  const today = args.today ?? (await tenantBusinessToday(ctx, args.tenantId));
  const state = args.state ?? createLiveReadState();
  let workerIds = args.workerIds;
  if (args.workerId) {
    const worker = await ctx.db.get("leadGenWorkers", args.workerId);
    if (!worker || worker.tenantId !== args.tenantId)
      throw new Error("Worker not found");
    workerIds = [worker._id];
  }
  if (!workerIds) {
    const workers = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) =>
        q.eq("tenantId", args.tenantId),
      )
      .take(250);
    workerIds = workers.map((worker) => worker._id);
  }
  const rows: Doc<"leadGenWorkerSchedules">[] = [];
  for (const workerId of workerIds) {
    const scan = await readScheduleRows(
      ctx,
      args.tenantId,
      { table: "leadGenWorkerSchedules", workerId },
      state,
    );
    rows.push(...rowsInForce(scan.rows, today));
    if (scan.capped) break;
  }
  return { rows, capped: state.capped };
}

export const listWorkers = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const workers = await listWorkersCore(ctx, { tenantId, ...args });
    return Promise.all(
      workers.map(async (worker) => ({
        ...worker,
        avatar: await leadGenWorkerMemberIdentity(ctx, worker),
      })),
    );
  },
});

export const listTeams = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return listTeamsCore(ctx, { tenantId, ...args });
  },
});

export const listWorkerSchedules = query({
  args: { workerId: v.optional(v.id("leadGenWorkers")) },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return (await listWorkerSchedulesCore(ctx, { tenantId, ...args })).rows;
  },
});

export const createTeam = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await upsertSharedDmTeamFromName(ctx, {
      tenantId,
      name,
      reuseActive: false,
    });
  },
});

export const archiveTeam = mutation({
  args: { teamId: v.id("attributionTeams") },
  handler: async (ctx, { teamId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const team = await ctx.db.get("attributionTeams", teamId);
    if (!team || team.tenantId !== tenantId) {
      throw new Error("Team not found");
    }

    await ctx.db.patch("attributionTeams", team._id, {
      isActive: false,
      updatedAt: Date.now(),
    });

    return team._id;
  },
});

export const updateWorkerProfile = mutation({
  args: {
    workerId: v.id("leadGenWorkers"),
    teamId: v.optional(v.id("attributionTeams")),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const worker = await ctx.db.get("leadGenWorkers", args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw new Error("Worker not found");
    }

    const teamId = await resolveLeadGenTeamIdForWrite(ctx, {
      tenantId,
      teamId: args.teamId,
      requireActive: true,
    });

    await ctx.db.patch("leadGenWorkers", worker._id, {
      teamId,
      isActive: args.isActive,
      updatedAt: Date.now(),
    });

    return worker._id;
  },
});

// Legacy: one weekday at a time, for Lead Gen settings until it moves to Team.
// Saves through the same dated writer as api.workSchedules.setLeadGenWeeklySchedule.
export const setWorkerSchedule = mutation({
  args: {
    workerId: v.id("leadGenWorkers"),
    weekday: leadGenWeekdayValidator,
    scheduledHours: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    validateScheduledHours(args.scheduledHours);

    const worker = await ctx.db.get("leadGenWorkers", args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw new Error("Worker not found");
    }

    return await writeDatedWeek(ctx, {
      tenantId,
      userId,
      owner: { table: "leadGenWorkerSchedules", workerId: worker._id },
      workerUserId: worker.userId,
      scheduledHours: { [args.weekday]: args.scheduledHours },
      days: [args.weekday],
    });
  },
});
