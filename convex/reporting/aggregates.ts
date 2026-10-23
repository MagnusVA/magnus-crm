import { DirectAggregate, TableAggregate } from "@convex-dev/aggregate";
import type { LifecycleStage } from "../leads/lifecycle";
import {
  dealStageOf,
  type DealOutcome,
  type DealStage,
} from "../opportunities/stages";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";

type MeetingCallClassification = "new" | "follow_up";
type OpportunityAssignedCloserKey = Id<"users"> | "";
type PaymentAggregateCloserKey = Id<"users"> | "";

function paymentAggregateCloserKey(
  doc: Doc<"paymentRecords">,
): PaymentAggregateCloserKey {
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

// Deals by stage and outcome (docs/plans/phase-5-deal-status.md §3.1). Every
// deal is in it (backfillOpportunityByStage), so the write hooks use the
// strict methods: a deal missing from it, or entered twice, throws instead of
// drifting.
export const opportunityByStage = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [DealStage, DealOutcome, OpportunityAssignedCloserKey, number];
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.opportunityByStage, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => {
    const { stage, outcome } = dealStageOf(doc);
    return [stage, outcome, doc.assignedCloserId ?? "", doc.createdAt];
  },
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

// One entry per linked lead gen prospect at Prospect, and one at each later
// stage its person reached at or after the prospect's first capture
// (docs/plans/phase-2-person-first.md §7, D6). Counting a worker's stage over
// a range of capture dates counts the prospects they first captured then that
// went on to reach it. The id is `${prospectId}:${stage}`.
export const prospectConversions = new DirectAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"leadGenWorkers">, LifecycleStage, number];
  Id: string;
}>(components.prospectConversions);
