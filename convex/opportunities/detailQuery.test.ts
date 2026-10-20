/**
 * The deal page's attribution: the first booking's DM team and DM closer,
 * every row on the deal, and its touches (docs/plans/phase-3-attribution.md
 * §6.5).
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedCreditedDeal } from "../../tests/detailAttributionFixtures";

describe("deal detail attribution", () => {
  it("credits the first booking and lists every row and touch", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run((ctx) => seedCreditedDeal(ctx, h.tenantId));
    const detail = await h.admin.query(api.opportunities.detailQuery.getOpportunityDetail, {
      opportunityId: seeded.opportunityId,
    });

    expect(detail?.attribution.dmAttribution).toMatchObject({
      status: "mapped",
      teamName: "Alpha Team",
      dmCloserName: "Dana DM",
    });
    expect(
      detail?.attribution.credits
        .filter((credit) => credit.role === "dm_closer")
        .map((credit) => [credit.name, credit.meetingId]),
    ).toEqual([
      ["Dana DM", seeded.first.meeting._id],
      ["Dirk DM", seeded.rebook.meeting._id],
    ]);
    expect(detail?.attribution.firstTouch).toMatchObject({ channel: "lead_gen", teamMemberName: "Wendy Worker" });
    expect(detail?.attribution.latestTouch).toMatchObject({ channel: "slack", teamMemberName: "Sam Setter" });
  });
});
