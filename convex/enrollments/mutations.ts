import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { emitDomainEvent } from "../lib/domainEvents";
import { rejectRequest } from "../lib/observability/errors";
import { log } from "../lib/observability/log";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { enrollmentStatusValidator, type EnrollmentStatus } from "./validators";

// An admin changes one enrollment's status (docs/plans/phase-4-customers.md
// §4.4). Nothing else writes the status, apart from a merge (§4.7).

const REASON_MAX_LENGTH = 500;

/** The trimmed reason, or undefined when blank. Only Paused and Churned take one. */
function normalizeReason(
  status: EnrollmentStatus,
  reason: string | undefined,
  tenantId: Id<"tenants">,
): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  if (status === "active") {
    throw rejectRequest(
      "enrollment.reason_not_allowed",
      "Moving a program back to Active takes no reason.",
      { tenantId },
    );
  }
  const trimmed = reason.trim();
  if (trimmed.length > REASON_MAX_LENGTH) {
    throw rejectRequest(
      "enrollment.reason_too_long",
      `Keep the reason to ${REASON_MAX_LENGTH} characters.`,
      { tenantId, length: trimmed.length },
    );
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Until PR 4 stops writing customer rows, the person's customer row for the
 * same program takes the status as `updateCustomerStatus` writes it, so the
 * two can't disagree.
 */
async function mirrorCustomerStatus(
  ctx: MutationCtx,
  enrollment: Doc<"enrollments">,
  status: EnrollmentStatus,
  now: number,
) {
  // One customer row per person in production (§2.1); a few more is still bounded.
  const customers = await ctx.db
    .query("customers")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", enrollment.tenantId).eq("leadId", enrollment.leadId),
    )
    .take(10);
  for (const customer of customers) {
    if (customer.programId !== enrollment.programId || customer.status === status) {
      continue;
    }
    await ctx.db.patch("customers", customer._id, {
      status,
      churnedAt: status === "churned" ? now : undefined,
      pausedAt: status === "paused" ? now : undefined,
    });
  }
}

export const updateEnrollmentStatus = mutation({
  args: {
    enrollmentId: v.id("enrollments"),
    status: enrollmentStatusValidator,
    reason: v.optional(v.string()),
    // The status the page showed. When the enrollment has changed since, the
    // request is stale and changes nothing.
    expectedStatus: v.optional(enrollmentStatusValidator),
  },
  returns: v.union(v.literal("changed"), v.literal("unchanged"), v.literal("stale")),
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["customer:edit"]]);
    const reason = normalizeReason(args.status, args.reason, tenantId);

    const enrollment = await ctx.db.get("enrollments", args.enrollmentId);
    if (!enrollment || enrollment.tenantId !== tenantId) {
      throw rejectRequest("enrollment.not_found", "Program enrollment not found.", {
        tenantId,
        enrollmentId: args.enrollmentId,
      });
    }

    if (args.expectedStatus !== undefined && args.expectedStatus !== enrollment.status) {
      log.info("enrollment.status_change.skipped", {
        tenantId,
        enrollmentId: enrollment._id,
        reason: "stale",
      });
      return "stale" as const;
    }
    if (enrollment.status === args.status) {
      log.info("enrollment.status_change.skipped", {
        tenantId,
        enrollmentId: enrollment._id,
        reason: "unchanged",
      });
      return "unchanged" as const;
    }

    const now = Date.now();
    await ctx.db.patch("enrollments", enrollment._id, {
      status: args.status,
      statusChangedAt: now,
      statusChangedByUserId: userId,
    });
    await mirrorCustomerStatus(ctx, enrollment, args.status, now);
    // The list shows the person-level status (§4.4).
    await rebuildLeadCustomerSearchRow(ctx, tenantId, enrollment.leadId);
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "enrollment",
      entityId: enrollment._id,
      eventType: "enrollment.status_changed",
      source: "admin",
      actorUserId: userId,
      fromStatus: enrollment.status,
      toStatus: args.status,
      reason,
      occurredAt: now,
      // The person, program and deal, so the event still finds the person
      // after the enrollment is gone (§4.10).
      metadata: {
        leadId: enrollment.leadId,
        programId: enrollment.programId,
        opportunityId: enrollment.opportunityId,
      },
    });
    return "changed" as const;
  },
});
