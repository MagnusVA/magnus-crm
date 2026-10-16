"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { getValidAccessToken } from "../calendly/tokens";
import { log } from "../lib/observability/log";
import {
  fetchInviteeSnapshot,
  type InviteeSnapshot,
  type InviteeTarget,
} from "./inviteeSnapshot";

const SAVE_BATCH = 10;
// One invitee can be forbidden; a bad token fails every call.
const MAX_CONSECUTIVE_AUTH_FAILURES = 3;

type SnapshotTarget = InviteeTarget & { snapshotOutcome?: InviteeSnapshot["outcome"] };
type FetchInviteesResult = {
  planId: Id<"leadSplitPlans">;
  dryRun: boolean;
  meetings: number;
  fetched: number;
  ok: number;
  notFound: number;
  failed: number;
  stoppedOnAuthError: boolean;
  failedMeetingIds: Id<"meetings">[];
};

/**
 * Phase 2 (§5.3). Reads the Calendly invitee of every meeting on the plan's
 * lead, one at a time, and stores one snapshot per meeting. Meetings that
 * already have a good snapshot are skipped unless `refetch` is set. With
 * `dryRun` it fetches but stores nothing; `limit` caps the calls. Returns
 * counts only, because snapshots hold personal data.
 */
export const fetchInvitees = internalAction({
  args: {
    planId: v.id("leadSplitPlans"),
    dryRun: v.boolean(),
    limit: v.optional(v.number()),
    refetch: v.optional(v.boolean()),
  },
  returns: v.object({
    planId: v.id("leadSplitPlans"),
    dryRun: v.boolean(),
    meetings: v.number(),
    fetched: v.number(),
    ok: v.number(),
    notFound: v.number(),
    failed: v.number(),
    stoppedOnAuthError: v.boolean(),
    failedMeetingIds: v.array(v.id("meetings")),
  }),
  handler: async (ctx, args): Promise<FetchInviteesResult> => {
    const { tenantId, targets }: { tenantId: Id<"tenants">; targets: SnapshotTarget[] } =
      await ctx.runQuery(internal.leadSplit.snapshotStore.getSnapshotTargets, {
        planId: args.planId,
      });
    const pending = targets
      .filter((target) => args.refetch || target.snapshotOutcome !== "ok")
      .slice(0, args.limit ?? targets.length);

    const accessToken = pending.length > 0 ? await getValidAccessToken(ctx, tenantId) : null;
    if (pending.length > 0 && !accessToken) {
      throw new Error("No valid Calendly access token for the plan's tenant");
    }

    const results: InviteeSnapshot[] = [];
    let unsaved: InviteeSnapshot[] = [];
    const save = async () => {
      if (!args.dryRun && unsaved.length > 0) {
        await ctx.runMutation(internal.leadSplit.snapshotStore.saveInviteeSnapshots, {
          tenantId,
          snapshots: unsaved,
        });
      }
      unsaved = [];
    };
    let stoppedOnAuthError = false;
    let authFailures = 0;
    for (const target of pending) {
      const snapshot = await fetchInviteeSnapshot(target, { accessToken: accessToken! });
      results.push(snapshot);
      unsaved.push(snapshot);
      if (unsaved.length >= SAVE_BATCH) await save();
      authFailures =
        snapshot.httpStatus === 401 || snapshot.httpStatus === 403 ? authFailures + 1 : 0;
      if (authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
        stoppedOnAuthError = true;
        break;
      }
    }
    await save();

    const count = (outcome: InviteeSnapshot["outcome"]) =>
      results.filter((result) => result.outcome === outcome).length;
    const summary = {
      planId: args.planId,
      dryRun: args.dryRun,
      meetings: targets.length,
      fetched: results.length,
      ok: count("ok"),
      notFound: count("not_found"),
      failed: results.length - count("ok") - count("not_found"),
      stoppedOnAuthError,
      failedMeetingIds: results
        .filter((result) => result.outcome !== "ok")
        .map((result) => result.meetingId),
    };
    log.info("lead_split.snapshot.fetched", {
      tenantId,
      ...summary,
      failedMeetingIds: summary.failedMeetingIds.length,
    });
    return summary;
  },
});
