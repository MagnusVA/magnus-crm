import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  correctLeadLifecycle,
  countLeadStageEntries,
  lifecycleProblems,
  recordMeeting,
} from "../lib/leadLifecycle";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const ALL_TIME = [0, Date.parse("2027-01-01T00:00:00Z")] as const;

// A person a closer recorded as held, then whose call turns out not to have
// happened: the admin moves them back.
async function heldPerson(harness: Harness): Promise<Id<"leads">> {
  const payload = bookingPayload("held");
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-09-30T10:00:00Z", payload }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await harness.t.run(async (ctx) => {
    const lead = (await ctx.db.query("leads").first())!;
    const meeting = (await ctx.db.query("meetings").first())!;
    await ctx.db.patch("meetings", meeting._id, { status: "completed", completedAt: Date.parse("2026-10-01T12:40:00Z") });
    await recordMeeting(ctx, meeting._id);
    return lead._id;
  });
}

describe("admin lifecycle controls", () => {
  it("an admin moves a person back with a reason, and the stage above stops counting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const harness = await bookingHarness();
    const leadId = await heldPerson(harness);
    const count = (stage: "showed" | "booked") =>
      harness.t.run((ctx) => countLeadStageEntries(ctx, harness.tenantId, stage, ...ALL_TIME));
    expect(await count("showed")).toBe(1);

    const movedBackAt = Date.parse("2026-10-03T09:00:00Z");
    vi.setSystemTime(new Date(movedBackAt));
    await harness.admin.mutation(api.leads.lifecycleAdmin.moveLifecycleStageBack, {
      leadId,
      toStage: "booked",
      reason: "Closer recorded the wrong meeting",
    });

    const state = await harness.t.run(async (ctx) => {
      const lead = (await ctx.db.get("leads", leadId))!;
      return {
        lead,
        problems: await lifecycleProblems(ctx, lead),
        event: (await ctx.db.query("domainEvents").take(100)).find(
          (event) => event.eventType === "lead.lifecycle_stage_changed" && event.source === "admin",
        ),
      };
    });
    expect(state.lead.lifecycleStage).toBe("booked");
    expect(state.lead.lifecycleStageEnteredAt?.showed).toBeUndefined();
    expect(state.lead.lifecycleStageMovedBackAt).toBe(movedBackAt);
    expect(await count("showed")).toBe(0);
    expect(await count("booked")).toBe(1);
    expect(state.event).toMatchObject({
      fromStatus: "showed",
      toStatus: "booked",
      reason: "Closer recorded the wrong meeting",
    });
    // A moved-back person no longer matches their records, on purpose.
    expect(state.problems).toEqual([]);
  });

  it("a later correction doesn't undo the move-back", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const harness = await bookingHarness();
    const leadId = await heldPerson(harness);
    await harness.admin.mutation(api.leads.lifecycleAdmin.moveLifecycleStageBack, {
      leadId,
      toStage: "booked",
      reason: "Closer recorded the wrong meeting",
    });

    // The held meeting is still on record, so deriving again would say Showed.
    await harness.t.run((ctx) => correctLeadLifecycle(ctx, leadId, "lead_split"));

    const lead = await harness.t.run((ctx) => ctx.db.get("leads", leadId));
    expect(lead?.lifecycleStage).toBe("booked");
  });

  it("only admins can move a stage back, and only to a lower stage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const harness = await bookingHarness();
    const leadId = await heldPerson(harness);

    await expect(
      harness.closer.mutation(api.leads.lifecycleAdmin.moveLifecycleStageBack, {
        leadId, toStage: "booked", reason: "No",
      }),
    ).rejects.toThrow();
    await expect(
      harness.admin.mutation(api.leads.lifecycleAdmin.moveLifecycleStageBack, {
        leadId, toStage: "customer", reason: "Forward",
      }),
    ).rejects.toThrow("lifecycle.not_lower_stage");
    await expect(
      harness.admin.mutation(api.leads.lifecycleAdmin.moveLifecycleStageBack, {
        leadId, toStage: "booked", reason: "   ",
      }),
    ).rejects.toThrow("lifecycle.reason_required");
  });

  it("an admin's disposition stays when the person books again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const harness = await bookingHarness();
    const leadId = await heldPerson(harness);

    await harness.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
      leadId,
      disposition: "do_not_contact",
      reason: "Asked not to be contacted",
    });
    const payload = bookingPayload("again");
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId: harness.tenantId,
      calendlyEventUri: payload.uri,
      eventType: "invitee.created",
      payload: JSON.stringify({ created_at: "2026-10-05T11:00:00Z", payload }),
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const lead = await harness.t.run((ctx) => ctx.db.get("leads", leadId));
    expect(lead).toMatchObject({
      disposition: "do_not_contact",
      dispositionSource: "admin",
      dispositionReason: "Asked not to be contacted",
    });
  });
});
