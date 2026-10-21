import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import {
  countNewCustomersFromCustomers,
  countNewCustomersFromEnrollments,
  MAX_NEW_CUSTOMER_SCAN_ROWS,
} from "../dashboard/adminStats";
import {
  customerBillingLabels,
  personBillingLabels,
  resolveBillingFromCustomer,
  resolveBillingFromPerson,
  type BillingLabels,
} from "../billing/enrichment";
import {
  customerCopyContact,
  customerFieldsFromCustomerRow,
  customerFieldsFromEnrollments,
  latestActivityFor,
  loadPersonDeals,
  personContact,
  projectedLifecycle,
  type SearchRowContact,
} from "../leadCustomers/projection";
import { countLeadStageEntries } from "../lib/leadLifecycle";
import { businessDateToUtcStart } from "../reporting/lib/hondurasBusinessTime";
import { assertValidDateRange, getActiveClosers } from "../reporting/lib/helpers";
import {
  computeLeadConversionMetrics,
  conversionsFromCustomers,
  conversionsFromEnrollments,
  type LeadConversion,
  type LeadConversionMetrics,
} from "../reporting/leadConversion";

// Each number the Phase 4 readers show, computed from the customer rows and
// from the person and their enrollments, with the differences by ID
// (docs/plans/phase-4-customers.md §10.3). Production runs these before the
// readers switch and again after; the narrow removes this module.

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_PARITY_MONTH = { year: 2026, month: 4 };
const MAX_RANGES = 50;
// Conversions read per call, both ways together; about 13 documents each.
const CONVERSION_BUDGET = 200;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

type ParityValue = string | number | boolean | null;
const parityValue = v.union(v.string(), v.number(), v.boolean(), v.null());

function asParityValue(value: ParityValue | undefined): ParityValue {
  return value ?? null;
}

function pageSize(numItems: number | undefined) {
  const size = Math.trunc(numItems ?? DEFAULT_PAGE_SIZE);
  return Number.isFinite(size) ? Math.min(Math.max(size, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/**
 * Each business month from April 2026 through the current one, and the last
 * 7 days.
 */
export function defaultParityRanges(now: number) {
  const ranges: Array<{ startDate: number; endDate: number }> = [];
  let { year, month } = FIRST_PARITY_MONTH;
  while (businessDateToUtcStart(monthKey(year, month)) <= now) {
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    ranges.push({
      startDate: businessDateToUtcStart(monthKey(year, month)),
      endDate: businessDateToUtcStart(monthKey(next.year, next.month)),
    });
    ({ year, month } = next);
  }
  ranges.push({ startDate: now - 7 * DAY_MS, endDate: now });
  return ranges;
}

const METRIC_KEYS = [
  "totalConversions",
  "conversionRate",
  "avgMeetingsPerSale",
  "meetingsPerSaleNumerator",
  "meetingsPerSaleDenominator",
  "avgTimeToConversionMs",
  "timeToConversionSampleCount",
  "excludedConversions",
  "isConversionDataTruncated",
] as const satisfies ReadonlyArray<keyof LeadConversionMetrics>;

function conversionsByLead(conversions: LeadConversion[]) {
  const byLead = new Map<Id<"leads">, LeadConversion[]>();
  for (const conversion of conversions) {
    byLead.set(conversion.leadId, [...(byLead.get(conversion.leadId) ?? []), conversion]);
  }
  return byLead;
}

function compareConversionLists(
  fromCustomers: LeadConversion[],
  fromEnrollments: LeadConversion[],
) {
  const differences: Array<{
    leadId: Id<"leads">;
    field: string;
    fromCustomers: ParityValue;
    fromEnrollments: ParityValue;
  }> = [];
  const customersByLead = conversionsByLead(fromCustomers);
  const enrollmentsByLead = conversionsByLead(fromEnrollments);
  const leadIds = new Set([...customersByLead.keys(), ...enrollmentsByLead.keys()]);
  for (const leadId of leadIds) {
    const left = customersByLead.get(leadId) ?? [];
    const right = enrollmentsByLead.get(leadId) ?? [];
    if (left.length !== 1 || right.length !== 1) {
      differences.push({ leadId, field: "count", fromCustomers: left.length, fromEnrollments: right.length });
      continue;
    }
    for (const field of ["convertedAt", "winningOpportunityId", "convertedByUserId"] as const) {
      if (left[0][field] !== right[0][field]) {
        differences.push({
          leadId,
          field,
          fromCustomers: asParityValue(left[0][field]),
          fromEnrollments: asParityValue(right[0][field]),
        });
      }
    }
  }
  return differences;
}

async function compareLeadConversionRange(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  activeCloserIds: ReadonlySet<Id<"users">>,
  range: { startDate: number; endDate: number },
) {
  const { startDate, endDate } = range;
  const newLeads = await countLeadStageEntries(ctx, tenantId, "qualified", startDate, endDate);
  const [customerList, enrollmentList] = await Promise.all([
    conversionsFromCustomers(ctx, tenantId, startDate, endDate),
    conversionsFromEnrollments(ctx, tenantId, startDate, endDate),
  ]);
  const [fromCustomers, fromEnrollments] = await Promise.all([
    computeLeadConversionMetrics(ctx, { newLeads, list: customerList, activeCloserIds }),
    computeLeadConversionMetrics(ctx, { newLeads, list: enrollmentList, activeCloserIds }),
  ]);

  const metrics: Array<{ metric: string; fromCustomers: ParityValue; fromEnrollments: ParityValue }> = [];
  // The admin dashboard's new customers, through the dashboard's own counts.
  const [newCustomersFromCustomers, newCustomersFromEnrollments] = await Promise.all([
    countNewCustomersFromCustomers(ctx, tenantId, startDate, endDate),
    countNewCustomersFromEnrollments(ctx, tenantId, startDate, endDate),
  ]);
  // A count at the cap may stand for more rows, so two capped counts prove
  // nothing: report the range instead of calling it equal.
  const capped =
    newCustomersFromCustomers >= MAX_NEW_CUSTOMER_SCAN_ROWS ||
    newCustomersFromEnrollments >= MAX_NEW_CUSTOMER_SCAN_ROWS;
  if (capped) {
    metrics.push({
      metric: "newCustomersCapped",
      fromCustomers: newCustomersFromCustomers,
      fromEnrollments: newCustomersFromEnrollments,
    });
  } else if (newCustomersFromCustomers !== newCustomersFromEnrollments) {
    metrics.push({
      metric: "newCustomers",
      fromCustomers: newCustomersFromCustomers,
      fromEnrollments: newCustomersFromEnrollments,
    });
  }
  for (const metric of METRIC_KEYS) {
    if (fromCustomers[metric] !== fromEnrollments[metric]) {
      metrics.push({
        metric,
        fromCustomers: fromCustomers[metric],
        fromEnrollments: fromEnrollments[metric],
      });
    }
  }

  const closers: Array<{ closerId: Id<"users">; fromCustomers: number; fromEnrollments: number }> = [];
  const closerIds = new Set([
    ...fromCustomers.conversionsByCloser.keys(),
    ...fromEnrollments.conversionsByCloser.keys(),
  ]);
  for (const closerId of closerIds) {
    const left = fromCustomers.conversionsByCloser.get(closerId) ?? 0;
    const right = fromEnrollments.conversionsByCloser.get(closerId) ?? 0;
    if (left !== right) {
      closers.push({ closerId, fromCustomers: left, fromEnrollments: right });
    }
  }

  return {
    startDate,
    endDate,
    newLeads,
    conversionsFromCustomers: customerList.conversions.length,
    conversionsFromEnrollments: enrollmentList.conversions.length,
    metrics,
    closers,
    conversions: compareConversionLists(customerList.conversions, enrollmentList.conversions),
  };
}

/**
 * Every Leads & Conversions number, and the admin dashboard's new customers,
 * from the customer rows and from first enrollments, per range. Without
 * `ranges`, each month from April 2026 and the last 7 days. Pass
 * `continueCursor` back as `cursor` until it is null.
 */
export const compareLeadConversion = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    ranges: v.optional(v.array(v.object({ startDate: v.number(), endDate: v.number() }))),
    cursor: v.optional(v.number()),
  },
  returns: v.object({
    ranges: v.array(
      v.object({
        startDate: v.number(),
        endDate: v.number(),
        newLeads: v.number(),
        conversionsFromCustomers: v.number(),
        conversionsFromEnrollments: v.number(),
        metrics: v.array(
          v.object({ metric: v.string(), fromCustomers: parityValue, fromEnrollments: parityValue }),
        ),
        closers: v.array(
          v.object({ closerId: v.id("users"), fromCustomers: v.number(), fromEnrollments: v.number() }),
        ),
        conversions: v.array(
          v.object({
            leadId: v.id("leads"),
            field: v.string(),
            fromCustomers: parityValue,
            fromEnrollments: parityValue,
          }),
        ),
      }),
    ),
    continueCursor: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const ranges = args.ranges ?? defaultParityRanges(Date.now());
    if (ranges.length > MAX_RANGES) {
      throw new Error(`Pass at most ${MAX_RANGES} ranges`);
    }
    for (const range of ranges) {
      assertValidDateRange(range.startDate, range.endDate);
    }
    const start = Math.max(0, Math.trunc(args.cursor ?? 0));
    const closers = await getActiveClosers(ctx, args.tenantId);
    const activeCloserIds = new Set<Id<"users">>(closers.map((closer) => closer._id));

    const results = [];
    let conversionsRead = 0;
    let index = start;
    while (index < ranges.length && (index === start || conversionsRead < CONVERSION_BUDGET)) {
      const result = await compareLeadConversionRange(ctx, args.tenantId, activeCloserIds, ranges[index]);
      conversionsRead += result.conversionsFromCustomers + result.conversionsFromEnrollments;
      results.push(result);
      index += 1;
    }
    return { ranges: results, continueCursor: index < ranges.length ? index : null };
  },
});

function contactChanges<T extends SearchRowContact | BillingLabels>(before: T, after: T) {
  return (Object.keys(before) as Array<keyof T>).filter((field) => before[field] !== after[field]);
}

type SocialHandles = Doc<"leads">["socialHandles"];

/** Whether two handle lists name different handles, ignoring order. */
function socialHandlesDiffer(left: SocialHandles, right: SocialHandles) {
  const key = (handles: SocialHandles) =>
    (handles ?? []).map((entry) => `${entry.type}:${entry.handle}`).sort().join("\n");
  return key(left) !== key(right);
}

/**
 * Per customer, the search row fields from the customer row and from the
 * enrollments (§6.1), and how many rows' name, email, phone or social
 * handles change.
 */
export const compareSearchRows = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    checked: v.number(),
    differences: v.array(
      v.object({
        customerId: v.id("customers"),
        leadId: v.id("leads"),
        field: v.string(),
        fromCustomers: parityValue,
        fromEnrollments: parityValue,
      }),
    ),
    contactChanges: v.object({
      rows: v.number(),
      displayName: v.number(),
      email: v.number(),
      phone: v.number(),
      socialHandles: v.number(),
      leadIds: v.array(v.id("leads")),
    }),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("customers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .paginate({ cursor: args.cursor, numItems: pageSize(args.numItems) });

    const differences: Array<{
      customerId: Id<"customers">;
      leadId: Id<"leads">;
      field: string;
      fromCustomers: ParityValue;
      fromEnrollments: ParityValue;
    }> = [];
    const changes = {
      rows: 0,
      displayName: 0,
      email: 0,
      phone: 0,
      socialHandles: 0,
      leadIds: [] as Id<"leads">[],
    };

    for (const customer of page.page) {
      const lead = await ctx.db.get("leads", customer.leadId);
      if (!lead || lead.tenantId !== args.tenantId) {
        differences.push({
          customerId: customer._id,
          leadId: customer.leadId,
          field: "person",
          fromCustomers: customer.leadId,
          fromEnrollments: null,
        });
        continue;
      }
      const deals = await loadPersonDeals(ctx, args.tenantId, lead._id);
      const [legacy, next] = await Promise.all([
        customerFieldsFromCustomerRow(ctx, args.tenantId, lead._id),
        customerFieldsFromEnrollments(ctx, args.tenantId, lead._id, deals),
      ]);
      const before = {
        lifecycle: projectedLifecycle(lead, legacy.fields.isCustomer),
        customerStatus: legacy.fields.customerStatus,
        totalPaidMinor: legacy.fields.totalPaidMinor,
        paymentCurrency: legacy.fields.paymentCurrency,
        convertedAt: legacy.fields.convertedAt,
        latestActivityAt: latestActivityFor(lead, legacy.fields, deals),
      };
      const after: typeof before = {
        lifecycle: projectedLifecycle(lead, next.isCustomer),
        customerStatus: next.customerStatus,
        totalPaidMinor: next.totalPaidMinor,
        paymentCurrency: next.paymentCurrency,
        convertedAt: next.convertedAt,
        latestActivityAt: latestActivityFor(lead, next, deals),
      };
      for (const field of Object.keys(before) as Array<keyof typeof before>) {
        if (before[field] !== after[field]) {
          differences.push({
            customerId: customer._id,
            leadId: lead._id,
            field,
            fromCustomers: asParityValue(before[field]),
            fromEnrollments: asParityValue(after[field]),
          });
        }
      }

      const changed = contactChanges(customerCopyContact(lead, legacy.customer), personContact(lead));
      const handlesChanged =
        legacy.customer !== null && socialHandlesDiffer(legacy.customer.socialHandles, lead.socialHandles);
      if (changed.length > 0 || handlesChanged) {
        changes.rows += 1;
        changes.leadIds.push(lead._id);
        for (const field of changed) {
          changes[field] += 1;
        }
        if (handlesChanged) {
          changes.socialHandles += 1;
        }
      }
    }

    return {
      checked: page.page.length,
      differences,
      contactChanges: changes,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Per payment, the deal and meeting billing resolves from the customer row
 * and from the payment's deal and person (§6.4), and how many payments'
 * customer labels change.
 */
export const compareBillingRows = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    checked: v.number(),
    differences: v.array(
      v.object({
        paymentId: v.id("paymentRecords"),
        field: v.string(),
        fromCustomers: parityValue,
        fromPerson: parityValue,
      }),
    ),
    labelChanges: v.object({
      rows: v.number(),
      fullName: v.number(),
      email: v.number(),
      phone: v.number(),
      paymentIds: v.array(v.id("paymentRecords")),
    }),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) => q.eq("tenantId", args.tenantId))
      .paginate({ cursor: args.cursor, numItems: pageSize(args.numItems) });

    const differences: Array<{
      paymentId: Id<"paymentRecords">;
      field: string;
      fromCustomers: ParityValue;
      fromPerson: ParityValue;
    }> = [];
    const changes = {
      rows: 0,
      fullName: 0,
      email: 0,
      phone: 0,
      paymentIds: [] as Id<"paymentRecords">[],
    };

    for (const payment of page.page) {
      const [legacy, next] = await Promise.all([
        resolveBillingFromCustomer(ctx, args.tenantId, payment),
        resolveBillingFromPerson(ctx, args.tenantId, payment),
      ]);
      const resolved = {
        opportunityId: [legacy.opportunity?._id ?? null, next.opportunity?._id ?? null],
        meetingId: [legacy.meeting?._id ?? null, next.meeting?._id ?? null],
      };
      for (const [field, [before, after]] of Object.entries(resolved)) {
        if (before !== after) {
          differences.push({ paymentId: payment._id, field, fromCustomers: before, fromPerson: after });
        }
      }

      const changed = contactChanges(
        customerBillingLabels(legacy.customer),
        personBillingLabels(next.person),
      );
      if (changed.length > 0) {
        changes.rows += 1;
        changes.paymentIds.push(payment._id);
        for (const field of changed) {
          changes[field] += 1;
        }
      }
    }

    return {
      checked: page.page.length,
      differences,
      labelChanges: changes,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
