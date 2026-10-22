import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { legacyStatus, loadPendingRescheduleLink } from "./dealState";
import { opportunityStatusValidator } from "./validators";
import { dealStageOf, isAllowedStageOutcome } from "./stages";

// Parity (docs/plans/phase-5-deal-status.md §10.4): each number a moved
// reader shows, computed from the status and from the stage, with the
// differences, IDs and counts only. Run in production before the PR that
// moves the reader deploys; PR 9 removes this module with the status.
//
// Each query lives in its own section below.

// ---------------------------------------------------------------------------
// compareDealState (PR 3): each deal's legacyStatus against its status.
// ---------------------------------------------------------------------------

const DEAL_STATE_PAGE_DEFAULT = 200;
const DEAL_STATE_PAGE_MAX = 500;

/**
 * Read-only: for one page of the tenant's deals, every deal whose status
 * rebuilt from its stage, outcome, loss and tasks (`legacyStatus`, §4.6)
 * isn't its stored status. `legacy` is null when the stage doesn't allow the
 * outcome. Page with `continueCursor` until `isDone`.
 */
export const compareDealState = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    checked: v.number(),
    mismatches: v.array(
      v.object({
        opportunityId: v.id("opportunities"),
        status: opportunityStatusValidator,
        legacy: v.union(opportunityStatusValidator, v.null()),
      }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { tenantId, cursor, numItems = DEAL_STATE_PAGE_DEFAULT }) => {
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > DEAL_STATE_PAGE_MAX) {
      throw new Error(`numItems must be a whole number from 1 to ${DEAL_STATE_PAGE_MAX}`);
    }
    const page = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .paginate({ cursor, numItems });

    const mismatches = [];
    for (const deal of page.page) {
      const { stage, outcome } = dealStageOf(deal);
      let legacy = null;
      if (isAllowedStageOutcome(stage, outcome)) {
        // Only a Follow-up deal's status reads its reschedule link.
        const links = stage === "follow_up" ? (await loadPendingRescheduleLink(ctx, deal._id)).count : 0;
        legacy = legacyStatus(deal, { hasPendingRescheduleLink: links > 0 });
      }
      if (legacy !== deal.status) {
        mismatches.push({ opportunityId: deal._id, status: deal.status, legacy });
      }
    }
    return {
      checked: page.page.length,
      mismatches,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
