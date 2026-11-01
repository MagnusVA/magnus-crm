import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { guardHarness, insertGuardDeal, type GuardHarness, type GuardState } from "../../tests/dealGuardFixtures";
import { loadListDeals } from "./listDeal";

// Leads & Customers shows each person's newest open deal beside them, else
// their newest deal, with its closer and next step, and says whether the
// viewer may act on it.

const followUpWithReminder: GuardState = {
  label: "follow_up_scheduled with a reminder",
  status: "follow_up_scheduled",
  source: "calendly",
  task: "reminder",
};
const booked: GuardState = { label: "scheduled", status: "scheduled", source: "calendly" };
const won: GuardState = { label: "payment_received", status: "payment_received", source: "calendly" };

async function listDealOf(
  harness: GuardHarness,
  leadId: Id<"leads">,
  viewer: { userId: Id<"users">; isAdmin: boolean },
) {
  return await harness.t.run(async (ctx) => {
    const deals = await loadListDeals(ctx, { tenantId: harness.tenantId, ...viewer }, [leadId]);
    return deals.get(leadId) ?? null;
  });
}

async function insertDealsFor(harness: GuardHarness, states: Array<{ state: GuardState; createdAt: number }>) {
  return await harness.t.run(async (ctx) => {
    const ids: Array<Id<"opportunities">> = [];
    let leadId: Id<"leads"> | undefined;
    for (const { state, createdAt } of states) {
      const id = await insertGuardDeal(ctx, harness.tenantId, state, {
        createdAt,
        ...(leadId ? { leadId } : {}),
      });
      leadId ??= (await ctx.db.get("opportunities", id))!.leadId;
      ids.push(id);
    }
    return { leadId: leadId!, ids };
  });
}

describe("the deal beside a person in Leads & Customers", () => {
  it("is the newest open deal, with its next step, even when a newer deal closed", async () => {
    const harness = await guardHarness();
    const { leadId, ids } = await insertDealsFor(harness, [
      { state: followUpWithReminder, createdAt: 1_000 },
      { state: won, createdAt: 2_000 },
    ]);

    const deal = await listDealOf(harness, leadId, { userId: harness.closerId, isAdmin: false });

    expect(deal).toMatchObject({
      opportunityId: ids[0],
      position: "follow_up",
      isMine: true,
      canAct: true,
      otherOpenCount: 0,
      nextStep: { callAt: null, task: { kind: "task", method: "call", dueAt: 1_500 } },
    });
  });

  it("counts the other open deals beside the newest", async () => {
    const harness = await guardHarness();
    const { leadId, ids } = await insertDealsFor(harness, [
      { state: booked, createdAt: 1_000 },
      { state: followUpWithReminder, createdAt: 3_000 },
    ]);

    const deal = await listDealOf(harness, leadId, { userId: harness.closerId, isAdmin: false });

    expect(deal).toMatchObject({ opportunityId: ids[1], otherOpenCount: 1 });
  });

  it("falls back to the newest closed deal, with no next step", async () => {
    const harness = await guardHarness();
    const { leadId, ids } = await insertDealsFor(harness, [{ state: won, createdAt: 1_000 }]);

    const deal = await listDealOf(harness, leadId, { userId: harness.closerId, isAdmin: false });

    expect(deal).toMatchObject({ opportunityId: ids[0], position: "won", nextStep: null });
  });

  it("lets an admin act on another closer's deal, but not another closer", async () => {
    const harness = await guardHarness();
    const { leadId } = await insertDealsFor(harness, [{ state: followUpWithReminder, createdAt: 1_000 }]);

    const asAdmin = await listDealOf(harness, leadId, { userId: harness.adminId, isAdmin: true });
    expect(asAdmin).toMatchObject({ isMine: false, canAct: true });
    expect(asAdmin?.closerName).toBeTruthy();

    const asOtherCloser = await listDealOf(harness, leadId, { userId: harness.adminId, isAdmin: false });
    expect(asOtherCloser).toMatchObject({ isMine: false, canAct: false });
  });
});
