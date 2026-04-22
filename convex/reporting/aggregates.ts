import { TableAggregate } from "@convex-dev/aggregate";
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

export const leadTimeline = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: number;
  DataModel: DataModel;
  TableName: "leads";
}>(components.leadTimeline, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => doc._creationTime,
});

export const customerConversions = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"users">, number];
  DataModel: DataModel;
  TableName: "customers";
}>(components.customerConversions, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.convertedByUserId, doc.convertedAt],
});
