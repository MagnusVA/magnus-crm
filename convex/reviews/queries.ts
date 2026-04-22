import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import { loadActiveFollowUpSummary } from "../lib/activeFollowUp";

type ReviewStatus = Doc<"meetingReviews">["status"];
type EnrichedPaymentRecord = Omit<
  Doc<"paymentRecords">,
  "attributedCloserId"
> & {
  amount: number;
  attributedCloserId: Id<"users"> | undefined;
  attributedCloserName: string | null;
  recordedByName: string | null;
};

function resolveAttributedCloserId(
  payment: Doc<"paymentRecords">,
): Id<"users"> | undefined {
  return resolveLegacyCompatibleAttributedCloserId(payment);
}

async function loadPaymentUserNameById(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payments: Array<Doc<"paymentRecords">>,
) {
  const userIds = [
    ...new Set(
      payments.flatMap((payment) => {
        const ids: Id<"users">[] = [];
        const attributedCloserId = resolveAttributedCloserId(payment);
        const recordedByUserId = resolveLegacyCompatibleRecordedByUserId(payment);
        if (attributedCloserId) {
          ids.push(attributedCloserId);
        }
        if (recordedByUserId) {
          ids.push(recordedByUserId);
        }
        return ids;
      }),
    ),
  ];

  const users = await Promise.all(
    userIds.map(async (userId) => [userId, await ctx.db.get(userId)] as const),
  );

  return new Map<Id<"users">, string | null>(
    users.map(([userId, user]) => [
      userId,
      user && "tenantId" in user && user.tenantId === tenantId
        ? (user.fullName ?? user.email)
        : null,
    ]),
  );
}

async function listReviewsByStatus(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  status: ReviewStatus,
) {
  return await ctx.db
    .query("meetingReviews")
    .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("status", status),
    )
    .order("desc")
    .take(50);
}

export const listPendingReviews = query({
  args: {
    statusFilter: v.optional(v.union(v.literal("pending"), v.literal("resolved"))),
  },
  handler: async (ctx, { statusFilter }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const reviews = await listReviewsByStatus(ctx, tenantId, statusFilter ?? "pending");

    const meetingIds = [...new Set(reviews.map((review) => review.meetingId))];
    const opportunityIds = [
      ...new Set(reviews.map((review) => review.opportunityId)),
    ];
    const closerIds = [...new Set(reviews.map((review) => review.closerId))];

    const [meetings, opportunities, closers] = await Promise.all([
      Promise.all(
        meetingIds.map(async (meetingId) => [meetingId, await ctx.db.get(meetingId)] as const),
      ),
      Promise.all(
        opportunityIds.map(
          async (opportunityId) =>
            [opportunityId, await ctx.db.get(opportunityId)] as const,
        ),
      ),
      Promise.all(
        closerIds.map(async (closerId) => [closerId, await ctx.db.get(closerId)] as const),
      ),
    ]);

    const meetingById = new Map(meetings);
    const opportunityById = new Map(opportunities);
    const closerById = new Map(closers);

    const leadIds = [
      ...new Set(
        opportunities
          .map(([, opportunity]) => opportunity?.leadId)
          .filter((leadId): leadId is Id<"leads"> => leadId !== undefined),
      ),
    ];
    const leads = await Promise.all(
      leadIds.map(async (leadId) => [leadId, await ctx.db.get(leadId)] as const),
    );
    const leadById = new Map(leads);
    const activeFollowUpEntries = await Promise.all(
      opportunityIds.map(async (opportunityId) => [
        opportunityId,
        await loadActiveFollowUpSummary(ctx, opportunityId),
      ] as const),
    );
    const activeFollowUpByOpportunityId = new Map(activeFollowUpEntries);

    return reviews.map((review) => {
      const meeting = meetingById.get(review.meetingId) ?? null;
      const opportunity = opportunityById.get(review.opportunityId) ?? null;
      const lead =
        opportunity && leadById.has(opportunity.leadId)
          ? (leadById.get(opportunity.leadId) ?? null)
          : null;
      const closer = closerById.get(review.closerId) ?? null;

      return {
        review,
        meeting,
        opportunity,
        lead,
        closer,
        meetingScheduledAt: meeting?.scheduledAt ?? null,
        meetingDurationMinutes: meeting?.durationMinutes ?? null,
        leadName: lead?.fullName ?? lead?.email ?? "Unknown",
        leadEmail: lead?.email ?? null,
        closerName: closer?.fullName ?? closer?.email ?? "Unknown",
        closerEmail: closer?.email ?? null,
        opportunityStatus: opportunity?.status ?? null,
        activeFollowUp:
          activeFollowUpByOpportunityId.get(review.opportunityId) ?? null,
      };
    });
  },
});

export const getReviewDetail = query({
  args: { reviewId: v.id("meetingReviews") },
  handler: async (ctx, { reviewId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const review = await ctx.db.get(reviewId);
    if (!review || review.tenantId !== tenantId) {
      return null;
    }

    const [meeting, opportunity, closer, resolver, timesSetter] = await Promise.all([
      ctx.db.get(review.meetingId),
      ctx.db.get(review.opportunityId),
      ctx.db.get(review.closerId),
      review.resolvedByUserId ? ctx.db.get(review.resolvedByUserId) : null,
      review.timesSetByUserId ? ctx.db.get(review.timesSetByUserId) : null,
    ]);
    if (!meeting || !opportunity) {
      return null;
    }

    const lead = await ctx.db.get(opportunity.leadId);
    const activeFollowUp = await loadActiveFollowUpSummary(ctx, opportunity._id);

    // v2: Outcome audit trail — surface the closer's action details so the
    // admin can review the full context before acknowledging or disputing.
    // All of this data is bounded per-opportunity (usually 0-3 payments,
    // always ≤1 lost/no-show actor).
    const [paymentRecordsRaw, lostByUser, noShowByUser] = await Promise.all([
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .take(20),
      opportunity.lostByUserId ? ctx.db.get(opportunity.lostByUserId) : null,
      meeting.noShowMarkedByUserId
        ? ctx.db.get(meeting.noShowMarkedByUserId)
        : null,
    ]);

    const paymentUserNameById = await loadPaymentUserNameById(
      ctx,
      tenantId,
      paymentRecordsRaw,
    );
    const paymentRecords: EnrichedPaymentRecord[] = paymentRecordsRaw
      .filter((payment) => payment.tenantId === tenantId)
      .map((payment) => {
        const attributedCloserId = resolveAttributedCloserId(payment);
        return {
          ...payment,
          amount: payment.amountMinor / 100,
          attributedCloserId,
          attributedCloserName: attributedCloserId
            ? (paymentUserNameById.get(attributedCloserId) ?? null)
            : null,
          recordedByName: (() => {
            const recordedByUserId = resolveLegacyCompatibleRecordedByUserId(
              payment,
            );
            return recordedByUserId
              ? (paymentUserNameById.get(recordedByUserId) ?? null)
              : null;
          })(),
        };
      });
    paymentRecords.sort((a, b) => b.recordedAt - a.recordedAt);

    return {
      review,
      meeting,
      opportunity,
      lead,
      closer,
      resolver,
      timesSetter,
      closerName: closer?.fullName ?? closer?.email ?? "Unknown",
      closerEmail: closer?.email ?? null,
      resolverName: resolver?.fullName ?? resolver?.email ?? null,
      timesSetterName: timesSetter?.fullName ?? timesSetter?.email ?? null,
      activeFollowUp,
      // v2: outcome audit fields
      paymentRecords,
      lostByUserName:
        lostByUser?.fullName ?? lostByUser?.email ?? null,
      noShowByUserName:
        noShowByUser?.fullName ?? noShowByUser?.email ?? null,
    };
  },
});

export const getPendingReviewCount = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const pending = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(100);

    return { count: pending.length };
  },
});
