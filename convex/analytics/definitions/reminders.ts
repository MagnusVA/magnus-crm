import type { Id } from "../../_generated/dataModel";
import { PAYMENT_TYPES, type PaymentType } from "../../lib/paymentTypes";
import {
  buildReminderOutcomeFunnel,
  type getReminderOutcomeFunnel,
} from "../../reporting/remindersReporting";
import {
  defineReport,
  optionalEnumFilter,
  optionalIdFilter,
  rangeParams,
} from "../definition";
import { docsFromRows } from "../rows";

// Reminder Outcomes (app/workspace/reports/reminders). The funnel reads the
// range's manual reminders and its non-disputed reminder payments, so
// ClickHouse returns those rows and the Convex builder does the rest; the
// reader's 2,000-row caps don't apply.

type RemindersFilters = {
  programId: Id<"tenantPrograms"> | null;
  paymentType: PaymentType | null;
};

// by_tenantId_and_createdAt order. The builder keeps only manual reminders.
const followUpsSql = `
SELECT *
FROM analytics.followups
WHERE tenant_id = {tenant_id:String}
  AND created_at_ms >= {from_ms:Int64}
  AND created_at_ms < {to_ms:Int64}
  AND type = 'manual_reminder'
ORDER BY created_at_ms, creation_time_ms`;

// The reader's scan: closer reminders, then admin reminders, each in
// by_tenantId_and_origin_and_recordedAt order.
const reminderPaymentsSql = `
SELECT *
FROM analytics.payments
WHERE tenant_id = {tenant_id:String}
  AND origin IN ('closer_reminder', 'admin_reminder')
  AND recorded_at_ms >= {from_ms:Int64}
  AND recorded_at_ms < {to_ms:Int64}
  AND ifNull(status, '') != 'disputed'
ORDER BY origin = 'admin_reminder', recorded_at_ms, creation_time_ms`;

export const remindersReports = [
  defineReport<typeof getReminderOutcomeFunnel, RemindersFilters>({
    id: "reminders.funnel",
    page: "reminders",
    roles: ["tenant_master", "tenant_admin"],
    day: "browser",
    parseFilters: async (ctx, raw) => ({
      programId: optionalIdFilter(ctx, "tenantPrograms", raw.programId),
      paymentType: optionalEnumFilter(raw.paymentType, PAYMENT_TYPES),
    }),
    sql: (input) => ({
      followUps: { sql: followUpsSql, params: rangeParams(input.range) },
      payments: { sql: reminderPaymentsSql, params: rangeParams(input.range) },
    }),
    finalize: async (ctx, input) =>
      await buildReminderOutcomeFunnel(ctx, input.filters, {
        followUps: docsFromRows<"followUps">(input.rows.followUps),
        isTruncated: false,
        reminderRevenue: docsFromRows<"paymentRecords">(input.rows.payments),
        isReminderRevenueTruncated: false,
      }),
    live: {
      name: "reporting/remindersReporting:getReminderOutcomeFunnel",
      args: (input) => ({
        startDate: input.range.fromMs,
        endDate: input.range.toMs,
        ...(input.filters.programId ? { programId: input.filters.programId } : {}),
        ...(input.filters.paymentType ? { paymentType: input.filters.paymentType } : {}),
      }),
    },
  }),
];
