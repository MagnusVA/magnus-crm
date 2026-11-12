import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The result a person recorded for one meeting, read the way Second opinion
 * reads it: a payment carries the meeting, a call-back task names it as its
 * source, and a loss is written in the same transaction that marks the meeting
 * held. Undefined while the meeting has no result.
 */
export type RecordedResult =
  | {
      kind: "paid";
      amountMinor: number;
      currency: string;
      paymentType?: string;
    }
  | { kind: "call_back" }
  | { kind: "lost" }
  | { kind: "no_show"; reason?: string }
  | { kind: "held_other" }
  | { kind: "canceled" };

export async function recordedResultForMeeting(
  ctx: QueryCtx | MutationCtx,
  meeting: Doc<"meetings">,
): Promise<RecordedResult | undefined> {
  if (meeting.status === "scheduled") return undefined;
  if (meeting.status === "canceled") return { kind: "canceled" };
  if (meeting.status === "no_show")
    return { kind: "no_show", reason: meeting.noShowReason };
  const deal = await ctx.db.get("opportunities", meeting.opportunityId);
  if (!deal || deal.tenantId !== meeting.tenantId)
    return { kind: "held_other" };

  const payments = await ctx.db
    .query("paymentRecords")
    .withIndex("by_opportunityId_and_recordedAt", (q) =>
      q.eq("opportunityId", deal._id),
    )
    .order("desc")
    .take(50);
  const payment = payments.find(
    (p) =>
      p.tenantId === meeting.tenantId &&
      p.meetingId === meeting._id &&
      p.status !== "disputed",
  );
  if (payment)
    return {
      kind: "paid",
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      paymentType: payment.paymentType,
    };

  if (
    deal.outcome === "lost" &&
    deal.lostAt !== undefined &&
    meeting.heldMarkedAt !== undefined &&
    Math.abs(deal.lostAt - meeting.heldMarkedAt) < 1000
  )
    return { kind: "lost" };

  const tasks = await ctx.db
    .query("followUps")
    .withIndex("by_opportunityId_and_status_and_reason", (q) =>
      q.eq("opportunityId", deal._id),
    )
    .take(50);
  // A reminder to call or text back. A booking link sent from the meeting is a
  // different result and reads as "held, something else".
  if (
    tasks.some(
      (task) =>
        task.sourceMeetingId === meeting._id && task.type === "manual_reminder",
    )
  )
    return { kind: "call_back" };
  return { kind: "held_other" };
}

export type SuggestionComparison =
  | "same_result"
  | "different_result"
  | "same_result_different_values";

/** How a saved result compares with what the suggestion proposed. */
export function compareSuggestion(
  suggestion: Pick<Doc<"resultSuggestionStates">, "kind" | "values">,
  recorded: RecordedResult,
): SuggestionComparison {
  const proposed =
    suggestion.kind === "promised"
      ? "paid"
      : suggestion.kind === "empty_recording"
        ? "no_show"
        : suggestion.kind;
  if (proposed !== recorded.kind) return "different_result";
  if (recorded.kind === "paid") {
    const { amountMinor, currency } = suggestion.values;
    if (
      (amountMinor !== undefined && amountMinor !== recorded.amountMinor) ||
      (currency !== undefined && currency !== recorded.currency)
    )
      return "same_result_different_values";
  }
  return "same_result";
}
