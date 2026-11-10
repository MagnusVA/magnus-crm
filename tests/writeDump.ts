import type { convexTest } from "convex-test";
import schema from "../convex/schema";

type TestConvex = ReturnType<typeof convexTest>;
type Row = Record<string, unknown> & { _id: string };
export type TableDump = Record<string, Record<string, string>>;

/** Every row of every app table, by table and ID, as JSON. Test data only. */
export async function dumpTables(t: TestConvex): Promise<TableDump> {
  // t.run returns Convex values, so each table is a plain object of JSON.
  return await t.run(async (ctx) => {
    const dump: TableDump = {};
    for (const table of Object.keys(schema.tables)) {
      const rows = (await ctx.db.query(table as never).take(5000)) as Row[];
      // `_creationTime` follows the workpools' fake timers, not the write.
      dump[table] = Object.fromEntries(
        rows.map(({ _creationTime: _ignored, ...row }) => [row._id, JSON.stringify(row)]),
      );
    }
    return dump;
  });
}

/**
 * The rows a write added, and the fields it set or removed on rows it
 * changed, by table. Domain event metadata is parsed, so a snapshot shows
 * every field a path writes. A changed row shows only its changed fields,
 * since its other fields come from the fixture's booking.
 */
export function writtenRows(before: TableDump, after: TableDump) {
  type Changed = { _id: string; set: Record<string, unknown>; removed: string[] };
  const written: Record<string, { added: Row[]; changed: Changed[]; deleted: string[] }> = {};
  for (const table of Object.keys(after)) {
    const added: Row[] = [];
    const changed: Changed[] = [];
    for (const [id, json] of Object.entries(after[table])) {
      const old = before[table]?.[id];
      if (old === undefined) {
        added.push(expand(JSON.parse(json) as Row));
      } else if (old !== json) {
        const from = JSON.parse(old) as Row;
        const to = JSON.parse(json) as Row;
        const set: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(to)) {
          if (JSON.stringify(from[key]) !== JSON.stringify(value)) set[key] = value;
        }
        const removed = Object.keys(from).filter((key) => !(key in to));
        changed.push({ _id: id, set, removed });
      }
    }
    const deleted = Object.keys(before[table] ?? {}).filter((id) => !(id in after[table]));
    if (added.length || changed.length || deleted.length) {
      written[table] = { added, changed, deleted };
    }
  }
  return written;
}

function expand(row: Row): Row {
  if (typeof row.metadata !== "string") return row;
  return { ...row, metadata: JSON.parse(row.metadata) as unknown };
}
