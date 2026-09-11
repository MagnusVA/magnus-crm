/** Assemble immutable aggregate dimensions without an oversized Convex response. */
export async function collectDashboardPages<Row>(
  read: (cursor: string | null) => Promise<{
    page: Row[];
    isDone: boolean;
    continueCursor: string;
  }>,
  isCanceled: () => boolean,
): Promise<Row[] | undefined> {
  const rows: Row[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (!isCanceled()) {
    const page = await read(cursor);
    if (isCanceled()) return undefined;
    for (const row of page.page) rows.push(row);
    if (page.isDone) return rows;
    if (seenCursors.has(page.continueCursor)) {
      throw new Error("The dashboard result could not make progress. Refresh to try again.");
    }
    seenCursors.add(page.continueCursor);
    cursor = page.continueCursor;
  }
  return undefined;
}
