import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { FIXTURE_NOW, providerPaymentFixture } from "../../tests/providerPaymentFixtures";
import { insertLatestMeeting } from "../../tests/dealStageFixtures";
import { insertMeetingAggregate } from "../reporting/writeHooks";
import { insertManualReminder } from "./reminderInsert";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  { source: "closer", reason: "closer_initiated" },
  { source: "admin", reason: "admin_initiated" },
] as const)("$source reminder matches the stored web reminder fields", async ({ source, reason }) => {
  const f = await providerPaymentFixture();
  const opportunityId = f.dealId!;
  const meetingId = await f.t.run(async (ctx) => {
    const id = await insertLatestMeeting(ctx, opportunityId, { status: "scheduled", scheduledAt: FIXTURE_NOW - 3_600_000 });
    await insertMeetingAggregate(ctx, id);
    return id;
  });
  const reminder = { contactMethod: "text" as const, reminderScheduledAt: FIXTURE_NOW + 1, reminderNote: "Ask about timing" };
  const webArgs = { opportunityId, meetingId, ...reminder };
  const reference = source === "closer"
    ? await f.closer.mutation(api.closer.followUpMutations.createManualReminderFollowUpPublic, webArgs)
    : await f.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, webArgs);
  const actorUserId = source === "closer" ? f.closerId : f.adminId;

  const followUpId = await f.t.run(async (ctx) => insertManualReminder(ctx, {
    source, actorUserId, opportunity: (await ctx.db.get("opportunities", opportunityId))!,
    closerId: f.closerId, ...reminder, sourceMeetingId: meetingId, reason, now: FIXTURE_NOW,
  }));

  const fields = (id: Id<"followUps">) => f.t.run(async (ctx) => {
    const { _id, _creationTime, ...row } = (await ctx.db.get("followUps", id))!;
    return row;
  });
  const expected = {
    tenantId: f.tenantId, opportunityId, leadId: f.personId, closerId: f.closerId,
    type: "manual_reminder", ...reminder, sourceMeetingId: meetingId, reason, status: "pending",
    createdAt: FIXTURE_NOW, createdByUserId: actorUserId, createdSource: source,
  };
  expect(await fields(reference.followUpId)).toEqual(expected);
  expect(await fields(followUpId)).toEqual(expected);
});

it.each([FIXTURE_NOW - 1, FIXTURE_NOW])("system reminder accepts due time %s and records no actor", async (reminderScheduledAt) => {
  const f = await providerPaymentFixture();
  const id = await f.t.run(async (ctx) => insertManualReminder(ctx, {
    source: "system", opportunity: (await ctx.db.get("opportunities", f.dealId!))!, closerId: f.closerId,
    contactMethod: "call", reminderScheduledAt, reason: "closer_initiated", now: FIXTURE_NOW,
    metadata: { origin: "test", version: 1 },
  }));

  const { row, event } = await f.t.run(async (ctx) => ({
    row: await ctx.db.get("followUps", id),
    event: await ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q.eq("tenantId", f.tenantId).eq("entityType", "followUp").eq("entityId", id)).unique(),
  }));
  expect(row).toMatchObject({ reminderScheduledAt, createdSource: "system", status: "pending" });
  expect(row?.createdByUserId).toBeUndefined();
  expect(event).toMatchObject({ eventType: "followUp.created", source: "system", toStatus: "pending", occurredAt: FIXTURE_NOW });
  expect(event?.actorUserId).toBeUndefined();
  expect(JSON.parse(event!.metadata!)).toEqual({ type: "manual_reminder", opportunityId: f.dealId, origin: "test", version: 1 });
});
