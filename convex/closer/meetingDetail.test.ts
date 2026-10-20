/**
 * The meeting page's DM team and DM closer come from the meeting's own
 * booking rows, or the deal's first booking's when the meeting was never
 * resolved (docs/plans/phase-3-attribution.md §6.5).
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import {
  seedCreditedDeal,
  seedScenario,
  type ScenarioName,
} from "../../tests/detailAttributionFixtures";

async function meetingDetailOf(scenario: ScenarioName, copies: boolean) {
  const h = await bookingHarness();
  const seeded = await h.t.run((ctx) => seedScenario(ctx, h.tenantId, scenario, { copies }));
  const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: seeded.meetingId!,
  });
  return { h, seeded, detail };
}

describe.each([
  { copies: true, label: "with the copied columns beside the rows" },
  { copies: false, label: "from the rows alone" },
])("meeting detail attribution $label", ({ copies }) => {
  it("shows a booking's team and DM closer", async () => {
    const { seeded, detail } = await meetingDetailOf("team_and_dm_closer", copies);
    expect(detail.attributionTeam?._id).toBe(seeded.teamId);
    expect(detail.dmCloser?._id).toBe(seeded.dm.dmCloserId);
    expect(detail.dmCloserIdentity).toMatchObject({
      id: seeded.dm.dmCloserId,
      name: "Dana DM",
      source: "dm_closer",
    });
  });

  it("shows a team-only booking's team and no DM closer", async () => {
    const { seeded, detail } = await meetingDetailOf("team_only", copies);
    expect(detail.attributionTeam?._id).toBe(seeded.teamId);
    expect(detail.dmCloser).toBeNull();
    expect(detail.dmCloserIdentity).toBeNull();
  });

  it("falls back to the deal's first booking for a meeting never resolved", async () => {
    const { seeded, detail } = await meetingDetailOf("unresolved_rebook", copies);
    expect(detail.attributionTeam?._id).toBe(seeded.teamId);
    expect(detail.dmCloser?._id).toBe(seeded.dm.dmCloserId);
  });

  it("shows no team or DM closer on an internal rebook", async () => {
    const { detail } = await meetingDetailOf("internal_rebook", copies);
    expect(detail.attributionTeam).toBeNull();
    expect(detail.dmCloser).toBeNull();
    expect(detail.dmCloserIdentity).toBeNull();
  });
});

describe("meeting detail credit", () => {
  it("shows a rebook's own DM closer, and every row and touch of its deal", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run((ctx) => seedCreditedDeal(ctx, h.tenantId));
    const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, {
      meetingId: seeded.rebook.meeting._id,
    });

    expect(detail.dmCloser?._id).toBe(seeded.dirk.dmCloserId);
    expect(detail.dealAttribution.credits.map((credit) => [credit.role, credit.name])).toEqual([
      ["lead_gen", "Wendy Worker"],
      ["setter", "Sam Setter"],
      ["dm_team", "Alpha Team"],
      ["dm_team", "Alpha Team"],
      ["dm_closer", "Dana DM"],
      ["dm_closer", "Dirk DM"],
      ["closer", "closer@example.com"],
      ["closer", "closer@example.com"],
    ]);
    expect(detail.dealAttribution.firstTouch).toMatchObject({
      channel: "lead_gen", teamMemberName: "Wendy Worker",
    });
    expect(detail.dealAttribution.latestTouch).toMatchObject({
      channel: "slack", teamMemberName: "Sam Setter",
    });
  });

  it("shows the assigned closer the credit on their own meeting", async () => {
    const h = await bookingHarness();
    const seeded = await h.t.run((ctx) => seedCreditedDeal(ctx, h.tenantId));
    const detail = await h.closer.query(api.closer.meetingDetail.getMeetingDetail, {
      meetingId: seeded.first.meeting._id,
    });
    expect(detail.dmCloser?._id).toBe(seeded.dana.dmCloserId);
    expect(detail.dealAttribution.credits).toHaveLength(8);
  });
});
