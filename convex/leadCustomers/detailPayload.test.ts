/**
 * The person page shows the person's first and latest touch, and each deal's
 * attribution rows and touches (docs/plans/phase-3-attribution.md §6.5).
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedCreditedDeal } from "../../tests/detailAttributionFixtures";

async function personDetail() {
  const h = await bookingHarness();
  const seeded = await h.t.run((ctx) => seedCreditedDeal(ctx, h.tenantId));
  const detail = await h.admin.query(api.leadCustomers.detail.getEntityDetail, {
    leadId: seeded.leadId,
  });
  if (detail?.kind !== "detail") throw new Error("Expected the person's detail");
  return { seeded, detail };
}

describe("person detail touches and credit", () => {
  it("shows the person's touches, with who made each", async () => {
    const { seeded, detail } = await personDetail();

    expect(detail.firstTouch).toMatchObject({
      eventId: seeded.captureEventId,
      channel: "lead_gen",
      occurredAt: seeded.capturedAt,
      teamMemberName: "Wendy Worker",
    });
    // The person's latest touch is the rebook, credited to its DM closer.
    expect(detail.latestTouch).toMatchObject({
      eventId: seeded.rebook.eventId,
      eventType: "meeting.created",
      channel: "calendly",
      occurredAt: seeded.rebook.meeting.createdAt,
      teamMemberName: "Dirk DM",
      teamMember: { id: seeded.dirk.dmCloserId, source: "dm_closer" },
    });
  });

  it("shows each deal's rows and the touches it copied when created", async () => {
    const { detail } = await personDetail();

    const [deal] = detail.opportunities;
    expect(deal.attribution?.credits.map((credit) => credit.role)).toEqual([
      "lead_gen", "setter", "dm_team", "dm_team", "dm_closer", "dm_closer", "closer", "closer",
    ]);
    expect(deal.attribution?.firstTouch).toMatchObject({ channel: "lead_gen" });
    expect(deal.attribution?.latestTouch).toMatchObject({ channel: "slack" });
    expect(deal.attribution?.dmAttribution).toMatchObject({
      status: "mapped", teamName: "Alpha Team", dmCloserName: "Dana DM",
    });
  });
});
