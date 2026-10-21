import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { rebuildLeadCustomerSearchRow } from "../convex/leadCustomers/projection";
import {
  DAY,
  fixtureUsers,
  insertDeal,
  insertEnrollment,
  insertPayment,
  insertPerson,
  insertProgram,
} from "./enrollmentReadFixtures";

// A customer for the person page and status control tests
// (docs/plans/phase-4-customers.md §4.4, §6.2): a converted person with won
// deals, their payments, and one enrollment per program bought, inserted
// consistent with the payments.

export const ENROLLED_AT = Date.parse("2026-09-01T12:00:00Z");

/**
 * A customer of Program A (paid on their first deal), with its enrollment.
 * `secondProgram` adds Program B, bought on a second deal a day later, with
 * its own enrollment.
 */
export async function seedEnrolledCustomer(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  options: { secondProgram?: boolean } = {},
) {
  const { admin, closer } = await fixtureUsers(ctx, tenantId);
  const programA = await insertProgram(ctx, tenantId, admin._id, "Program A");
  const leadId = await insertPerson(ctx, tenantId, {
    fullName: "Erin Enrolled",
    email: "erin@example.com",
    status: "converted",
    firstSeenAt: ENROLLED_AT - DAY,
  });
  const dealA = await insertDeal(ctx, {
    tenantId, leadId, assignedCloserId: closer._id, createdAt: ENROLLED_AT,
  });
  const paymentA = await insertPayment(ctx, {
    tenantId, opportunityId: dealA, programId: programA, recordedByUserId: closer._id,
    recordedAt: ENROLLED_AT, amountMinor: 300_000,
  });
  const enrollmentA = await insertEnrollment(ctx, {
    tenantId, leadId, programId: programA, opportunityId: dealA, enrolledAt: ENROLLED_AT,
  });

  let second:
    | { programId: Id<"tenantPrograms">; dealId: Id<"opportunities">; enrollmentId: Id<"enrollments"> }
    | undefined;
  if (options.secondProgram) {
    const programB = await insertProgram(ctx, tenantId, admin._id, "Program B");
    const dealB = await insertDeal(ctx, {
      tenantId, leadId, assignedCloserId: closer._id, createdAt: ENROLLED_AT + DAY,
    });
    await insertPayment(ctx, {
      tenantId, opportunityId: dealB, programId: programB, recordedByUserId: closer._id,
      recordedAt: ENROLLED_AT + DAY, amountMinor: 120_000,
    });
    const enrollmentB = await insertEnrollment(ctx, {
      tenantId, leadId, programId: programB, opportunityId: dealB, enrolledAt: ENROLLED_AT + DAY,
    });
    second = { programId: programB, dealId: dealB, enrollmentId: enrollmentB };
  }

  await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
  return {
    adminId: admin._id,
    closerId: closer._id,
    leadId,
    programA,
    dealA,
    paymentA,
    enrollmentA,
    second,
  };
}
