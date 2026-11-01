import type { TestConvex } from "convex-test";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { expect } from "vitest";
import type schema from "../convex/schema";

/** What an answer looks like after a trip through JSON, as cached answers are. */
function json<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

/**
 * Asserts a report's merge (convex/analytics/merge/) joins the reader's
 * answers for two adjacent windows into its answer for both, which is how a
 * page reads a range that includes today: ClickHouse answers the days before
 * today with the reader's exact shape (see `expectSameAnswer`), and the
 * reader answers the rest live. Put rows on both sides of the split, so
 * neither answer is empty. Returns the three answers for further checks.
 */
export async function expectMergedAnswer<Query extends FunctionReference<"query">>(args: {
  t: TestConvex<typeof schema>;
  identity: { subject: string; org_id: string };
  live: Query;
  /** The reader's arguments for the days before the split. */
  history: FunctionArgs<Query>;
  /** The reader's arguments from the split to the end of the range. */
  today: FunctionArgs<Query>;
  /** The reader's arguments for the whole range. */
  whole: FunctionArgs<Query>;
  merge: (history: FunctionReturnType<Query>, today: FunctionReturnType<Query>) => FunctionReturnType<Query>;
}) {
  const reader = args.t.withIdentity(args.identity);
  const read = async (window: FunctionArgs<Query>) =>
    (await reader.query(args.live as FunctionReference<"query">, window)) as FunctionReturnType<Query>;
  const history = await read(args.history);
  const today = await read(args.today);
  const whole = await read(args.whole);
  expect(json(args.merge(json(history), json(today)))).toEqual(json(whole));
  return { history, today, whole };
}
