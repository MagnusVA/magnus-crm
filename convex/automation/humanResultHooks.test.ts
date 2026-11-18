import type { FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { insertGuardTask } from "../../tests/dealGuardFixtures";
import { insertDeal, insertLatestMeeting } from "../../tests/dealStageFixtures";
import { insertPayment, insertProgram } from "../../tests/enrollmentFixtures";
import { crmLinkTracking, inviteeUri, missedMeetingHarness } from "../../tests/missedMeetingFixtures";
import {
  FIXTURE_NOW,
  insertProviderDeal,
  insertProviderPerson,
  providerPaymentFixture,
  seedAppliedReceipt,
  seedReadyDecision,
  setPaymentFixtureModes,
} from "../../tests/providerPaymentFixtures";
import { seedProviderWin } from "../../tests/paymentInvariants";
import { moveOpportunityToLead } from "../leads/repointLeadReferences";
import { WEB } from "../lib/outcomeCores";
import { moveCallbackCore } from "../mcp/tools/callbacks";
import { reconcilePaymentWrite } from "../payments/reconcileCheck";
import { repairCommitter } from "../mcp/admin/writes/repairs";
import { adminCreateFollowUpCore } from "../admin/meetingActions";
import { insertPaymentAggregate, insertMeetingAggregate } from "../reporting/writeHooks";
import { applyCoveragePlanCore, type CoveragePlanArgs } from "../unavailability/coverage";

const HOUR = 3_600_000;
const REMINDER_AT = FIXTURE_NOW + HOUR;
const CALENDLY = "https://calendly.com/closer/strategy";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Options = NonNullable<Parameters<typeof providerPaymentFixture>[0]> & {
  meeting?: Doc<"meetings">["status"];
  scheduledAt?: number;
  task?: Parameters<typeof insertGuardTask>[2];
};

async function fixture(options: Options = {}) {
  const h = await providerPaymentFixture(options);
  const dealId = h.dealId!;
  const ids = await h.t.run(async (ctx) => {
    await ctx.db.patch("users", h.closerId, { personalEventTypeUri: CALENDLY });
    const meetingId = options.meeting ? await insertLatestMeeting(ctx, dealId, {
      status: options.meeting,
      scheduledAt: options.scheduledAt ?? FIXTURE_NOW - HOUR,
    }) : undefined;
    if (meetingId) await insertMeetingAggregate(ctx, meetingId);
    const taskId = options.task ? await insertGuardTask(ctx, dealId, options.task) : undefined;
    const decisionId = await seedReadyDecision(ctx, {
      tenantId: h.tenantId,
      opportunityId: dealId,
      leadId: h.personId,
      providerPaymentId: h.providerPaymentId,
    });
    return { meetingId, taskId, decisionId };
  });
  return { ...h, ...ids, dealId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const dealArgs = (f: Fixture) => ({ opportunityId: f.dealId, meetingId: f.meetingId });
const taskArgs = (f: Fixture) => ({ followUpId: f.taskId! });
const callbackArgs = (f: Fixture) => ({
  ...dealArgs(f), contactMethod: "call" as const, reminderScheduledAt: REMINDER_AT,
});
const closerActor = (f: Fixture) => ({ tenantId: f.tenantId, userId: f.closerId, role: "closer" as const });
const adminActor = (f: Fixture) => ({ tenantId: f.tenantId, userId: f.adminId, role: "tenant_admin" as const });

type Write = () => Promise<unknown>;
type Step = { write: Write; refused: Write; retry: Write; retryRefused?: boolean };
type HumanCase = {
  name: string;
  options?: Options;
  prepare: (f: Fixture) => Step | Promise<Step>;
  deleted?: true;
};

function web<Ref extends FunctionReference<"mutation">>(
  f: Fixture,
  role: "closer" | "admin",
  ref: Ref,
  args: Ref["_args"],
): Step {
  const write = () => f[role].mutation<FunctionReference<"mutation">>(ref, args);
  return { write, refused: () => f.t.mutation<FunctionReference<"mutation">>(ref, args), retry: write, retryRefused: true };
}

const missed = { dealPosition: "lost", lostReason: "no_show", meeting: "no_show" } satisfies Options;

async function absence(f: Fixture, withRecord = true) {
  const date = Date.UTC(2026, 10, 17);
  return await f.t.run(async (ctx) => {
    const otherCloser = await ctx.db.insert("users", {
      tenantId: f.tenantId, workosUserId: "covering_closer", email: "cover@example.com",
      role: "closer", isActive: true,
    });
    const fields = { date, isFullDay: true, reason: "sick" as const };
    const unavailabilityId = withRecord ? await ctx.db.insert("closerUnavailability", {
      ...fields, tenantId: f.tenantId, closerId: f.closerId, createdByUserId: f.adminId, createdAt: FIXTURE_NOW,
    }) : undefined;
    return { otherCloser, unavailabilityId, ...fields };
  });
}

async function recording(f: Fixture) {
  return await f.t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("tenantFathomConnections", {
      tenantId: f.tenantId, apiKey: "", keyLast4: "", triggeredFor: [], connectionStatus: "connected",
      connectedByUserId: f.adminId, connectedAt: FIXTURE_NOW,
    });
    return await ctx.db.insert("callRecordings", {
      tenantId: f.tenantId, connectionId, recordedByUserId: f.closerId,
      recordedByEmail: "closer@example.com", fathomRecordingId: 1,
      title: "Sales call", url: "https://fathom.video/recording/1", shareUrl: "https://fathom.video/share/1",
      recordingStartAt: FIXTURE_NOW - HOUR, recordingEndAt: FIXTURE_NOW - HOUR / 2,
      inviteeEmails: [], matchStatus: "unmatched", createdAt: FIXTURE_NOW,
    });
  });
}

async function payment(f: Fixture) {
  return await f.t.run(async (ctx) => {
    const id = await insertPayment(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealId, programId: f.programId, recordedAt: FIXTURE_NOW - HOUR,
    });
    await insertPaymentAggregate(ctx, id);
    return id;
  });
}

async function attachedReview(f: Fixture, suffix = "review") {
  return await f.t.run(async (ctx) => {
    const other = await ctx.db.query("leads").withIndex("by_tenantId_and_email", (q) =>
      q.eq("tenantId", f.tenantId).eq("email", "other@example.com")).first()
      ?? { _id: await insertProviderPerson(ctx, f.tenantId, { email: "other@example.com" }) };
    const rawEventId = await ctx.db.insert("rawWebhookEvents", {
      tenantId: f.tenantId, calendlyEventUri: suffix, eventType: "invitee.created", payload: "{}",
      processed: true, receivedAt: FIXTURE_NOW,
    });
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      tenantId: f.tenantId, key: suffix, eventType: "invitee.created", inviteeUri: suffix,
      rawEventId, occurredAt: FIXTURE_NOW, receivedAt: FIXTURE_NOW, generation: 1, status: "applied",
      opportunityId: f.dealId, leadId: f.personId,
    });
    return await ctx.db.insert("bookingReviews", {
      tenantId: f.tenantId, deliveryId, kind: "attached", status: "open",
      reason: "identity_conflict", leadId: f.personId, conflicts: [{ leadId: other._id, via: "phone" }],
      booking: {}, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW,
    });
  });
}

const humanCases: HumanCase[] = [
  {
    name: "closer loss from the meeting",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "closer", api.closer.meetingActions.markAsLost, dealArgs(f)),
  },
  {
    name: "closer loss from the deal",
    prepare: (f) => web(f, "closer", api.closer.meetingActions.markAsLost, dealArgs(f)),
  },
  {
    name: "admin loss from the meeting",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminMarkAsLost, dealArgs(f)),
  },
  {
    name: "admin loss from the deal",
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminMarkAsLost, dealArgs(f)),
  },
  {
    name: "closer no-show",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "closer", api.closer.noShowActions.markNoShow, { meetingId: f.meetingId!, reason: "no_response" }),
  },
  {
    name: "admin no-show",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminMarkNoShow, { meetingId: f.meetingId!, reason: "no_response" }),
  },
  {
    name: "closer callback including held attendance",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "closer", api.closer.followUpMutations.createManualReminderFollowUpPublic, callbackArgs(f)),
  },
  {
    name: "admin manual reminder including held attendance",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminCreateManualReminder, callbackArgs(f)),
  },
  {
    name: "closer scheduling link",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "closer", api.closer.followUpMutations.createSchedulingLinkFollowUp, dealArgs(f)),
  },
  {
    name: "legacy closer scheduling link",
    prepare: (f) => {
      const args = { tenantId: f.tenantId, opportunityId: f.dealId, leadId: f.personId, closerId: f.closerId,
        schedulingLinkUrl: CALENDLY, reason: "closer_initiated" as const };
      const mutation = internal.closer.followUpMutations.createFollowUpRecord;
      const write = () => f.t.mutation(mutation, args);
      return {
        write, refused: () => f.t.mutation(mutation, { ...args, closerId: f.adminId }), retry: write, retryRefused: true,
      };
    },
  },
  {
    name: "admin scheduling link",
    options: { meeting: "scheduled" },
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminCreateFollowUp, dealArgs(f)),
  },
  {
    name: "admin second-opinion callback after a no-show",
    options: missed,
    prepare: (f) => {
      const run = (scheduledAt: number) => f.t.run((ctx) =>
        adminCreateFollowUpCore(ctx, adminActor(f), { ...dealArgs(f), callBack: { scheduledAt } }));
      const write = () => run(REMINDER_AT);
      return { write, refused: () => run(FIXTURE_NOW), retry: write, retryRefused: true };
    },
  },
  {
    name: "closer no-show reschedule link",
    options: missed,
    prepare: (f) => web(f, "closer", api.closer.noShowActions.createNoShowRescheduleLink, {
      ...dealArgs(f), meetingId: f.meetingId!,
    }),
  },
  {
    name: "admin no-show reschedule link",
    options: missed,
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminCreateRescheduleLink, {
      ...dealArgs(f), meetingId: f.meetingId!,
    }),
  },
  {
    name: "closer cancel an unfinished follow-up",
    options: { task: "scheduling_link" },
    prepare: (f) => web(f, "closer", api.closer.followUpMutations.cancelPendingFollowUp, taskArgs(f)),
  },
  {
    name: "admin cancel an unfinished follow-up",
    options: { task: "reminder" },
    prepare: (f) => web(f, "admin", api.admin.meetingActions.adminCancelPendingFollowUp, taskArgs(f)),
  },
  {
    name: "admin cancel a task on an open deal",
    options: { dealPosition: "follow_up", task: "reminder" },
    prepare: (f) => web(f, "admin", api.admin.dealActions.adminCancelTask, taskArgs(f)),
  },
  {
    name: "closer complete reminder",
    options: { dealPosition: "follow_up", task: "reminder" },
    prepare: (f) => web(f, "closer", api.closer.followUpMutations.markReminderComplete, taskArgs(f)),
  },
  {
    name: "MCP move callback",
    options: { dealPosition: "follow_up", task: "reminder" },
    prepare: (f) => {
      const move = (reminderScheduledAt: number) => f.t.run((ctx) => moveCallbackCore(ctx,
        closerActor(f), { ...taskArgs(f), reminderScheduledAt }, { via: "mcp", agentClient: "test" }));
      const write = () => move(REMINDER_AT);
      return { write, refused: () => move(FIXTURE_NOW), retry: write };
    },
  },
  {
    name: "closer cancel a link task",
    options: { dealPosition: "follow_up", task: "scheduling_link" },
    prepare: (f) => web(f, "closer", api.closer.linkTaskOutcomes.cancelLinkTask, taskArgs(f)),
  },
  {
    name: "closer close a link task as lost",
    options: { dealPosition: "follow_up", task: "scheduling_link" },
    prepare: (f) => web(f, "closer", api.closer.linkTaskOutcomes.markLinkTaskLost, taskArgs(f)),
  },
  {
    name: "admin auto-distribute multiple meetings on one deal",
    options: { meeting: "scheduled" },
    prepare: async (f) => {
      const a = await absence(f);
      const second = await f.t.run(async (ctx) => {
        const id = await insertLatestMeeting(ctx, f.dealId, {
          status: "scheduled", scheduledAt: FIXTURE_NOW + HOUR,
          calendlyEventUri: "coverage-second", calendlyInviteeUri: "coverage-second/person",
        });
        await insertMeetingAggregate(ctx, id);
        return id;
      });
      const step = web(f, "admin", api.unavailability.redistribution.autoDistributeMeetings, {
        unavailabilityId: a.unavailabilityId!, meetingIds: [f.meetingId!, second], candidateCloserIds: [a.otherCloser],
      });
      return { ...step, retryRefused: false };
    },
  },
  {
    name: "admin manually assign a meeting",
    options: { meeting: "scheduled" },
    prepare: async (f) => {
      const a = await absence(f);
      return web(f, "admin", api.unavailability.redistribution.manuallyResolveMeeting, {
        unavailabilityId: a.unavailabilityId!, meetingId: f.meetingId!, action: "assign", targetCloserId: a.otherCloser,
      });
    },
  },
  {
    name: "admin manually cancel a meeting",
    options: { meeting: "scheduled" },
    prepare: async (f) => {
      const a = await absence(f);
      const step = web(f, "admin", api.unavailability.redistribution.manuallyResolveMeeting, {
        unavailabilityId: a.unavailabilityId!, meetingId: f.meetingId!, action: "cancel",
      });
      return { ...step, retryRefused: false };
    },
  },
  {
    name: "MCP apply closer coverage",
    options: { meeting: "scheduled", scheduledAt: FIXTURE_NOW + HOUR },
    prepare: async (f) => {
      const a = await absence(f, false);
      const scheduledAt = FIXTURE_NOW + HOUR;
      const args: CoveragePlanArgs = { closerId: f.closerId, date: a.date, isFullDay: a.isFullDay, reason: a.reason,
        deals: [{
          opportunityId: f.dealId, toCloserId: a.otherCloser, affectedMeetingIds: [f.meetingId!],
          meetings: [{ meetingId: f.meetingId!, scheduledAt, durationMinutes: 30, status: "scheduled" }],
        }] };
      const write = () => f.t.run((ctx) => applyCoveragePlanCore(ctx, adminActor(f), args, WEB));
      return { write, refused: () => f.t.run((ctx) => applyCoveragePlanCore(ctx, closerActor(f), args, WEB)),
        retry: write, retryRefused: true };
    },
  },
  {
    name: "admin keep a booking review's people separate",
    prepare: async (f) => {
      const reviewId = await attachedReview(f);
      const sibling = await attachedReview(f, "sibling");
      const step = web(f, "admin", api.pipeline.bookingReviews.keepSeparate, { reviewId });
      return { ...step, write: async () => {
        expect(await step.write()).toEqual({ alsoClosed: 1 });
        expect(await f.t.run((ctx) => ctx.db.get("bookingReviews", sibling))).toMatchObject({ status: "resolved" });
      } };
    },
  },
  {
    name: "admin manually attach Fathom recording",
    options: { meeting: "scheduled" },
    prepare: async (f) => {
      const recordingId = await recording(f);
      const step = web(f, "admin", api.fathom.recordings.attach, { recordingId, meetingId: f.meetingId! });
      return { ...step, retryRefused: false };
    },
  },
  {
    name: "closer mark a side deal lost",
    options: { source: "side_deal", dealPosition: "call_held" },
    prepare: (f) => web(f, "closer", api.sideDeals.markLost.markLost, { opportunityId: f.dealId }),
  },
  {
    name: "closer delete an empty side deal",
    options: { source: "side_deal", dealPosition: "call_held" },
    prepare: (f) => web(f, "closer", api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity, { opportunityId: f.dealId }),
    deleted: true,
  },
  ...(["amount", "paymentType", "program"] as const).map((field): HumanCase => ({
    name: `admin correct a payment's ${field}`,
    options: { dealPosition: "won" },
    prepare: async (f) => {
      const paymentRecordId = await payment(f);
      const programId = await f.t.run((ctx) => insertProgram(ctx, f.tenantId, "Another program"));
      const fields = field === "amount" ? { amount: 70 } :
        field === "paymentType" ? { paymentType: "deposit" as const } : { programId };
      const step = web(f, "admin", api.billing.mutations.correctPayment, {
        paymentRecordId, ...fields, reason: "recorded incorrectly",
      });
      return { ...step, retryRefused: false };
    },
  })),
];

describe("human results", () => {
  it.each(humanCases)("$name", async ({ options, prepare, deleted }) => {
    const f = await fixture(options);
    const step = await prepare(f);
    const read = () => f.t.run(async (ctx) => ({
      deal: await ctx.db.get("opportunities", f.dealId),
      decision: await ctx.db.get("resultAutomationDecisions", f.decisionId),
    }));

    await expect(step.refused()).rejects.toThrow();
    const before = await read();
    expect(before.deal?.humanResultRevision).toBeUndefined();
    expect(before.decision).toMatchObject({ state: "ready" });

    await step.write();
    const after = await read();
    if (deleted) expect(after.deal).toBeNull();
    else expect(after.deal?.humanResultRevision).toBe(1);
    expect(after.decision).toMatchObject({ state: "stopped", stopCode: "human_result" });

    if (step.retryRefused) await expect(step.retry()).rejects.toThrow();
    else await step.retry();
    const retried = await read();
    expect(retried.deal?.humanResultRevision).toBe(after.deal?.humanResultRevision);
    expect(retried.decision).toEqual(after.decision);
  });
});

it("moves a manual recording between deals and bumps each one once", async () => {
  const f = await fixture({ meeting: "scheduled" });
  const recordingId = await recording(f);
  const { oldDealId, oldDecisionId } = await f.t.run(async (ctx) => {
    const oldDealId = await insertProviderDeal(ctx, {
      tenantId: f.tenantId, leadId: f.personId, assignedCloserId: f.closerId,
    });
    const oldMeetingId = await insertLatestMeeting(ctx, oldDealId, { status: "scheduled" });
    await ctx.db.patch("callRecordings", recordingId, { meetingId: oldMeetingId, matchStatus: "matched" });
    const oldDecisionId = await seedReadyDecision(ctx, {
      tenantId: f.tenantId, leadId: f.personId, opportunityId: oldDealId,
    });
    return { oldDealId, oldDecisionId };
  });
  const attach = () => f.admin.mutation(api.fathom.recordings.attach, { recordingId, meetingId: f.meetingId! });
  await attach();
  await attach();
  await f.t.run(async (ctx) => {
    for (const id of [f.dealId, oldDealId]) {
      expect((await ctx.db.get("opportunities", id))?.humanResultRevision).toBe(1);
    }
    for (const id of [f.decisionId, oldDecisionId]) {
      expect(await ctx.db.get("resultAutomationDecisions", id)).toMatchObject({
        state: "stopped", stopCode: "human_result",
      });
    }
  });
});

it("an admin closing a review as merged records the answer on its linked deal", async () => {
  const f = await fixture();
  const reviewId = await attachedReview(f);
  await f.t.run(async (ctx) => {
    const { conflicts } = (await ctx.db.get("bookingReviews", reviewId))!;
    await ctx.db.patch("leads", conflicts[0].leadId, { status: "merged", mergedIntoLeadId: f.personId });
  });
  const args = { reviewId };
  const write = () => f.admin.mutation(api.pipeline.bookingReviews.closeAsMerged, args);
  await expect(f.closer.mutation(api.pipeline.bookingReviews.closeAsMerged, args)).rejects.toThrow();
  await expectUnchanged(f);
  await write();
  await expect(write()).rejects.toThrow();
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get("opportunities", f.dealId))?.humanResultRevision).toBe(1);
    expect(await ctx.db.get("resultAutomationDecisions", f.decisionId)).toMatchObject({
      state: "stopped", stopCode: "human_result",
    });
  });
});

it.each([true, false])("identity review with a CRM link=%s stops the affected proposals once", async (linked) => {
  const f = await fixture();
  const reviewId = await attachedReview(f);
  await f.t.run(async (ctx) => {
    const review = (await ctx.db.get("bookingReviews", reviewId))!;
    const receipt = (await ctx.db.get("webhookDeliveries", review.deliveryId))!;
    await ctx.db.patch("bookingReviews", reviewId, {
      kind: "identity_check", leadId: undefined, reason: "phone_match_new_email",
      conflicts: [{ leadId: f.personId, via: "phone" }], booking: { email: "new@example.com" },
    });
    await ctx.db.patch("webhookDeliveries", receipt._id, {
      status: "blocked", reason: "phone_match_new_email", opportunityId: undefined,
    });
    if (linked) {
      await ctx.db.patch("rawWebhookEvents", receipt.rawEventId, {
        payload: JSON.stringify({ payload: { tracking: { utm_source: "ptdom", utm_campaign: f.dealId } } }),
      });
    }
  });
  const ref = api.pipeline.identityDecisions.decideIdentityCheck;
  const args = { reviewId, decision: "same_person" as const };
  const decide = () => f.admin.mutation(ref, args);
  await expect(f.closer.mutation(ref, args)).rejects.toThrow();
  await expectUnchanged(f);
  await decide();
  await expect(decide()).rejects.toThrow();
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get("opportunities", f.dealId))?.humanResultRevision).toBe(linked ? 1 : undefined);
    expect(await ctx.db.get("resultAutomationDecisions", f.decisionId)).toMatchObject({
      state: "stopped", stopCode: "human_result",
    });
  });
});

async function expectUnchanged(f: Fixture) {
  await f.t.run(async (ctx) => {
    expect((await ctx.db.get("opportunities", f.dealId))?.humanResultRevision).toBeUndefined();
    const decision = await ctx.db.get("resultAutomationDecisions", f.decisionId);
    expect(decision?.state).toBe("ready");
    expect(decision?.stopCode).toBeUndefined();
  });
}

describe("system and evidence-only writes", () => {
  const original = { key: "original", start: "2026-10-06T15:00:00Z" };
  const bookedAt = "2026-10-02T10:00:00Z";

  it.each(["booking through a link", "cancellation", "no-show", "withdrawn no-show", "redelivery", "MCP delivery retry"] as const)(
    "Calendly %s preserves the revision and ready decision",
    async (kind) => {
      const h = await missedMeetingHarness();
      const { opportunityId } = await h.book(original, bookedAt);
      if (kind === "booking through a link") {
        const deal = await h.deal(opportunityId);
        h.clockAt("2026-10-06T16:00:00Z");
        const { followUpId } = await h.closer.mutation(api.closer.followUpMutations.createSchedulingLinkFollowUp, {
          opportunityId, meetingId: deal!.latestMeetingId!,
        });
        const revision = (await h.deal(opportunityId))!.humanResultRevision!;
        const decisionId = await h.t.run((ctx) => seedReadyDecision(ctx, {
          tenantId: h.tenantId, opportunityId, leadId: deal!.leadId, humanResultRevision: revision,
        }));
        const rebooked = await h.book({
          key: "return", start: "2026-10-09T15:00:00Z",
          tracking: crmLinkTracking("follow_up", opportunityId, followUpId),
        }, "2026-10-07T19:00:00Z");
        expect(rebooked.opportunityId).toBe(opportunityId);
        expect((await h.deal(opportunityId))?.humanResultRevision).toBe(revision);
        expect(await h.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId))).toMatchObject({ state: "ready" });
        return;
      }

      const decisionId = await h.t.run((ctx) => seedReadyDecision(ctx, { tenantId: h.tenantId, opportunityId }));
      const readDecision = () => h.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId));
      const before = await readDecision();
      switch (kind) {
        case "cancellation":
          await h.deliver("invitee.canceled", { ...original, canceled: {} }, "2026-10-06T16:00:00Z");
          expect((await h.meeting(original.key))?.status).toBe("canceled");
          break;
        case "no-show":
        case "withdrawn no-show":
          await h.deliver("invitee_no_show.created", original, "2026-10-06T16:00:00Z");
          expect((await h.meeting(original.key))?.status).toBe("no_show");
          if (kind === "withdrawn no-show") {
            await h.deliver("invitee_no_show.deleted", original, "2026-10-06T17:00:00Z");
            expect((await h.meeting(original.key))?.status).toBe("scheduled");
          }
          break;
        case "redelivery":
          await h.deliver("invitee.created", original, bookedAt);
          expect(await h.dealCount()).toBe(1);
          break;
        case "MCP delivery retry": {
          const receipt = await h.receipt("invitee.created", original.key);
          const actor = await h.t.run(async (ctx) => {
            const user = (await ctx.db.query("users").withIndex("by_workosUserId", (q) =>
              q.eq("workosUserId", "user_admin")).unique())!;
            await ctx.db.patch("webhookDeliveries", receipt._id, { status: "failed" });
            return { tenantId: h.tenantId, userId: user._id, role: "tenant_admin" as const, agentClient: "test" };
          });
          const retry = () => h.t.run((ctx) => repairCommitter.apply(ctx, actor, {
            action: { kind: "retry_delivery", deliveryId: receipt._id, generation: receipt.generation },
          }, { via: "mcp", agentClient: "test" }));
          await retry();
          await expect(retry()).rejects.toThrow();
          await h.t.finishAllScheduledFunctions(vi.runAllTimers);
          break;
        }
      }
      expect((await h.deal(opportunityId))?.humanResultRevision).toBeUndefined();
      expect(await readDecision()).toEqual(before);
    },
  );

  it.each(["job", "migration"] as const)("Slack stale expiry via %s preserves the ready decision", async (path) => {
    if (path === "migration") {
      const h = await missedMeetingHarness();
      vi.setSystemTime(FIXTURE_NOW);
      const { dealId, decisionId } = await h.t.run(async (ctx) => {
        const dealId = await insertDeal(ctx, {
          tenantId: h.tenantId, status: "qualified_pending", source: "slack_qualified",
          fields: { createdAt: Date.UTC(2026, 8, 1) },
        });
        const { leadId } = (await ctx.db.get("opportunities", dealId))!;
        const decisionId = await seedReadyDecision(ctx, { tenantId: h.tenantId, leadId, opportunityId: dealId });
        return { dealId, decisionId };
      });
      await h.runMigration("expireStaleSlackBacklog");
      expect(await h.deal(dealId)).toMatchObject({ outcome: "lost", lostReason: "stale" });
      expect((await h.deal(dealId))?.humanResultRevision).toBeUndefined();
      expect(await h.t.run((ctx) => ctx.db.get("resultAutomationDecisions", decisionId))).toMatchObject({ state: "ready" });
      return;
    }
    const f = await fixture({ source: "slack_qualified", dealPosition: "qualified" });
    vi.setSystemTime(FIXTURE_NOW + 32 * 24 * HOUR);
    await f.t.mutation(internal.slack.staleExpiry.expireOne, { opportunityId: f.dealId });
    expect(await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId))).toMatchObject({ outcome: "lost", lostReason: "stale" });
    await expectUnchanged(f);
  });

  it("matches an automatic Fathom recording without recording attendance", async () => {
    const f = await fixture({ meeting: "scheduled" });
    const eventId = await f.t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("tenantFathomConnections", {
        tenantId: f.tenantId, apiKey: "", keyLast4: "", triggeredFor: [], connectionStatus: "connected",
        connectedByUserId: f.adminId, connectedAt: FIXTURE_NOW,
      });
      await ctx.db.insert("fathomOrgMembers", {
        tenantId: f.tenantId, email: "closer@example.com", lastSyncedAt: FIXTURE_NOW,
        ignored: false, matchedUserId: f.closerId,
      });
      return await ctx.db.insert("fathomWebhookEvents", {
        tenantId: f.tenantId, connectionId, webhookMessageId: "recording-one",
        payload: "{}", receivedAt: FIXTURE_NOW, status: "pending",
      });
    });
    const commit = () => f.t.mutation(internal.fathom.processor.commit, {
      eventId, transcriptLineCount: 0, data: {
        fathomRecordingId: 1, recordedByEmail: "closer@example.com", title: "Sales call",
        url: "https://fathom.video/recording/1", shareUrl: "https://fathom.video/share/1",
        recordingStartAt: FIXTURE_NOW - HOUR, recordingEndAt: FIXTURE_NOW - HOUR / 2,
        hasExternalInvitee: true, inviteeEmails: [], actionItems: [],
      },
    });
    expect(await commit()).toBe(true);
    expect(await commit()).toBe(false);
    expect(await f.t.run((ctx) => ctx.db.query("callRecordings")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", f.meetingId!)).unique())).toMatchObject({
      matchStatus: "matched", matchMethod: "time_only",
    });
    await expectUnchanged(f);
  });

  it("MCP retry of projection work and linking a Fathom staff mapping leave the deal alone", async () => {
    const f = await fixture({ meeting: "scheduled" });
    const { id, memberId } = await f.t.run(async (ctx) => ({
      id: await ctx.db.insert("opportunityProjectionJobs", {
        tenantId: f.tenantId, opportunityId: f.dealId, status: "failed", generation: 1,
        requestedAt: FIXTURE_NOW, cursor: null, dirty: false,
      }),
      memberId: await ctx.db.insert("fathomOrgMembers", {
        tenantId: f.tenantId, email: "closer@example.com", lastSyncedAt: FIXTURE_NOW, ignored: false,
      }),
    }));
    const actor = { ...adminActor(f), agentClient: "test" };
    const mcp = { via: "mcp", agentClient: "test" } as const;
    await f.t.run((ctx) => repairCommitter.apply(ctx, actor, {
      action: { kind: "retry_projection", projection: "opportunity", id, generation: 1 },
    }, mcp));
    await f.t.run((ctx) => repairCommitter.apply(ctx, actor, {
      action: { kind: "link_fathom_recorder", memberId, userId: f.closerId },
    }, mcp));
    await expectUnchanged(f);
  });

  it("booking a pending follow-up through the legacy system helper preserves the ready decision", async () => {
    const f = await fixture({ dealPosition: "follow_up", task: "scheduling_link" });
    await f.t.mutation(internal.closer.followUpMutations.markFollowUpBooked, {
      opportunityId: f.dealId, calendlyEventUri: inviteeUri("through-link"), occurredAt: FIXTURE_NOW,
    });
    expect(await f.t.run((ctx) => ctx.db.get("followUps", f.taskId!))).toMatchObject({ status: "booked" });
    await expectUnchanged(f);
  });

  it("an automatic stale side-deal nudge leaves the ready decision", async () => {
    const f = await fixture({ dealPosition: "call_held", source: "side_deal" });
    await f.t.mutation(internal.opportunities.staleness.nudgeStaleSideDeals, { cutoff: FIXTURE_NOW });
    expect(await f.t.run((ctx) => ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", f.dealId)
        .eq("status", "pending").eq("reason", "stale_opportunity_nudge")).first())).not.toBeNull();
    await expectUnchanged(f);
  });

  it("Billing review, its retry and reference/note corrections leave the ready decision", async () => {
    const f = await fixture({ dealPosition: "won" });
    const paymentRecordId = await payment(f);
    const review = () => f.admin.mutation(api.billing.mutations.markReviewed, { paymentRecordId });
    await review();
    await review();
    await f.admin.mutation(api.billing.mutations.correctPayment, {
      paymentRecordId, reason: "Add the wire reference", referenceCode: "WIRE-1", note: "Wire arrived",
    });
    await expectUnchanged(f);
  });

  it("creating a side deal by hand and retrying the same request skip the hook", async () => {
    const f = await fixture();
    const args = { clientRequestId: "new-side-deal", existingLeadId: f.personId };
    const created = await f.closer.mutation(api.opportunities.createManual.createManual, args);
    expect(await f.closer.mutation(api.opportunities.createManual.createManual, args)).toEqual(created);
    expect((await f.t.run((ctx) => ctx.db.get("opportunities", created.opportunityId)))?.humanResultRevision).toBeUndefined();
    await expectUnchanged(f);
  });
});

describe("person merges and deal moves", () => {
  it.each(["lead merge", "booking review", "operator", "deal move"] as const)(
    "%s supersedes both people's decisions with merged",
    async (entry) => {
      const f = await fixture();
      const reviewId = entry === "booking review" ? await attachedReview(f) : undefined;
      const { other, otherDeal, onExistingDeal, personOnlyDecision } = await f.t.run(async (ctx) => {
        const other = reviewId
          ? (await ctx.db.get("bookingReviews", reviewId))!.conflicts[0].leadId
          : await insertProviderPerson(ctx, f.tenantId, { email: "other@example.com" });
        const otherDeal = await insertProviderDeal(ctx, { tenantId: f.tenantId, leadId: other, position: "follow_up" });
        return {
          other, otherDeal,
          onExistingDeal: await seedReadyDecision(ctx, { tenantId: f.tenantId, leadId: other, opportunityId: otherDeal }),
          personOnlyDecision: await seedReadyDecision(ctx, { tenantId: f.tenantId, leadId: other }),
        };
      });
      const args = { sourceLeadId: f.personId, targetLeadId: other };
      const invoke = () => {
        switch (entry) {
          case "lead merge":
            return f.admin.mutation(api.leads.merge.mergeLead, args);
          case "booking review":
            return f.admin.mutation(api.pipeline.bookingReviews.mergePeople, { reviewId: reviewId!, keepLeadId: other });
          case "operator":
            return f.t.mutation(internal.leads.merge.mergeLeadAsOperator, { ...args, tenantId: f.tenantId, actorUserId: f.adminId });
          case "deal move":
            return f.t.run((ctx) => moveOpportunityToLead(ctx, {
              tenantId: f.tenantId, opportunityId: f.dealId, toLeadId: other, leadName: "Other person",
              now: FIXTURE_NOW, moveFormResponses: false, humanMove: { userId: f.adminId },
            }));
        }
      };
      await expect(f.t.mutation(api.leads.merge.mergeLead, args)).rejects.toThrow();
      await expectUnchanged(f);
      await invoke();
      if (entry === "deal move") await invoke();
      else await expect(invoke()).rejects.toThrow();
      await f.t.run(async (ctx) => {
        expect(await ctx.db.get("opportunities", f.dealId)).toMatchObject({ leadId: other, humanResultRevision: 1 });
        const survivor = await ctx.db.get("opportunities", otherDeal);
        expect(survivor?.humanResultRevision).toBe(entry === "deal move" ? undefined : 1);
        for (const id of [f.decisionId, onExistingDeal, personOnlyDecision]) {
          expect(await ctx.db.get("resultAutomationDecisions", id)).toMatchObject({
            state: "superseded", stopCode: "merged", resolvedByUserId: f.adminId,
          });
        }
      });
    },
  );
});

it("an accepted Whop payment and its receipt survive a merge while the old proposal is superseded", async () => {
  const f = await fixture();
  const { targetLeadId, paymentRecordId, receiptId } = await f.t.run(async (ctx) => {
    const targetLeadId = await insertProviderPerson(ctx, f.tenantId, { email: "surviving@example.com" });
    const paymentRecordId = await seedProviderWin(ctx, {
      tenantId: f.tenantId, opportunityId: f.dealId, providerPaymentId: f.providerPaymentId,
      programId: f.programId, closerId: f.closerId, approverId: f.adminId, recordedAt: FIXTURE_NOW,
    });
    const receiptId = await seedAppliedReceipt(ctx, {
      tenantId: f.tenantId, leadId: f.personId, opportunityId: f.dealId,
      providerPaymentId: f.providerPaymentId, appliedPaymentRecordId: paymentRecordId,
    });
    return { targetLeadId, paymentRecordId, receiptId };
  });
  await f.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: f.personId, targetLeadId });

  await f.t.run(async (ctx) => {
    expect(await ctx.db.get("opportunities", f.dealId)).toMatchObject({
      leadId: targetLeadId, outcome: "won", humanResultRevision: 1,
    });
    expect(await ctx.db.get("providerPayments", f.providerPaymentId)).toMatchObject({
      leadId: targetLeadId, opportunityId: f.dealId, paymentRecordId, reviewState: "recorded",
    });
    expect(await ctx.db.get("paymentRecords", paymentRecordId)).toMatchObject({
      opportunityId: f.dealId, providerPaymentId: f.providerPaymentId,
    });
    expect(await ctx.db.get("resultAutomationDecisions", receiptId)).toMatchObject({
      state: "applied", appliedPaymentRecordId: paymentRecordId,
    });
    expect(await ctx.db.get("resultAutomationDecisions", f.decisionId)).toMatchObject({
      state: "superseded", stopCode: "merged", humanResultRevision: 0,
    });
  });
});

it("merge drains older person-only proposals in batches and leaves new proposals alone", async () => {
  const f = await fixture();
  const { targetLeadId, decisions } = await f.t.run(async (ctx) => {
    const targetLeadId = await insertProviderPerson(ctx, f.tenantId, { email: "survivor@example.com" });
    const decisions: Id<"resultAutomationDecisions">[] = [];
    for (let index = 0; index < 110; index += 1) {
      decisions.push(await seedReadyDecision(ctx, {
        tenantId: f.tenantId, leadId: targetLeadId, createdAt: FIXTURE_NOW + index,
      }));
    }
    return { targetLeadId, decisions };
  });
  await f.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: f.personId, targetLeadId });
  const newest = await f.t.run((ctx) => seedReadyDecision(ctx, {
    tenantId: f.tenantId, leadId: targetLeadId, createdAt: FIXTURE_NOW + 111,
  }));
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);

  const read = () => f.t.run(async (ctx) => ({
    old: await Promise.all(decisions.map((id) => ctx.db.get("resultAutomationDecisions", id))),
    newest: await ctx.db.get("resultAutomationDecisions", newest),
  }));
  const { old, newest: fresh } = await read();
  expect(old.every((decision) => decision?.state === "superseded" && decision.stopCode === "merged")).toBe(true);
  expect(fresh).toMatchObject({ state: "ready" });
});

it("refuses a formerly valid Whop confirmation after the deal's person merges", async () => {
  const f = await fixture({ fact: { reviewState: "needs_person" } });
  const targetLeadId = await f.t.run(async (ctx) => {
    await setPaymentFixtureModes(ctx, f);
    return await insertProviderPerson(ctx, f.tenantId, { email: undefined });
  });
  const confirm = () => f.t.run(async (ctx) => {
    const deal = (await ctx.db.get("opportunities", f.dealId))!;
    return await reconcilePaymentWrite(ctx, deal, "meeting", [], {
      kind: "confirm", providerPaymentId: f.providerPaymentId,
      expectedAllocationRevision: 0, decisionId: f.decisionId,
    });
  });
  expect(await confirm()).toMatchObject({ action: "insert_from_provider", decisionId: f.decisionId });
  await f.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: f.personId, targetLeadId });
  await expect(confirm()).rejects.toMatchObject({ data: { code: "payment.stale_preview" } });
});
