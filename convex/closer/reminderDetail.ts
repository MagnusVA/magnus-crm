import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import {
  type MemberAvatarIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";
import { loadFollowedMeeting } from "../lib/followedMeeting";
import { loadTaskDealContext } from "../lib/taskDealContext";
import { dealLabelOf } from "../opportunities/stageLabels";
import { requireTenantUser } from "../requireTenantUser";

type EnrichedPayment = Omit<
  Doc<"paymentRecords">,
  "attributedCloserId"
> & {
  amount: number;
  attributedCloserId: Id<"users"> | undefined;
  attributedCloserName: string | null;
  attributedCloser: MemberAvatarIdentity | null;
  recordedByName: string | null;
  recordedBy: MemberAvatarIdentity | null;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
};

function resolveAttributedCloserId(
  payment: Doc<"paymentRecords">,
): Id<"users"> | undefined {
  return resolveLegacyCompatibleAttributedCloserId(payment);
}

async function loadPaymentUserMaps(
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
    userIds.map(async (userId) => [userId, await ctx.db.get("users", userId)] as const),
  );

  const userNameById = new Map<Id<"users">, string | null>(
    users.map(([userId, user]) => [
      userId,
      user && "tenantId" in user && user.tenantId === tenantId
        ? (user.fullName ?? user.email)
        : null,
    ]),
  );
  const userIdentityById = new Map<Id<"users">, MemberAvatarIdentity | null>(
    await Promise.all(
      users.map(async ([userId, user]) => [
        userId,
        user && "tenantId" in user && user.tenantId === tenantId
          ? await userMemberIdentity(ctx, user)
          : null,
      ] as const),
    ),
  );

  return { userNameById, userIdentityById };
}

/**
 * The closer's task page: one of their own tasks, a call-back or text-back
 * reminder or a scheduling link waiting on a booking, with the deal it
 * belongs to. Null for anything else: another closer's task, another
 * tenant's, or a missing one, which the page reads as "Task not found".
 */
export const getReminderDetail = query({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, ["closer"]);

    const followUp = await ctx.db.get("followUps", followUpId);
    if (!followUp) {
      return null;
    }
    if (followUp.tenantId !== tenantId) {
      return null;
    }
    if (followUp.closerId !== userId) {
      return null;
    }

    const [opportunity, lead] = await Promise.all([
      ctx.db.get("opportunities", followUp.opportunityId),
      ctx.db.get("leads", followUp.leadId),
    ]);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      return null;
    }
    if (!lead || lead.tenantId !== tenantId) {
      return null;
    }

    const [latestMeeting, paymentRecordsRaw, eventTypeConfig] = await Promise.all([
      opportunity.latestMeetingId
        ? ctx.db.get("meetings", opportunity.latestMeetingId)
        : Promise.resolve(null),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_recordedAt", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .order("desc")
        .take(10),
      opportunity.eventTypeConfigId
        ? ctx.db.get("eventTypeConfigs", opportunity.eventTypeConfigId)
        : Promise.resolve(null),
    ]);

    const {
      userNameById: paymentUserNameById,
      userIdentityById: paymentUserIdentityById,
    } = await loadPaymentUserMaps(
      ctx,
      tenantId,
      paymentRecordsRaw,
    );
    const payments: EnrichedPayment[] = await Promise.all(
      paymentRecordsRaw
        .filter((payment) => payment.tenantId === tenantId)
        .map(async (payment) => {
          let proofFileUrl: string | null = null;
          let proofFileContentType: string | null = null;
          let proofFileSize: number | null = null;
          const attributedCloserId = resolveAttributedCloserId(payment);
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
            attributedCloserId,
            attributedCloserName: attributedCloserId
              ? (paymentUserNameById.get(attributedCloserId) ?? null)
              : null,
            attributedCloser: attributedCloserId
              ? (paymentUserIdentityById.get(attributedCloserId) ?? null)
              : null,
            recordedByName: recordedByUserId
              ? (paymentUserNameById.get(recordedByUserId) ?? null)
              : null,
            recordedBy: recordedByUserId
              ? (paymentUserIdentityById.get(recordedByUserId) ?? null)
              : null,
            proofFileUrl,
            proofFileContentType,
            proofFileSize,
          };
        }),
    );
    payments.sort((a, b) => b.recordedAt - a.recordedAt);

    const paymentLinks =
      eventTypeConfig && eventTypeConfig.tenantId === tenantId
        ? (eventTypeConfig.paymentLinks ?? [])
        : [];
    // The deal card, its credit line and the deal's calls.
    const dealContext = await loadTaskDealContext(ctx, tenantId, opportunity);
    // The call the task follows ("after the Oct 26 no-show"): the one the
    // task was set from, or the deal's last call up to its early-outcome
    // window, however old.
    const followed = await loadFollowedMeeting(ctx, followUp);
    const followedMeeting = followed
      ? { _id: followed._id, scheduledAt: followed.scheduledAt, status: followed.status }
      : null;

    return {
      followUp,
      // The deal badge and the page's analytics read the stage and outcome
      // (docs/plans/phase-5-deal-status.md §6.1).
      opportunity: { ...opportunity, ...dealLabelOf(opportunity) },
      lead,
      latestMeeting:
        latestMeeting && latestMeeting.tenantId === tenantId
          ? latestMeeting
          : null,
      payments,
      paymentLinks,
      ...dealContext,
      followedMeeting,
      bookedMeeting: await loadBookedMeeting(ctx, tenantId, followUp),
    };
  },
});

/**
 * The call a booked scheduling link made, by the Calendly event the booking
 * stamped on the link: one indexed read, and only for a booked link.
 */
async function loadBookedMeeting(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  followUp: Doc<"followUps">,
): Promise<{ _id: Id<"meetings">; scheduledAt: number } | null> {
  const eventUri = followUp.calendlyEventUri;
  if (followUp.type !== "scheduling_link" || followUp.status !== "booked" || !eventUri) {
    return null;
  }
  const meeting = await ctx.db
    .query("meetings")
    .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
      q.eq("tenantId", tenantId).eq("calendlyEventUri", eventUri),
    )
    .first();
  return meeting ? { _id: meeting._id, scheduledAt: meeting.scheduledAt } : null;
}
