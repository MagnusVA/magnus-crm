import { getConvexSize, type Value } from "convex/values";
import type { QueryCtx } from "../_generated/server";

export const LIVE_QUERY_BYTE_BUDGET = 512 * 1024;

/**
 * Reads stop while this share of each Convex transaction limit (bytes read,
 * documents read, db.get/db.query calls) is still left, so the rest of the
 * function can finish. https://docs.convex.dev/production/state/limits
 */
export const TRANSACTION_RESERVE = 0.1;

type Headroom = { bytes: number; documents: number; queries: number };
/**
 * Spends against the function's real transaction usage. Usage comes from
 * `ctx.meta.getTransactionMetrics()`; between readings it is estimated with
 * `getConvexSize`, and read again once half the last headroom is spent, so
 * index entries and earlier reads are counted too.
 */
export type TransactionGuard = {
  meta: QueryCtx["meta"];
  headroom: Headroom | null;
  refreshBelow: Headroom;
};

export type LiveReadState = {
  bytesRead: number;
  capped: boolean;
  /** When set, the transaction's own limits replace the fixed byte budget. */
  transaction?: TransactionGuard;
};

export function createLiveReadState(ctx?: Pick<QueryCtx, "meta">): LiveReadState {
  return {
    bytesRead: 0, capped: false,
    ...(ctx ? { transaction: { meta: ctx.meta, headroom: null, refreshBelow: { bytes: 0, documents: 0, queries: 0 } } } : {}),
  };
}

async function measure(guard: TransactionGuard) {
  const metrics = await guard.meta.getTransactionMetrics();
  const left = (metric: { used: number; remaining: number }) =>
    metric.remaining - TRANSACTION_RESERVE * (metric.used + metric.remaining);
  guard.headroom = { bytes: left(metrics.bytesRead), documents: left(metrics.documentsRead), queries: left(metrics.databaseQueries) };
  guard.refreshBelow = { bytes: guard.headroom.bytes / 2, documents: guard.headroom.documents / 2, queries: guard.headroom.queries / 2 };
}

/** Records a read that happened, then says whether reading may go on. */
async function spend(state: LiveReadState, cost: Headroom, byteBudget: number): Promise<boolean> {
  state.bytesRead += cost.bytes;
  const guard = state.transaction;
  if (!guard) {
    if (state.bytesRead > byteBudget) state.capped = true;
    return !state.capped;
  }
  if (guard.headroom === null) await measure(guard);
  const room = guard.headroom!;
  room.bytes -= cost.bytes; room.documents -= cost.documents; room.queries -= cost.queries;
  if (room.bytes <= guard.refreshBelow.bytes || room.documents <= guard.refreshBelow.documents || room.queries <= guard.refreshBelow.queries) {
    await measure(guard);
  }
  const after = guard.headroom!;
  if (after.bytes <= 0 || after.documents <= 0 || after.queries < 1) state.capped = true;
  return !state.capped;
}

/** Whether one more db.get or db.query fits, before making it. */
async function mayQuery(state: LiveReadState): Promise<boolean> {
  if (state.capped) return false;
  return spend(state, { bytes: 0, documents: 0, queries: 1 }, Infinity);
}

export async function readLiveQueryRows<T>(
  query: AsyncIterable<T>,
  maxRows: number,
  state = createLiveReadState(),
  byteBudget = LIVE_QUERY_BYTE_BUDGET,
): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];
  if (state.transaction && !(await mayQuery(state))) return { rows, capped: true };

  for await (const row of query) {
    if (
      !(await spend(state, { bytes: getConvexSize(row as unknown as Value), documents: 1, queries: 0 }, byteBudget)) ||
      rows.length >= maxRows ||
      state.capped
    ) {
      state.capped = true;
      return { rows, capped: true };
    }
    rows.push(row);
  }

  return { rows, capped: false };
}

export async function readLiveDocuments<K, T>(
  keys: readonly K[],
  load: (key: K) => Promise<T | null>,
  state = createLiveReadState(),
  byteBudget = LIVE_QUERY_BYTE_BUDGET,
): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];

  for (const key of keys) {
    if (state.capped) return { rows, capped: true };
    if (state.transaction && !(await mayQuery(state))) return { rows, capped: true };
    const row = await load(key);
    if (row === null) continue;
    if (!(await spend(state, { bytes: getConvexSize(row as unknown as Value), documents: 1, queries: 0 }, byteBudget))) {
      return { rows, capped: true };
    }
    rows.push(row);
  }

  return { rows, capped: false };
}
