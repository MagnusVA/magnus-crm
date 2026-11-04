import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, mutation, query } from "../_generated/server";
import { leadGenWorkerMemberIdentity } from "../lib/memberIdentity";
import { requireTenantUser } from "../requireTenantUser";
import {
  listSharedDmTeams,
  resolveLeadGenTeamIdForWrite,
  upsertSharedDmTeamFromName,
} from "./sharedTeams";
import { leadGenWeekdayValidator } from "./validators";
import { linkLeadGenWorkerTeamMember } from "../lib/teamMembers";
import { createLiveReadState } from "../lib/liveQueryBounds";
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

export const listWorkers = query({
  args: {
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", tenantId))
      .take(250);

    const filtered = rows
      .filter((worker) => args.includeInactive || worker.isActive)
      .sort((a, b) => a.email.localeCompare(b.email));
    return await Promise.all(
      filtered.map(async (worker) => ({
        ...worker,
        avatar: await leadGenWorkerMemberIdentity(ctx, worker),
      })),
    );
  },
});

export const listTeams = query({
  args: {
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await listSharedDmTeams(ctx, {
      tenantId,
      includeInactive: args.includeInactive,
    });
  },
});

export const listWorkerSchedules = query({
  args: {
    workerId: v.optional(v.id("leadGenWorkers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // The week in force today, one row per weekday, as before rows were dated.
    const today = await tenantBusinessToday(ctx, tenantId);
    const state = createLiveReadState();

    if (args.workerId) {
      const worker = await ctx.db.get("leadGenWorkers", args.workerId);
      if (!worker || worker.tenantId !== tenantId) {
        throw new Error("Worker not found");
      }

      const scan = await readScheduleRows(
        ctx,
        tenantId,
        { table: "leadGenWorkerSchedules", workerId: worker._id },
        state,
      );
      return rowsInForce(scan.rows, today);
    }

    const workers = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", tenantId))
      .take(250);

    const schedules = [];
    for (const worker of workers) {
      const scan = await readScheduleRows(
        ctx,
        tenantId,
        { table: "leadGenWorkerSchedules", workerId: worker._id },
        state,
      );
      schedules.push(...rowsInForce(scan.rows, today));
      if (scan.capped) break;
    }

    return schedules;
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
