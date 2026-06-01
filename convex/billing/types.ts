import type { Doc, Id } from "../_generated/dataModel";
import type { MemberAvatarIdentity } from "../lib/memberIdentity";
import type { PaymentType } from "../lib/paymentTypes";

export type BillingPaymentStatus = "recorded" | "verified" | "disputed";

export type BillingReviewSemantics = {
  needsReviewStatus: "recorded";
  reviewedStatus: "verified";
  invalidRevenueStatus: "disputed";
  reviewedByField: "verifiedByUserId";
  reviewedAtField: "verifiedAt";
};

export const BILLING_REVIEW_SEMANTICS: BillingReviewSemantics = {
  needsReviewStatus: "recorded",
  reviewedStatus: "verified",
  invalidRevenueStatus: "disputed",
  reviewedByField: "verifiedByUserId",
  reviewedAtField: "verifiedAt",
};

export const BILLING_PAYMENT_STATUSES = [
  "recorded",
  "verified",
  "disputed",
] as const satisfies readonly BillingPaymentStatus[];

export type BillingAuditMetric =
  | "missingCustomerId"
  | "missingMeetingId"
  | "missingAttributedCloserOnCommissionable"
  | "missingRecordedByUser"
  | "missingProgram"
  | "missingAttributionContext"
  | "missingSlackContributorTimeline"
  | "existingVerifiedRows"
  | "proofFileRows";

export type BillingCountArgs = {
  status: Doc<"paymentRecords">["status"];
  programId?: Id<"tenantPrograms">;
  paymentType?: Doc<"paymentRecords">["paymentType"];
  startAt?: number;
  endAt?: number;
};

export type BillingDmAttribution = {
  status: "mapped" | "unmapped" | "internal" | "none";
  teamName: string | null;
  dmCloserName: string | null;
  dmCloser: MemberAvatarIdentity | null;
  rawSource: string | null;
  rawMedium: string | null;
};

export type BillingPaymentListRow = {
  payment: {
    id: Id<"paymentRecords">;
    amountMinor: number;
    currency: string;
    recordedAt: number;
    status: BillingPaymentStatus;
    paymentType: PaymentType;
    programName: string;
    hasProofFile: boolean;
  };
  customer: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
  };
};

export type BillingPaymentRow = {
  payment: {
    id: Id<"paymentRecords">;
    amountMinor: number;
    currency: string;
    recordedAt: number;
    status: BillingPaymentStatus;
    paymentType: PaymentType;
    programId: Id<"tenantPrograms">;
    programName: string;
    origin: Doc<"paymentRecords">["origin"];
    contextType: Doc<"paymentRecords">["contextType"];
    referenceCode: string | null;
    note: string | null;
    hasProofFile: boolean;
    commissionable: boolean;
  };
  customer: {
    id: Id<"customers"> | null;
    fullName: string | null;
    email: string | null;
    phone: string | null;
  };
  opportunity: {
    id: Id<"opportunities"> | null;
    status: Doc<"opportunities">["status"] | null;
    source: Doc<"opportunities">["source"] | null;
  };
  meeting: {
    id: Id<"meetings"> | null;
    scheduledAt: number | null;
    fathomLink: string | null;
  };
  enteredBy: {
    id: Id<"users"> | null;
    name: string;
    identity: MemberAvatarIdentity;
  };
  phoneCloser: {
    id: Id<"users"> | null;
    name: string | null;
    identity: MemberAvatarIdentity | null;
  };
  dmAttribution: BillingDmAttribution;
  slackContributorSummary: {
    firstLabel: string | null;
    latestLabel: string | null;
    count: number;
  };
  review: {
    reviewedAt: number | null;
    reviewerName: string | null;
    reviewer: MemberAvatarIdentity | null;
  };
};

export type BillingPaymentEvent = {
  id: Id<"domainEvents">;
  eventType: string;
  occurredAt: number;
  source: Doc<"domainEvents">["source"];
  actorUserId: Id<"users"> | null;
  actorName: string | null;
  actor: MemberAvatarIdentity | null;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  metadata: string | null;
};

export type BillingSlackContributorTimelineEntry = {
  slackUserId: string;
  label: string;
  identity: MemberAvatarIdentity;
  submittedAt: number;
  resultKind: Doc<"slackQualificationEvents">["resultKind"] | null;
};

export type BillingPaymentDetail = BillingPaymentRow & {
  proof: {
    url: string | null;
    contentType: string | null;
    size: number | null;
  };
  events: BillingPaymentEvent[];
  slackContributorTimeline: BillingSlackContributorTimelineEntry[];
};

export type BillingExportRow = {
  paymentId: Id<"paymentRecords">;
  paidAt: number;
  reviewedAt: number | null;
  reviewer: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  amount: number;
  currency: string;
  program: string;
  paymentType: PaymentType;
  referenceCode: string | null;
  note: string | null;
  enteredBy: string;
  phoneCloser: string | null;
  dmTeam: string | null;
  dmCloser: string | null;
  slackContributor: string | null;
  slackContributorCount: number;
  opportunityId: Id<"opportunities"> | null;
  meetingId: Id<"meetings"> | null;
  hasProofFile: boolean;
};
