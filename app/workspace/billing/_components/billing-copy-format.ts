import type { Id } from "@/convex/_generated/dataModel";
import type { PaymentType } from "@/convex/lib/paymentTypes";
import type { BillingPaymentStatus } from "@/convex/billing/types";

export type BillingCopyDetail = {
  payment: {
    id: Id<"paymentRecords">;
    amountMinor: number;
    currency: string;
    recordedAt: number;
    status: BillingPaymentStatus;
    paymentType: PaymentType;
    programName: string;
    referenceCode: string | null;
    note: string | null;
  };
  customer: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
  };
  enteredBy: { name: string };
  phoneCloser: { name: string | null };
  dmAttribution: {
    teamName: string | null;
    dmCloserName: string | null;
  };
  slackContributorSummary: {
    firstLabel: string | null;
    count: number;
  };
  opportunity: { id: Id<"opportunities"> | null };
  meeting: { id: Id<"meetings"> | null };
  review: {
    reviewedAt: number | null;
    reviewerName: string | null;
  };
};

function line(label: string, value: unknown) {
  return `${label}: ${value === null || value === "" ? "None" : String(value)}`;
}

export function formatBillingCopyPayload(detail: BillingCopyDetail) {
  return [
    line("Payment ID", detail.payment.id),
    line("Paid at", new Date(detail.payment.recordedAt).toISOString()),
    line(
      "Reviewed at",
      detail.review.reviewedAt
        ? new Date(detail.review.reviewedAt).toISOString()
        : null,
    ),
    line("Reviewer", detail.review.reviewerName),
    line("Customer name", detail.customer.fullName),
    line("Customer email", detail.customer.email),
    line("Customer phone", detail.customer.phone),
    line("Amount", (detail.payment.amountMinor / 100).toFixed(2)),
    line("Currency", detail.payment.currency),
    line("Payment program", detail.payment.programName),
    line("Payment type", detail.payment.paymentType),
    line("Payment status", detail.payment.status),
    line("Reference code", detail.payment.referenceCode),
    line("Internal note", detail.payment.note),
    line("Entered by", detail.enteredBy.name),
    line("Phone closer", detail.phoneCloser.name),
    line("DM team", detail.dmAttribution.teamName),
    line("DM closer", detail.dmAttribution.dmCloserName),
    line("Slack contributor", detail.slackContributorSummary.firstLabel),
    line("Slack contributor count", detail.slackContributorSummary.count),
    line("Opportunity ID", detail.opportunity.id),
    line("Meeting ID", detail.meeting.id),
  ].join("\n");
}
