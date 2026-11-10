import { defineMcpMutation, type McpToolRegistration } from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import type { WriteFamily } from "../families";
import { correctPaymentArgs, reviewPaymentsArgs } from "../admin/writes/payments";
import { recordResultArgs } from "../admin/writes/results";
import { nextStepArgs } from "../admin/writes/nextStep";
import { decideOpinionArgs } from "../admin/writes/opinions";
import { repairArgs } from "../admin/writes/repairs";
import { setGoalArgs } from "../admin/writes/goals";
import { coverCloserArgs } from "../admin/writes/coverage";

/**
 * Admin prepare tools (docs/plans/admin-assistant.md §2, §4). Each one checks
 * the change and stores a draft; nothing changes until `magnus_commit` (a
 * single change) or an approval in Magnus (a plan). `metadata.family` is the
 * owner's switch that shows or hides the tool.
 */

const PREPARE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const meta = (family: WriteFamily) => ({ roles: ["tenant_master", "tenant_admin"], writes: true, family });

const SINGLE =
  "Returns a preview and a `commit` object. Read the preview to the admin; after a clear yes, pass `commit` unchanged to magnus_commit. Nothing changes until then.";
const PLAN =
  "Returns a preview and an approvalUrl. Nothing changes in chat: the admin opens the link and approves the plan in Magnus.";

export const adminWriteTools: McpToolRegistration[] = [
  defineMcpMutation({
    name: "magnus_correct_payment",
    title: "Prepare a payment correction",
    description: `Prepares a correction to one logged payment: amount, type, program, reference code or note. Needs a reason of a few words. The preview lists what else changes, such as an enrollment or the review state. ${SINGLE}`,
    fn: internal.mcp.admin.writes.payments.prepareCorrectPayment,
    args: correctPaymentArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("payments"),
  }),
  defineMcpMutation({
    name: "magnus_review_payments",
    title: "Prepare payment reviews",
    description: `Prepares marking 1 to 20 payments reviewed, by paymentRecordId from magnus_queue. Payments that are disputed, already reviewed, have no receipt, reuse a receipt, or were logged by this admin are left out and listed. ${PLAN}`,
    fn: internal.mcp.admin.writes.payments.prepareReviewPayments,
    args: reviewPaymentsArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("payments"),
  }),
  defineMcpMutation({
    name: "magnus_record_result",
    title: "Prepare a call result",
    description: `Prepares the result of a closer's call that has started. A no-show is applied with magnus_commit (${SINGLE}) A loss needs a category and a reason of a few words, can't be undone, and is approved in Magnus (${PLAN})`,
    fn: internal.mcp.admin.writes.results.prepareRecordResult,
    args: recordResultArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("results"),
  }),
  defineMcpMutation({
    name: "magnus_next_step",
    title: "Prepare a deal's next step",
    description: `Prepares what happens next on a deal: a call-back or text-back at a date and time in the closer's zone; marking a call held with a call-back; a scheduling link; a reschedule link after a no-show; or cancelling an open task. A call-back that already exists is returned, not duplicated. ${SINGLE}`,
    fn: internal.mcp.admin.writes.nextStep.prepareNextStep,
    args: nextStepArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("results"),
  }),
  defineMcpMutation({
    name: "magnus_decide_second_opinion",
    title: "Prepare a second-opinion decision",
    description: `Prepares a decision on an open second opinion: the closer was right, or the second opinion was. A disproved no-show can be reopened as a call-back with reopen {date, time} in the closer's zone. ${SINGLE}`,
    fn: internal.mcp.admin.writes.opinions.prepareDecideSecondOpinion,
    args: decideOpinionArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("opinions"),
  }),
  defineMcpMutation({
    name: "magnus_repair",
    title: "Prepare a repair",
    description: `Prepares one repair from magnus_health: retry a blocked booking delivery or a failed projection (pass the generation you read), link a Fathom recorder to a teammate or ignore them, or attach an unmatched recording to a meeting. Retries are queued; magnus_health shows the outcome. ${SINGLE}`,
    fn: internal.mcp.admin.writes.repairs.prepareRepair,
    args: repairArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("repairs"),
  }),
  defineMcpMutation({
    name: "magnus_set_goal",
    title: "Prepare a goal change",
    description: `Prepares a change to the team's daily qualification goal, or a DM team's daily booking quota (teamId from magnus_team). value null clears it. The preview shows before and after. ${SINGLE}`,
    fn: internal.mcp.admin.writes.goals.prepareSetGoal,
    args: setGoalArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("goals"),
  }),
  defineMcpMutation({
    name: "magnus_cover_closer",
    title: "Cover an absent closer's calls",
    description: `Covers a closer's absence on one day: fullDay: true, or from and to ("HH:MM" in the closer's zone). mode "preview" changes nothing (it shares this tool only for convenience): it lists the affected calls, which candidate closers are free, and a link to the redistribute wizard. mode "plan" prepares the absence and a fixed plan that gives each deal one new owner who is free for every call on it; all of a deal's calls move together. At most 50 calls across 25 deals and 8 candidates (name them with candidateCloserIds); larger ones go to the wizard. The plan expires when its first upcoming call starts. ${PLAN}`,
    fn: internal.mcp.admin.writes.coverage.prepareCoverCloser,
    args: coverCloserArgs,
    identityArg: "caller",
    annotations: PREPARE,
    metadata: meta("coverage"),
  }),
];
