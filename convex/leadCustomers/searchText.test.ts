/**
 * A person's search row holds each deal's stage words, and a missed
 * meeting's on a deal one closed, instead of the status
 * (docs/plans/phase-5-deal-status.md §4.8, §6.1).
 */
import { describe, expect, it } from "vitest";
import { rebuildLeadCustomerSearchRow } from "./projection";
import { bookingHarness } from "../../tests/bookingHarness";
import { insertPerson, insertPersonDeal } from "../../tests/stageLabelFixtures";

describe("the person's search text", () => {
  it("searches the person by the stage words, and a missed meeting's", async () => {
    const h = await bookingHarness();
    const searchText = await h.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, h.tenantId);
      await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "no_show" });
      await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "payment_received" });
      await insertPersonDeal(ctx, { tenantId: h.tenantId, leadId, status: "scheduled", source: "side_deal" });
      await rebuildLeadCustomerSearchRow(ctx, h.tenantId, leadId);
      const row = await ctx.db
        .query("leadCustomerSearchRows")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", h.tenantId).eq("leadId", leadId))
        .unique();
      return row!.searchText;
    });
    for (const word of ["lost", "no show", "won", "call held"]) {
      expect(searchText).toContain(word);
    }
    for (const status of ["no_show", "payment_received", "scheduled"]) {
      expect(searchText).not.toContain(status);
    }
  });
});
