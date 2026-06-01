import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildOpportunityAttributionPayload } from "../lib/attribution/detailPayload";
import { userMemberIdentity } from "../lib/memberIdentity";
import type { CrmRole } from "../lib/roleMapping";
import { normalizeOpportunitySource } from "../lib/sideDeals";
import { buildEntityActivity } from "./activity";
import {
  canOpenMeetingDetail,
  canOpenOpportunityDetail,
  canViewPaymentDetail,
  isAdminRole,
  relatedRecordPermissions,
} from "./permissions";

const MAX_OPPORTUNITIES = 50;
const MAX_MEETINGS = 50;
const MAX_MEETINGS_PER_OPPORTUNITY = 10;
const MAX_COMMENTS_PER_MEETING = 5;
const MAX_TOTAL_COMMENTS = 250;
const MAX_PAYMENTS = 50;
const MAX_PAYMENTS_PER_OPPORTUNITY = 10;
const MAX_ACTIVITY = 75;

function compactOpportunity(opportunity: Doc<"opportunities">) {
  return {
    _id: opportunity._id,
    leadId: opportunity.leadId,
    assignedCloserId: opportunity.assignedCloserId,
    status: opportunity.status,
    source: opportunity.source,
    firstBookingProgramId: opportunity.firstBookingProgramId,
    firstBookingProgramName: opportunity.firstBookingProgramName,
    soldProgramId: opportunity.soldProgramId,
    soldProgramName: opportunity.soldProgramName,
    latestMeetingId: opportunity.latestMeetingId,
    latestMeetingAt: opportunity.latestMeetingAt,
    nextMeetingId: opportunity.nextMeetingId,
    nextMeetingAt: opportunity.nextMeetingAt,
    firstMeetingId: opportunity.firstMeetingId,
    firstMeetingAt: opportunity.firstMeetingAt,
    paymentReceivedAt: opportunity.paymentReceivedAt,
    latestActivityAt: opportunity.latestActivityAt,
    createdAt: opportunity.createdAt,
    updatedAt: opportunity.updatedAt,
  };
}

function compactMeeting(
  meeting: Doc<"meetings">,
  opportunity: Doc<"opportunities">,
  permissions: ReturnType<typeof relatedRecordPermissions>,
) {
  return {
    _id: meeting._id,
    opportunityId: meeting.opportunityId,
    assignedCloserId: meeting.assignedCloserId,
    scheduledAt: meeting.scheduledAt,
    durationMinutes: meeting.durationMinutes,
    status: meeting.status,
    callClassification: meeting.callClassification,
    completedAt: meeting.completedAt,
    canceledAt: meeting.canceledAt,
    bookingProgramName: meeting.bookingProgramName,
    soldProgramName: meeting.soldProgramName,
    opportunityStatus: opportunity.status,
    opportunitySource: normalizeOpportunitySource(opportunity),
    permissions,
  };
}

function compactPayment(
  payment: Doc<"paymentRecords">,
  permissions: ReturnType<typeof relatedRecordPermissions>,
) {
  return {
    _id: payment._id,
    opportunityId: payment.opportunityId,
    meetingId: payment.meetingId,
    attributedCloserId: payment.attributedCloserId,
    customerId: payment.customerId,
    originatingOpportunityId: payment.originatingOpportunityId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    commissionable: payment.commissionable,
    programId: payment.programId,
    programName: payment.programName,
    paymentType: payment.paymentType,
    status: payment.status,
    recordedAt: payment.recordedAt,
    contextType: payment.contextType,
    origin: payment.origin,
    permissions,
  };
}

function uniqueById<T extends { _id: string }>(rows: T[]) {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const row of rows) {
    if (seen.has(row._id)) {
      continue;
    }
    seen.add(row._id);
    unique.push(row);
  }

  return unique;
}

export async function buildEntityDetailPayload(
  ctx: QueryCtx,
  input: {
    tenantId: Id<"tenants">;
    viewerUserId: Id<"users">;
    viewerRole: CrmRole;
    lead: Doc<"leads">;
    customer: Doc<"customers"> | null;
    identifiers: Doc<"leadIdentifiers">[];
    opportunities: Doc<"opportunities">[];
  },
) {
  const opportunities = input.opportunities.slice(0, MAX_OPPORTUNITIES);
  const opportunityById = new Map(
    opportunities.map((opportunity) => [opportunity._id, opportunity]),
  );
  const closerIds = [
    ...new Set(
      opportunities
        .map((opportunity) => opportunity.assignedCloserId)
        .filter((closerId): closerId is Id<"users"> => closerId !== undefined),
    ),
  ];

  const [closers, meetingBatches, customerPayments, opportunityPaymentBatches] =
    await Promise.all([
      Promise.all(
        closerIds.map(async (closerId) => ({
          closerId,
          closer: await ctx.db.get(closerId),
        })),
      ),
      Promise.all(
        opportunities.map((opportunity) =>
          ctx.db
            .query("meetings")
            .withIndex("by_opportunityId_and_scheduledAt", (q) =>
              q.eq("opportunityId", opportunity._id),
            )
            .order("desc")
            .take(MAX_MEETINGS_PER_OPPORTUNITY),
        ),
      ),
      input.customer
        ? ctx.db
            .query("paymentRecords")
            .withIndex("by_customerId_and_recordedAt", (q) =>
              q.eq("customerId", input.customer!._id),
            )
            .order("desc")
            .take(MAX_PAYMENTS)
        : Promise.resolve([]),
      Promise.all(
        opportunities.map((opportunity) =>
          ctx.db
            .query("paymentRecords")
            .withIndex("by_opportunityId_and_recordedAt", (q) =>
              q.eq("opportunityId", opportunity._id),
            )
            .order("desc")
            .take(MAX_PAYMENTS_PER_OPPORTUNITY),
        ),
      ),
    ]);

  const closerById = new Map(
    await Promise.all(
      closers.map(async ({ closerId, closer }) => [
        closerId,
        closer && closer.tenantId === input.tenantId
          ? {
              _id: closer._id,
              fullName: closer.fullName,
              email: closer.email,
              avatar: await userMemberIdentity(ctx, closer),
            }
          : null,
      ] as const),
    ),
  );

  const rawMeetings = meetingBatches
    .flat()
    .filter((meeting) => meeting.tenantId === input.tenantId)
    .sort((left, right) => right.scheduledAt - left.scheduledAt);
  const meetings = rawMeetings.slice(0, MAX_MEETINGS);
  const meetingPermissionsById = new Map<
    Id<"meetings">,
    ReturnType<typeof relatedRecordPermissions>
  >();
  for (const meeting of meetings) {
    const opportunity = opportunityById.get(meeting.opportunityId);
    const canOpenOpportunity = opportunity
      ? canOpenOpportunityDetail({
          viewerUserId: input.viewerUserId,
          viewerRole: input.viewerRole,
          opportunity,
        })
      : false;
    const canOpenMeeting = canOpenMeetingDetail({
      viewerUserId: input.viewerUserId,
      viewerRole: input.viewerRole,
      meeting,
    });
    meetingPermissionsById.set(
      meeting._id,
      relatedRecordPermissions({
        canOpenOpportunity,
        canOpenMeeting,
        canViewComments: canOpenMeeting,
      }),
    );
  }

  const commentsNested = await Promise.all(
    meetings.map(async (meeting) => {
      const permissions = meetingPermissionsById.get(meeting._id);
      if (!permissions?.canViewComments) {
        return [];
      }

      return await ctx.db
        .query("meetingComments")
        .withIndex("by_meetingId_and_createdAt", (q) =>
          q.eq("meetingId", meeting._id),
        )
        .order("desc")
        .take(MAX_COMMENTS_PER_MEETING);
    }),
  );
  const comments = commentsNested
    .flat()
    .filter(
      (comment) =>
        comment.tenantId === input.tenantId && comment.deletedAt === undefined,
    )
    .slice(0, MAX_TOTAL_COMMENTS);

  const rawPayments = uniqueById([
    ...customerPayments,
    ...opportunityPaymentBatches.flat(),
  ])
    .filter((payment) => payment.tenantId === input.tenantId)
    .sort((left, right) => right.recordedAt - left.recordedAt);
  const visiblePayments = rawPayments
    .filter((payment) =>
      canViewPaymentDetail({
        viewerUserId: input.viewerUserId,
        viewerRole: input.viewerRole,
        payment,
        opportunityById,
      }),
    )
    .slice(0, MAX_PAYMENTS);

  const opportunitiesWithAttribution = await Promise.all(
    opportunities.map(async (opportunity) => {
      const canOpenOpportunity = canOpenOpportunityDetail({
        viewerUserId: input.viewerUserId,
        viewerRole: input.viewerRole,
        opportunity,
      });
      const permissions = relatedRecordPermissions({
        canOpenOpportunity,
        canViewPayments: isAdminRole(input.viewerRole) || canOpenOpportunity,
        canRecordPayment:
          canOpenOpportunity &&
          normalizeOpportunitySource(opportunity) === "side_deal" &&
          opportunity.status === "scheduled",
      });

      return {
        opportunity: compactOpportunity(opportunity),
        closer: opportunity.assignedCloserId
          ? closerById.get(opportunity.assignedCloserId) ?? null
          : null,
        attribution: canOpenOpportunity
          ? await buildOpportunityAttributionPayload(ctx, opportunity)
          : null,
        permissions,
      };
    }),
  );

  const compactMeetings = meetings
    .map((meeting) => {
      const opportunity = opportunityById.get(meeting.opportunityId);
      if (!opportunity) {
        return null;
      }
      return compactMeeting(
        meeting,
        opportunity,
        meetingPermissionsById.get(meeting._id) ??
          relatedRecordPermissions({}),
      );
    })
    .filter(
      (meeting): meeting is NonNullable<typeof meeting> => meeting !== null,
    );

  const compactPayments = visiblePayments.map((payment) =>
    {
      const paymentOpportunityId =
        payment.opportunityId ?? payment.originatingOpportunityId;
      const paymentOpportunity = paymentOpportunityId
        ? opportunityById.get(paymentOpportunityId)
        : undefined;

      return compactPayment(
        payment,
        relatedRecordPermissions({
          canViewPayments: true,
          canOpenOpportunity: paymentOpportunity
            ? canOpenOpportunityDetail({
                viewerUserId: input.viewerUserId,
                viewerRole: input.viewerRole,
                opportunity: paymentOpportunity,
              })
            : false,
        }),
      );
    },
  );
  const activity = buildEntityActivity({
    customer: input.customer,
    opportunities,
    meetings,
    payments: visiblePayments,
    maxActivity: MAX_ACTIVITY,
  });

  return {
    kind: "detail" as const,
    viewer: {
      userId: input.viewerUserId,
      role: input.viewerRole,
    },
    lead: input.lead,
    customer: input.customer,
    identifiers: input.identifiers,
    opportunities: opportunitiesWithAttribution,
    meetings: compactMeetings,
    comments,
    payments: compactPayments,
    activity,
    caps: {
      opportunities: input.opportunities.length >= MAX_OPPORTUNITIES,
      meetings: rawMeetings.length > MAX_MEETINGS,
      comments: comments.length >= MAX_TOTAL_COMMENTS,
      payments: rawPayments.length > MAX_PAYMENTS,
      activity: activity.length >= MAX_ACTIVITY,
      maxActivity: MAX_ACTIVITY,
    },
  };
}
