import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { paginationOptsValidator } from "convex/server";

/**
 * List customers with pagination and optional status filter.
 *
 * Admins see all customers. Closers see only their own (convertedByUserId).
 * Enriches each customer with computed totalPaid from payment records.
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
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    // Build base query
    let customersQuery;
    if (args.statusFilter) {
      customersQuery = ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_status", (q) =>
          q.eq("tenantId", tenantId).eq("status", args.statusFilter!),
        );
    } else {
      customersQuery = ctx.db
        .query("customers")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId));
    }

    const paginatedResult = await customersQuery
      .order("desc")
      .paginate(args.paginationOpts);

    // Enrich with computed totalPaid and closer name
    const enrichedPage = await Promise.all(
      paginatedResult.page.map(async (customer) => {
        // Closer filter: only show own customers
        if (role === "closer" && customer.convertedByUserId !== userId) {
          return null; // Filtered out client-side; paginate doesn't support compound conditions
        }

        // Compute total paid from payment records
        const payments = await ctx.db
          .query("paymentRecords")
          .withIndex("by_customerId", (q) => q.eq("customerId", customer._id))
          .collect();
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        const currency = payments[0]?.currency ?? "USD"; // Use first payment's currency

        // Get converter's name
        const converter = await ctx.db.get(customer.convertedByUserId);

        return {
          ...customer,
          totalPaid,
          currency,
          paymentCount: payments.length,
          convertedByName: converter?.fullName ?? converter?.email ?? "Unknown",
        };
      }),
    );

    return {
      ...paginatedResult,
      page: enrichedPage.filter(Boolean),
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
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.tenantId !== tenantId) {
      return null;
    }

    // Closer authorization: own customers only
    if (role === "closer" && customer.convertedByUserId !== userId) {
      return null;
    }

    // Load linked lead
    const lead = await ctx.db.get(customer.leadId);

    // Load winning opportunity
    const winningOpportunity = await ctx.db.get(
      customer.winningOpportunityId,
    );

    // Load winning meeting (if set)
    const winningMeeting = customer.winningMeetingId
      ? await ctx.db.get(customer.winningMeetingId)
      : null;

    // Load all opportunities for this lead (for relationship graph)
    const opportunities = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", customer.leadId),
      )
      .take(50);

    // Load all meetings across all opportunities
    const meetings = [];
    for (const opp of opportunities) {
      const oppMeetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
        .take(20);
      meetings.push(
        ...oppMeetings.map((m) => ({
          ...m,
          opportunityStatus: opp.status,
        })),
      );
    }
    meetings.sort((a, b) => b.scheduledAt - a.scheduledAt);

    // Load all payment records for this customer
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_customerId", (q) => q.eq("customerId", customer._id))
      .collect();
    payments.sort((a, b) => b.recordedAt - a.recordedAt);

    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const currency = payments[0]?.currency ?? "USD";

    // Get converter name
    const converter = await ctx.db.get(customer.convertedByUserId);

    // Get closer name (from winning opportunity)
    let closerName: string | undefined;
    if (winningOpportunity?.assignedCloserId) {
      const closer = await ctx.db.get(winningOpportunity.assignedCloserId);
      closerName = closer?.fullName ?? closer?.email;
    }

    return {
      customer,
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

/**
 * Get computed total paid for a customer.
 *
 * Lightweight query for when only the total is needed (e.g., list enrichment).
 */
export const getCustomerTotalPaid = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, { customerId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const customer = await ctx.db.get(customerId);
    if (!customer || customer.tenantId !== tenantId) {
      return null;
    }

    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_customerId", (q) => q.eq("customerId", customerId))
      .collect();

    return {
      totalPaid: payments.reduce((sum, p) => sum + p.amount, 0),
      currency: payments[0]?.currency ?? "USD",
      paymentCount: payments.length,
    };
  },
});
