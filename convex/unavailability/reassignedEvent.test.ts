import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { book, enrollmentHarness, type EnrollmentHarness } from "../../tests/enrollmentFixtures";
import { getEventLabel } from "../reporting/lib/eventLabels";

// A reassignment that changes a deal's owner is a domain event,
// `opportunity.reassigned` (admin assistant, commit 6), next to the
// `meetingReassignments` row and the attribution row it already wrote.

afterEach(() => vi.useRealTimers());

async function unavailableCloser(harness: EnrollmentHarness) {
  const closer2 = await harness.t.run((ctx) =>
    ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_closer2",
      email: "closer2@example.com",
      role: "closer",
      isActive: true,
      calendlyUserUri: "https://api.calendly.com/users/closer2",
    }),
  );
  const deal = await book(harness, "busy");
  const unavailabilityId = await harness.t.run((ctx) =>
    ctx.db.insert("closerUnavailability", {
      tenantId: harness.tenantId,
      closerId: harness.closerId,
      date: Date.parse("2026-10-01T00:00:00Z"),
      isFullDay: true,
      reason: "sick",
      createdByUserId: harness.adminId,
      createdAt: Date.now(),
    }),
  );
  return { ...deal, closer2, unavailabilityId };
}

async function reassignedEvents(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(200))
      .filter((event) => event.eventType === "opportunity.reassigned")
      .map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        source: event.source,
        actorUserId: event.actorUserId,
        leadId: event.leadId,
        metadata: JSON.parse(event.metadata ?? "{}") as Record<string, unknown>,
      })),
  );
}

async function reassignmentRows(harness: EnrollmentHarness, meetingId: Id<"meetings">) {
  return await harness.t.run(async (ctx) =>
    (await ctx.db.query("meetingReassignments").take(20)).filter((row) => row.meetingId === meetingId),
  );
}

describe("opportunity.reassigned", () => {
  it("is emitted by auto-distribution", async () => {
    const harness = await enrollmentHarness();
    const f = await unavailableCloser(harness);
    const result = await harness.admin.mutation(api.unavailability.redistribution.autoDistributeMeetings, {
      unavailabilityId: f.unavailabilityId,
      meetingIds: [f.meetingId],
      candidateCloserIds: [f.closer2],
    });
    expect(result.assigned).toHaveLength(1);
    expect(await reassignedEvents(harness)).toEqual([
      {
        entityType: "opportunity",
        entityId: f.opportunityId,
        source: "admin",
        actorUserId: harness.adminId,
        leadId: f.leadId,
        metadata: {
          fromCloserId: harness.closerId,
          toCloserId: f.closer2,
          meetingId: f.meetingId,
          unavailabilityId: f.unavailabilityId,
          mode: "auto_distributed",
        },
      },
    ]);
    expect(await reassignmentRows(harness, f.meetingId)).toHaveLength(1);
  });

  it("is emitted by a manual assignment", async () => {
    const harness = await enrollmentHarness();
    const f = await unavailableCloser(harness);
    await harness.admin.mutation(api.unavailability.redistribution.manuallyResolveMeeting, {
      meetingId: f.meetingId,
      unavailabilityId: f.unavailabilityId,
      action: "assign",
      targetCloserId: f.closer2,
    });
    expect(await reassignedEvents(harness)).toEqual([
      {
        entityType: "opportunity",
        entityId: f.opportunityId,
        source: "admin",
        actorUserId: harness.adminId,
        leadId: f.leadId,
        metadata: {
          fromCloserId: harness.closerId,
          toCloserId: f.closer2,
          meetingId: f.meetingId,
          unavailabilityId: f.unavailabilityId,
          mode: "manually_assigned",
        },
      },
    ]);
    expect(await reassignmentRows(harness, f.meetingId)).toHaveLength(1);
  });

  it("is not emitted when a meeting is canceled instead", async () => {
    const harness = await enrollmentHarness();
    const f = await unavailableCloser(harness);
    await harness.admin.mutation(api.unavailability.redistribution.manuallyResolveMeeting, {
      meetingId: f.meetingId,
      unavailabilityId: f.unavailabilityId,
      action: "cancel",
    });
    expect(await reassignedEvents(harness)).toEqual([]);
  });

  it("has an Activity label", () => {
    expect(getEventLabel("opportunity.reassigned").verb).toBe("reassigned a deal to another closer");
    expect(getEventLabel("second_opinion.checked").verb).toBe("checked a second opinion");
  });
});
