import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { QueryCtx } from "../convex/_generated/server";
import { legacyStatus, loadPendingRescheduleLink } from "../convex/opportunities/dealState";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import type { EnrollmentHarness } from "./enrollmentFixtures";

// Phase 5 (docs/plans/phase-5-deal-status.md §9): no deal stores a status.
// The tests that compare a write with PR 7's name the old status a deal's
// stage, loss and tasks give (namedStatus).

/** A Slack installation, so the qualification path can post. */
export async function insertSlackInstallation(harness: EnrollmentHarness) {
  return await harness.t.run((ctx) =>
    ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
      installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
}

/** A Slack qualification that creates a deal at Qualified. */
export async function qualifyInSlack(harness: EnrollmentHarness, handle = "@slack.lead") {
  const installationId = await insertSlackInstallation(harness);
  await harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Slack Lead",
    handle,
    country: "Mexico",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: Date.now() },
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await harness.t.run(async (ctx) => {
    const deal = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_source_and_createdAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("source", "slack_qualified"),
      )
      .order("desc")
      .first();
    return deal!._id;
  });
}

/**
 * The old status the deal's stage, loss and pending reschedule link name
 * (`legacyStatus`, §4.6): what PR 7 would have stored, for the tests that
 * compare a write with PR 7's. The deal stores none.
 */
export async function namedStatus(
  ctx: QueryCtx,
  opportunityId: Id<"opportunities">,
): Promise<OpportunityStatus> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const { count } = await loadPendingRescheduleLink(ctx, opportunityId);
  return legacyStatus(deal, { hasPendingRescheduleLink: count > 0 });
}
