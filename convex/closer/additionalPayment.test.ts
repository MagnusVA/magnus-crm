import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  enrollmentHarness,
  enrollmentsOf,
  insertDeal,
  insertPerson,
  paySideDeal,
  sideDeal,
  twoPrograms as programs,
} from "../../tests/enrollmentFixtures";

afterEach(() => vi.useRealTimers());

// 10 won deals in production have no sold program
// (docs/plans/phase-4-customers.md §2.3, D14).
describe("additional payments on a deal with no sold program", () => {
  it("take the program from the deal's earliest payment that isn't disputed", async () => {
    const harness = await enrollmentHarness();
    const { programA } = await programs(harness);
    const created = await sideDeal(harness, "no-sold-program", { email: "buyer@example.com" });
    await paySideDeal(harness, created.opportunityId, programA, Date.parse("2026-10-05T10:00:00Z"));
    // As on the 10 deals won before the sold program cache existed.
    await harness.t.run((ctx) =>
      ctx.db.patch("opportunities", created.opportunityId, { soldProgramId: undefined, soldProgramName: undefined }),
    );
    const detail = await harness.closer.query(api.opportunities.detailQuery.getOpportunityDetail, {
      opportunityId: created.opportunityId,
    });
    expect(detail?.permissions).toMatchObject({ canRecordAdditionalPayment: true, additionalPaymentProgramName: "Program A" });

    const { paymentId } = await harness.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: created.opportunityId, amount: 200, currency: "USD", paymentType: "split",
    });

    const payment = await harness.t.run((ctx) => ctx.db.get("paymentRecords", paymentId));
    expect(payment).toMatchObject({ programId: programA, programName: "Program A" });
    expect((await enrollmentsOf(harness, created.leadId)).map((row) => row.programId)).toEqual([programA]);
  });

  it("still refuse a won deal with neither a sold program nor a payment", async () => {
    const harness = await enrollmentHarness();
    const opportunityId = await harness.t.run(async (ctx) => {
      const leadId = await insertPerson(ctx, harness.tenantId);
      const opportunityId = await insertDeal(ctx, harness.tenantId, leadId);
      await ctx.db.patch("opportunities", opportunityId, { assignedCloserId: harness.closerId });
      return opportunityId;
    });
    const detail = await harness.closer.query(api.opportunities.detailQuery.getOpportunityDetail, { opportunityId });
    expect(detail?.permissions).toMatchObject({ canRecordAdditionalPayment: false, additionalPaymentProgramName: null });

    await expect(
      harness.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
        opportunityId, amount: 200, currency: "USD", paymentType: "split",
      }),
    ).rejects.toThrow("no sold program or payment");
  });
});
