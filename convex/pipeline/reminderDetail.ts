import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import {
  type MemberAvatarIdentity,
  unknownMemberIdentity,
  userMemberIdentity,
} from "../lib/memberIdentity";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";
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
 * Admin-side reminder detail query. Mirrors the closer reminder detail
 * contract so the admin route can reuse the same page composition.
 */
export const getAdminReminderDetail = query({
  args: { followUpId: v.id("followUps") },
  handler: async (ctx, { followUpId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const followUp = await ctx.db.get(followUpId);
    if (!followUp) {
      return null;
    }
    if (followUp.tenantId !== tenantId) {
      return null;
    }
    if (followUp.type !== "manual_reminder") {
      return null;
    }

    const [opportunity, lead] = await Promise.all([
      ctx.db.get(followUp.opportunityId),
      ctx.db.get(followUp.leadId),
    ]);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      return null;
    }
    if (!lead || lead.tenantId !== tenantId) {
      return null;
    }

    const [latestMeeting, paymentRecordsRaw, eventTypeConfig, assignedCloserUser] = await Promise.all([
      opportunity.latestMeetingId
        ? ctx.db.get(opportunity.latestMeetingId)
        : Promise.resolve(null),
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId", (q) =>
          q.eq("opportunityId", opportunity._id),
        )
        .order("desc")
        .take(10),
      opportunity.eventTypeConfigId
        ? ctx.db.get(opportunity.eventTypeConfigId)
        : Promise.resolve(null),
      ctx.db.get(followUp.closerId),
    ]);
    const assignedCloser =
      assignedCloserUser && assignedCloserUser.tenantId === tenantId
        ? await userMemberIdentity(ctx, assignedCloserUser)
        : unknownMemberIdentity("Assigned closer", "unknown");

    const { userNameById: paymentUserNameById, userIdentityById: paymentUserIdentityById } =
      await loadPaymentUserNameById(
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

    console.log("[Admin:Reminder] getAdminReminderDetail", {
      followUpId,
      opportunityStatus: opportunity.status,
      followUpStatus: followUp.status,
      hasLatestMeeting: Boolean(latestMeeting),
      paymentCount: payments.length,
      paymentLinkCount: paymentLinks.length,
    });

    return {
      followUp,
      opportunity,
      lead,
      assignedCloser,
      latestMeeting:
        latestMeeting && latestMeeting.tenantId === tenantId
          ? latestMeeting
          : null,
      payments,
      paymentLinks,
    };
  },
});
