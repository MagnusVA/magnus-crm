import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { DealStage } from "../opportunities/stages";
import { isPersonLoss } from "./lib/outcomeDerivation";

export const openDealAging = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [DealStage, number];
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.openDealAging, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.stage, doc.nextMeetingAt ?? 0],
  sumValue: (doc) => doc.createdAt,
});

export const personLosses = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [number, Id<"users"> | ""];
  DataModel: DataModel;
  TableName: "opportunities";
}>(components.personLosses, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.lostAt ?? 0, doc.lostByUserId ?? ""],
});

export const isOpenDealAgingEligible = (doc: Doc<"opportunities">) =>
  doc.outcome === "open";
export const isPersonLossEligible = (doc: Doc<"opportunities">) =>
  doc.outcome === "lost" && doc.lostAt !== undefined && isPersonLoss(doc);

// Backfilled and verified: missing or duplicate eligible entries must fail
// instead of silently masking aggregate drift.
const filteredAggregates = [
  { aggregate: openDealAging, eligible: isOpenDealAgingEligible },
  { aggregate: personLosses, eligible: isPersonLossEligible },
] as const;

export async function insertPipelineHealthAggregates(ctx: MutationCtx, doc: Doc<"opportunities">) {
  for (const { aggregate, eligible } of filteredAggregates) {
    if (eligible(doc)) await aggregate.insert(ctx, doc);
  }
}

export async function replaceOpenDealAging(
  ctx: MutationCtx,
  before: Doc<"opportunities">,
  after: Doc<"opportunities">,
) {
  if (isOpenDealAgingEligible(before) && isOpenDealAgingEligible(after)) {
    await openDealAging.replace(ctx, before, after);
  } else if (isOpenDealAgingEligible(before)) {
    await openDealAging.delete(ctx, before);
  } else if (isOpenDealAgingEligible(after)) {
    await openDealAging.insert(ctx, after);
  }
}

export async function replacePipelineHealthAggregates(
  ctx: MutationCtx,
  before: Doc<"opportunities">,
  after: Doc<"opportunities">,
) {
  await replaceOpenDealAging(ctx, before, after);
  if (isPersonLossEligible(before) && isPersonLossEligible(after)) {
    await personLosses.replace(ctx, before, after);
  } else if (isPersonLossEligible(before)) {
    await personLosses.delete(ctx, before);
  } else if (isPersonLossEligible(after)) {
    await personLosses.insert(ctx, after);
  }
}

export async function deletePipelineHealthAggregates(ctx: MutationCtx, doc: Doc<"opportunities">) {
  for (const { aggregate, eligible } of filteredAggregates) {
    if (eligible(doc)) await aggregate.delete(ctx, doc);
  }
}
