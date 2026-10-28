import type { Doc, TableNames } from "../_generated/dataModel";
import type { SqlRow } from "./clickhouse";

function camel(snake: string) {
  return snake.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Turns a `SELECT *` row from an `analytics.*` view back into the Convex
 * document it was copied from, so a report can hand ClickHouse rows to the
 * same builder its Convex reader uses. Reverses the view conventions in
 * clickhouse/migrations/0002_views.sql: `id` and `creation_time_ms` become
 * `_id` and `_creationTime`, `*_ms` drops its suffix, `*_json` is parsed,
 * snake_case becomes camelCase, and NULL becomes an absent field. Fields the
 * views leave out (contact details, notes) stay absent.
 */
export function docFromRow<Table extends TableNames>(row: SqlRow): Doc<Table> {
  const doc: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (key === "id") {
      doc._id = value;
    } else if (key === "creation_time_ms") {
      doc._creationTime = Number(value);
    } else if (key.endsWith("_json")) {
      doc[camel(key.slice(0, -"_json".length))] = typeof value === "string" ? JSON.parse(value) : value;
    } else if (key.endsWith("_ms")) {
      doc[camel(key.slice(0, -"_ms".length))] = Number(value);
    } else {
      doc[camel(key)] = value;
    }
  }
  return doc as Doc<Table>;
}

export function docsFromRows<Table extends TableNames>(rows: readonly SqlRow[] | undefined): Doc<Table>[] {
  return (rows ?? []).map((row) => docFromRow<Table>(row));
}
