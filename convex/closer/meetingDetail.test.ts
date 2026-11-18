/**
 * The meeting page's DM team and DM closer come from the meeting's own
 * booking rows, or the deal's first booking's when the meeting was never
 * resolved (docs/plans/phase-3-attribution.md §6.5).
 */
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { seedProviderWin } from "../../tests/paymentInvariants";
import { FIXTURE_NOW, insertProviderMeeting, paymentConfirmationFixture } from "../../tests/providerPaymentFixtures";
import {
  seedCreditedDeal,
  seedScenario,
  type ScenarioName,
} from "../../tests/detailAttributionFixtures";

async function meetingDetailOf(scenario: ScenarioName) {
  const h = await bookingHarness();
  const seeded = await h.t.run((ctx) => seedScenario(ctx, h.tenantId, scenario));
  const detail = await h.admin.query(api.closer.meetingDetail.getMeetingDetail, {
    meetingId: seeded.meetingId!,
  });
  return { h, seeded, detail };
}

describe("meeting detail attribution", () => {
  it("shows a booking's team and DM closer", async () => {
    const { seeded, detail } = await meetingDetailOf("team_and_dm_closer");
    expect(detail.attributionTeam?._id).toBe(seeded.teamId);
    expect(detail.dmCloser?._id).toBe(seeded.dm.dmCloserId);
    expect(detail.dmCloserIdentity).toMatchObject({
      id: seeded.dm.dmCloserId,
      name: "Dana DM",
      source: "dm_closer",
    });
  });

  it("shows a team-only booking's team and no DM closer", async () => {
    const { seeded, detail } = await meetingDetailOf("team_only");
    expect(detail.attributionTeam?._id).toBe(seeded.teamId);
    expect(detail.dmCloser).toBeNull();
    expect(detail.dmCloserIdentity).toBeNull();
  });

  it("falls back to the deal's first booking for a meeting never resolved", async () => {
    const { seeded, detail } = await meetingDetailOf("unresolved_rebook");
    expect(detail.attributionTeam?._id).toBe(seeded.teamId);
    expect(detail.dmCloser?._id).toBe(seeded.dm.dmCloserId);
  });

  it("shows no team or DM closer on an internal rebook", async () => {
    const { detail } = await meetingDetailOf("internal_rebook");
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

it("shows the active Whop payment's not-my-sale flag and reflects its clearance", async () => {
  const f = await paymentConfirmationFixture();
  const { meetingId, paymentRecordId } = await f.t.run(async (ctx) => {
    const meetingId = await insertProviderMeeting(ctx, {
      ...f, opportunityId: f.dealId, scheduledAt: FIXTURE_NOW - 60_000,
    });
    const paymentRecordId = await seedProviderWin(ctx, {
      ...f, opportunityId: f.dealId, approverId: f.adminId, recordedAt: FIXTURE_NOW,
    });
    return { meetingId, paymentRecordId };
  });
  const detail = () => f.closer.query(api.closer.meetingDetail.getMeetingDetail, { meetingId });
  expect((await detail()).payments).toMatchObject([{ _id: paymentRecordId, notMySaleAt: null }]);
  await expect(f.closer.mutation(api.payments.notMySale.flagNotMySale, { paymentRecordId })).resolves.toMatchObject({ ok: true });
  const flag = await f.t.run((ctx) => ctx.db.get("providerPayments", f.providerPaymentId));
  expect(flag?.notMySaleAt).toBeTypeOf("number");
  expect((await detail()).payments).toMatchObject([{ _id: paymentRecordId, notMySaleAt: flag?.notMySaleAt }]);
  await expect(f.admin.mutation(api.payments.notMySale.clearNotMySale, { providerPaymentId: f.providerPaymentId }))
    .resolves.toMatchObject({ ok: true });
  expect((await detail()).payments).toMatchObject([{ _id: paymentRecordId, notMySaleAt: null }]);
});
