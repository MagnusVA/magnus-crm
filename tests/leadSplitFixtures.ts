/**
 * Fixtures for the polluted-lead split tests (docs/plans/polluted-lead-split.md):
 * leads, deals and bookings shaped like the production data.
 */
import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { bookingHarness } from "./bookingHarness";

export type Harness = Awaited<ReturnType<typeof bookingHarness>>;
export type Fields<T extends "leads" | "opportunities"> = Partial<Omit<Doc<T>, "_id" | "_creationTime">>;

export const AT = Date.parse("2026-07-01T00:00:00Z");
export const DAY = 86_400_000;
export const PHONE_LABEL = "Phone";
export const INSTAGRAM_LABEL = "What's your Instagram username? (Example @therealbrianmark)";

export async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  return await bookingHarness();
}

export async function closerId(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const users = await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(10);
  return users.find((user) => user.role === "closer")!._id;
}

export async function insertLead(ctx: MutationCtx, tenantId: Id<"tenants">, fields: Fields<"leads"> = {}) {
  return await ctx.db.insert("leads", {
    tenantId,
    status: "active",
    firstSeenAt: AT,
    updatedAt: AT,
    ...fields,
  });
}

export async function insertOpportunity(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  fields: Fields<"opportunities"> = {},
) {
  return await ctx.db.insert("opportunities", {
    tenantId,
    leadId,
    status: "scheduled",
    source: "calendly",
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  });
}

export async function insertIdentifier(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  type: Doc<"leadIdentifiers">["type"],
  value: string,
  fields: { sourceMeetingId?: Id<"meetings">; createdAt?: number } = {},
) {
  return await ctx.db.insert("leadIdentifiers", {
    tenantId,
    leadId,
    type,
    value,
    rawValue: value,
    source: "calendly_booking",
    confidence: "verified",
    createdAt: fields.createdAt ?? AT,
    sourceMeetingId: fields.sourceMeetingId,
  });
}

export type Booking = {
  day: number;
  status?: Doc<"meetings">["status"];
  /** An email identifier this meeting sourced. */
  email?: string;
  /** A phone identifier this meeting sourced. */
  identifierPhone?: string;
  phoneAnswer?: string;
  instagramAnswer?: string;
};

/** A meeting with the identifiers and form answers its booking left. */
export async function book(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; opportunityId: Id<"opportunities"> },
  booking: Booking,
) {
  const { tenantId, leadId, opportunityId } = args;
  const at = AT + booking.day * DAY;
  const key = `${opportunityId}-${booking.day}`;
  const meetingId = await ctx.db.insert("meetings", {
    tenantId,
    opportunityId,
    assignedCloserId: await closerId(ctx, tenantId),
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${key}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${key}/invitees/i`,
    scheduledAt: at,
    durationMinutes: 30,
    status: booking.status ?? "scheduled",
    createdAt: at - DAY,
  });
  if (booking.email) {
    await insertIdentifier(ctx, tenantId, leadId, "email", booking.email, {
      sourceMeetingId: meetingId,
      createdAt: at,
    });
  }
  if (booking.identifierPhone) {
    await insertIdentifier(ctx, tenantId, leadId, "phone", booking.identifierPhone, {
      sourceMeetingId: meetingId,
      createdAt: at,
    });
  }
  for (const [label, answer] of [
    [PHONE_LABEL, booking.phoneAnswer],
    [INSTAGRAM_LABEL, booking.instagramAnswer],
  ] as const) {
    if (!answer) continue;
    await ctx.db.insert("meetingFormResponses", {
      tenantId,
      meetingId,
      opportunityId,
      leadId,
      fieldKey: `q_${label.length}`,
      questionLabelSnapshot: label,
      answerText: answer,
      capturedAt: at,
    });
  }
  return meetingId;
}

export async function snapshot(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  meetingId: Id<"meetings">,
  fields: { email: string; name: string },
) {
  const meeting = await ctx.db.get("meetings", meetingId);
  await ctx.db.insert("leadSplitInviteeSnapshots", {
    tenantId,
    meetingId,
    inviteeUri: meeting!.calendlyInviteeUri,
    outcome: "ok",
    httpStatus: 200,
    ...fields,
    fetchedAt: Date.now(),
  });
}

/**
 * Tier A: three bookers merged on Calendly's example phone.
 * - Paula (original) booked first, then Pedro's booking joined her deal as a
 *   reschedule, so the deal mixes two people.
 * - Pia booked with a placeholder email; her handle already has its own lead.
 */
export async function seedTierA(harness: Harness, options: { snapshots?: boolean } = {}) {
  const { t, tenantId } = harness;
  return await t.run(async (ctx) => {
    const leadId = await insertLead(ctx, tenantId, { email: "paula@x.com", fullName: "Pedro Two" });
    const piaLeadId = await insertLead(ctx, tenantId, { email: "pia@x.com" });
    await insertIdentifier(ctx, tenantId, piaLeadId, "instagram", "piathree");
    const mixed = await insertOpportunity(ctx, tenantId, leadId, { status: "no_show" });
    const whole = await insertOpportunity(ctx, tenantId, leadId);
    const paula = await book(ctx, { tenantId, leadId, opportunityId: mixed }, {
      day: 1,
      status: "canceled",
      email: "paula@x.com",
      identifierPhone: "+12345678910",
      instagramAnswer: "paulaone",
    });
    const pedro = await book(ctx, { tenantId, leadId, opportunityId: mixed }, {
      day: 3,
      status: "no_show",
      email: "pedro@x.com",
      phoneAnswer: "+1 234-567-8910",
      instagramAnswer: "pedrotwo",
    });
    const pia = await book(ctx, { tenantId, leadId, opportunityId: whole }, {
      day: 5,
      instagramAnswer: "@PiaThree",
    });
    if (options.snapshots ?? true) {
      await snapshot(ctx, tenantId, paula, { email: "paula@x.com", name: "Paula One" });
      await snapshot(ctx, tenantId, pedro, { email: "pedro@x.com", name: "Pedro Two" });
      await snapshot(ctx, tenantId, pia, { email: "email@gmail.com", name: "Pia Three" });
    }
    return { leadId, piaLeadId, mixed, whole, meetings: { paula, pedro, pia } };
  });
}

export async function discover(harness: Harness, excludeLeadIds: Id<"leads">[] = []) {
  return await harness.t.action(internal.leadSplit.discover.discover, {
    tenantId: harness.tenantId,
    dryRun: false,
    excludeLeadIds,
  });
}

export async function planFor(harness: Harness, leadId: Id<"leads">) {
  const plan = await harness.t.run(async (ctx) =>
    ctx.db
      .query("leadSplitPlans")
      .withIndex("by_tenantId_and_sourceLeadId", (q) =>
        q.eq("tenantId", harness.tenantId).eq("sourceLeadId", leadId),
      )
      .unique(),
  );
  if (!plan) throw new Error("No plan for lead");
  return plan;
}

export async function build(harness: Harness, planId: Id<"leadSplitPlans">, extra: object = {}) {
  return await harness.t.mutation(internal.leadSplit.plan.buildPlan, {
    planId,
    dryRun: false,
    ...extra,
  });
}

export const describePlan = (harness: Harness, planId: Id<"leadSplitPlans">) =>
  harness.t.query(internal.leadSplit.plan.describe, { planId });

export const person = (
  described: Awaited<ReturnType<typeof describePlan>>,
  meetingId: Id<"meetings">,
) => {
  const found = described.persons.find((candidate) => candidate.meetingIds.includes(meetingId));
  if (!found) throw new Error("No person holds the meeting");
  return found;
};
