/**
 * A payment's DM attribution is its meeting's booking rows, else its deal's
 * first booking's (docs/plans/phase-3-attribution.md §6.5).
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedScenario, T0, type ScenarioName } from "../../tests/detailAttributionFixtures";
import { enrichBillingPaymentRows } from "./enrichment";

async function insertPayment(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    closerId: Id<"users">;
    opportunityId?: Id<"opportunities">;
    meetingId?: Id<"meetings">;
  },
) {
  const programId = await ctx.db.insert("tenantPrograms", {
    tenantId,
    name: "Program",
    normalizedName: "program",
    createdAt: T0,
    createdByUserId: args.closerId,
    updatedAt: T0,
  });
  return await ctx.db.insert("paymentRecords", {
    tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    attributedCloserId: args.closerId,
    amountMinor: 100_000,
    currency: "USD",
    recordedByUserId: args.closerId,
    commissionable: true,
    programId,
    programName: "Program",
    paymentType: "pif",
    status: "recorded",
    recordedAt: T0 + 1_000,
    contextType: "opportunity",
    origin: "closer_meeting",
  });
}

async function paymentDmAttribution(
  scenario: ScenarioName,
  options: { withDeal: boolean } = { withDeal: true },
) {
  const h = await bookingHarness();
  return await h.t.run(async (ctx) => {
    const seeded = await seedScenario(ctx, h.tenantId, scenario);
    const paymentId = await insertPayment(ctx, h.tenantId, {
      closerId: seeded.closer._id,
      opportunityId: options.withDeal ? seeded.opportunityId : undefined,
      meetingId: seeded.meetingId ?? undefined,
    });
    const payment = (await ctx.db.get("paymentRecords", paymentId))!;
    const [row] = await enrichBillingPaymentRows(ctx, h.tenantId, [payment]);
    return { dmAttribution: row.dmAttribution, seeded };
  });
}

describe("billing DM attribution", () => {
  it("labels a payment from its meeting's booking", async () => {
    const { dmAttribution, seeded } = await paymentDmAttribution("team_and_dm_closer");
    expect(dmAttribution).toMatchObject({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
      dmCloser: { id: seeded.dm.dmCloserId, source: "dm_closer" },
      rawSource: "alpha",
      rawMedium: "dana",
    });
  });

  it("labels a payment on a meeting never resolved from the deal's first booking", async () => {
    const { dmAttribution } = await paymentDmAttribution("unresolved_rebook");
    expect(dmAttribution).toMatchObject({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
    });
  });

  it("labels an internal rebook's payment as internal", async () => {
    const { dmAttribution } = await paymentDmAttribution("internal_rebook");
    expect(dmAttribution).toMatchObject({
      status: "internal",
      teamName: null,
      dmCloserName: null,
      rawSource: "ptdom",
    });
  });

  it("labels a payment with a meeting and no deal from the meeting's rows", async () => {
    const { dmAttribution, seeded } = await paymentDmAttribution("team_and_dm_closer", {
      withDeal: false,
    });
    expect(dmAttribution).toEqual({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
      dmCloser: expect.objectContaining({ id: seeded.dm.dmCloserId }),
      rawSource: "alpha",
      rawMedium: "dana",
    });
  });
});
