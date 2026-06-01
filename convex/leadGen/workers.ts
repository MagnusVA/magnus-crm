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

function displayNameForUser(user: Doc<"users">) {
  return user.fullName?.trim() || user.email;
}

export const syncWorkerProfileForUser = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
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
      return await ctx.db.insert("leadGenWorkers", {
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
    }

    await ctx.db.patch(existing._id, {
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
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
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

    if (args.workerId) {
      const worker = await ctx.db.get(args.workerId);
      if (!worker || worker.tenantId !== tenantId) {
        throw new Error("Worker not found");
      }

      return await ctx.db
        .query("leadGenWorkerSchedules")
        .withIndex("by_tenantId_and_workerId", (q) =>
          q.eq("tenantId", tenantId).eq("workerId", args.workerId!),
        )
        .take(7);
    }

    const workers = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(250);

    const schedules = [];
    for (const worker of workers) {
      const rows = await ctx.db
        .query("leadGenWorkerSchedules")
        .withIndex("by_tenantId_and_workerId", (q) =>
          q.eq("tenantId", tenantId).eq("workerId", worker._id),
        )
        .take(7);
      schedules.push(...rows);
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

    const team = await ctx.db.get(teamId);
    if (!team || team.tenantId !== tenantId) {
      throw new Error("Team not found");
    }

    await ctx.db.patch(team._id, {
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

    const worker = await ctx.db.get(args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw new Error("Worker not found");
    }

    const teamId = await resolveLeadGenTeamIdForWrite(ctx, {
      tenantId,
      teamId: args.teamId,
      requireActive: true,
    });

    await ctx.db.patch(worker._id, {
      teamId,
      isActive: args.isActive,
      updatedAt: Date.now(),
    });

    return worker._id;
  },
});

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

    if (args.scheduledHours < 0 || args.scheduledHours > 24) {
      throw new Error("Scheduled hours must be between 0 and 24");
    }

    const worker = await ctx.db.get(args.workerId);
    if (!worker || worker.tenantId !== tenantId) {
      throw new Error("Worker not found");
    }

    const existing = await ctx.db
      .query("leadGenWorkerSchedules")
      .withIndex("by_tenantId_and_workerId_and_weekday", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("workerId", worker._id)
          .eq("weekday", args.weekday),
      )
      .unique();

    const patch = {
      scheduledHours: args.scheduledHours,
      updatedByUserId: userId,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("leadGenWorkerSchedules", {
      tenantId,
      workerId: worker._id,
      userId: worker.userId,
      weekday: args.weekday,
      ...patch,
    });
  },
});
