import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { EnrollmentStatus } from "./validators";

// A person has at most one enrollment per program, and a tenant has a handful
// of programs; past this the read is wrong, not merely large.
const MAX_ENROLLMENTS_PER_PERSON = 100;

/** The person's enrollments, oldest first. */
export async function listPersonEnrollments(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"enrollments">[]> {
  const enrollments = await ctx.db
    .query("enrollments")
    .withIndex("by_tenantId_and_leadId_and_programId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .take(MAX_ENROLLMENTS_PER_PERSON + 1);
  if (enrollments.length > MAX_ENROLLMENTS_PER_PERSON) {
    throw new Error(
      `Person ${leadId} has more than ${MAX_ENROLLMENTS_PER_PERSON} enrollments`,
    );
  }
  return enrollments.sort(
    (a, b) => a.enrolledAt - b.enrolledAt || a._creationTime - b._creationTime,
  );
}

/**
 * The one status the leads and customers list shows for a person: active if
 * any enrollment is active, else paused if any is, else churned. Undefined for
 * a person with no enrollment (docs/plans/phase-4-customers.md §4.4).
 */
export function personCustomerStatus(
  enrollments: ReadonlyArray<Pick<Doc<"enrollments">, "status">>,
): EnrollmentStatus | undefined {
  if (enrollments.length === 0) {
    return undefined;
  }
  if (enrollments.some((enrollment) => enrollment.status === "active")) {
    return "active";
  }
  if (enrollments.some((enrollment) => enrollment.status === "paused")) {
    return "paused";
  }
  return "churned";
}
