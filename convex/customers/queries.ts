import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleCustomerProgramName,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import { paginationOptsValidator } from "convex/server";

type EnrichedPayment = Omit<
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

/**
 * List customers with pagination and optional status filter.
 *
 * All tenant users with customer access see the tenant-wide customer registry.
 * Enriches each customer with denormalized totals and converter display names.
 */
export const listCustomers = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(
      v.union(
        v.literal("active"),
        v.literal("churned"),
        v.literal("paused"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const paginatedResult = args.statusFilter
      ? await ctx.db
          .query("customers")
          .withIndex("by_tenantId_and_status", (q) =>
            q.eq("tenantId", tenantId).eq("status", args.statusFilter!),
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("customers")
          .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
          .order("desc")
          .paginate(args.paginationOpts);

    const converterIds = [
      ...new Set(paginatedResult.page.map((customer) => customer.convertedByUserId)),
    ];
    const converters = await Promise.all(
      converterIds.map(async (converterId) => ({
        converterId,
        converter: await ctx.db.get(converterId),
      })),
    );
    const converterNameById = new Map<Id<"users">, string>(
      converters.map(({ converterId, converter }) => [
        converterId,
        converter?.fullName ?? converter?.email ?? "Unknown",
      ]),
    );

    return {
      ...paginatedResult,
      page: paginatedResult.page.map((customer) => ({
        ...customer,
        totalPaid: (customer.totalPaidMinor ?? 0) / 100,
        currency: customer.paymentCurrency ?? "USD",
        paymentCount: customer.totalPaymentCount ?? 0,
        convertedByName:
          converterNameById.get(customer.convertedByUserId) ?? "Unknown",
      })),
    };
  },
});

/**
 * Get full customer detail with linked entities.
 *
 * Returns the customer, linked lead, winning opportunity, all meetings
 * across the lead's opportunities, and complete payment history.
 */
export const getCustomerDetail = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.tenantId !== tenantId) {
      return null;
    }

    const [lead, winningOpportunity, winningMeeting, opportunities, paymentRecordsRaw, converter] =
      await Promise.all([
        ctx.db.get(customer.leadId),
        ctx.db.get(customer.winningOpportunityId),
        customer.winningMeetingId
          ? ctx.db.get(customer.winningMeetingId)
          : Promise.resolve(null),
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_leadId", (q) =>
            q.eq("tenantId", tenantId).eq("leadId", customer.leadId),
          )
          .take(50),
        ctx.db
          .query("paymentRecords")
          .withIndex("by_customerId_and_recordedAt", (q) =>
            q.eq("customerId", customer._id),
          )
          .order("desc")
          .take(50),
        ctx.db.get(customer.convertedByUserId),
      ]);

    const opportunityStatusById = new Map(
      opportunities.map((opportunity) => [opportunity._id.toString(), opportunity.status]),
    );
    const meetingBatches = await Promise.all(
      opportunities.map((opportunity) =>
        ctx.db
          .query("meetings")
          .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
          .take(20),
      ),
    );

    const meetings = meetingBatches
      .flat()
      .map((meeting) => ({
        ...meeting,
        opportunityStatus:
          opportunityStatusById.get(meeting.opportunityId.toString()) ??
          "scheduled",
      }))
      .sort((a, b) => b.scheduledAt - a.scheduledAt)
      .slice(0, 20);

    const paymentUserNameById = await loadPaymentUserNameById(
      ctx,
      tenantId,
      paymentRecordsRaw,
    );
    const payments: EnrichedPayment[] = paymentRecordsRaw
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
    payments.sort((a, b) => b.recordedAt - a.recordedAt);

    const totalPaid = (customer.totalPaidMinor ?? 0) / 100;
    const currency = customer.paymentCurrency ?? "USD";

    const assignedCloser = winningOpportunity?.assignedCloserId
      ? await ctx.db.get(winningOpportunity.assignedCloserId)
      : null;
    const closerName = assignedCloser?.fullName ?? assignedCloser?.email;

    return {
      customer: {
        ...customer,
        programName: resolveLegacyCompatibleCustomerProgramName(customer),
      },
      lead,
      winningOpportunity,
      winningMeeting,
      closerName,
      convertedByName: converter?.fullName ?? converter?.email ?? "Unknown",
      opportunities: opportunities.map((o) => ({
        _id: o._id,
        status: o.status,
        createdAt: o.createdAt,
        latestMeetingAt: o.latestMeetingAt,
      })),
      meetings: meetings.slice(0, 20), // Cap at 20 most recent
      payments,
      totalPaid,
      currency,
    };
  },
});
