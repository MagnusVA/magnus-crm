import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { requireOperationalLeadGenWorker } from "../../leadGen/capture";
import { rejectRequest } from "../../lib/observability/errors";
import { instagramHandle } from "../../lib/respark/people";
import {
  claimResparkBatchCore,
  markResparkItemCore,
  resparkLeftPoolReason,
  type ResparkMark,
} from "../../respark/batches";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation } from "../confirm";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { listPreview, sameAsPreview, withAgentErrors } from "../leadGenShared";
import { formatLocal } from "../time";

/**
 * `magnus_claim_respark_batch` and `magnus_mark_respark_items`
 * (docs/plans/lead-gen-assistant.md §2 rows 11 and 12, §3), on the cores the
 * Respark page uses. A claim is one call: claiming twice returns the batch
 * the lead gen holds. Marks preview first and commit with a token, all in
 * one transaction, because not a fit has no undo here.
 */
const MARK_TOOL = "magnus_mark_respark_items";
export const MAX_MARKS = 20;

export const claimArgs = {};

export const claim = internalMutation({
  args: { caller: mcpCallerValidator, ...claimArgs },
  returns: v.object({
    batchId: v.union(v.id("resparkBatches"), v.null()),
    resumed: v.boolean(),
    size: v.number(),
    heldUntil: v.union(v.string(), v.null()),
    noTeam: v.boolean(),
    endedOtherTeamBatch: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, { caller }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const now = Date.now();
    const worker = await withAgentErrors("respark.refused", () => requireOperationalLeadGenWorker(ctx, me, now));
    const claimed = await withAgentErrors("respark.refused", () => claimResparkBatchCore(ctx, me, worker, now));
    const heldUntil = claimed.heldUntil === null ? null : formatLocal(claimed.heldUntil, me.timeZone);
    let message: string;
    if (claimed.noTeam) message = "You have no team, so there is no respark pool. Ask an admin to add you to a team.";
    else if (!claimed.batchId) message = "The respark pool has nobody to offer right now.";
    else if (claimed.resumed) message = `You already hold a batch of ${claimed.size}, held until ${heldUntil}.`;
    else message = `Claimed a batch of ${claimed.size}, held until ${heldUntil}.`;
    return {
      batchId: claimed.batchId,
      resumed: claimed.resumed,
      size: claimed.size,
      heldUntil,
      noTeam: claimed.noTeam,
      endedOtherTeamBatch: claimed.endedOtherTeamBatch,
      message,
    };
  },
});

const markResultValidator = v.union(v.literal("resparked"), v.literal("not_a_fit"), v.literal("skipped"));

export const markArgs = {
  marks: v.array(v.object({ itemId: v.id("resparkBatchItems"), result: markResultValidator })),
  confirm: v.boolean(),
  confirmToken: v.optional(v.string()),
};

const RESULT_WORDS: Record<ResparkMark, string> = {
  resparked: "resparked",
  not_a_fit: "not a fit",
  skipped: "skipped",
};

const EFFECTS: Record<ResparkMark, string> = {
  resparked: "Adds a respark touch and moves them to In conversation.",
  not_a_fit: "Marks them not a fit, so they leave the respark pool.",
  skipped: "Back in the pool for your team, and not offered to you again today.",
};

type PlannedMark = {
  itemId: Id<"resparkBatchItems">;
  result: ResparkMark;
  name: string;
  state: "record" | "already" | "blocked";
  text: string;
  reason: string | null;
};

async function planMarks(
  ctx: MutationCtx,
  me: McpUser,
  worker: Doc<"leadGenWorkers">,
  marks: Array<{ itemId: Id<"resparkBatchItems">; result: ResparkMark }>,
  now: number,
) {
  if (marks.length < 1 || marks.length > MAX_MARKS) {
    throw rejectRequest("respark.count", `Pass 1 to ${MAX_MARKS} marks in one call.`);
  }
  if (new Set(marks.map((mark) => mark.itemId)).size !== marks.length) {
    throw rejectRequest("respark.repeated_item", "The same person is in this list twice.");
  }
  const lines: PlannedMark[] = [];
  for (const mark of marks) {
    const item = await ctx.db.get("resparkBatchItems", mark.itemId);
    if (!item || item.tenantId !== me.tenantId || item.userId !== me.userId) {
      throw rejectRequest("respark.item_not_found", "One of these people isn't in your batch.");
    }
    const lead = await ctx.db.get("leads", item.leadId);
    const handle = lead ? instagramHandle(lead) : null;
    const name = handle ? `@${handle}` : (lead?.fullName ?? "This person");
    const base = { itemId: mark.itemId, result: mark.result, name };
    const blocked = (reason: string): PlannedMark => ({
      ...base,
      state: "blocked",
      reason,
      text: `${name}: ${reason} Not recorded.`,
    });

    if (item.result !== undefined) {
      if (item.result === mark.result) {
        lines.push({
          ...base,
          state: "already",
          reason: null,
          text: `${name}: already recorded as ${RESULT_WORDS[mark.result]}.`,
        });
      } else {
        lines.push(blocked(`Already recorded as ${RESULT_WORDS[item.result]}, and that can't be changed.`));
      }
      continue;
    }
    if (item.heldUntil <= now) {
      lines.push(blocked("This batch ended with the business day."));
      continue;
    }
    if (mark.result !== "skipped") {
      const left = await resparkLeftPoolReason(ctx, item, worker);
      if (left) {
        lines.push(blocked(`${left} Skip them instead.`));
        continue;
      }
    }
    lines.push({
      ...base,
      state: "record",
      reason: null,
      text: `${name}: ${RESULT_WORDS[mark.result]}. ${EFFECTS[mark.result]}`,
    });
  }
  const toRecord = lines.filter((line) => line.state === "record").length;
  const notes = lines.some((line) => line.state === "record" && line.result === "resparked")
    ? ["Mark someone resparked only after the message was sent."]
    : [];
  if (lines.some((line) => line.state === "record" && line.result === "not_a_fit")) {
    notes.push("Not a fit can't be undone here.");
  }
  const previewText = listPreview(
    `Record ${toRecord} of ${lines.length} ${lines.length === 1 ? "result" : "results"} in your respark batch:`,
    lines.map((line) => line.text),
    notes,
  );
  return { lines, toRecord, previewText };
}

const markLineValidator = v.object({
  itemId: v.id("resparkBatchItems"),
  person: v.string(),
  result: markResultValidator,
  willRecord: v.boolean(),
  note: v.union(v.string(), v.null()),
});

const itemValidator = v.object({
  itemId: v.id("resparkBatchItems"),
  person: v.string(),
  result: markResultValidator,
});

export const mark = internalMutation({
  args: { caller: mcpCallerValidator, ...markArgs },
  returns: v.union(
    v.object({
      preview: v.string(),
      lines: v.array(markLineValidator),
      willRecord: v.number(),
      // Absent when nothing would be recorded.
      confirmToken: v.optional(v.string()),
      expiresInSeconds: v.optional(v.number()),
    }),
    v.object({
      ok: v.literal(true),
      recorded: v.array(itemValidator),
      alreadyRecorded: v.array(itemValidator),
      notRecorded: v.array(v.object({ itemId: v.id("resparkBatchItems"), person: v.string(), reason: v.string() })),
      message: v.string(),
    }),
  ),
  handler: async (ctx, { caller, marks, confirm, confirmToken }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const now = Date.now();
    const hashed = { marks };
    if (confirm) {
      const replay = await redeemConfirmation(ctx, me, MARK_TOOL, confirmToken, hashed);
      if (replay.kind === "replay") return replay.result as never;
      // A lead generator whose lead gen access was turned off can't work on.
      const worker = await withAgentErrors("respark.refused", () => requireOperationalLeadGenWorker(ctx, me, now));
      const plan = await planMarks(ctx, me, worker, marks, now);
      if (
        !sameAsPreview(
          replay.preview,
          plan.lines.map((line) => line.text),
          plan.lines.map((line) => line.state === "already"),
        )
      ) {
        throw rejectRequest("respark.changed", "Something changed since the preview. Preview again, then ask for a yes.");
      }
      for (const line of plan.lines) {
        if (line.state !== "record") continue;
        await markResparkItemCore(ctx, me, worker, { itemId: line.itemId, result: line.result }, now, {
          via: "mcp",
          agentClient: me.agentClient,
        });
      }
      const pick = (line: PlannedMark) => ({ itemId: line.itemId, person: line.name, result: line.result });
      const recorded = plan.lines.filter((line) => line.state === "record").map(pick);
      const result = {
        ok: true as const,
        recorded,
        alreadyRecorded: plan.lines.filter((line) => line.state === "already").map(pick),
        notRecorded: plan.lines
          .filter((line) => line.state === "blocked")
          .map((line) => ({ itemId: line.itemId, person: line.name, reason: line.reason ?? "Not recorded." })),
        message: `Recorded ${recorded.length} ${recorded.length === 1 ? "result" : "results"}.`,
      };
      await markConfirmationUsed(ctx, replay.confirmationId, result);
      return result;
    }

    const worker = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", me.tenantId).eq("userId", me.userId))
      .unique();
    if (!worker?.isActive) {
      throw rejectRequest("lead_gen.inactive", "Lead gen access isn't active for you. Ask an admin.");
    }
    const plan = await planMarks(ctx, me, worker, marks, now);
    const body = {
      preview: plan.previewText,
      lines: plan.lines.map((line) => ({
        itemId: line.itemId,
        person: line.name,
        result: line.result,
        willRecord: line.state === "record",
        note: line.state === "already" ? "Already recorded." : line.reason,
      })),
      willRecord: plan.toRecord,
    };
    if (plan.toRecord === 0) return body;
    const issued = await issueConfirmation(ctx, me, MARK_TOOL, hashed, plan.previewText);
    return { ...body, confirmToken: issued.confirmToken, expiresInSeconds: issued.expiresInSeconds };
  },
});
