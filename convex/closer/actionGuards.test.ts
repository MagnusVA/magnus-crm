import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import {
  expectGuard,
  guardDealIn,
  guardHarness,
  guardStates,
  readGuardDeal,
  reminderOn,
  todaysGuards as today,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// The closer's actions are allowed on the same deals as before PR 7
// (docs/plans/phase-5-deal-status.md §4.6, §6.4): each runs against every
// deal state, and goes through exactly where today's status check let it.

const DAY_MS = 24 * 60 * 60 * 1000;

const calendlyStates = guardStates("calendly");
// The side deal a booking joined is `scheduled` with a meeting, and Call held.
const meetingStates: GuardState[] = [
  ...calendlyStates,
  ...guardStates("side_deal").filter((state) => state.status === "scheduled"),
].map((state) => ({ ...state, label: `${state.label} (${state.source})` }));

describe("markAsLost", () => {
  it.each(calendlyStates)("without a meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.closer.mutation(api.closer.meetingActions.markAsLost, { opportunityId }),
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
        harness.closer.mutation(api.closer.meetingActions.markAsLost, {
          opportunityId,
          meetingId: meetingId!,
        }),
      today.scheduled(state.status),
    );
  });
});

describe("the meeting's outcome", () => {
  it.each(meetingStates)("markNoShow: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.noShowActions.markNoShow, {
          meetingId: meetingId!,
          reason: "no_response",
        }),
      today.scheduled(state.status),
    );
  });

  it.each(meetingStates)("logPayment: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.payments.logPayment, {
          opportunityId,
          meetingId: meetingId!,
          amount: 500,
          currency: "USD",
          programId: harness.programId,
          paymentType: "pif",
        }),
      today.scheduled(state.status),
    );
  });

  it.each(calendlyStates)("createNoShowRescheduleLink: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "no_show" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.noShowActions.createNoShowRescheduleLink, {
          opportunityId,
          meetingId: meetingId!,
        }),
      today.sendRescheduleLink(state.status),
    );
  });
});

describe("follow-ups", () => {
  it.each(calendlyStates)("createSchedulingLinkFollowUp: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.closer.mutation(api.closer.followUpMutations.createSchedulingLinkFollowUp, { opportunityId }),
      today.startFollowUp(state.status),
    );
  });

  it.each(calendlyStates)("transitionToFollowUp: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.t.mutation(internal.closer.followUpMutations.transitionToFollowUp, { opportunityId }),
      today.startFollowUp(state.status),
    );
  });

  it.each(calendlyStates)("confirmFollowUpScheduled without a meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.closer.mutation(api.closer.followUpMutations.confirmFollowUpScheduled, { opportunityId }),
      today.followUpScheduled(state.status) || today.startFollowUp(state.status),
    );
    const after = await readGuardDeal(harness, opportunityId);
    if (today.followUpScheduled(state.status) || today.startFollowUp(state.status)) {
      // From PR 8 the status is legacyStatus of the deal it leaves: a stale
      // reschedule link left on a no-show deal (production has none) makes
      // the Follow-up deal `reschedule_link_sent`, as the guards already read
      // it; PR 7 stored `follow_up_scheduled` there, which assertDealStages
      // would have reported.
      expect(after.status).toBe(
        state.task === "reschedule_link" ? "reschedule_link_sent" : "follow_up_scheduled",
      );
    }
  });

  it.each(meetingStates)("confirmFollowUpScheduled with a scheduled meeting: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, state, { meeting: "scheduled" });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.followUpMutations.confirmFollowUpScheduled, {
          opportunityId,
          meetingId: meetingId!,
        }),
      today.followUpScheduled(state.status) || today.scheduled(state.status),
    );
  });

  it.each(calendlyStates)("createManualReminderFollowUpPublic: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, {
          opportunityId,
          contactMethod: "call",
          reminderScheduledAt: Date.now() + DAY_MS,
        }),
      today.startFollowUp(state.status),
    );
  });
});

describe("the reminder page", () => {
  it.each(calendlyStates)("logReminderPayment: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const followUpId = await reminderOn(harness, opportunityId);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
          followUpId,
          amount: 500,
          currency: "USD",
          programId: harness.programId,
          paymentType: "pif",
        }),
      today.takePayment(state.status),
    );
  });

  it.each(calendlyStates)("markReminderLost: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const followUpId = await reminderOn(harness, opportunityId);
    await expectGuard(
      harness,
      opportunityId,
      () => harness.closer.mutation(api.closer.reminderOutcomes.markReminderLost, { followUpId }),
      today.markLost(state.status),
    );
  });

  it.each(calendlyStates)("markReminderNoResponse, schedule a new one: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const followUpId = await reminderOn(harness, opportunityId);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.reminderOutcomes.markReminderNoResponse, {
          followUpId,
          nextStep: "schedule_new",
          newReminder: { contactMethod: "text", reminderScheduledAt: Date.now() + DAY_MS },
        }),
      today.followUpScheduled(state.status),
    );
  });

  it.each(calendlyStates)("markReminderNoResponse, give up: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const followUpId = await reminderOn(harness, opportunityId);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.reminderOutcomes.markReminderNoResponse, {
          followUpId,
          nextStep: "give_up",
        }),
      today.markLost(state.status),
    );
  });

  it.each(calendlyStates)("markReminderNoResponse, close only: $label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state);
    const followUpId = await reminderOn(harness, opportunityId);
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.reminderOutcomes.markReminderNoResponse, {
          followUpId,
          nextStep: "close_only",
        }),
      true,
    );
  });
});

describe("recordAdditionalPayment", () => {
  it.each(calendlyStates)("$label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, state, {
      fields: { soldProgramId: harness.programId, soldProgramName: "Program" },
    });
    await expectGuard(
      harness,
      opportunityId,
      () =>
        harness.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
          opportunityId,
          amount: 200,
          currency: "USD",
          paymentType: "split",
        }),
      today.won(state.status),
    );
  });
});
