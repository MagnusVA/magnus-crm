import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { loadActiveFollowUpSummary } from "../lib/activeFollowUp";

type MeetingHistoryEntry = Doc<"meetings"> & {
  opportunityStatus: Doc<"opportunities">["status"];
  isCurrentMeeting: boolean;
};

// Enriched payment with proof file URL and closer info
type EnrichedPayment = Omit<Doc<"paymentRecords">, "amount"> & {
  amount: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  closerName: string | null;
};

/**
 * Get all data for the meeting detail page.
 *
 * Returns:
 * - meeting: The meeting record
 * - opportunity: The parent opportunity
 * - lead: The lead with full profile
 * - meetingHistory: All meetings for this lead across all opportunities
 * - paymentLinks: From the event type config (if configured)
 * - payments: Payment records for this opportunity
 *
 * Authorization:
 * - Closers can only view meetings for their assigned opportunities
 * - Admins (tenant_master, tenant_admin) can view any meeting in the tenant
 */
export const getMeetingDetail = query({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    console.log("[Closer:MeetingDetail] getMeetingDetail called", { meetingId });
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    // Load the meeting
    const meeting = await ctx.db.get(meetingId);
    console.log("[Closer:MeetingDetail] meeting lookup", { found: !!meeting });
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    // Load the parent opportunity
    const opportunity = await ctx.db.get(meeting.opportunityId);
    console.log("[Closer:MeetingDetail] opportunity lookup", { found: !!opportunity, opportunityId: meeting.opportunityId });
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Authorization: Closers can only see their own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Load the lead
    const lead = await ctx.db.get(opportunity.leadId);
    console.log("[Closer:MeetingDetail] lead lookup", { found: !!lead, leadId: opportunity.leadId });
    if (!lead || lead.tenantId !== tenantId) {
      throw new Error("Lead not found");
    }

    const [
      leadOpportunities,
      eventTypeConfig,
      paymentRecordsRaw,
      assignedCloser,
      reassignment,
      reassignedFromCloser,
      potentialDuplicateLead,
      originalMeeting,
      meetingReview,
      activeFollowUp,
    ] = await Promise.all([
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .take(50),
      opportunity.eventTypeConfigId
        ? ctx.db.get(opportunity.eventTypeConfigId)
        : Promise.resolve(null),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .take(50),
      opportunity.assignedCloserId
        ? ctx.db.get(opportunity.assignedCloserId)
        : Promise.resolve(null),
      meeting.reassignedFromCloserId
        ? ctx.db
            .query("meetingReassignments")
            .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
            .order("desc")
            .first()
        : Promise.resolve(null),
      meeting.reassignedFromCloserId
        ? ctx.db.get(meeting.reassignedFromCloserId)
        : Promise.resolve(null),
      opportunity.potentialDuplicateLeadId
        ? ctx.db.get(opportunity.potentialDuplicateLeadId)
        : Promise.resolve(null),
      meeting.rescheduledFromMeetingId
        ? ctx.db.get(meeting.rescheduledFromMeetingId)
        : Promise.resolve(null),
      meeting.reviewId ? ctx.db.get(meeting.reviewId) : Promise.resolve(null),
      loadActiveFollowUpSummary(ctx, opportunity._id),
    ]);

    const opportunityStatusById = new Map<
      Id<"opportunities">,
      Doc<"opportunities">["status"]
    >(leadOpportunities.map((item) => [item._id, item.status]));
    const meetingHistoryBatches = await Promise.all(
      leadOpportunities.map((leadOpportunity) =>
        ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) =>
            q.eq("opportunityId", leadOpportunity._id),
          )
          .order("desc")
          .take(20),
      ),
    );
    const meetingHistory: MeetingHistoryEntry[] = meetingHistoryBatches
      .flat()
      .map((historicalMeeting) => ({
        ...historicalMeeting,
        opportunityStatus:
          opportunityStatusById.get(historicalMeeting.opportunityId) ??
          "scheduled",
        isCurrentMeeting: historicalMeeting._id === meetingId,
      }))
      .sort((a, b) => b.scheduledAt - a.scheduledAt);

    const eventTypeName = eventTypeConfig?.displayName ?? null;
    const paymentLinks = eventTypeConfig?.paymentLinks ?? null;

    const paymentCloserIds = [
      ...new Set(paymentRecordsRaw.map((payment) => payment.closerId)),
    ];
    const paymentClosers = await Promise.all(
      paymentCloserIds.map(async (closerId) => ({
        closerId,
        closer: await ctx.db.get(closerId),
      })),
    );
    const paymentCloserNameById = new Map<Id<"users">, string | null>(
      paymentClosers.map(({ closerId, closer }) => [
        closerId,
        closer && closer.tenantId === tenantId
          ? closer.fullName ?? closer.email
          : null,
      ]),
    );

    const payments: EnrichedPayment[] = await Promise.all(
      paymentRecordsRaw
        .filter((payment) => payment.tenantId === tenantId)
        .map(async (payment) => {
          let proofFileUrl: string | null = null;
          let proofFileContentType: string | null = null;
          let proofFileSize: number | null = null;

          if (payment.proofFileId) {
            const [url, fileMeta] = await Promise.all([
              ctx.storage.getUrl(payment.proofFileId),
              ctx.db.system.get("_storage", payment.proofFileId),
            ]);
            proofFileUrl = url;
            if (fileMeta) {
              proofFileContentType = fileMeta.contentType ?? null;
              proofFileSize = fileMeta.size ?? null;
            }
          }

          return {
            ...payment,
            amount: payment.amountMinor / 100,
            proofFileUrl,
            proofFileContentType,
            proofFileSize,
            closerName: paymentCloserNameById.get(payment.closerId) ?? null,
          };
        }),
    );
    payments.sort((a, b) => b.recordedAt - a.recordedAt);

    const assignedCloserSummary =
      assignedCloser && assignedCloser.tenantId === tenantId
        ? assignedCloser.fullName
          ? { fullName: assignedCloser.fullName, email: assignedCloser.email }
          : { email: assignedCloser.email }
        : null;

    // === Feature H: Load reassignment metadata ===
    let reassignmentInfo: {
      reassignedFromCloserName: string;
      reassignedAt: number;
      reason: string;
    } | null = null;

    if (meeting.reassignedFromCloserId) {
      reassignmentInfo = {
        reassignedFromCloserName:
          reassignedFromCloser?.fullName ??
          reassignedFromCloser?.email ??
          "Unknown",
        reassignedAt: reassignment?.reassignedAt ?? meeting._creationTime,
        reason: reassignment?.reason ?? "Reassigned",
      };
    }
    // === End Feature H ===

    // === Feature E: Load potential duplicate lead info ===
    let potentialDuplicate: {
      _id: typeof opportunity.leadId;
      fullName?: string;
      email: string;
    } | null = null;

    if (potentialDuplicateLead && potentialDuplicateLead.tenantId === tenantId) {
        potentialDuplicate = {
          _id: potentialDuplicateLead._id,
          fullName: potentialDuplicateLead.fullName,
          email: potentialDuplicateLead.email,
        };
    }
    // === End Feature E ===

    // === Feature B: Resolve reschedule chain ===
    let rescheduledFromMeeting: {
      _id: typeof meeting._id;
      scheduledAt: number;
      status: Doc<"meetings">["status"];
    } | null = null;

    if (originalMeeting && originalMeeting.tenantId === tenantId) {
        rescheduledFromMeeting = {
          _id: originalMeeting._id,
          scheduledAt: originalMeeting.scheduledAt,
          status: originalMeeting.status,
        };
    }
    // === End Feature B ===

    const meetingReviewForTenant =
      meetingReview && meetingReview.tenantId === tenantId ? meetingReview : null;

    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
      hasPotentialDuplicate: !!potentialDuplicate,
      hasRescheduleChain: !!rescheduledFromMeeting,
      hasActiveFollowUp: !!activeFollowUp,
    });
    return {
      meeting,
      opportunity,
      lead,
      assignedCloser: assignedCloserSummary,
      meetingHistory,
      eventTypeName,
      paymentLinks,
      payments,
      meetingReview: meetingReviewForTenant,
      reassignmentInfo,
      potentialDuplicate,
      rescheduledFromMeeting,
      // v2: closer may have created a follow-up (scheduling link or manual
      // reminder) on a still-`meeting_overran` opportunity. The follow-up
      // mutations intentionally skip the status transition in that case,
      // so the closer UI uses this signal to detect "already acted" and
      // flip the banner/action-bar accordingly.
      activeFollowUp,
    };
  },
});
