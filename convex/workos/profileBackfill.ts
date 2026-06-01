"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { getRawWorkosUserId } from "../lib/workosUserId";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

type ProfileBackfillPage = {
  page: Array<{
    _id: Id<"users">;
    workosUserId: string;
    deletedAt?: number;
    invitationStatus?: "pending" | "accepted";
  }>;
  isDone: boolean;
  continueCursor: string;
};

type ProfileBackfillResult = {
  scanned: number;
  skipped: number;
  updated: number;
  unchanged: number;
  failed: number;
  continueCursor: string;
  isDone: boolean;
  scheduledContinuation: boolean;
};

export const backfillUserProfilePictures = internalAction({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args): Promise<ProfileBackfillResult> => {
    const page: ProfileBackfillPage = await ctx.runQuery(
      internal.workos.profileBackfillQueries.listUsersForProfileBackfill,
      {
        tenantId: args.tenantId,
        cursor: args.cursor,
      },
    );

    const result: ProfileBackfillResult = {
      scanned: 0,
      skipped: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scheduledContinuation: false,
    };

    for (const user of page.page) {
      result.scanned += 1;

      if (
        user.deletedAt ||
        user.invitationStatus === "pending" ||
        user.workosUserId.startsWith("pending:")
      ) {
        result.skipped += 1;
        continue;
      }

      try {
        const workosUser = await workos.userManagement.getUser(
          getRawWorkosUserId(user.workosUserId),
        );
        const patch = await ctx.runMutation(
          internal.workos.profileMutations.patchBackfilledProfile,
          {
            userId: user._id,
            profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
            syncedAt: Date.now(),
            dryRun: args.dryRun,
          },
        );

        if (
          patch.status === "updated" ||
          patch.status === "would_update"
        ) {
          result.updated += 1;
        } else if (patch.status === "unchanged") {
          result.unchanged += 1;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        console.warn("[WorkOS:ProfileBackfill] failed user", {
          userId: user._id,
          workosUserId: user.workosUserId,
          error: error instanceof Error ? error.message : String(error),
        });
        result.failed += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.workos.profileBackfill.backfillUserProfilePictures,
        {
          tenantId: args.tenantId,
          cursor: page.continueCursor,
          dryRun: args.dryRun,
        },
      );
      result.scheduledContinuation = true;
    }

    return result;
  },
});
