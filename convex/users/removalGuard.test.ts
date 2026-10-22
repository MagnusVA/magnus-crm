import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import {
  guardDealIn,
  guardHarness,
  guardStates,
  todaysGuards as today,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// A closer with a Booked, Call held or Follow-up deal can't be removed, the
// deals `scheduled`, `follow_up_scheduled` and `reschedule_link_sent` named
// before PR 7 (docs/plans/phase-5-deal-status.md §6.9).

const states: GuardState[] = [...guardStates("calendly"), ...guardStates("side_deal")].map((state) => ({
  ...state,
  label: `${state.label} (${state.source})`,
}));

describe("removing a closer with a deal", () => {
  it.each(states)("getActiveAssignedOpportunityCount: $label", async (state) => {
    const harness = await guardHarness();
    await guardDealIn(harness, state);
    const count = await harness.t.query(internal.users.queries.getActiveAssignedOpportunityCount, {
      tenantId: harness.tenantId,
      userId: harness.closerId,
    });
    expect(count).toBe(today.blocksUserRemoval(state.status) ? 1 : 0);
  });

  it.each(states)("removeUser: $label", async (state) => {
    const harness = await guardHarness();
    await guardDealIn(harness, state);
    const remove = () => harness.t.mutation(internal.workos.userMutations.removeUser, { userId: harness.closerId });
    if (today.blocksUserRemoval(state.status)) {
      await expect(remove()).rejects.toThrow(ConvexError);
      expect((await harness.t.run((ctx) => ctx.db.get("users", harness.closerId)))!.isActive).toBe(true);
      return;
    }
    await remove();
    expect((await harness.t.run((ctx) => ctx.db.get("users", harness.closerId)))!.isActive).toBe(false);
  });

  it("counts a closer's other deals as not blocking", async () => {
    const harness = await guardHarness();
    await guardDealIn(harness, { label: "scheduled", status: "scheduled", source: "calendly" });
    const count = await harness.t.query(internal.users.queries.getActiveAssignedOpportunityCount, {
      tenantId: harness.tenantId,
      userId: harness.adminId,
    });
    expect(count).toBe(0);
  });
});
