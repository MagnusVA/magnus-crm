import type { Id } from "../../_generated/dataModel";
import type { CloseRateCohortCount } from "../../reporting/lib/closeRateCohort";
import type { SqlRow } from "../clickhouse";
import { num, str } from "../definition";

// The close rate cohort (convex/reporting/lib/closeRateCohort.ts), rebuilt:
// each deal's first held call, by scheduled time then creation time, with
// that call's closer and booked program; a deal is in the range's cohort when
// that call is in the range. A meeting whose deal is missing has no outcome,
// hence the inner join. The call's closer and program are taken as one tuple:
// argMin skips a NULL argument, so a program alone would come from a later
// call when the first has none.
export const closeRateCohortSql = `
SELECT
  f.first_closer_id AS closer_id,
  f.first_program_id AS booking_program_id,
  count() AS cohort_deals,
  countIf(d.outcome = 'won') AS won_deals
FROM (
  SELECT
    opportunity_id,
    argMin((assigned_closer_id, booking_program_id), (scheduled_at_ms, creation_time_ms)) AS first_call,
    tupleElement(first_call, 1) AS first_closer_id,
    tupleElement(first_call, 2) AS first_program_id,
    min(scheduled_at_ms) AS first_held_at_ms
  FROM analytics.meetings
  WHERE tenant_id = {tenant_id:String}
    AND status = 'held'
  GROUP BY opportunity_id
  HAVING first_held_at_ms >= {from_ms:Int64}
    AND first_held_at_ms < {to_ms:Int64}
) AS f
INNER JOIN (
  SELECT id, outcome
  FROM analytics.deals
  WHERE tenant_id = {tenant_id:String}
) AS d ON d.id = f.opportunity_id
GROUP BY closer_id, booking_program_id
ORDER BY closer_id, booking_program_id`;

export function closeRateCohortCounts(
  rows: SqlRow[] | undefined,
): CloseRateCohortCount[] {
  return (rows ?? []).map((row) => ({
    closerId: String(row.closer_id) as Id<"users">,
    bookingProgramId: str(row.booking_program_id) as Id<"tenantPrograms"> | null,
    cohortDeals: num(row.cohort_deals),
    wonDeals: num(row.won_deals),
  }));
}
