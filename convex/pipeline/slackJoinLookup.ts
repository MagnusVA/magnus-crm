import { blockBooking } from "./blocked";
import type { DealStateFields } from "../opportunities/dealState";
import {
	SYSTEM_LOSS_REASONS,
	dealStageOf,
	type DealOutcome,
	type DealStage,
} from "../opportunities/stages";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Window for joining a Calendly booking to a previously Slack-qualified
 * opportunity. After this, treat the booking as a cold lead.
 */
export const SLACK_JOIN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A Slack-qualified opportunity that never booked closes as lost, reason
 * "stale", one day after the join window (slack/staleExpiry.ts). The extra
 * day keeps it in the 8am stale digest before it closes.
 */
export const SLACK_OPPORTUNITY_EXPIRY_MS = SLACK_JOIN_LOOKBACK_MS + 24 * 60 * 60 * 1000;
export const SLACK_STALE_LOST_REASON = SYSTEM_LOSS_REASONS.stale;

/**
 * True when the stale expiry closed this opportunity after `referenceTime`:
 * a Slack deal, Closed lost with the reason `stale`, lost after that time.
 * The pipeline judges time by the booking event, and a blocked booking can be
 * retried days later, so the expiry may have run after the booking happened.
 * That booking still belongs to the deal.
 *
 * Today's check read `lost` with that reason, so a person's loss with the
 * text "stale" counts too, as it did (docs/plans/phase-5-deal-status.md §4.6).
 */
export function wasStaleExpiredAfter(
	opportunity: DealStateFields & Pick<Doc<"opportunities">, "lostAt">,
	referenceTime: number,
): boolean {
	const { stage, outcome } = dealStageOf(opportunity);
	return (
		opportunity.source === "slack_qualified" &&
		stage === "closed" &&
		outcome === "lost" &&
		opportunity.lostReason === SLACK_STALE_LOST_REASON &&
		(opportunity.lostAt ?? 0) > referenceTime
	);
}

/**
 * Finds the Slack-qualified opportunity, if any, that an incoming Calendly
 * booking at `referenceTime` should join: one still Qualified inside the join
 * window, or one the stale expiry closed after the booking happened. Reads
 * eight of each kind at most, and blocks the booking when more than one
 * could take it.
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

	const inWindow = (stage: DealStage, outcome: DealOutcome) =>
		ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_leadId_source_stage_outcome_createdAt", (q) =>
				q
					.eq("tenantId", args.tenantId)
					.eq("leadId", args.leadId)
					.eq("source", "slack_qualified")
					.eq("stage", stage)
					.eq("outcome", outcome)
					.gt("createdAt", cutoff)
					.lte("createdAt", referenceTime),
			)
			.order("desc")
			.take(8);
	const pending = await inWindow("qualified", "open");
	const expiredAfterBooking = (await inWindow("closed", "lost")).filter((opportunity) =>
		wasStaleExpiredAfter(opportunity, referenceTime),
	);
	const candidates = [...pending, ...expiredAfterBooking];
	if (candidates.length > 1) blockBooking("ambiguous_booking_target");
	return candidates[0] ?? null;
}
