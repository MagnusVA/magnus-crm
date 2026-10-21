import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

// People, deals, payments and enrollments for the Phase 4 read tests
// (docs/plans/phase-4-customers.md §6). The enrollment rows are inserted
// directly, consistent with the payments, as syncPersonEnrollments would
// derive them.

export const T0 = Date.parse("2026-05-01T12:00:00Z");
export const DAY = 24 * 60 * 60 * 1000;

export async function fixtureUsers(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const users = await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(10);
  const admin = users.find((user) => user.role === "tenant_admin");
  const closer = users.find((user) => user.role === "closer");
  if (!admin || !closer) throw new Error("Fixture users missing");
  return { admin, closer };
}

export async function insertProgram(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  createdByUserId: Id<"users">,
  name: string,
) {
  return await ctx.db.insert("tenantPrograms", {
    tenantId,
    name,
    normalizedName: name.toLowerCase(),
    createdAt: T0,
    createdByUserId,
    updatedAt: T0,
  });
}

export async function insertPerson(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    fullName?: string;
    email?: string;
    phone?: string;
    firstSeenAt?: number;
    status?: Doc<"leads">["status"];
  } = {},
) {
  const firstSeenAt = args.firstSeenAt ?? T0 - 10 * DAY;
  return await ctx.db.insert("leads", {
    tenantId,
    fullName: args.fullName,
    email: args.email,
    phone: args.phone,
    status: args.status ?? "active",
    firstSeenAt,
    updatedAt: firstSeenAt,
    lifecycleStage: args.status === "converted" ? "customer" : "qualified",
    lifecycleStageEnteredAt: { qualified: firstSeenAt },
    disposition: "open",
  });
}

export async function insertDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    assignedCloserId?: Id<"users">;
    status?: Doc<"opportunities">["status"];
    createdAt?: number;
  },
) {
  const createdAt = args.createdAt ?? T0 - 5 * DAY;
  return await ctx.db.insert("opportunities", {
    tenantId: args.tenantId,
    leadId: args.leadId,
    assignedCloserId: args.assignedCloserId,
    status: args.status ?? "payment_received",
    source: "calendly",
    createdAt,
    updatedAt: createdAt,
    latestActivityAt: createdAt,
  });
}

/** A meeting on the deal, kept in the deal's first and latest refs. */
export async function insertMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    scheduledAt: number;
  },
) {
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    assignedCloserId: args.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${args.scheduledAt}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${args.scheduledAt}/invitees/person`,
    scheduledAt: args.scheduledAt,
    durationMinutes: 30,
    status: "completed",
    createdAt: args.scheduledAt - DAY,
  });
  const deal = await ctx.db.get("opportunities", args.opportunityId);
  if (!deal) throw new Error("Fixture deal missing");
  await ctx.db.patch("opportunities", args.opportunityId, {
    firstMeetingId: deal.firstMeetingId ?? meetingId,
    firstMeetingAt: deal.firstMeetingAt ?? args.scheduledAt,
    latestMeetingId: meetingId,
    latestMeetingAt: args.scheduledAt,
  });
  return meetingId;
}

export async function insertPayment(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    programId: Id<"tenantPrograms">;
    recordedByUserId: Id<"users">;
    recordedAt: number;
    meetingId?: Id<"meetings">;
    amountMinor?: number;
    currency?: string;
    status?: Doc<"paymentRecords">["status"];
    origin?: Doc<"paymentRecords">["origin"];
  },
) {
  const program = await ctx.db.get("tenantPrograms", args.programId);
  return await ctx.db.insert("paymentRecords", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    attributedCloserId: args.recordedByUserId,
    amountMinor: args.amountMinor ?? 100_000,
    currency: args.currency ?? "USD",
    recordedByUserId: args.recordedByUserId,
    commissionable: true,
    programId: args.programId,
    programName: program?.name ?? "Program",
    paymentType: "pif",
    status: args.status ?? "recorded",
    recordedAt: args.recordedAt,
    origin: args.origin ?? (args.meetingId ? "closer_meeting" : "closer_side_deal"),
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
    createdAt: args.enrolledAt,
  });
}

/**
 * A person who bought one program: a won deal with a meeting and its
 * payment, and the enrollment syncPersonEnrollments derives from them.
 */
export async function seedCustomer(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  args: {
    closerId: Id<"users">;
    recorderId?: Id<"users">;
    programId: Id<"tenantPrograms">;
    paidAt: number;
    fullName?: string;
    email?: string;
    phone?: string;
    amountMinor?: number;
    withMeeting?: boolean;
    assignedCloserId?: Id<"users"> | null;
  },
) {
  const recorderId = args.recorderId ?? args.closerId;
  const leadId = await insertPerson(ctx, tenantId, {
    fullName: args.fullName ?? "Customer",
    email: args.email ?? "customer@example.com",
    phone: args.phone,
    status: "converted",
    firstSeenAt: args.paidAt - 3 * DAY,
  });
  const opportunityId = await insertDeal(ctx, {
    tenantId,
    leadId,
    assignedCloserId:
      args.assignedCloserId === null ? undefined : (args.assignedCloserId ?? args.closerId),
    createdAt: args.paidAt - 2 * DAY,
  });
  const meetingId =
    args.withMeeting === false
      ? undefined
      : await insertMeeting(ctx, {
          tenantId,
          opportunityId,
          closerId: args.closerId,
          scheduledAt: args.paidAt - DAY,
        });
  const amountMinor = args.amountMinor ?? 100_000;
  const paymentId = await insertPayment(ctx, {
    tenantId,
    opportunityId,
    meetingId,
    programId: args.programId,
    recordedByUserId: recorderId,
    recordedAt: args.paidAt,
    amountMinor,
  });
  const enrollmentId = await insertEnrollment(ctx, {
    tenantId,
    leadId,
    programId: args.programId,
    opportunityId,
    enrolledAt: args.paidAt,
  });
  return { leadId, opportunityId, meetingId, paymentId, enrollmentId };
}
