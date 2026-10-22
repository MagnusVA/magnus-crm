import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { legacyStatus } from "../opportunities/dealState";
import { parseDealEventOutcomes } from "../opportunities/stageLabels";
import {
	DEAL_STAGES,
	OPPORTUNITY_STATUSES,
	dealPosition,
	dealStageOf,
	isAllowedStageOutcome,
	stageForStatus,
	type DealOutcome,
	type DealPosition,
	type DealStage,
	type DealStageAndOutcome,
	type OpportunityStatus,
} from "../opportunities/stages";
import { loadDealTasks } from "./bookingTargets";

/** Most deals changed after a booking that it reconstructs before giving up. */
export const MAX_CHANGED_DEALS = 16;
const MAX_CHANGES = 32;
// Events of any kind read to find those changes. Other events (a stale flag)
// share the index, so the cap on changes applies after filtering.
const MAX_EVENTS = 128;

/**
 * Positions at which no booking without a link attaches to a deal: Booked,
 * Call held and Closed won, today's `scheduled` and `payment_received`. The
 * Slack join takes Qualified deals, and a follow-up booking takes Follow-up.
 * No booking without a link joins a deal a missed meeting closed either, but
 * Closed lost stays outside the set: a deal that left it after the booking
 * happened holds the booking for review, the cautious answer the old
 * reschedule join needed.
 */
const UNATTACHABLE_POSITIONS: ReadonlySet<DealPosition> = new Set([
	"booked",
	"call_held",
	"won",
]);

/**
 * One side of a recorded change. An old event holds today's status; from
 * PR 8 an event holds a stage, with its outcome in the metadata
 * (docs/plans/phase-5-deal-status.md §4.7). The two lists share no value.
 */
type RecordedState =
	| { kind: "status"; status: OpportunityStatus }
	| { kind: "stage"; stage: DealStageAndOutcome };

function isOpportunityStatus(value: string): value is OpportunityStatus {
	return (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}

function isDealStage(value: string): value is DealStage {
	return (DEAL_STAGES as readonly string[]).includes(value);
}

/**
 * What one side of an event recorded, or null when it can't be read: a value
 * in neither list, or a Closed stage with no outcome. An open stage allows
 * only `open`, so it needs none.
 */
function recordedState(value: string, outcome: DealOutcome | null): RecordedState | null {
	if (isOpportunityStatus(value)) return { kind: "status", status: value };
	if (!isDealStage(value)) return null;
	const resolved = outcome ?? (value === "closed" ? null : "open");
	if (!resolved || !isAllowedStageOutcome(value, resolved)) return null;
	return { kind: "stage", stage: { stage: value, outcome: resolved } };
}

function stageOfState(
	state: RecordedState,
	source: Doc<"opportunities">["source"],
): DealStageAndOutcome {
	return state.kind === "stage" ? state.stage : stageForStatus(state.status, source);
}

function sameStage(a: DealStageAndOutcome, b: DealStageAndOutcome): boolean {
	return a.stage === b.stage && a.outcome === b.outcome;
}

/**
 * Whether one change ends where the next begins. Two statuses must match as
 * they are, as before PR 8. Where a status meets a stage, the status maps
 * through `stageForStatus` with the deal's source.
 */
function chains(
	previous: RecordedState,
	next: RecordedState,
	source: Doc<"opportunities">["source"],
): boolean {
	if (previous.kind === "status" && next.kind === "status")
		return previous.status === next.status;
	return sameStage(stageOfState(previous, source), stageOfState(next, source));
}

/**
 * Whether the last change ends at the deal as it is now. A stage must be the
 * deal's stage and outcome. A status must be the one the deal's fields
 * rebuild (`legacyStatus`: the stage and outcome, the loss and the pending
 * reschedule link), so an old history's last status is checked as fully as
 * against the stored status before PR 7: a no-show isn't a cancellation, and
 * Follow-up with a reschedule link isn't Follow-up without one.
 */
async function endsAtDeal(
	ctx: MutationCtx,
	last: RecordedState,
	opportunity: Doc<"opportunities">,
): Promise<boolean> {
	const current = dealStageOf(opportunity);
	if (last.kind === "stage") return sameStage(last.stage, current);
	if (!isAllowedStageOutcome(current.stage, current.outcome)) return false;
	const tasks =
		current.stage === "follow_up"
			? await loadDealTasks(ctx, opportunity._id)
			: { hasPendingRescheduleLink: false };
	return last.status === legacyStatus(opportunity, tasks);
}

/**
 * The position a deal had at `time`, read from the changes it recorded after
 * `time`, old events and new. Undefined when those changes don't account for
 * where the deal is now (a gap in the history, an event it can't read, or
 * more changes than this reads), so the caller can't rely on the answer.
 */
export async function dealPositionAt(
	ctx: MutationCtx,
	opportunity: Doc<"opportunities">,
	time: number,
): Promise<DealPosition | undefined> {
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
	if (changes.length === 0) {
		const { stage, outcome } = dealStageOf(opportunity);
		return isAllowedStageOutcome(stage, outcome) ? dealPosition(stage, outcome) : undefined;
	}
	const recorded: Array<{ from: RecordedState; to: RecordedState }> = [];
	for (const change of changes) {
		const { fromOutcome, toOutcome } = parseDealEventOutcomes(change.metadata);
		const from = recordedState(change.fromStatus!, fromOutcome);
		const to = recordedState(change.toStatus!, toOutcome);
		if (!from || !to) return undefined;
		recorded.push({ from, to });
	}
	const { source } = opportunity;
	for (let i = 1; i < recorded.length; i++)
		if (!chains(recorded[i - 1].to, recorded[i].from, source)) return undefined;
	if (!(await endsAtDeal(ctx, recorded[recorded.length - 1].to, opportunity)))
		return undefined;
	const { stage, outcome } = stageOfState(recorded[0].from, source);
	return dealPosition(stage, outcome);
}

/**
 * Whether a deal that changed after a booking happened at `time` was out of
 * that booking's reach then: it already existed, and it was Booked, Call held
 * or Closed won. A booking without a link would not have attached to it in
 * any arrival order, so the later change doesn't make the booking historical.
 */
export async function wasUnattachableAt(
	ctx: MutationCtx,
	opportunity: Doc<"opportunities">,
	time: number,
): Promise<boolean> {
	if (opportunity.createdAt > time) return false;
	const position = await dealPositionAt(ctx, opportunity, time);
	return position !== undefined && UNATTACHABLE_POSITIONS.has(position);
}
