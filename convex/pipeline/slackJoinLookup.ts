import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Window for joining a Calendly booking to a previously Slack-qualified
 * opportunity. After this, treat the booking as a cold lead.
 */
export const SLACK_JOIN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Finds the most recent open Slack-qualified opportunity for a lead that is
 * eligible to be joined by an incoming Calendly booking.
 */
export async function findOpenSlackQualifiedOpportunity(
	ctx: QueryCtx | MutationCtx,
	args: {
		tenantId: Id<"tenants">;
		leadId: Id<"leads">;
		referenceTime?: number;
		lookbackMs?: number;
	},
): Promise<Doc<"opportunities"> | null> {
	const referenceTime = args.referenceTime ?? Date.now();
	const lookbackMs = args.lookbackMs ?? SLACK_JOIN_LOOKBACK_MS;
	const cutoff = referenceTime - lookbackMs;

	return await ctx.db
		.query("opportunities")
		.withIndex(
			"by_tenantId_and_leadId_and_source_and_status_and_createdAt",
			(q) =>
				q
					.eq("tenantId", args.tenantId)
					.eq("leadId", args.leadId)
					.eq("source", "slack_qualified")
					.eq("status", "qualified_pending")
					.gt("createdAt", cutoff),
		)
		.order("desc")
		.first();
}
