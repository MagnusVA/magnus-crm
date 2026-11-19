import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import { guardDealIn, guardHarness, guardStates, type GuardState } from "../../tests/dealGuardFixtures";

// Deactivating a closer only takes away their login: their deals stay assigned
// to them whatever stage they're at.

const states: GuardState[] = [...guardStates("calendly"), ...guardStates("side_deal")].map((state) => ({
  ...state,
  label: `${state.label} (${state.source})`,
}));

describe("deactivating a closer with a deal", () => {
  it.each(states)("removeUser: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await harness.t.mutation(internal.workos.userMutations.removeUser, { userId: harness.closerId });
    expect((await harness.t.run((ctx) => ctx.db.get("users", harness.closerId)))!.isActive).toBe(false);
    const deal = await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId));
    expect(deal!.assignedCloserId).toBe(harness.closerId);
  });
});
