import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { rebuildLeadCustomerSearchRow } from "../convex/leadCustomers/projection";
import { qualifiedLifecycle } from "./bookingHarness";

// A customer as production holds them during Phase 4 (docs/plans/
// phase-4-customers.md §3.1, §4.1): a converted person with won deals, their
// payments, the customer row for the first program, and one enrollment per
// program bought. Enrollments are inserted directly, consistent with the
// payments, as syncPersonEnrollments would derive them.

export const ENROLLED_AT = Date.parse("2026-09-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

async function userByWorkosId(ctx: MutationCtx, workosUserId: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique();
  if (!user) throw new Error(`No user ${workosUserId}`);
  return user;
}

export async function insertProgram(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  name: string,
  createdByUserId: Id<"users">,
) {
  return await ctx.db.insert("tenantPrograms", {
    tenantId,
    name,
    normalizedName: name.toLowerCase(),
    createdAt: 0,
    createdByUserId,
    updatedAt: 0,
  });
}

export async function insertWonDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    closerId: Id<"users">;
    programId: Id<"tenantPrograms">;
    programName: string;
    at: number;
  },
) {
  return await ctx.db.insert("opportunities", {
    tenantId: args.tenantId,
    leadId: args.leadId,
    assignedCloserId: args.closerId,
    status: "payment_received",
    source: "side_deal",
    soldProgramId: args.programId,
    soldProgramName: args.programName,
    paymentReceivedAt: args.at,
    createdAt: args.at,
    updatedAt: args.at,
  });
}

export async function insertDealPayment(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    programId: Id<"tenantPrograms">;
    programName: string;
    amountMinor: number;
    recordedAt: number;
    customerId?: Id<"customers">;
    status?: Doc<"paymentRecords">["status"];
    currency?: string;
  },
) {
  return await ctx.db.insert("paymentRecords", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    attributedCloserId: args.closerId,
    amountMinor: args.amountMinor,
    currency: args.currency ?? "USD",
    recordedByUserId: args.closerId,
    commissionable: true,
    programId: args.programId,
    programName: args.programName,
    paymentType: "pif",
    status: args.status ?? "recorded",
    recordedAt: args.recordedAt,
    customerId: args.customerId,
    contextType: "opportunity",
    origin: "closer_side_deal",
  });
}

/**
 * A customer of Program A (paid on their first deal), with the customer row
 * and its enrollment. `secondProgram` adds Program B, bought on a second deal
 * a day later, with its own enrollment.
 */
export async function seedEnrolledCustomer(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  options: { secondProgram?: boolean } = {},
) {
  const admin = await userByWorkosId(ctx, "user_admin");
  const closer = await userByWorkosId(ctx, "user_closer");
  const programA = await insertProgram(ctx, tenantId, "Program A", admin._id);
  const leadId = await ctx.db.insert("leads", {
    ...qualifiedLifecycle(ENROLLED_AT - DAY),
    tenantId,
    fullName: "Erin Enrolled",
    email: "erin@example.com",
    status: "converted",
    searchText: "erin enrolled erin@example.com",
    firstSeenAt: ENROLLED_AT - DAY,
    updatedAt: ENROLLED_AT,
  });
  const dealA = await insertWonDeal(ctx, {
    tenantId, leadId, closerId: closer._id, programId: programA, programName: "Program A", at: ENROLLED_AT,
  });
  const customerId = await ctx.db.insert("customers", {
    tenantId,
    leadId,
    fullName: "Erin Enrolled",
    email: "erin@example.com",
    convertedAt: ENROLLED_AT,
    convertedByUserId: closer._id,
    winningOpportunityId: dealA,
    programId: programA,
    programName: "Program A",
    status: "active",
    createdAt: ENROLLED_AT,
  });
  const paymentA = await insertDealPayment(ctx, {
    tenantId, opportunityId: dealA, closerId: closer._id, programId: programA,
    programName: "Program A", amountMinor: 300_000, recordedAt: ENROLLED_AT, customerId,
  });
  const enrollmentA = await ctx.db.insert("enrollments", {
    tenantId,
    leadId,
    programId: programA,
    opportunityId: dealA,
    enrolledAt: ENROLLED_AT,
    status: "active",
    createdAt: ENROLLED_AT,
  });

  let second:
    | { programId: Id<"tenantPrograms">; dealId: Id<"opportunities">; enrollmentId: Id<"enrollments"> }
    | undefined;
  if (options.secondProgram) {
    const programB = await insertProgram(ctx, tenantId, "Program B", admin._id);
    const dealB = await insertWonDeal(ctx, {
      tenantId, leadId, closerId: closer._id, programId: programB, programName: "Program B", at: ENROLLED_AT + DAY,
    });
    await insertDealPayment(ctx, {
      tenantId, opportunityId: dealB, closerId: closer._id, programId: programB,
      programName: "Program B", amountMinor: 120_000, recordedAt: ENROLLED_AT + DAY, customerId,
    });
    const enrollmentB = await ctx.db.insert("enrollments", {
      tenantId,
      leadId,
      programId: programB,
      opportunityId: dealB,
      enrolledAt: ENROLLED_AT + DAY,
      status: "active",
      createdAt: ENROLLED_AT + DAY,
    });
    second = { programId: programB, dealId: dealB, enrollmentId: enrollmentB };
  }

  await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
  return {
    adminId: admin._id,
    closerId: closer._id,
    leadId,
    customerId,
    programA,
    dealA,
    paymentA,
    enrollmentA,
    second,
  };
}
