import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { earliestCountingPayment } from "../lib/enrollments";

/**
 * The saved result of one meeting. A linked payment, call-back task or loss
 * can record the result directly. A provider win can also explain a held
 * call without linking the payment to it. Undefined while there is no result.
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
  const linkedPayment = payments.find(
    (p) =>
      p.tenantId === meeting.tenantId &&
      p.meetingId === meeting._id &&
      p.status !== "disputed",
  );
  const payment =
    linkedPayment ??
    (deal.outcome === "won"
      ? await providerPaymentForMeeting(ctx, meeting)
      : undefined);
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

async function providerPaymentForMeeting(
  ctx: QueryCtx | MutationCtx,
  meeting: Doc<"meetings">,
) {
  const candidates = await Promise.all(
    (["recorded", "verified"] as const).map((status) =>
      ctx.db
        .query("paymentRecords")
        .withIndex("by_opportunityId_and_status_and_recordedAt", (q) =>
          q.eq("opportunityId", meeting.opportunityId).eq("status", status),
        )
        .first(),
    ),
  );
  const payment = earliestCountingPayment(
    candidates.filter(
      (row): row is Doc<"paymentRecords"> => row?.tenantId === meeting.tenantId,
    ),
  );
  if (payment?.origin !== "provider") return undefined;

  // The win explains one call. Prefer the latest slot up to and including
  // the payment time, or the first slot when the payment predates them all.
  const previous = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId_and_scheduledAt", (q) =>
      q.eq("opportunityId", meeting.opportunityId)
        .lte("scheduledAt", payment.recordedAt),
    )
    .order("desc")
    .first();
  const matched =
    previous ??
    (await ctx.db
      .query("meetings")
      .withIndex("by_opportunityId_and_scheduledAt", (q) =>
        q.eq("opportunityId", meeting.opportunityId)
          .gt("scheduledAt", payment.recordedAt),
      )
      .first());
  return matched?.tenantId === meeting.tenantId && matched._id === meeting._id
    ? payment
    : undefined;
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
