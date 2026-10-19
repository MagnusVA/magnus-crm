import { DirectAggregate, TableAggregate } from "@convex-dev/aggregate";
import type { LifecycleStage } from "../leads/lifecycle";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";

type MeetingCallClassification = "new" | "follow_up";
type OpportunityAssignedCloserKey = Id<"users"> | "";
type PaymentAggregateCloserKey = Id<"users"> | "";

function paymentAggregateCloserKey(
  doc: Doc<"paymentRecords">,
): PaymentAggregateCloserKey {
  if (doc.commissionable === false) {
    return "";
  }
  return doc.attributedCloserId ?? "";
}

export const meetingsByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, MeetingCallClassification, Doc<"meetings">["status"], number];
  DataModel: DataModel;
  TableName: "meetings";
}>(components.meetingsByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.assignedCloserId,
    doc.callClassification ?? "new",
    doc.status,
    doc.scheduledAt,
  ],
});

export const paymentSums = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentAggregateCloserKey, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.paymentSums, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [paymentAggregateCloserKey(doc), doc.recordedAt],
  sumValue: (doc) => (doc.status === "disputed" ? 0 : doc.amountMinor),
});

export const opportunityByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Doc<"opportunities">["status"], OpportunityAssignedCloserKey, number];
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.opportunityByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.status,
    doc.assignedCloserId ?? "",
    doc.createdAt,
  ],
});

function slackQualificationSubmittedAt(doc: Doc<"opportunities">): number {
  return doc.qualifiedBy?.submittedAt ?? doc.createdAt;
}

export function isSlackQualificationAggregateEligible(
  doc: Doc<"opportunities">,
): boolean {
  return doc.source === "slack_qualified" && doc.qualifiedBy !== undefined;
}

export const slackQualificationsByUser = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [string, number];
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.slackQualificationsByUser, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.qualifiedBy?.slackUserId ?? "",
    slackQualificationSubmittedAt(doc),
  ],
});

export const slackQualificationsByTime = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: number;
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.slackQualificationsByTime, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => slackQualificationSubmittedAt(doc),
});

// One entry per person and lifecycle stage reached, keyed by when they first
// reached it (docs/plans/phase-1-foundations.md §3). Counting a stage over a
// range counts the people who first reached it in that range. The id is
// `${leadId}:${stage}`. A merged person has no entries.
export const leadStageEntries = new DirectAggregate<{
  Namespace: Id<"tenants">;
  Key: [LifecycleStage, number];
  Id: string;
}>(components.leadStageEntries);

export const customerConversions = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, number];
  DataModel: DataModel;
  TableName: "customers";
}>(components.customerConversions, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.convertedByUserId, doc.convertedAt],
});
