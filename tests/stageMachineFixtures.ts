import { expect } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { QueryCtx } from "../convex/_generated/server";
import { legacyStatus, loadPendingRescheduleLink } from "../convex/opportunities/dealState";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import { isActiveOpportunityStatus } from "../convex/lib/tenantStatsHelper";
import { opportunityByStatus } from "../convex/reporting/aggregates";

// PR 8 moves the deal's transitions to the stage machine
// (docs/plans/phase-5-deal-status.md §4.4) and still writes the status, as
// `legacyStatus` of the new fields, so a revert to PR 7 finds every deal as
// PR 7 would have written it (§12).

/**
 * PR 7's status machine, frozen: `statusTransitions.ts` before PR 8. The
 * reference the stage machine and every write path are checked against.
 */
export const PR7_STATUS_TRANSITIONS: Record<OpportunityStatus, readonly OpportunityStatus[]> = {
  qualified_pending: ["scheduled", "lost"],
  scheduled: ["payment_received", "follow_up_scheduled", "lost", "no_show", "canceled"],
  canceled: ["follow_up_scheduled", "scheduled"],
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"],
  follow_up_scheduled: ["scheduled", "payment_received", "lost"],
  reschedule_link_sent: ["scheduled"],
  payment_received: [],
  lost: [],
};

/** PR 7's named exceptions, frozen. */
export const PR7_TRANSITION_EXCEPTIONS = {
  calendly_webhook: { no_show: ["canceled"], canceled: ["no_show"] },
  payment_voided: { payment_received: ["lost"] },
  slack_stale_rejoin: { lost: ["scheduled"] },
} as const satisfies Record<string, Partial<Record<OpportunityStatus, readonly OpportunityStatus[]>>>;

/** PR 7's `validateTransition`. */
export function pr7ValidateTransition(from: OpportunityStatus, to: OpportunityStatus): boolean {
  return PR7_STATUS_TRANSITIONS[from].includes(to);
}

/** Every move PR 7 made, with the exception that allowed it. */
export function pr7Moves(): Array<[OpportunityStatus, OpportunityStatus, keyof typeof PR7_TRANSITION_EXCEPTIONS | undefined]> {
  const moves: Array<[OpportunityStatus, OpportunityStatus, keyof typeof PR7_TRANSITION_EXCEPTIONS | undefined]> = [];
  for (const [from, tos] of Object.entries(PR7_STATUS_TRANSITIONS) as [OpportunityStatus, readonly OpportunityStatus[]][])
    for (const to of tos) moves.push([from, to, undefined]);
  for (const [exception, rules] of Object.entries(PR7_TRANSITION_EXCEPTIONS) as [
    keyof typeof PR7_TRANSITION_EXCEPTIONS,
    Partial<Record<OpportunityStatus, readonly OpportunityStatus[]>>,
  ][])
    for (const [from, tos] of Object.entries(rules) as [OpportunityStatus, readonly OpportunityStatus[]][])
      for (const to of tos) moves.push([from, to, exception]);
  return moves;
}

/** A deal event, as the tests compare it. */
export function eventShape(event: Doc<"domainEvents">) {
  return {
    eventType: event.eventType,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reason: event.reason,
    metadata: event.metadata ? (JSON.parse(event.metadata) as Record<string, unknown>) : undefined,
  };
}

/** The deal's events, oldest first. */
export async function dealEvents(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  dealId: Id<"opportunities">,
) {
  const events = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
      q.eq("tenantId", tenantId).eq("entityType", "opportunity").eq("entityId", dealId),
    )
    .take(50);
  return events.map(eventShape);
}

/**
 * The revert property, for one deal: its stored status is the one
 * `legacyStatus` rebuilds from its stage, outcome, loss and pending
 * reschedule link, which is the status PR 7 would have written.
 */
export async function storedAndRebuiltStatus(ctx: QueryCtx, dealId: Id<"opportunities">) {
  const deal = (await ctx.db.get("opportunities", dealId))!;
  const { count } = await loadPendingRescheduleLink(ctx, dealId);
  return { stored: deal.status, rebuilt: legacyStatus(deal, { hasPendingRescheduleLink: count > 0 }) };
}

/**
 * The tenant's status copies agree with its deals: the active, won and lost
 * counters, and `opportunityByStatus` per status, recounted from the table.
 */
export async function expectStatusCopiesMatch(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const deals = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(200);
  const stats = await ctx.db
    .query("tenantStats")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .unique();
  expect({
    activeOpportunities: stats?.activeOpportunities ?? 0,
    wonDeals: stats?.wonDeals ?? 0,
    lostDeals: stats?.lostDeals ?? 0,
  }).toEqual({
    activeOpportunities: deals.filter((deal) => deal.status && isActiveOpportunityStatus(deal.status)).length,
    wonDeals: deals.filter((deal) => deal.status === "payment_received").length,
    lostDeals: deals.filter((deal) => deal.status === "lost").length,
  });
  const statuses = [...new Set(deals.map((deal) => deal.status))].filter(
    (status): status is OpportunityStatus => status !== undefined,
  );
  for (const status of statuses) {
    expect({
      status,
      count: await opportunityByStatus.count(ctx, { namespace: tenantId, bounds: { prefix: [status] } }),
    }).toEqual({ status, count: deals.filter((deal) => deal.status === status).length });
  }
}
