import migrationsTest from "@convex-dev/migrations/test";
import { vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { listPersonEnrollments } from "../convex/enrollments/read";
import { migrations } from "../convex/migrations";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "./bookingHarness";
import { stageFields } from "./dealStageFixtures";

// Phase 4 enrollments (docs/plans/phase-4-customers.md §4.1): a harness that
// can run the migrations, and rows inserted the way production holds them.

export type EnrollmentHarness = Awaited<ReturnType<typeof enrollmentHarness>>;

export async function enrollmentHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const { adminId, closerId } = await harness.t.run(async (ctx) => {
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", harness.tenantId))
      .take(10);
    return {
      adminId: users.find((user) => user.role === "tenant_admin")!._id,
      closerId: users.find((user) => user.role === "closer")!._id,
    };
  });

  async function status(name: string) {
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [result] = await harness.t.run((ctx) =>
      migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
    );
    return result;
  }
  async function run(name: string) {
    await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
    return await status(name);
  }
  async function rerun(name: string) {
    await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset: true });
    return await status(name);
  }
  return { ...harness, adminId, closerId, run, rerun };
}

export async function enrollmentsOf(harness: EnrollmentHarness, leadId: Id<"leads">) {
  return await harness.t.run((ctx) => listPersonEnrollments(ctx, harness.tenantId, leadId));
}

export async function insertProgram(ctx: MutationCtx, tenantId: Id<"tenants">, name: string) {
  const admin = (await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
    .unique())!;
  return await ctx.db.insert("tenantPrograms", {
    tenantId,
    name,
    normalizedName: name.toLowerCase(),
    createdAt: 0,
    createdByUserId: admin._id,
    updatedAt: 0,
  });
}

export async function insertPerson(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  status: Doc<"leads">["status"] = "converted",
) {
  return await ctx.db.insert("leads", {
    ...qualifiedLifecycle(0),
    tenantId,
    email: "person@example.com",
    status,
    firstSeenAt: 0,
    updatedAt: 0,
  });
}

export async function insertDeal(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  status: OpportunityStatus = "payment_received",
) {
  return await ctx.db.insert("opportunities", {
    tenantId,
    leadId,
    ...stageFields(status, "side_deal"),
    createdAt: 0,
    updatedAt: 0,
  });
}

export async function insertPayment(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    programId: Id<"tenantPrograms">;
    recordedAt: number;
    status?: Doc<"paymentRecords">["status"];
  },
) {
  const admin = (await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin"))
    .unique())!;
  return await ctx.db.insert("paymentRecords", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    attributedCloserId: admin._id,
    recordedByUserId: admin._id,
    commissionable: true,
    amountMinor: 10000,
    currency: "USD",
    programId: args.programId,
    programName: "Program",
    paymentType: "pif",
    status: args.status ?? "recorded",
    recordedAt: args.recordedAt,
    origin: "admin_side_deal",
  });
}

export async function insertEnrollment(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    programId: Id<"tenantPrograms">;
    opportunityId: Id<"opportunities">;
    enrolledAt: number;
    status?: Doc<"enrollments">["status"];
  },
) {
  return await ctx.db.insert("enrollments", {
    tenantId: args.tenantId,
    leadId: args.leadId,
    programId: args.programId,
    opportunityId: args.opportunityId,
    enrolledAt: args.enrolledAt,
    status: args.status ?? "active",
    createdAt: 0,
  });
}

/**
 * Books a Calendly meeting for `email` and runs the pipeline, so the person,
 * the deal and the meeting exist as a booking leaves them. The call starts
 * 2026-10-01T12:00:00Z (`bookingPayload`).
 */
export async function book(harness: EnrollmentHarness, key: string, email = "lead@example.com") {
  const payload = bookingPayload(key, email);
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-09-30T10:00:00Z", payload }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  return await harness.t.run(async (ctx) => {
    const meeting = (await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyInviteeUri", (q) =>
        q.eq("tenantId", harness.tenantId).eq("calendlyInviteeUri", payload.uri),
      )
      .first())!;
    const deal = (await ctx.db.get("opportunities", meeting.opportunityId))!;
    return { meetingId: meeting._id, opportunityId: deal._id, leadId: deal.leadId };
  });
}

/** Two programs, A and B. */
export async function twoPrograms(harness: EnrollmentHarness) {
  return await harness.t.run(async (ctx) => ({
    programA: await insertProgram(ctx, harness.tenantId, "Program A"),
    programB: await insertProgram(ctx, harness.tenantId, "Program B"),
  }));
}

/** A side deal opened by the closer, for a new person or an existing one. */
export async function sideDeal(harness: EnrollmentHarness, key: string, lead: Id<"leads"> | { email: string }) {
  return await harness.closer.mutation(api.opportunities.createManual.createManual, {
    clientRequestId: key,
    ...(typeof lead === "string"
      ? { existingLeadId: lead }
      : { newLeadInput: { fullName: "Side Deal Person", email: lead.email } }),
  });
}

/** The closer records a side deal payment at `at`. */
export async function paySideDeal(
  harness: EnrollmentHarness,
  opportunityId: Id<"opportunities">,
  programId: Id<"tenantPrograms">,
  at: number,
) {
  vi.setSystemTime(new Date(at));
  const { paymentId } = await harness.closer.mutation(api.sideDeals.logPayment.logPayment, {
    opportunityId,
    amount: 500,
    currency: "USD",
    programId,
    paymentType: "pif",
  });
  return paymentId;
}
