import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  dealProgramKey,
  loadDealNextStep,
  loadPrograms,
  programFallbackNames,
  type DealNextStep,
  type ProgramInfo,
} from "../closer/pipelineDeals";
import { systemLossOf } from "../opportunities/stageLabels";
import {
  dealPosition,
  dealStageOf,
  type DealPosition,
  type SystemLossReason,
} from "../opportunities/stages";

// The deal a Leads & Customers row shows beside the person: their newest
// open deal, else their newest deal of any outcome. The search row carries
// counts only, so each row of a page reads its deal here: one indexed read
// for the open deals (a second when there are none), one for the open
// deal's tasks, and the program and closer once per query.

/** What the row says about the person's deal. */
export type ListDeal = {
  opportunityId: Id<"opportunities">;
  programName: string | null;
  position: DealPosition;
  systemLoss: SystemLossReason | null;
  closerName: string | null;
  /** The viewer is the deal's closer. */
  isMine: boolean;
  /** The viewer can act on the deal: its closer, or an admin. */
  canAct: boolean;
  /** The open deal's next call and task (the client decides whether the call has passed); null when closed. */
  nextStep: DealNextStep | null;
  /** The person's other open deals, beside this one. */
  otherOpenCount: number;
};

export type ListViewer = {
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  isAdmin: boolean;
};

// A person rarely has more than one open deal; this only bounds the read.
const OPEN_DEAL_SCAN = 10;

/** Reads each row's deal, sharing program and closer lookups across the rows. */
export async function loadListDeals(
  ctx: QueryCtx,
  viewer: ListViewer,
  leadIds: Array<Id<"leads">>,
): Promise<Map<Id<"leads">, ListDeal | null>> {
  const picked = await Promise.all(
    leadIds.map(async (leadId) => [leadId, await pickRowDeal(ctx, viewer.tenantId, leadId)] as const),
  );

  const deals = picked.flatMap(([, pick]) => (pick ? [pick.deal] : []));
  const programs = await loadPrograms(ctx, viewer.tenantId, programFallbackNames(deals));
  const closerNames = await loadCloserNames(ctx, viewer.tenantId, deals);

  const result = new Map<Id<"leads">, ListDeal | null>();
  await Promise.all(
    picked.map(async ([leadId, pick]) => {
      if (!pick) {
        result.set(leadId, null);
        return;
      }
      result.set(leadId, await toListDeal(ctx, viewer, pick, programs, closerNames));
    }),
  );
  return result;
}

type RowDealPick = { deal: Doc<"opportunities">; openCount: number };

async function pickRowDeal(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<RowDealPick | null> {
  const open = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId_and_outcome", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId).eq("outcome", "open"),
    )
    .order("desc")
    .take(OPEN_DEAL_SCAN);
  if (open.length > 0) {
    const newest = open.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    return { deal: newest, openCount: open.length };
  }
  const newest = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .order("desc")
    .first();
  return newest ? { deal: newest, openCount: 0 } : null;
}

async function loadCloserNames(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  deals: Array<Doc<"opportunities">>,
): Promise<Map<Id<"users">, string>> {
  const ids = [...new Set(deals.flatMap((deal) => (deal.assignedCloserId ? [deal.assignedCloserId] : [])))];
  const names = new Map<Id<"users">, string>();
  await Promise.all(
    ids.map(async (id) => {
      const user = await ctx.db.get("users", id);
      if (user && user.tenantId === tenantId) {
        names.set(id, user.fullName ?? user.email);
      }
    }),
  );
  return names;
}

async function toListDeal(
  ctx: QueryCtx,
  viewer: ListViewer,
  { deal, openCount }: RowDealPick,
  programs: Map<string, ProgramInfo>,
  closerNames: Map<Id<"users">, string>,
): Promise<ListDeal> {
  const { stage, outcome } = dealStageOf(deal);
  const isMine = deal.assignedCloserId === viewer.userId;
  return {
    opportunityId: deal._id,
    programName: programs.get(dealProgramKey(deal))?.name ?? null,
    position: dealPosition(stage, outcome),
    systemLoss: systemLossOf(deal),
    closerName: deal.assignedCloserId ? (closerNames.get(deal.assignedCloserId) ?? null) : null,
    isMine,
    canAct: isMine || viewer.isAdmin,
    nextStep: outcome === "open" ? await loadDealNextStep(ctx, deal) : null,
    otherOpenCount: Math.max(openCount - 1, 0),
  };
}
