import { v } from "convex/values";
import { query } from "../_generated/server";
import { isSideDealOrigin, normalizeOpportunitySource } from "../lib/sideDeals";
import { requireTenantUser } from "../requireTenantUser";

export const getOpportunityDetail = query({
  args: { opportunityId: v.id("opportunities") },
  handler: async (ctx, { opportunityId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);
    const isAdmin = role === "tenant_master" || role === "tenant_admin";

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      return null;
    }
    if (!isAdmin && opportunity.assignedCloserId !== userId) {
      return null;
    }

    const [
      lead,
      closer,
      meetings,
      paymentRows,
      opportunityEvents,
      pendingStaleNudge,
      attachedFollowUps,
    ] = await Promise.all([
      ctx.db.get(opportunity.leadId),
      opportunity.assignedCloserId
        ? ctx.db.get(opportunity.assignedCloserId)
        : Promise.resolve(null),
      ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunityId),
        )
        .order("desc")
        .take(20),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunityId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("domainEvents")
        .withIndex(
          "by_tenantId_and_entityType_and_entityId_and_occurredAt",
          (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("entityType", "opportunity")
              .eq("entityId", opportunityId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId_and_status_and_reason", (q) =>
          q
            .eq("opportunityId", opportunityId)
            .eq("status", "pending")
            .eq("reason", "stale_opportunity_nudge"),
        )
        .first(),
      ctx.db
        .query("followUps")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunityId),
        )
        .take(50),
    ]);

    const payments = paymentRows.filter(
      (payment) => payment.tenantId === tenantId,
    ).sort((left, right) => right.recordedAt - left.recordedAt);

    const paymentEventsNested = await Promise.all(
      payments.map((payment) =>
        ctx.db
          .query("domainEvents")
          .withIndex(
            "by_tenantId_and_entityType_and_entityId_and_occurredAt",
            (q) =>
              q
                .eq("tenantId", tenantId)
                .eq("entityType", "payment")
                .eq("entityId", payment._id),
          )
          .order("desc")
          .take(10),
      ),
    );

    const source = normalizeOpportunitySource(opportunity);
    const isSideDeal = source === "side_deal";
    const recordedSideDealPayment = payments.find(
      (payment) =>
        payment.status === "recorded" && isSideDealOrigin(payment.origin),
    );
    const hasOnlyStaleNudgeFollowUps =
      attachedFollowUps.length < 50 &&
      attachedFollowUps.every(
        (followUp) => followUp.reason === "stale_opportunity_nudge",
      );
    const events = [...opportunityEvents, ...paymentEventsNested.flat()]
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, 50);

    return {
      opportunity: {
        _id: opportunity._id,
        status: opportunity.status,
        source,
        notes: opportunity.notes,
        assignedCloserId: opportunity.assignedCloserId,
        createdAt: opportunity.createdAt,
        updatedAt: opportunity.updatedAt,
        latestActivityAt: opportunity.latestActivityAt,
        paymentReceivedAt: opportunity.paymentReceivedAt,
        lostAt: opportunity.lostAt,
        lostReason: opportunity.lostReason,
      },
      lead:
        lead && lead.tenantId === tenantId
          ? {
              _id: lead._id,
              fullName: lead.fullName,
              email: lead.email,
              phone: lead.phone,
              status: lead.status,
            }
          : null,
      closer:
        closer && closer.tenantId === tenantId
          ? {
              _id: closer._id,
              fullName: closer.fullName,
              email: closer.email,
            }
          : null,
      meetings: meetings.map((meeting) => ({
        _id: meeting._id,
        status: meeting.status,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        callClassification: meeting.callClassification,
      })),
      payments: payments.map((payment) => ({
        _id: payment._id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        programName: payment.programName,
        paymentType: payment.paymentType,
        origin: payment.origin,
        status: payment.status,
        recordedAt: payment.recordedAt,
      })),
      events: events.map((event) => ({
        _id: event._id,
        eventType: event.eventType,
        source: event.source,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reason: event.reason,
      })),
      pendingStaleNudge: pendingStaleNudge
        ? {
            _id: pendingStaleNudge._id,
            reminderScheduledAt: pendingStaleNudge.reminderScheduledAt,
            reminderNote: pendingStaleNudge.reminderNote,
          }
        : null,
      permissions: {
        viewerUserId: userId,
        viewerRole: role,
        canRecordPayment: isSideDeal && opportunity.status === "in_progress",
        canMarkLost: isSideDeal && opportunity.status === "in_progress",
        canVoidPayment:
          isAdmin &&
          isSideDeal &&
          opportunity.status === "payment_received" &&
          recordedSideDealPayment !== undefined,
        voidablePaymentId: recordedSideDealPayment?._id,
        canDeleteOpportunity:
          isSideDeal &&
          opportunity.status === "in_progress" &&
          payments.length === 0 &&
          meetings.length === 0 &&
          hasOnlyStaleNudgeFollowUps,
      },
    };
  },
});
