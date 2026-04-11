import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

type MeetingHistoryEntry = Doc<"meetings"> & {
  opportunityStatus: Doc<"opportunities">["status"];
  isCurrentMeeting: boolean;
};

// Enriched payment with proof file URL and closer info
type EnrichedPayment = Doc<"paymentRecords"> & {
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

    // Load lead's full meeting history (all meetings across all opportunities for this lead)
    const meetingHistory: MeetingHistoryEntry[] = [];
    const leadOpportunities = ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
      );

    for await (const leadOpportunity of leadOpportunities) {
      const meetings = ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", leadOpportunity._id),
        );

      for await (const historicalMeeting of meetings) {
        meetingHistory.push({
          ...historicalMeeting,
          opportunityStatus: leadOpportunity.status,
          isCurrentMeeting: historicalMeeting._id === meetingId,
        });
      }
    }

    // Sort meeting history by scheduledAt descending (most recent first)
    meetingHistory.sort((a, b) => b.scheduledAt - a.scheduledAt);

    const eventTypeConfig = opportunity.eventTypeConfigId
      ? await ctx.db.get(opportunity.eventTypeConfigId)
      : null;
    const eventTypeName = eventTypeConfig?.displayName ?? null;
    const paymentLinks = eventTypeConfig?.paymentLinks ?? null;

    // Load payment records for this opportunity with enrichment
    const payments: EnrichedPayment[] = [];
    const paymentRecords = ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) =>
        q.eq("opportunityId", opportunity._id),
      );

    for await (const payment of paymentRecords) {
      if (payment.tenantId !== tenantId) continue;

      // Resolve proof file URL and metadata from Convex file storage
      let proofFileUrl: string | null = null;
      let proofFileContentType: string | null = null;
      let proofFileSize: number | null = null;

      if (payment.proofFileId) {
        proofFileUrl = await ctx.storage.getUrl(payment.proofFileId);
        // Query the _storage system table for file metadata (contentType, size)
        const fileMeta = await ctx.db.system.get(
          "_storage",
          payment.proofFileId,
        );
        if (fileMeta) {
          proofFileContentType = fileMeta.contentType ?? null;
          proofFileSize = fileMeta.size ?? null;
        }
      }

      // Resolve the closer who recorded this payment
      let closerName: string | null = null;
      const closer = await ctx.db.get(payment.closerId);
      if (closer && closer.tenantId === tenantId) {
        closerName = closer.fullName ?? closer.email;
      }

      payments.push({
        ...payment,
        proofFileUrl,
        proofFileContentType,
        proofFileSize,
        closerName,
      });
    }
    payments.sort((a, b) => b.recordedAt - a.recordedAt);

    // Load assigned closer info (for admin view)
    const assignedCloser = opportunity.assignedCloserId
      ? await ctx.db.get(opportunity.assignedCloserId)
      : null;
    const assignedCloserSummary =
      assignedCloser && assignedCloser.tenantId === tenantId
        ? assignedCloser.fullName
          ? { fullName: assignedCloser.fullName, email: assignedCloser.email }
          : { email: assignedCloser.email }
        : null;

    // === Feature E: Load potential duplicate lead info ===
    let potentialDuplicate: {
      _id: typeof opportunity.leadId;
      fullName?: string;
      email: string;
    } | null = null;

    if (opportunity.potentialDuplicateLeadId) {
      const dupLead = await ctx.db.get(opportunity.potentialDuplicateLeadId);
      if (dupLead && dupLead.tenantId === tenantId) {
        potentialDuplicate = {
          _id: dupLead._id,
          fullName: dupLead.fullName,
          email: dupLead.email,
        };
      }
    }
    // === End Feature E ===

    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
      hasPotentialDuplicate: !!potentialDuplicate,
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
      potentialDuplicate,
    };
  },
});
