import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import {
  buildDealAttributionDetail,
  resolveBookingDmAttribution,
} from "../lib/attribution/detailPayload";
import {
  type MemberAvatarIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import { loadActiveFollowUpSummary } from "../lib/activeFollowUp";
import { loadPendingRescheduleLink } from "../opportunities/dealState";
import { dealLabelOf, meetingDealLabelOf } from "../opportunities/stageLabels";

type MeetingHistoryEntry = Doc<"meetings"> &
  ReturnType<typeof meetingDealLabelOf> & {
    isCurrentMeeting: boolean;
  };

type EnrichedPayment = Omit<
  Doc<"paymentRecords">,
  "amount" | "attributedCloserId"
> & {
  amount: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  attributedCloserId: Id<"users"> | null;
  attributedCloserName: string | null;
  attributedCloser: MemberAvatarIdentity | null;
  recordedByName: string | null;
  recordedBy: MemberAvatarIdentity | null;
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
 * - attributionTeam / dmCloser / dmCloserIdentity: from the booking rows
 * - dealAttribution: every attribution row on the deal, and its touches
 *
 * Authorization:
 * - Closers can only view meetings for their assigned opportunities
 * - Admins (tenant_master, tenant_admin) can view any meeting in the tenant
 */
export const getMeetingDetail = query({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    // Load the meeting
    const meeting = await ctx.db.get("meetings", meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    // Load the parent opportunity
    const opportunity = await ctx.db.get("opportunities", meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Authorization: Closers can only see their own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Load the lead
    const lead = await ctx.db.get("leads", opportunity.leadId);
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
      activeFollowUp,
      dmAttribution,
      dealAttribution,
      rescheduleLink,
      meetingFormResponses,
    ] = await Promise.all([
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId),
        )
        .take(50),
      opportunity.eventTypeConfigId
        ? ctx.db.get("eventTypeConfigs", opportunity.eventTypeConfigId)
        : Promise.resolve(null),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .take(50),
      opportunity.assignedCloserId
        ? ctx.db.get("users", opportunity.assignedCloserId)
        : Promise.resolve(null),
      meeting.reassignedFromCloserId
        ? ctx.db
            .query("meetingReassignments")
            .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
            .order("desc")
            .first()
        : Promise.resolve(null),
      meeting.reassignedFromCloserId
        ? ctx.db.get("users", meeting.reassignedFromCloserId)
        : Promise.resolve(null),
      opportunity.potentialDuplicateLeadId
        ? ctx.db.get("leads", opportunity.potentialDuplicateLeadId)
        : Promise.resolve(null),
      meeting.rescheduledFromMeetingId
        ? ctx.db.get("meetings", meeting.rescheduledFromMeetingId)
        : Promise.resolve(null),
      loadActiveFollowUpSummary(ctx, opportunity._id),
      // The meeting's own booking, or the deal's first when it was never
      // resolved (docs/plans/phase-3-attribution.md §6.5).
      resolveBookingDmAttribution(ctx, { tenantId, opportunity, meeting }),
      buildDealAttributionDetail(ctx, opportunity),
      loadPendingRescheduleLink(ctx, opportunity._id),
      ctx.db
        .query("meetingFormResponses")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meetingId))
        .take(100),
    ]);

    const opportunityById = new Map<Id<"opportunities">, Doc<"opportunities">>(
      leadOpportunities.map((item) => [item._id, item]),
    );
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
      .flatMap((historicalMeeting) => {
        // Every meeting read here is on one of the person's deals above.
        const historicalDeal = opportunityById.get(historicalMeeting.opportunityId);
        return historicalDeal
          ? [
              {
                ...historicalMeeting,
                ...meetingDealLabelOf(historicalDeal),
                isCurrentMeeting: historicalMeeting._id === meetingId,
              },
            ]
          : [];
      })
      .sort((a, b) => b.scheduledAt - a.scheduledAt);

    const eventTypeName = eventTypeConfig?.displayName ?? null;
    const paymentLinks = eventTypeConfig?.paymentLinks ?? null;

    const paymentUserIds = [
      ...new Set(
        paymentRecordsRaw.flatMap((payment) =>
          [
            resolveLegacyCompatibleAttributedCloserId(payment),
            resolveLegacyCompatibleRecordedByUserId(payment),
          ].filter((userId): userId is Id<"users"> => userId !== undefined),
        ),
      ),
    ];
    const paymentUsers = await Promise.all(
      paymentUserIds.map(async (paymentUserId) => [
        paymentUserId,
        await ctx.db.get("users", paymentUserId),
      ] as const),
    );
    const paymentUserNameById = new Map<Id<"users">, string | null>(
      paymentUsers.map(([paymentUserId, paymentUser]) => [
        paymentUserId,
        paymentUser && "tenantId" in paymentUser && paymentUser.tenantId === tenantId
          ? ("fullName" in paymentUser && paymentUser.fullName
              ? paymentUser.fullName
              : "email" in paymentUser
                ? paymentUser.email
                : null)
          : null,
      ]),
    );
    const paymentUserIdentityById = new Map<
      Id<"users">,
      MemberAvatarIdentity | null
    >(
      await Promise.all(
        paymentUsers.map(async ([paymentUserId, paymentUser]) => [
          paymentUserId,
          paymentUser &&
          "tenantId" in paymentUser &&
          paymentUser.tenantId === tenantId
            ? await userMemberIdentity(ctx, paymentUser)
            : null,
        ] as const),
      ),
    );

    const payments: EnrichedPayment[] = await Promise.all(
      paymentRecordsRaw
        .filter((payment) => payment.tenantId === tenantId)
        .map(async (payment) => {
          let proofFileUrl: string | null = null;
          let proofFileContentType: string | null = null;
          let proofFileSize: number | null = null;
          const attributedCloserId =
            resolveLegacyCompatibleAttributedCloserId(payment) ?? null;
          const recordedByUserId = resolveLegacyCompatibleRecordedByUserId(
            payment,
          );

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
            attributedCloserId,
            attributedCloserName:
              attributedCloserId !== null
                ? (paymentUserNameById.get(attributedCloserId) ?? null)
                : null,
            attributedCloser:
              attributedCloserId !== null
                ? (paymentUserIdentityById.get(attributedCloserId) ?? null)
                : null,
            recordedByName: recordedByUserId
              ? (paymentUserNameById.get(recordedByUserId) ?? null)
              : null,
            recordedBy: recordedByUserId
              ? (paymentUserIdentityById.get(recordedByUserId) ?? null)
              : null,
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
    const assignedCloserIdentity =
      assignedCloser && assignedCloser.tenantId === tenantId
        ? await userMemberIdentity(ctx, assignedCloser)
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
      email?: string;
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

    return {
      meeting,
      // The header badge reads the stage and outcome, and the page's controls
      // read them with the pending reschedule link, which with a Follow-up
      // deal is today's `reschedule_link_sent` (docs/plans/phase-5-deal-status.md
      // §6.1, §6.4; lib/deal-controls.ts).
      opportunity: {
        ...opportunity,
        ...dealLabelOf(opportunity),
        rescheduleLinkPending: rescheduleLink.count > 0,
      },
      lead,
      bookingAnswers: meetingFormResponses
        .filter((response) => response.tenantId === tenantId)
        .sort((a, b) =>
          a.capturedAt - b.capturedAt || a.fieldKey.localeCompare(b.fieldKey),
        )
        .map(({ fieldKey, questionLabelSnapshot, answerText, capturedAt }) => ({
          fieldKey,
          question: questionLabelSnapshot,
          answer: answerText,
          capturedAt,
        })),
      assignedCloser: assignedCloserSummary,
      meetingHistory,
      eventTypeName,
      paymentLinks,
      payments,
      reassignmentInfo,
      potentialDuplicate,
      rescheduledFromMeeting,
      assignedCloserIdentity,
      attributionTeam: dmAttribution.team,
      dmCloser: dmAttribution.dmCloser,
      dmCloserIdentity: dmAttribution.dmCloserIdentity,
      dealAttribution,
      activeFollowUp,
    };
  },
});
