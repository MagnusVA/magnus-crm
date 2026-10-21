import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { personCustomerStatus } from "../enrollments/read";
import {
  buildOpportunityAttributionPayload,
  resolveTouches,
  teamMemberDirectory,
} from "../lib/attribution/detailPayload";
import { userMemberIdentity } from "../lib/memberIdentity";
import type { CrmRole } from "../lib/roleMapping";
import { ENROLLMENT_DEAL_LIMIT, ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT } from "../lib/enrollments";
import { normalizeOpportunitySource } from "../lib/sideDeals";
import { getUserDisplayName } from "../reporting/lib/helpers";
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
// Payments are read on every deal and up to the payments a deal that
// syncPersonEnrollments derives from, so a program's total counts every
// payment behind its enrollment.
const MAX_PAYMENTS_PER_OPPORTUNITY = ENROLLMENT_PAYMENTS_PER_DEAL_LIMIT;

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
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    commissionable: payment.commissionable,
    programId: payment.programId,
    programName: payment.programName,
    paymentType: payment.paymentType,
    status: payment.status,
    recordedAt: payment.recordedAt,
    origin: payment.origin,
    permissions,
  };
}

/** What payments that aren't disputed add up to; no currency when they mix. */
function paidTotals(payments: ReadonlyArray<Doc<"paymentRecords">>) {
  const counted = payments.filter((payment) => payment.status !== "disputed");
  const currencies = new Set(counted.map((payment) => payment.currency));
  // Amounts in different currencies don't add up, so a mixed set has no total.
  const mixed = currencies.size > 1;
  return {
    totalPaidMinor: mixed ? null : counted.reduce((sum, payment) => sum + payment.amountMinor, 0),
    currency: currencies.size === 1 ? [...currencies][0] : null,
    paymentCount: counted.length,
  };
}

/**
 * Each of the person's programs with its status, deal and what its payments
 * on the person's deals add up to, and the person as a customer: their status
 * across programs, total, "Customer since" and the first enrollment's deal
 * (docs/plans/phase-4-customers.md §4.4, §6.2). Nothing reads the customer row.
 */
async function buildEnrollmentsPayload(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  enrollments: Doc<"enrollments">[],
  payments: Doc<"paymentRecords">[],
) {
  const programIds = [...new Set(enrollments.map((enrollment) => enrollment.programId))];
  const changerIds = [
    ...new Set(
      enrollments
        .map((enrollment) => enrollment.statusChangedByUserId)
        .filter((userId): userId is Id<"users"> => userId !== undefined),
    ),
  ];
  const [programs, changers] = await Promise.all([
    Promise.all(programIds.map((programId) => ctx.db.get("tenantPrograms", programId))),
    Promise.all(changerIds.map((userId) => ctx.db.get("users", userId))),
  ]);
  const programNameById = new Map<Id<"tenantPrograms">, string>();
  for (const program of programs) {
    if (program && program.tenantId === tenantId) {
      programNameById.set(program._id, program.name);
    }
  }
  const changerNameById = new Map<Id<"users">, string>();
  for (const user of changers) {
    if (user && user.tenantId === tenantId) {
      changerNameById.set(user._id, getUserDisplayName(user));
    }
  }

  const rows = enrollments.map((enrollment) => ({
    enrollmentId: enrollment._id,
    programId: enrollment.programId,
    programName: programNameById.get(enrollment.programId) ?? "Unknown program",
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt,
    opportunityId: enrollment.opportunityId,
    statusChangedAt: enrollment.statusChangedAt ?? null,
    // Null when no user was recorded, as for a status the backfill carried
    // from the customer row. A name of null means the user's row is gone,
    // and the page says "Removed user".
    statusChangedBy: enrollment.statusChangedByUserId
      ? {
          userId: enrollment.statusChangedByUserId,
          name: changerNameById.get(enrollment.statusChangedByUserId) ?? null,
        }
      : null,
    ...paidTotals(payments.filter((payment) => payment.programId === enrollment.programId)),
  }));

  const status = personCustomerStatus(enrollments);
  const [first] = enrollments;
  const enrolledProgramIds = new Set(programIds);
  const customerSummary =
    status && first
      ? {
          status,
          ...paidTotals(payments.filter((payment) => enrolledProgramIds.has(payment.programId))),
          // Enrollments come oldest first.
          customerSince: first.enrolledAt,
          programNames: rows.map((row) => row.programName),
          winningOpportunityId: first.opportunityId,
        }
      : null;

  return { enrollments: rows, customerSummary };
}

export async function buildEntityDetailPayload(
  ctx: QueryCtx,
  input: {
    tenantId: Id<"tenants">;
    viewerUserId: Id<"users">;
    viewerRole: CrmRole;
    lead: Doc<"leads">;
    // Oldest first, as listPersonEnrollments returns them.
    enrollments: Doc<"enrollments">[];
    identifiers: Doc<"leadIdentifiers">[];
    // Newest first, up to the ENROLLMENT_DEAL_LIMIT deals enrollments derive from.
    opportunities: Doc<"opportunities">[];
  },
) {
  // The page lists the newest 50 deals; payments come from every deal read.
  const opportunities = input.opportunities.slice(0, MAX_OPPORTUNITIES);
  const opportunityById = new Map(
    input.opportunities.map((opportunity) => [opportunity._id, opportunity]),
  );
  const closerIds = [
    ...new Set(
      opportunities
        .map((opportunity) => opportunity.assignedCloserId)
        .filter((closerId): closerId is Id<"users"> => closerId !== undefined),
    ),
  ];

  const [closers, meetingBatches, opportunityPaymentBatches] =
    await Promise.all([
      Promise.all(
        closerIds.map(async (closerId) => ({
          closerId,
          closer: await ctx.db.get("users", closerId),
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
      Promise.all(
        input.opportunities.map((opportunity) =>
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

  // The payments on the person's deals; every payment is on a deal (§2.2).
  const rawPayments = opportunityPaymentBatches
    .flat()
    .filter((payment) => payment.tenantId === input.tenantId)
    .sort((left, right) => right.recordedAt - left.recordedAt);
  // Past either limit the person's enrollments can't be derived, and the
  // totals may miss payments.
  const paymentsCapped =
    input.opportunities.length >= ENROLLMENT_DEAL_LIMIT ||
    opportunityPaymentBatches.some((batch) => batch.length >= MAX_PAYMENTS_PER_OPPORTUNITY);
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

  // Deals of one person share their team members; resolve each once.
  const teamMembers = teamMemberDirectory(ctx, input.tenantId);
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
          ? await buildOpportunityAttributionPayload(ctx, opportunity, { teamMembers })
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
      const paymentOpportunity = payment.opportunityId
        ? opportunityById.get(payment.opportunityId)
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
  // The person's first and latest touch, with who made each.
  const { firstTouch, latestTouch } = await resolveTouches(ctx, input.lead, teamMembers);
  // Totals count every payment on the person's deals, whoever is viewing, as
  // the customer row's total did.
  const { enrollments, customerSummary } = await buildEnrollmentsPayload(
    ctx,
    input.tenantId,
    input.enrollments,
    rawPayments,
  );

  return {
    kind: "detail" as const,
    viewer: {
      userId: input.viewerUserId,
      role: input.viewerRole,
    },
    lead: input.lead,
    firstTouch,
    latestTouch,
    enrollments,
    customerSummary,
    identifiers: input.identifiers,
    opportunities: opportunitiesWithAttribution,
    meetings: compactMeetings,
    comments,
    payments: compactPayments,
    caps: {
      opportunities: input.opportunities.length > MAX_OPPORTUNITIES,
      meetings: rawMeetings.length > MAX_MEETINGS,
      comments: comments.length >= MAX_TOTAL_COMMENTS,
      payments: rawPayments.length > MAX_PAYMENTS || paymentsCapped,
    },
  };
}
