import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { loadActiveFollowUpSummary } from "../lib/activeFollowUp";
import {
  guardDealIn,
  guardHarness,
  readGuardDeal,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// A scheduling link generated from the meeting page leaves the deal Booked
// until the closer confirms it. While it is pending the outcome buttons are
// hidden, so the meeting page offers to finish it (the confirm mutations) or
// cancel it (`cancelPendingFollowUp`, `adminCancelPendingFollowUp`).

const booked: GuardState = { label: "scheduled", status: "scheduled", source: "calendly" };
const bookedWithLink: GuardState = { ...booked, task: "scheduling_link" };
const followUpWithLink: GuardState = {
  label: "follow_up_scheduled with a pending scheduling link",
  status: "follow_up_scheduled",
  source: "calendly",
  task: "scheduling_link",
};

async function pendingFollowUpOf(
  harness: GuardHarness,
  opportunityId: Id<"opportunities">,
): Promise<Id<"followUps">> {
  const summary = await harness.t.run((ctx) => loadActiveFollowUpSummary(ctx, opportunityId));
  expect(summary).not.toBeNull();
  return summary!._id;
}

async function followUpEvents(harness: GuardHarness, followUpId: Id<"followUps">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("entityType", "followUp").eq("entityId", followUpId),
      )
      .take(10),
  );
}

/** A second closer in the same tenant, who isn't assigned the deal. */
async function otherCloser(harness: GuardHarness) {
  await harness.t.run((ctx) =>
    ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_other_closer",
      email: "other@example.com",
      role: "closer",
      isActive: true,
    }),
  );
  return harness.t.withIdentity({ subject: "user_other_closer", org_id: "org_test" });
}

/** An admin of another tenant. */
async function otherTenantAdmin(harness: GuardHarness) {
  await harness.t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      businessDayAppliedVersion: 0,
      companyName: "Other",
      contactEmail: "other-admin@example.com",
      workosOrgId: "org_other",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_other_admin",
      email: "other-admin@example.com",
      role: "tenant_admin",
      isActive: true,
    });
  });
  return harness.t.withIdentity({ subject: "user_other_admin", org_id: "org_other" });
}

describe("closing the dialog after Generate", () => {
  it("the generated link hides the outcome buttons until the confirm moves the deal and holds the meeting", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, booked, { meeting: "scheduled" });

    const { followUpId } = await harness.closer.mutation(
      api.closer.followUpMutations.createSchedulingLinkFollowUp,
      { opportunityId },
    );
    // Generate alone leaves the deal Booked with a pending link: the state the
    // meeting page now shows as an unfinished follow-up.
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("booked");
    expect(await pendingFollowUpOf(harness, opportunityId)).toBe(followUpId);

    // The dialog's close runs the same confirm as Done.
    await harness.closer.mutation(api.closer.followUpMutations.confirmFollowUpScheduled, {
      opportunityId,
      meetingId: meetingId!,
    });
    const deal = await readGuardDeal(harness, opportunityId);
    expect(deal.stage).toBe("follow_up");
    expect(deal.outcome).toBe("open");
    const meeting = await harness.t.run((ctx) => ctx.db.get("meetings", meetingId!));
    expect(meeting!.status).toBe("held");
    // The link stays pending for the booking to find.
    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("pending");
  });

  it("the admin's confirm finishes a link left pending on a Booked deal", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, bookedWithLink, {
      meeting: "scheduled",
    });

    await harness.admin.mutation(api.admin.meetingActions.adminConfirmFollowUp, {
      opportunityId,
      meetingId: meetingId!,
    });
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("follow_up");
    const meeting = await harness.t.run((ctx) => ctx.db.get("meetings", meetingId!));
    expect(meeting!.status).toBe("held");
  });
});

describe("cancelPendingFollowUp", () => {
  it("expires the link and leaves the deal and the meeting where they were", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, bookedWithLink, {
      meeting: "scheduled",
    });
    const followUpId = await pendingFollowUpOf(harness, opportunityId);
    const before = await readGuardDeal(harness, opportunityId);

    await harness.closer.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId });

    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("expired");
    expect(await harness.t.run((ctx) => loadActiveFollowUpSummary(ctx, opportunityId))).toBeNull();
    const after = await readGuardDeal(harness, opportunityId);
    expect({ stage: after.stage, outcome: after.outcome }).toEqual({
      stage: before.stage,
      outcome: before.outcome,
    });
    const meeting = await harness.t.run((ctx) => ctx.db.get("meetings", meetingId!));
    expect(meeting!.status).toBe("scheduled");

    const events = await followUpEvents(harness, followUpId);
    expect(events.map((event) => [event.eventType, event.source, event.fromStatus, event.toStatus])).toEqual([
      ["followUp.expired", "closer", "pending", "expired"],
    ]);
    expect(events[0].actorUserId).toBe(harness.closerId);
  });

  it("then the outcome actions go through again", async () => {
    const harness = await guardHarness();
    const { opportunityId, meetingId } = await guardDealIn(harness, bookedWithLink, {
      meeting: "scheduled",
    });
    const followUpId = await pendingFollowUpOf(harness, opportunityId);
    await harness.closer.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId });

    await harness.closer.mutation(api.closer.meetingActions.markAsLost, {
      opportunityId,
      meetingId: meetingId!,
    });
    const deal = await readGuardDeal(harness, opportunityId);
    expect({ stage: deal.stage, outcome: deal.outcome }).toEqual({ stage: "closed", outcome: "lost" });
  });

  it("refuses an admin, who has its own mutation", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);

    await expect(
      harness.admin.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("refuses a caller who isn't signed in", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);

    await expect(
      harness.t.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("Not authenticated");
  });

  it("refuses a closer the deal isn't assigned to", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);
    const other = await otherCloser(harness);

    await expect(
      other.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("Not your opportunity");
    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("pending");
  });

  it("refuses a follow-up that is no longer pending", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);
    await harness.closer.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId });

    await expect(
      harness.closer.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("Follow-up is not pending");
  });

  it("refuses a follow-up whose deal already moved to Follow-up", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);

    await expect(
      harness.closer.mutation(api.closer.followUpMutations.cancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("still waiting for its call's result");
    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("pending");
  });
});

describe("adminCancelPendingFollowUp", () => {
  it("expires the link for the closer, with the admin as the actor", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink, { meeting: "scheduled" });
    const followUpId = await pendingFollowUpOf(harness, opportunityId);

    await harness.admin.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, { followUpId });

    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("expired");
    expect((await readGuardDeal(harness, opportunityId)).stage).toBe("booked");
    const events = await followUpEvents(harness, followUpId);
    expect(events.map((event) => [event.eventType, event.source, event.actorUserId])).toEqual([
      ["followUp.expired", "admin", harness.adminId],
    ]);
  });

  it("refuses a closer", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);

    await expect(
      harness.closer.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("refuses an admin of another tenant", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, bookedWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);
    const outsider = await otherTenantAdmin(harness);

    await expect(
      outsider.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("Follow-up not found");
    const followUp = await harness.t.run((ctx) => ctx.db.get("followUps", followUpId));
    expect(followUp!.status).toBe("pending");
  });

  it("refuses a follow-up whose deal already moved to Follow-up", async () => {
    const harness = await guardHarness();
    const { opportunityId } = await guardDealIn(harness, followUpWithLink);
    const followUpId = await pendingFollowUpOf(harness, opportunityId);

    await expect(
      harness.admin.mutation(api.admin.meetingActions.adminCancelPendingFollowUp, { followUpId }),
    ).rejects.toThrow("still waiting for its call's result");
  });
});
