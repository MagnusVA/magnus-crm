import { v } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { requireOwnLeadGenWorker } from "../../leadGen/assistantAccess";
import { buildShiftNumbers, endLeadGenShiftCore, hoursStatusValidator, hoursUnknownReasonValidator, retryShiftDeliveryCore,
  shiftContext, shiftDeliveryRetryable, shiftSlackStatusValidator, shiftText, type ShiftContext } from "../../leadGen/endOfShift";
import { leadGenShiftNumbersValidator } from "../../leadGen/endOfShiftSchema";
import { rejectRequest } from "../../lib/observability/errors";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation, stableJson } from "../confirm";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { listPreview, withAgentErrors } from "../leadGenShared";
import { formatLocal } from "../time";

const TOOL = "magnus_end_lead_gen_shift";
export const endShiftArgs = {
  narrative: v.optional(v.string()), note: v.optional(v.string()), confirm: v.boolean(), confirmToken: v.optional(v.string()),
  dayKey: v.optional(v.string()), businessDayVersion: v.optional(v.number()),
};
const summaryFields = { dayKey: v.string(), businessDayVersion: v.number(), numbers: leadGenShiftNumbersValidator,
  hoursStatus: hoursStatusValidator, hoursUnknownReason: v.union(hoursUnknownReasonValidator, v.null()) };
const receiptValidator = v.object({ ok: v.literal(true), reportId: v.id("leadGenShiftReports"), ...summaryFields,
  window: v.object({ from: v.string(), to: v.string() }), asOf: v.string(), timeZone: v.string(),
  narrative: v.union(v.string(), v.null()), note: v.union(v.string(), v.null()), repeated: v.boolean(), slackStatus: shiftSlackStatusValidator, message: v.string() });

function receipt(report: Doc<"leadGenShiftReports">, repeated: boolean) {
  const message = report.slackStatus === "not_configured" ? "Saved in Magnus. No lead gen Slack channel is set, so nothing was posted."
    : report.slackStatus === "failed" ? "Saved in Magnus, but the Slack post failed. Preview and confirm again to retry."
    : report.slackStatus === "posted" ? "Saved in Magnus and posted to the lead gen Slack channel."
    : "Saved in Magnus. The Slack post is pending.";
  return { ok: true as const, reportId: report._id, dayKey: report.dayKey, businessDayVersion: report.businessDayVersion,
    numbers: report.numbers, hoursStatus: report.hoursStatus, hoursUnknownReason: report.hoursUnknownReason ?? null,
    window: { from: formatLocal(report.periodStart, report.timeZone), to: formatLocal(report.periodEnd, report.timeZone) },
    asOf: formatLocal(report.asOf, report.timeZone), timeZone: report.timeZone, narrative: report.narrative ?? null, note: report.note ?? null,
    repeated, slackStatus: report.slackStatus, message };
}

async function planShift(ctx: MutationCtx, me: McpUser, current: ShiftContext, text: { narrative?: string; note?: string }, now: number) {
  const saved = current.existing;
  const summary = saved ? { numbers: saved.numbers, hoursStatus: saved.hoursStatus, hoursUnknownReason: saved.hoursUnknownReason }
    : await withAgentErrors("shift.unavailable", () => buildShiftNumbers(ctx, me, current.worker, current.dayKey, current.periodStart, current.dayEnd));
  const retry = saved !== null && current.channelId !== null && shiftDeliveryRetryable(saved, now);
  const narrative = saved?.narrative ?? (saved ? undefined : text.narrative);
  const note = saved?.note ?? (saved ? undefined : text.note);
  // asOf moves between preview and commit; the day, settings, counts and destination must not.
  const snapshot = { intent: saved ? "receipt" : "save", reportId: saved?._id ?? null, dayKey: current.dayKey,
    workerId: current.worker._id, businessDayVersion: current.businessDayVersion, timeZone: current.timeZone, dayStartHour: current.dayStartHour,
    periodStart: current.periodStart, ...summary, narrative, note,
    channelId: current.channelId, channelName: current.channelName, retry,
    slackStatus: saved?.slackStatus ?? null, attempt: saved?.slackPostAttempt ?? null, startedAt: saved?.slackPostStartedAt ?? null };
  const n = summary.numbers;
  const lines = [
    `Business date ${current.dayKey}. The day starts at ${current.dayStartHour}:00 in ${current.timeZone}.`,
    `Raw leads ${n.rawLeads}. Resparks ${n.resparks}. Entries ${n.entries}. Not a fit ${n.notAFit}.`,
    `Scheduled hours ${n.scheduledHours ?? "unknown"}. Leads per scheduled hour ${n.leadsPerHour === null ? "not available" : n.leadsPerHour.toFixed(2)}.${summary.hoursUnknownReason ? " Magnus couldn't read the schedule in full." : ""}`,
    saved ? retry ? "Return your saved report and retry its Slack post. The saved numbers and text stay the same."
      : "Return your saved report. The saved numbers and text stay the same." : "Save one report for this business day.",
    current.channelId ? `${saved && !retry ? "Current Slack destination" : "Post to"} #${current.channelName ?? current.channelId}.` : "No lead gen Slack channel is set. Nothing will be posted.",
    `Your lines: ${narrative ?? "None."}`, `Team note: ${note ?? "None."}`,
  ];
  return { summary, snapshot, preview: listPreview("Your end-of-shift report:", lines,
    ["Read this back before asking for a yes. Confirm with the same text and the returned business date and settings version."]),
    body: { dayKey: current.dayKey, businessDayVersion: current.businessDayVersion, ...summary, hoursUnknownReason: summary.hoursUnknownReason ?? null } };
}

export const endShift = internalMutation({
  args: { caller: mcpCallerValidator, ...endShiftArgs },
  returns: v.union(receiptValidator, v.object({ preview: v.string(), ...summaryFields, confirmToken: v.string(), expiresInSeconds: v.number() })),
  handler: async (ctx, { caller, narrative, note, confirm, confirmToken, dayKey, businessDayVersion }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    await requireOwnLeadGenWorker(ctx, me);
    // Bind the exact input too: even a whitespace edit needs another read-back.
    const text = { narrative: shiftText(narrative), note: shiftText(note) };
    const now = Date.now();
    if (confirm) {
      const redeemed = await redeemConfirmation(ctx, me, TOOL, confirmToken, { narrative, note, dayKey, businessDayVersion });
      if (redeemed.kind === "replay") return redeemed.result as never;
      const current = await shiftContext(ctx, me, now);
      if (dayKey !== current.dayKey || businessDayVersion !== current.businessDayVersion) {
        throw rejectRequest("shift.day_changed", "The business day or its settings changed. Preview again, then ask for a yes.");
      }
      // Two separately confirmed previews may reach the same day's immutable report.
      // Only a preview of that saved report may initiate a retry.
      const original = JSON.parse(redeemed.preview) as { intent: string };
      if (current.existing && original.intent === "save") {
        const result = receipt(current.existing, true);
        await markConfirmationUsed(ctx, redeemed.confirmationId, result);
        return result;
      }
      const plan = await planShift(ctx, me, current, text, now);
      if (redeemed.preview !== stableJson(plan.snapshot)) {
        throw rejectRequest("shift.changed", "Something changed since the preview. Nothing was saved. Preview again, then ask for a yes.");
      }
      const report = current.existing ? await retryShiftDeliveryCore(ctx, current, now)
        : await endLeadGenShiftCore(ctx, me, current, plan.summary, { ...text, via: "mcp", agentClient: me.agentClient }, now);
      const result = receipt(report, current.existing !== null);
      await markConfirmationUsed(ctx, redeemed.confirmationId, result);
      return result;
    }
    const current = await shiftContext(ctx, me, now);
    const plan = await planShift(ctx, me, current, text, now);
    const issued = await issueConfirmation(ctx, me, TOOL, { narrative, note, dayKey: current.dayKey, businessDayVersion: current.businessDayVersion }, stableJson(plan.snapshot));
    return { ...plan.body, preview: plan.preview, confirmToken: issued.confirmToken, expiresInSeconds: issued.expiresInSeconds };
  },
});
