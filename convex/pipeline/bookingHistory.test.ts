import { expect, it } from "vitest";
import { bookingHarness } from "../../tests/bookingHarness";
import { opportunityStatusAt, wasUnattachableAt } from "./bookingHistory";
import type { OpportunityStatus } from "../lib/statusTransitions";

const T = Date.parse("2026-10-14T09:13:23Z");

async function statusAt(
  current: OpportunityStatus,
  changes: Array<[at: number, from: OpportunityStatus | undefined, to: OpportunityStatus]>,
  createdAt = T - 60_000,
) {
  const { t, tenantId } = await bookingHarness();
  return await t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", {
      tenantId, email: "lead@example.com", status: "active", firstSeenAt: createdAt, updatedAt: createdAt,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId, leadId, status: current, source: "calendly", createdAt, updatedAt: T + 21_000,
    });
    for (const [at, from, to] of changes)
      await ctx.db.insert("domainEvents", {
        tenantId, entityType: "opportunity", entityId: opportunityId,
        eventType: from ? "opportunity.status_changed" : "opportunity.created",
        occurredAt: at, source: "pipeline", fromStatus: from, toStatus: to,
      });
    const opportunity = (await ctx.db.get("opportunities", opportunityId))!;
    return {
      status: await opportunityStatusAt(ctx, opportunity, T),
      unattachable: await wasUnattachableAt(ctx, opportunity, T),
    };
  });
}

it("reads a deal's status at a time from the changes it recorded after", async () => {
  expect(await statusAt("canceled", [
    [T - 60_000, undefined, "scheduled"],
    [T + 21_000, "scheduled", "canceled"],
  ])).toEqual({ status: "scheduled", unattachable: true });
  expect(await statusAt("scheduled", [
    [T + 1_000, "canceled", "scheduled"],
  ])).toEqual({ status: "canceled", unattachable: false });
  // No status change since: the deal had its current status.
  expect(await statusAt("scheduled", [])).toEqual({ status: "scheduled", unattachable: true });
});

it("doesn't answer when the recorded changes don't account for the current status", async () => {
  // A gap: two changes that don't chain.
  expect(await statusAt("canceled", [
    [T + 1_000, "scheduled", "no_show"],
    [T + 2_000, "follow_up_scheduled", "canceled"],
  ])).toEqual({ status: undefined, unattachable: false });
  // The last change doesn't end at the current status.
  expect(await statusAt("canceled", [
    [T + 1_000, "scheduled", "no_show"],
  ])).toEqual({ status: undefined, unattachable: false });
});

it("treats a deal created after the time as within reach", async () => {
  expect(await statusAt("scheduled", [], T + 1_000)).toEqual({ status: "scheduled", unattachable: false });
});
