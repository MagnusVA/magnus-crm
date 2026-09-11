import { getConvexSize, type Value } from "convex/values";

export const LIVE_QUERY_BYTE_BUDGET = 512 * 1024;

export type LiveReadState = {
  bytesRead: number;
  capped: boolean;
};

export function createLiveReadState(): LiveReadState {
  return { bytesRead: 0, capped: false };
}

export async function readLiveQueryRows<T>(
  query: AsyncIterable<T>,
  maxRows: number,
  state = createLiveReadState(),
): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];

  for await (const row of query) {
    state.bytesRead += getConvexSize(row as unknown as Value);
    if (
      state.bytesRead > LIVE_QUERY_BYTE_BUDGET ||
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
): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];

  for (const key of keys) {
    if (state.capped) return { rows, capped: true };
    const row = await load(key);
    if (row === null) continue;
    state.bytesRead += getConvexSize(row as unknown as Value);
    if (state.bytesRead > LIVE_QUERY_BYTE_BUDGET) {
      state.capped = true;
      return { rows, capped: true };
    }
    rows.push(row);
  }

  return { rows, capped: false };
}
