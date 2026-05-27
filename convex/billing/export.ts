import type { Id } from "../_generated/dataModel";
import type { PaymentType } from "../lib/paymentTypes";
import type {
  BillingExportRow,
  BillingPaymentRow,
  BillingPaymentStatus,
} from "./types";

export const MAX_BILLING_EXPORT_ROWS = 1000;
const DEFAULT_BILLING_EXPORT_ROWS = 500;

export type BillingExportFilters = {
  status: BillingPaymentStatus;
  programId?: Id<"tenantPrograms">;
  programName?: string;
  paymentType?: PaymentType;
  startAt?: number;
  endAt?: number;
  limit: number;
};

export function normalizeExportLimit(limit: number | undefined) {
  const parsed = Math.trunc(limit ?? DEFAULT_BILLING_EXPORT_ROWS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BILLING_EXPORT_ROWS;
  }
  return Math.min(Math.max(parsed, 1), MAX_BILLING_EXPORT_ROWS);
}

export function normalizeExportFilters(filters: BillingExportFilters) {
  return JSON.stringify({
    status: filters.status,
    programId: filters.programId ?? null,
    programName: filters.programName ?? null,
    paymentType: filters.paymentType ?? null,
    startAt: filters.startAt ?? null,
    endAt: filters.endAt ?? null,
    limit: filters.limit,
  });
}

export function toBillingExportRow(row: BillingPaymentRow): BillingExportRow {
  return {
    paymentId: row.payment.id,
    paidAt: row.payment.recordedAt,
    reviewedAt: row.review.reviewedAt,
    reviewer: row.review.reviewerName,
    customerName: row.customer.fullName,
    customerEmail: row.customer.email,
    customerPhone: row.customer.phone,
    amount: row.payment.amountMinor / 100,
    currency: row.payment.currency,
    program: row.payment.programName,
    paymentType: row.payment.paymentType,
    referenceCode: row.payment.referenceCode,
    note: row.payment.note,
    enteredBy: row.enteredBy.name,
    phoneCloser: row.phoneCloser.name,
    dmTeam: row.dmAttribution.teamName,
    dmCloser: row.dmAttribution.dmCloserName,
    slackContributor: row.slackContributorSummary.firstLabel,
    slackContributorCount: row.slackContributorSummary.count,
    opportunityId: row.opportunity.id,
    meetingId: row.meeting.id,
    hasProofFile: row.payment.hasProofFile,
  };
}
