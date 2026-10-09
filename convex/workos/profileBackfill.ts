"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, env } from "../_generated/server";
import { log, reportError } from "../lib/observability/log";
import { getRawWorkosUserId } from "../lib/workosUserId";

const workos = new WorkOS(env.WORKOS_API_KEY, {
  clientId: env.WORKOS_CLIENT_ID,
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
    const startedAt = Date.now();
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
        reportError("workos.profile_backfill.user_failed", error, {
          severity: "warning",
          integration: "workos",
          fingerprint: "workos.profile_backfill.user_failed",
          tenantId: args.tenantId,
          userId: user._id,
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

    log.info("workos.profile_backfill.batch", {
      tenantId: args.tenantId,
      dryRun: args.dryRun,
      scanned: result.scanned,
      skipped: result.skipped,
      updated: result.updated,
      unchanged: result.unchanged,
      failed: result.failed,
      isDone: result.isDone,
      scheduledContinuation: result.scheduledContinuation,
      durationMs: Date.now() - startedAt,
    });
    return result;
  },
});
