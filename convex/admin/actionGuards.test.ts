import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import {
  expectGuard,
  guardDealIn,
  guardHarness,
  guardStates,
  readGuardDeal,
  todaysGuards as today,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// The admin twins of the closer's actions, and the unavailability cancel,
// are allowed on the same deals as before PR 7
// (docs/plans/phase-5-deal-status.md §4.6, §6.4, §5).

const DAY_MS = 24 * 60 * 60 * 1000;

const calendlyStates = guardStates("calendly");
const meetingStates: GuardState[] = [
  ...calendlyStates,
  ...guardStates("side_deal").filter((state) => state.status === "scheduled"),
].map((state) => ({ ...state, label: `${state.label} (${state.source})` }));

describe("adminMarkAsLost", () => {
  it.each(calendlyStates)("without a meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.admin.mutation(api.admin.meetingActions.adminMarkAsLost, { opportunityId }),
      today.markLost(state.status),
    );
  });

  it.each(meetingStates)("with a scheduled meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.admin.mutation(api.admin.meetingActions.adminMarkAsLost, {
          opportunityId,
          meetingId: meetingId!,
        }),
      today.scheduled(state.status),
    );
  });
});

describe("admin follow-ups", () => {
  it.each(calendlyStates)("adminCreateFollowUp: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.admin.mutation(api.admin.meetingActions.adminCreateFollowUp, { opportunityId }),
      today.startFollowUp(state.status),
    );
  });

  it.each(calendlyStates)("adminConfirmFollowUp without a meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const allowed = today.followUpScheduled(state.status) || today.startFollowUp(state.status);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.admin.mutation(api.admin.meetingActions.adminConfirmFollowUp, { opportunityId }),
      allowed,
    );
    if (allowed) {
      expect((await readGuardDeal(harness, opportunityId)).status).toBe("follow_up_scheduled");
    }
  });

  it.each(meetingStates)("adminConfirmFollowUp with a scheduled meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.admin.mutation(api.admin.meetingActions.adminConfirmFollowUp, {
          opportunityId,
          meetingId: meetingId!,
        }),
      today.followUpScheduled(state.status) || today.scheduled(state.status),
    );
  });

  it.each(calendlyStates)("adminCreateManualReminder: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
          opportunityId,
          contactMethod: "call",
          reminderScheduledAt: Date.now() + DAY_MS,
        }),
      today.startFollowUp(state.status),
    );
  });
});

describe("admin meeting outcomes", () => {
  it.each(meetingStates)("adminMarkNoShow: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
          meetingId: meetingId!,
          reason: "no_response",
        }),
      today.scheduled(state.status),
    );
  });

  it.each(calendlyStates)("adminCreateRescheduleLink: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "no_show" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.admin.mutation(api.admin.meetingActions.adminCreateRescheduleLink, {
          opportunityId,
          meetingId: meetingId!,
        }),
      today.sendRescheduleLink(state.status),
    );
  });
});

describe("manuallyResolveMeeting, cancel", () => {
  it.each(meetingStates)("cancels the deal only from where it could: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    const unavailabilityId = await harness.t.run((ctx) =>
      ctx.db.insert("closerUnavailability", {
        tenantId: harness.tenantId,
        closerId: harness.closerId,
        date: 0,
        isFullDay: true,
        reason: "sick",
        createdByUserId: harness.adminId,
        createdAt: 0,
      }),
    );

    await harness.admin.mutation(api.unavailability.redistribution.manuallyResolveMeeting, {
      meetingId: meetingId!,
      unavailabilityId,
      action: "cancel",
    });

    const after = await readGuardDeal(harness, opportunityId);
    expect(after.status).toBe(today.canceledFrom(state.status) ? "canceled" : state.status);
    expect(after.cancellationReason).toBe("Canceled due to closer unavailability (Sick)");
  });
});
