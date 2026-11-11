import { MAX_ASSISTANT_ANSWER_BYTES } from "../../../../lib/assistantReportMerge";
import { v } from "convex/values";
import type { Doc, Id, TableNames } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { expectedError } from "../../../lib/observability/errors";
import { canRecordMeetingOutcome } from "../../../opportunities/dealGuards";
import { isMissedMeetingLoss } from "../../../opportunities/dealState";
import { hasPermission } from "../../../lib/permissions";
import { loadInTenant, type requireMcpAdmin } from "../../guard";
import { appLink } from "../prepare";

export type Admin = Awaited<ReturnType<typeof requireMcpAdmin>>;
export const textValidator = v.object({
  text: v.string(),
  by: v.union(
    v.literal("person"),
    v.literal("closer"),
    v.literal("closer_agent"),
    v.literal("integration"),
    v.literal("admin"),
  ),
});
export function text(
  value: string,
  by: "person" | "closer" | "closer_agent" | "integration" | "admin" = "person",
  max = 500,
) {
  let clean = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contact hidden]")
    .replace(/\+\d[\d ().-]{7,}\d/g, "[contact hidden]")
    .slice(0, max);
  while (new TextEncoder().encode(clean).byteLength > max)
    clean = clean.slice(0, -1);
  return { text: clean, by };
}
export function notFound(): never {
  throw expectedError("mcp.not_found", "Magnus can't find that record.");
}
export function limitOf(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25)
    throw expectedError("mcp.invalid_limit", "Use a limit from 1 to 25.");
  return limit;
}
export async function tenantId<T extends TableNames>(
  ctx: QueryCtx,
  me: Admin,
  table: T,
  raw: string,
): Promise<Id<T>> {
  const id = ctx.db.normalizeId(table, raw);
  if (!id) notFound();
  await loadInTenant(ctx, me, table, id);
  return id;
}
/** The web's rule: reviewers see results in "on" and during the shadow run. */
export function canSeeOpinions(me: Admin) {
  return (
    hasPermission(me.role, "second-opinion:review") &&
    (me.tenant.secondOpinion?.mode === "on" ||
      me.tenant.secondOpinion?.mode === "shadow")
  );
}
export function paymentActions(me: Admin, payment: Doc<"paymentRecords">) {
  const actions = ["magnus_lookup"];
  if (me.tenant.billingOpsEnabled && me.writeFamilies.includes("payments")) {
    if (hasPermission(me.role, "billing:correct"))
      actions.push("magnus_correct_payment");
    if (
      hasPermission(me.role, "billing:review") &&
      payment.status === "recorded" &&
      payment.proofFileId &&
      !payment.proofReused &&
      payment.recordedByUserId !== me.userId
    )
      actions.push("magnus_review_payments");
  }
  return actions;
}
export function dealActions(me: Admin, deal: Doc<"opportunities">) {
  const actions = ["magnus_lookup"];
  if (
    me.writeFamilies.includes("results") &&
    (deal.outcome === "open" || isMissedMeetingLoss(deal) !== null)
  )
    actions.push("magnus_next_step");
  return actions;
}
export function meetingActions(
  me: Admin,
  meeting: Doc<"meetings">,
  deal: Doc<"opportunities">,
  now = Date.now(),
) {
  const actions = ["magnus_lookup", "magnus_get_recording"];
  if (
    me.writeFamilies.includes("results") &&
    meeting.scheduledAt <= now &&
    meeting.status === "scheduled" &&
    canRecordMeetingOutcome(deal)
  )
    actions.push("magnus_record_result", "magnus_next_step");
  return actions;
}
export const paths = {
  person: (id: string) => appLink(`/workspace/leads-customers/${id}`),
  deal: (id: string) => appLink(`/workspace/opportunities/${id}`),
  meeting: (id: string) => appLink(`/workspace/pipeline/meetings/${id}`),
  payment: (id: string) => appLink(`/workspace/billing/${id}`),
  team: () => appLink("/workspace/team"),
};
export const ageValidator = v.object({
  seconds: v.number(),
  since: v.string(),
});
/** Only a result that returns a cursor tells the agent to continue with it. */
export function partialReason(isPartial: boolean, hasCursor = false) {
  if (!isPartial) return null;
  return hasCursor
    ? "The bounded live read has more rows or reached its byte budget. Continue with the cursor."
    : "The bounded live read has more rows or reached its byte budget. Narrow the request or open Magnus for the rest.";
}

/**
 * What one value costs in the gateway's answer, which carries it twice: as
 * `structuredContent` and again as escaped JSON text.
 */
export function answerBytes(value: unknown): number {
  const json = JSON.stringify(value);
  const encoder = new TextEncoder();
  return encoder.encode(json).byteLength + encoder.encode(JSON.stringify(json)).byteLength;
}

/** Reserve room for the envelope inside the gateway's answer budget. */
export function fitRows<T>(
  rows: T[],
  byteBudget = MAX_ASSISTANT_ANSWER_BYTES - 6 * 1024,
): { rows: T[]; capped: boolean } {
  const result: T[] = [];
  let bytes = 4;
  for (const row of rows) {
    const size = answerBytes(row) + 2;
    if (bytes + size > byteBudget) return { rows: result, capped: true };
    result.push(row);
    bytes += size;
  }
  return { rows: result, capped: false };
}
