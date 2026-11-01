// Joins a report's two answers for a range that includes today
// (docs/agents/reporting.md): ClickHouse's for the days before today and the
// Convex reader's from the start of today. Both come from the same builder
// over days that don't overlap, so counts and sums add, rates are worked out
// again from their parts, and lists keyed by an id combine. People, names and
// other labels come from today's answer, which is current.
//
// Every module here is pure and imports types only: pages import it.

/** A rate from its parts, as the builders compute it. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Adds two records of counts key by key. A key in either record is kept. */
export function addCounts<Counts extends Record<string, number>>(
  history: Counts,
  today: Counts,
): Counts {
  const total: Record<string, number> = { ...history };
  for (const [key, value] of Object.entries(today)) {
    total[key] = (total[key] ?? 0) + value;
  }
  return total as Counts;
}

/**
 * Combines two lists of rows keyed by `key`. A row in both lists is joined
 * with `join`; a row in one is kept as it is. History's rows come first, in
 * their order, then today's new rows, so a list in time order stays in time
 * order. Sort the result when the builder sorts.
 */
export function mergeRows<Row>(
  history: readonly Row[],
  today: readonly Row[],
  key: (row: Row) => string,
  join: (history: Row, today: Row) => Row,
): Row[] {
  const todayByKey = new Map(today.map((row) => [key(row), row]));
  const merged = history.map((row) => {
    const match = todayByKey.get(key(row));
    if (match === undefined) return row;
    todayByKey.delete(key(row));
    return join(row, match);
  });
  return [...merged, ...todayByKey.values()];
}

/**
 * Today's rows, each joined with history's row for the same key when there
 * is one. For lists of current people, such as every active closer: a person
 * only in history has left since, and the reader wouldn't list them now.
 */
export function joinOntoToday<Row>(
  history: readonly Row[],
  today: readonly Row[],
  key: (row: Row) => string,
  join: (history: Row, today: Row) => Row,
): Row[] {
  const historyByKey = new Map(history.map((row) => [key(row), row]));
  return today.map((row) => {
    const match = historyByKey.get(key(row));
    return match === undefined ? row : join(match, row);
  });
}
