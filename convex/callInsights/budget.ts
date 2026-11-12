import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { monthRange } from "../secondOpinion/month";
import type { CallInsightsSettings, Receipt } from "./validators";

/**
 * The spend ledger. Every paid request reserves the most it could cost before
 * it is sent and settles to what it did cost afterwards. Both happen in
 * mutations on one row per tenant per UTC month, so two runs can't both take
 * the last dollar.
 *
 * Second opinion keeps its own cap and code. Call insights may commit what is
 * left of the one monthly limit after Second opinion's share: its cap while it
 * is on, or what it already spent this month if that is more.
 */

export const toMicroUsd = (usd: number) => Math.ceil(usd * 1e6);
export const fromMicroUsd = (micro: number) => micro / 1e6;

/** `YYYY-MM` in UTC, the month Second opinion's cap and the gateway invoice use. */
export function monthKeyFor(now: number): string {
  const start = new Date(monthRange(now).start);
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Second opinion's share of the monthly limit, in micro-USD. */
export function secondOpinionShareMicroUsd(
  tenant: Pick<Doc<"tenants">, "secondOpinion">,
  secondOpinionSpentUsd: number,
): number {
  const so = tenant.secondOpinion;
  const cap = so && so.mode !== "off" ? toMicroUsd(so.monthlyCapUsd) : 0;
  return Math.max(cap, toMicroUsd(secondOpinionSpentUsd));
}

/** The most Call insights may have reserved plus spent this month. Can be zero or less. */
export function limitMicroUsd(
  tenant: Pick<Doc<"tenants">, "secondOpinion">,
  settings: CallInsightsSettings,
  secondOpinionSpentUsd: number,
): number {
  return (
    toMicroUsd(settings.monthlyCapUsd) -
    secondOpinionShareMicroUsd(tenant, secondOpinionSpentUsd)
  );
}

/**
 * What Second opinion spent this UTC month, summed the way its own run does:
 * paged through its `costPage` query from an action.
 */
export async function secondOpinionSpendUsd(
  ctx: Pick<ActionCtx, "runQuery">,
  tenantId: Id<"tenants">,
  now: number,
): Promise<number> {
  let cursor: string | null = null;
  let costUsd = 0;
  do {
    const page: { costUsd: number; cursor: string | null } = await ctx.runQuery(
      internal.secondOpinion.run.costPage,
      { tenantId, now, cursor },
    );
    costUsd += page.costUsd;
    cursor = page.cursor;
  } while (cursor !== null);
  return costUsd;
}

export async function budgetRow(
  ctx: Pick<QueryCtx, "db">,
  tenantId: Id<"tenants">,
  monthKey: string,
): Promise<Doc<"callInsightBudgets"> | null> {
  return await ctx.db
    .query("callInsightBudgets")
    .withIndex("by_tenantId_and_monthKey", (q) =>
      q.eq("tenantId", tenantId).eq("monthKey", monthKey),
    )
    .first();
}

async function budgetRowForWrite(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  monthKey: string,
  now: number,
): Promise<Doc<"callInsightBudgets">> {
  const existing = await budgetRow(ctx, tenantId, monthKey);
  if (existing) return existing;
  const id = await ctx.db.insert("callInsightBudgets", {
    tenantId,
    monthKey,
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    evalReservedMicroUsd: 0,
    evalSpentMicroUsd: 0,
    updatedAt: now,
  });
  const created = await ctx.db.get("callInsightBudgets", id);
  if (!created) throw new Error("Budget row vanished after insert");
  return created;
}

export type ReserveArgs = {
  tenant: Doc<"tenants">;
  settings: CallInsightsSettings;
  now: number;
  /** Unique within the run, such as `claude:2`. */
  key: string;
  origin: Receipt["origin"];
  pool: Receipt["pool"];
  amountMicroUsd: number;
  /** Second opinion's spend this month, summed by the calling action. */
  secondOpinionSpentUsd: number;
};

/**
 * Books a reservation if the month has room and returns its receipt, or null
 * when it doesn't fit. Eval reservations must also fit the eval allowance.
 */
export async function reserve(
  ctx: MutationCtx,
  args: ReserveArgs,
): Promise<Receipt | null> {
  const amount = Math.max(0, Math.ceil(args.amountMicroUsd));
  const monthKey = monthKeyFor(args.now);
  const limit = limitMicroUsd(
    args.tenant,
    args.settings,
    args.secondOpinionSpentUsd,
  );
  const row = await budgetRowForWrite(ctx, args.tenant._id, monthKey, args.now);
  if (row.reservedMicroUsd + row.spentMicroUsd + amount > limit) return null;
  if (
    args.pool === "eval" &&
    row.evalReservedMicroUsd + row.evalSpentMicroUsd + amount >
      toMicroUsd(args.settings.evalMonthlyUsd)
  )
    return null;
  await ctx.db.patch("callInsightBudgets", row._id, {
    reservedMicroUsd: row.reservedMicroUsd + amount,
    ...(args.pool === "eval"
      ? { evalReservedMicroUsd: row.evalReservedMicroUsd + amount }
      : {}),
    updatedAt: args.now,
  });
  return {
    key: args.key,
    origin: args.origin,
    monthKey,
    pool: args.pool,
    reservedMicroUsd: amount,
  };
}

export type ReceiptCost = {
  /** What the gateway billed. Absent means the cost never came back. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  gatewayRequestId?: string;
};

/**
 * Settles the named open receipts and returns the run's receipts with them
 * closed. A receipt settles once: a second call for the same key changes
 * nothing. Spend is booked in the month the reservation was made. A receipt
 * with no known cost settles at its full reservation.
 */
export async function settle(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    jobId?: Id<"callInsightJobs">;
    receipts: Receipt[];
    costs: Record<string, ReceiptCost>;
    now: number;
  },
): Promise<Receipt[]> {
  const deltas = new Map<
    string,
    { reserved: number; spent: number; evalReserved: number; evalSpent: number }
  >();
  let jobSpent = 0;
  const next = args.receipts.map((receipt) => {
    if (receipt.settledAt !== undefined) return receipt;
    if (!Object.prototype.hasOwnProperty.call(args.costs, receipt.key))
      return receipt;
    const cost = args.costs[receipt.key];
    const spent =
      cost.costUsd === undefined
        ? receipt.reservedMicroUsd
        : toMicroUsd(cost.costUsd);
    const delta = deltas.get(receipt.monthKey) ?? {
      reserved: 0,
      spent: 0,
      evalReserved: 0,
      evalSpent: 0,
    };
    delta.reserved += receipt.reservedMicroUsd;
    delta.spent += spent;
    if (receipt.pool === "eval") {
      delta.evalReserved += receipt.reservedMicroUsd;
      delta.evalSpent += spent;
    }
    deltas.set(receipt.monthKey, delta);
    jobSpent += spent;
    return {
      ...receipt,
      spentMicroUsd: spent,
      settledAt: args.now,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      gatewayRequestId: cost.gatewayRequestId,
    };
  });
  for (const [monthKey, delta] of deltas) {
    const row = await budgetRowForWrite(ctx, args.tenantId, monthKey, args.now);
    await ctx.db.patch("callInsightBudgets", row._id, {
      reservedMicroUsd: Math.max(0, row.reservedMicroUsd - delta.reserved),
      spentMicroUsd: row.spentMicroUsd + delta.spent,
      evalReservedMicroUsd: Math.max(
        0,
        row.evalReservedMicroUsd - delta.evalReserved,
      ),
      evalSpentMicroUsd: row.evalSpentMicroUsd + delta.evalSpent,
      updatedAt: args.now,
    });
  }
  if (args.jobId && jobSpent > 0) {
    const job = await ctx.db.get("callInsightJobs", args.jobId);
    if (job)
      await ctx.db.patch("callInsightJobs", job._id, {
        spentMicroUsd: job.spentMicroUsd + jobSpent,
      });
  }
  return next;
}

/** Closes every open receipt at its full reservation: a dead worker's cost is unknown. */
export async function settleAllAtReservation(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    jobId?: Id<"callInsightJobs">;
    receipts: Receipt[];
    now: number;
  },
): Promise<Receipt[]> {
  const costs: Record<string, ReceiptCost> = {};
  for (const receipt of args.receipts)
    if (receipt.settledAt === undefined) costs[receipt.key] = {};
  return await settle(ctx, { ...args, costs });
}

/** What a run has cost so far, in micro-USD. */
export function spentMicroUsd(receipts: Receipt[]): number {
  return receipts.reduce(
    (sum, receipt) => sum + (receipt.spentMicroUsd ?? 0),
    0,
  );
}
