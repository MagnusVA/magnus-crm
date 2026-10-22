import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
	OPPORTUNITY_STATUSES,
	type OpportunityStatus,
} from "../lib/statusTransitions";

/** Most deals changed after a booking that it reconstructs before giving up. */
export const MAX_CHANGED_DEALS = 16;
const MAX_CHANGES = 32;
// Events of any kind read to find those changes. Other events (a stale flag)
// share the index, so the cap on changes applies after filtering.
const MAX_EVENTS = 128;

/**
 * Statuses at which no booking without a link attaches to a deal: the Slack
 * join takes pending ones, and a follow-up booking takes
 * `follow_up_scheduled`. No booking without a link joins a canceled or
 * no-show deal either, now that a missed meeting ends the deal, but those
 * stay outside the set: a deal that left one after the booking happened
 * holds the booking for review, the cautious answer the old reschedule join
 * needed.
 */
const UNATTACHABLE_STATUSES: ReadonlySet<OpportunityStatus> = new Set([
	"scheduled",
	"payment_received",
]);

/**
 * The status a deal had at `time`, read from the status changes it recorded
 * after `time`. Undefined when those changes don't account for its current
 * status (a gap in the history, or more changes than this reads), so the
 * caller can't rely on the answer.
 */
export async function opportunityStatusAt(
	ctx: MutationCtx,
	opportunity: Doc<"opportunities">,
	time: number,
): Promise<OpportunityStatus | undefined> {
	const events = await ctx.db
		.query("domainEvents")
		.withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
			q
				.eq("tenantId", opportunity.tenantId)
				.eq("entityType", "opportunity")
				.eq("entityId", opportunity._id)
				.gt("occurredAt", time),
		)
		.take(MAX_EVENTS + 1);
	if (events.length > MAX_EVENTS) return undefined;
	const changes = events.filter(
		(event) => event.fromStatus !== undefined && event.toStatus !== undefined,
	);
	if (changes.length > MAX_CHANGES) return undefined;
	if (changes.length === 0) return opportunity.status;
	for (let i = 1; i < changes.length; i++)
		if (changes[i].fromStatus !== changes[i - 1].toStatus) return undefined;
	if (changes[changes.length - 1].toStatus !== opportunity.status) return undefined;
	const first = changes[0].fromStatus;
	return OPPORTUNITY_STATUSES.find((status) => status === first);
}

/**
 * Whether a deal that changed after a booking happened at `time` was out of
 * that booking's reach then: it already existed, and it was booked or won.
 * A booking without a link would not have attached to it in any arrival
 * order, so the later change doesn't make the booking historical.
 */
export async function wasUnattachableAt(
	ctx: MutationCtx,
	opportunity: Doc<"opportunities">,
	time: number,
): Promise<boolean> {
	if (opportunity.createdAt > time) return false;
	const status = await opportunityStatusAt(ctx, opportunity, time);
	return status !== undefined && UNATTACHABLE_STATUSES.has(status);
}
