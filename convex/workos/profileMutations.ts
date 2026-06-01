import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { getWorkosUserIdCandidates } from "../lib/workosUserId";

export const patchCurrentProfile = internalMutation({
  args: {
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    profilePictureUrl: v.optional(v.string()),
    syncedAt: v.number(),
  },
  handler: async (ctx, args) => {
    let user: Doc<"users"> | null = null;
    for (const candidateWorkosUserId of getWorkosUserIdCandidates(
      args.workosUserId,
    )) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) =>
          q.eq("workosUserId", candidateWorkosUserId),
        )
        .unique();
      if (user) break;
    }

    if (!user || user.isActive === false) {
      return null;
    }

    await ctx.db.patch(user._id, {
      email: args.email.trim().toLowerCase(),
      fullName: args.fullName ?? user.fullName,
      profilePictureUrl: args.profilePictureUrl?.trim() || undefined,
      profilePictureSyncedAt: args.syncedAt,
    });

    await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
      userId: user._id,
    });

    return user._id;
  },
});

export const patchBackfilledProfile = internalMutation({
  args: {
    userId: v.id("users"),
    profilePictureUrl: v.optional(v.string()),
    syncedAt: v.number(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (
      !user ||
      user.isActive === false ||
      user.deletedAt ||
      user.invitationStatus === "pending" ||
      user.workosUserId.startsWith("pending:")
    ) {
      return { status: "skipped" as const };
    }

    const profilePictureUrl = args.profilePictureUrl?.trim() || undefined;
    const isUnchanged = user.profilePictureUrl === profilePictureUrl;

    if (args.dryRun) {
      return {
        status: isUnchanged ? "unchanged" : "would_update",
      } as const;
    }

    await ctx.db.patch(user._id, {
      profilePictureUrl,
      profilePictureSyncedAt: args.syncedAt,
    });

    await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
      userId: user._id,
    });

    return { status: isUnchanged ? "unchanged" : "updated" } as const;
  },
});
