import { makeFunctionReference, paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v, type Infer, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { transcriptGone } from "../callInsights/retention";
import { callEvidenceWanted } from "../callInsights/settings";
import { slotEndAt } from "../callInsights/suggest/state";
import { headerFor } from "../callInsights/trigger";
import { DEFAULT_BUSINESS_DAY } from "../../lib/businessDay";
import { paymentCounts } from "../lib/enrollments";
import { leadDisplayFromShape } from "../lib/leadDisplay";
import { log } from "../lib/observability/log";
import { PERMISSIONS } from "../lib/permissions";
import { isSideDeal } from "../lib/sideDeals";
import { sha256Hex, stableJson } from "../lib/stableHash";
import { userTeamMemberName } from "../lib/teamMembers";
import { dealPosition } from "../opportunities/stages";
import { requireTenantUser } from "../requireTenantUser";
import { isOtherProspectsCall } from "../secondOpinion/trigger";
import { enrollInSample } from "./certificates";
import { callRuleVersion, deriveCallDecisions, type CallDecisionInput, type DerivedCallDecision } from "./callRule";
import { captureRefusalNoticeBefore } from "./notice";
import { isCallKind, type DecisionKind } from "./proposals";
import { automationTables, decisionStateValidator } from "./schema";
import { currentRuleVersion, DEFAULT_ALERT_GRACE_MINUTES, effectiveAlertMode, effectiveKindMode } from "./settings";

const callEvaluateCauseValidator = v.union(
  v.literal("published"), v.literal("reprojected"), v.literal("slot_ended"), v.literal("alert_due"),
  v.literal("human_result"), v.literal("assignment"), v.literal("payment"), v.literal("settings"), v.literal("sweep"),
);
export type CallEvaluateCause = Infer<typeof callEvaluateCauseValidator>;
type Decision = Doc<"resultAutomationDecisions">;
type ReadCtx = QueryCtx | MutationCtx;
type CallRecording = Doc<"callRecordings">;
type CallDeal = NonNullable<CallDecisionInput["deal"]>;
type Tenant = Doc<"tenants">;
type Meeting = Doc<"meetings">;
type Deal = Doc<"opportunities">;
type EvaluateArgs = { tenantId: Id<"tenants">; meetingId: Id<"meetings">; cause: CallEvaluateCause; now: number };

const OUTSTANDING = ["ready", "notice", "needs_person", "blocked", "shadow"] as const;
const BATCH = 50;
const VETO_HISTORY_LIMIT = 100;
const HOUR = 3_600_000;

const evaluateRef = makeFunctionReference<"mutation", { meetingId: Id<"meetings">; cause: CallEvaluateCause }>(
  "automation/callDecisions:evaluateCallMeeting",
);
const executeCallTaskRef = makeFunctionReference<"mutation", { decisionId: Id<"resultAutomationDecisions"> }>(
  "automation/apply:executeCallTask",
);

function callModes(tenant: Tenant) {
  const settings = tenant.resultAutomation;
  const policy = (kind: keyof CallDecisionInput["modes"]) => ({
    mode: effectiveKindMode(tenant, kind),
    policyVersion: settings?.kinds[kind]?.policyVersion ?? 0,
  });
  return {
    modes: { call_back: policy("call_back"), payment_owed: policy("payment_owed"), refusal_loss: policy("refusal_loss") },
    alert: {
      mode: effectiveAlertMode(tenant),
      graceMinutes: settings?.paidOnCallAlert?.graceMinutes ?? DEFAULT_ALERT_GRACE_MINUTES,
      policyVersion: settings?.paidOnCallAlert?.policyVersion ?? 0,
    },
  };
}

export async function scheduleCallEvaluation(
  ctx: MutationCtx, tenant: Tenant | null, meetingId: Id<"meetings">, cause: CallEvaluateCause, at?: number,
): Promise<void> {
  if (!tenant || !callEvidenceWanted(tenant)) return;
  const { modes, alert } = callModes(tenant);
  if (alert.mode === "off" && Object.values(modes).every((policy) => policy.mode === "off")) return;
  try {
    if (at === undefined) await ctx.scheduler.runAfter(0, evaluateRef, { meetingId, cause });
    else await ctx.scheduler.runAt(at, evaluateRef, { meetingId, cause });
  } catch {
    log.warn("automation.call_schedule_failed", { tenantId: tenant._id, meetingId });
  }
}

export async function schedulePublishedCallEvaluation(
  ctx: MutationCtx, tenant: Tenant | null, meeting: Meeting, cause: "published" | "reprojected", now: number,
): Promise<void> {
  if (!tenant || !callEvidenceWanted(tenant)) return;
  await scheduleCallEvaluation(ctx, tenant, meeting._id, cause);
  const slotEndedAt = slotEndAt(meeting);
  const { modes, alert } = callModes(tenant);
  if (now < slotEndedAt && Object.values(modes).some((policy) => policy.mode !== "off")) {
    await scheduleCallEvaluation(ctx, tenant, meeting._id, "slot_ended", slotEndedAt);
  }
  const alertDue = slotEndedAt + alert.graceMinutes * 60_000;
  if (alert.mode !== "off" && now < alertDue) {
    await scheduleCallEvaluation(ctx, tenant, meeting._id, "alert_due", alertDue);
  }
}

function decisionKey(derived: DerivedCallDecision) {
  return sha256Hex(stableJson(derived.inputTuple));
}

function vetoKey(recordingId: Id<"callRecordings">, dealId: Id<"opportunities"> | undefined, family: "task" | "refusal" | "alert") {
  return sha256Hex(stableJson(["call", recordingId, dealId ?? "", family]));
}

async function vetoHistory(ctx: ReadCtx, tenantId: Id<"tenants">, key: string) {
  const rows = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_vetoKey", (q) => q.eq("tenantId", tenantId).eq("vetoKey", key))
    .order("desc")
    .take(VETO_HISTORY_LIMIT + 1);
  return {
    active: rows.length > VETO_HISTORY_LIMIT ||
      rows.some((row) => row.stopCode === "person_stop" && row.vetoReleasedAt === undefined),
    released: rows.find((row) => row.stopCode === "person_stop" && row.vetoReleasedAt !== undefined)?._id,
  };
}

function decisionsForRecording(ctx: ReadCtx, tenantId: Id<"tenants">, recordingId: Id<"callRecordings">, state: Decision["state"]) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_recordingId_and_state", (q) => q.eq("tenantId", tenantId).eq("recordingId", recordingId).eq("state", state));
}

async function latestAssignmentRefusal(ctx: ReadCtx, deal: Deal, meeting: Meeting, recordingId: Id<"callRecordings">) {
  if (!deal.humanResultRevision) return;
  const stopped = await decisionsForRecording(ctx, deal.tenantId, recordingId, "stopped").order("desc").take(BATCH);
  return stopped.find((row) => row.meetingId === meeting._id && row.opportunityId === deal._id &&
    row.stopCode === "closer_changed" && row.kind === "refusal_loss" && row.proposal !== undefined &&
    row.humanResultRevision + 1 === deal.humanResultRevision);
}

async function hasNewerMeeting(ctx: ReadCtx, deals: Deal[], meeting: Meeting) {
  for (const deal of deals) {
    for (const status of ["scheduled", "held", "no_show"] as const) {
      const newer = await ctx.db.query("meetings")
        .withIndex("by_opportunityId_and_status_and_scheduledAt", (q) =>
          q.eq("opportunityId", deal._id).eq("status", status).gt("scheduledAt", meeting.scheduledAt))
        .first();
      if (newer?.tenantId === meeting.tenantId) return true;
    }
  }
  return false;
}

async function hasCountingPayment(ctx: ReadCtx, deal: Deal, since?: number) {
  for (const status of ["recorded", "verified"] as const) {
    const row = await ctx.db.query("paymentRecords")
      .withIndex("by_opportunityId_and_status_and_recordedAt", (q) => {
        const range = q.eq("opportunityId", deal._id).eq("status", status);
        return since === undefined ? range : range.gte("recordedAt", since);
      })
      .order("desc")
      .first();
    if (row?.tenantId === deal.tenantId && paymentCounts(row)) return true;
  }
  return false;
}

async function providerFacts(ctx: ReadCtx, deal: Deal, meeting: Meeting, recording: CallRecording) {
  const { tenantId, leadId } = deal;
  const [resolved, candidates] = await Promise.all([
    ctx.db.query("providerPayments").withIndex("by_tenantId_and_leadId_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId)).take(BATCH + 1),
    ctx.db.query("providerPayments").withIndex("by_tenantId_and_candidateLeadId_and_paidAt", (q) =>
      q.eq("tenantId", tenantId).eq("candidateLeadId", leadId)).take(BATCH + 1),
  ]);
  // When a person's history exceeds this budget, abstain on missing-money decisions.
  if (resolved.length > BATCH || candidates.length > BATCH) {
    return { unresolvedProviderPayment: true, paidForAlert: true };
  }
  const rows = [...resolved, ...candidates.filter((row) => row.leadId === undefined)];
  const slotEndedAt = slotEndAt(meeting);
  const attempt = rows.filter((row) => row.declineCode && row.failedAttemptCount > 0 &&
      row.sourceUpdatedAt >= Math.min(meeting.scheduledAt, recording.recordingStartAt) &&
      row.sourceUpdatedAt <= Math.max(slotEndedAt, recording.recordingEndAt))
    .sort((a, b) => b.sourceUpdatedAt - a.sourceUpdatedAt)[0];
  return {
    unresolvedProviderPayment: rows.some((row) => row.totalMinor !== 0 &&
      (row.status === "paid" || row.status === "unresolved" || row.status === "authorized" || row.status === "pending") &&
      (!row.paymentRecordId || row.status === "paid") && row.reviewState !== "historical" &&
      row.reviewState !== "dismissed"),
    paidForAlert: rows.some((row) => row.status === "paid" && row.totalMinor !== 0 &&
      (row.paidAt ?? -Infinity) >= meeting.scheduledAt - HOUR),
    declineCode: attempt?.declineCode,
  };
}

async function dealFacts(ctx: ReadCtx, deal: Deal, meeting: Meeting, recording: CallRecording, alertOn: boolean) {
  const { tenantId } = deal;
  const [pendingTasks, personDeals, closer, provider, assignmentNotice] = await Promise.all([
    ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", deal._id).eq("status", "pending"))
      .take(1),
    ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", deal.leadId)).take(BATCH + 1),
    deal.assignedCloserId && ctx.db.get("users", deal.assignedCloserId),
    providerFacts(ctx, deal, meeting, recording),
    latestAssignmentRefusal(ctx, deal, meeting, recording._id),
  ]);
  const overflow = personDeals.length > BATCH;
  let countingPaymentSinceCall = overflow;
  let countingPaymentForRefusal = overflow;
  for (const sibling of personDeals.slice(0, BATCH)) {
    if (countingPaymentSinceCall && countingPaymentForRefusal) break;
    const isCallDeal = sibling._id === deal._id;
    if (!countingPaymentSinceCall) countingPaymentSinceCall = await hasCountingPayment(ctx, sibling, isCallDeal ? undefined : meeting.scheduledAt);
    if (!countingPaymentForRefusal) countingPaymentForRefusal = countingPaymentSinceCall || await hasCountingPayment(ctx, sibling);
  }
  const facts: CallDeal = {
    _id: deal._id,
    position: dealPosition(deal.stage, deal.outcome),
    isSideDeal: isSideDeal(deal),
    assignedCloserId: closer && closer.tenantId === tenantId && closer.isActive !== false ? closer._id : undefined,
    humanResultRevision: deal.humanResultRevision ?? 0,
    humanResultRecorded: Boolean(deal.humanResultRevision && !assignmentNotice),
    pendingTasks: pendingTasks.filter((task) => task.tenantId === tenantId),
    newerMeeting: overflow || await hasNewerMeeting(ctx, personDeals, meeting),
    countingPaymentSinceCall,
    countingPaymentForRefusal,
    unresolvedProviderPayment: provider.unresolvedProviderPayment,
    alertPaymentExists: alertOn && (provider.paidForAlert || await hasCountingPayment(ctx, deal, meeting.scheduledAt - 24 * HOUR)),
    declineCode: provider.declineCode,
  };
  return { facts, noticeRound: assignmentNotice?.noticeRound };
}

async function loadSubject(ctx: ReadCtx, tenant: Tenant, meeting: Meeting, now: number) {
  if (!callEvidenceWanted(tenant) || meeting.tenantId !== tenant._id) return null;
  const { modes, alert } = callModes(tenant);
  if (alert.mode === "off" && Object.values(modes).every((policy) => policy.mode === "off")) return null;

  const recording = await ctx.db.query("callRecordings")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
    .first();
  if (recording?.tenantId !== tenant._id || recording.matchStatus !== "matched") return null;
  const header = await headerFor(ctx, recording._id);
  if (!header?.active || header.tenantId !== tenant._id || header.meetingId !== meeting._id || !header.publishedRunId) return null;
  const run = await ctx.db.get("callInsightRuns", header.publishedRunId);
  if (run?.tenantId !== tenant._id || run.recordingId !== recording._id || run.meetingId !== meeting._id ||
      run.status !== "answered" || run.purpose !== "serve") return null;

  const storedDeal = await ctx.db.get("opportunities", meeting.opportunityId);
  const deal = storedDeal?.tenantId === tenant._id ? storedDeal : null;
  const [otherProspect, loaded, taskVetoKey, refusalVetoKey] = await Promise.all([
    isOtherProspectsCall(ctx, meeting, recording),
    deal && dealFacts(ctx, deal, meeting, recording, alert.mode !== "off"),
    vetoKey(recording._id, deal?._id, "task"),
    vetoKey(recording._id, deal?._id, "refusal"),
  ]);
  const [task, refusal] = await Promise.all([
    vetoHistory(ctx, tenant._id, taskVetoKey), vetoHistory(ctx, tenant._id, refusalVetoKey),
  ]);
  const input: CallDecisionInput = {
    now,
    timeZone: tenant.businessDay?.timeZone ?? DEFAULT_BUSINESS_DAY.timeZone,
    modes, alert, activationVersion: tenant.resultAutomation!.activationVersion,
    run: {
      _id: run._id, generation: run.generation, trigger: run.trigger, kind: run.kind, config: run.config,
      publishedAt: header.analyzedAt ?? run.finishedAt ?? run.createdAt,
      publicationRevision: header.publicationRevision,
      speakerUncertain: run.speakerUncertain === true,
      evidence: run.evidence, checks: run.callChecks, result: run.result, earlyReading: run.earlyReading,
    },
    recording: {
      _id: recording._id, matchMethod: recording.matchMethod, otherProspect,
      lengthSeconds: (recording.recordingEndAt - recording.recordingStartAt) / 1000,
      transcriptGone: transcriptGone(recording, now) || run.quotesPurgedAt !== undefined || header.quotesPurgedAt !== undefined,
    },
    meeting: { ...meeting, slotEndedAt: slotEndAt(meeting) },
    deal: loaded && loaded.facts,
    vetoed: { task: task.active, refusal: refusal.active },
    releasedVeto: { task: task.released, refusal: refusal.released },
  };
  const checksVersion = input.run.checks?.version ?? "cc0";
  return {
    input, leadId: deal?.leadId, priorNoticeRound: loaded?.noticeRound,
    decisions: deriveCallDecisions(input),
    version: callRuleVersion({ ...run.config, checksVersion }), checksVersion,
  };
}

function isCallDecision(kind: DecisionKind) {
  return isCallKind(kind) || kind === "paid_on_call_alert";
}

async function supersede(
  ctx: MutationCtx, args: EvaluateArgs, input: CallDecisionInput,
  replacements: Map<DecisionKind, Id<"resultAutomationDecisions">>,
) {
  for (const state of OUTSTANDING) {
    const rows = await decisionsForRecording(ctx, args.tenantId, input.recording._id, state).take(BATCH);
    for (const row of rows) {
      if (row.meetingId !== args.meetingId || !isCallDecision(row.kind)) continue;
      const replacement = row.kind === "paid_on_call_alert" ? replacements.get(row.kind) :
        replacements.get("call_back") ?? replacements.get("payment_owed") ?? replacements.get("refusal_loss");
      if (replacement === row._id) continue;
      // The alert has its own timer and must survive an early slot-ended wakeup.
      if (!replacement && row.runId === input.run._id && args.cause !== "reprojected") continue;
      await ctx.db.patch("resultAutomationDecisions", row._id, {
        state: "superseded", stopCode: "input_changed", resolvedAt: args.now,
        supersededByDecisionId: replacement,
      });
    }
  }
}

async function evaluateLoaded(ctx: MutationCtx, tenant: Tenant, meeting: Meeting, args: EvaluateArgs) {
  const loaded = await loadSubject(ctx, tenant, meeting, args.now);
  if (!loaded) return { decisionIds: [] };
  const { input, checksVersion, version } = loaded;
  const { run, deal, activationVersion } = input;
  // A purged reading may still cite a line. Never replace its retired rows with new ones.
  if (input.recording.transcriptGone) {
    await stopCallDecisionsForRecording(ctx, input.recording._id, "transcript_gone", args.tenantId);
    return { decisionIds: [] };
  }

  const replacements = new Map<DecisionKind, Id<"resultAutomationDecisions">>();
  for (const derived of loaded.decisions) {
    const { kind, askable, wouldWrite } = derived;
    const inputKey = await decisionKey(derived);
    const previous = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_inputKey", (q) => q.eq("tenantId", args.tenantId).eq("inputKey", inputKey))
      .unique();
    if (previous) {
      replacements.set(kind, previous._id);
      continue;
    }

    const policy = kind === "paid_on_call_alert" ? input.alert : input.modes[kind];
    const automatic = kind !== "paid_on_call_alert" && policy.mode === "automatic" && wouldWrite &&
      currentRuleVersion(tenant, kind) === version;
    const mode = policy.mode === "shadow" ? "shadow" : automatic ? "automatic" : "ask";
    const state = mode === "shadow" ? "shadow" : !askable ? "needs_person" :
      automatic && kind === "refusal_loss" ? "notice" : "ready";
    const dueAt = derived.dueAt ?? (automatic && kind !== "refusal_loss" ? args.now : undefined);
    const id = await ctx.db.insert("resultAutomationDecisions", {
      tenantId: args.tenantId, leadId: loaded.leadId, opportunityId: deal?._id, meetingId: meeting._id,
      assignedCloserId: deal?.assignedCloserId, kind, mode, state, inputKey,
      vetoKey: await sha256Hex(stableJson(derived.vetoTuple)),
      ruleVersion: version, policyVersion: policy.policyVersion, activationVersion,
      humanResultRevision: deal?.humanResultRevision ?? 0,
      wouldWrite, gates: derived.gates, proposal: derived.proposal,
      confirmRoute: kind !== "paid_on_call_alert" && askable ? "meeting" : undefined,
      noticeUserId: askable && mode !== "shadow" ? derived.noticeUserId : undefined,
      runId: run._id, recordingId: input.recording._id,
      dueAt,
      noticeRound: state === "notice" ? (loaded.priorNoticeRound ?? 0) + 1 : undefined,
      // What the deal and meeting looked like when the notice was raised: the
      // deadline writes only if they still match.
      callBefore: state === "notice" && deal ? await captureRefusalNoticeBefore(ctx, deal._id, meeting) : undefined,
      evidence: {
        type: "call", runId: run._id, recordingId: input.recording._id, generation: run.generation,
        promptVersion: run.config.promptVersion, model: run.config.model, thresholdsVersion: run.config.thresholdsVersion,
        checksVersion, readTrigger: run.trigger, publishedAt: run.publishedAt, slotEndedAt: input.meeting.slotEndedAt,
        finalStatementLine: derived.finalStatementLine,
      },
      createdAt: args.now,
    });
    const inserted = await ctx.db.get("resultAutomationDecisions", id);
    if (inserted) await enrollInSample(ctx, inserted);
    // An automatic task is due at once. The executor re-checks everything in its own mutation.
    if (state === "ready" && mode === "automatic" && (kind === "call_back" || kind === "payment_owed") && dueAt !== undefined) {
      await ctx.scheduler.runAt(dueAt, executeCallTaskRef, { decisionId: id });
    }
    replacements.set(kind, id);
  }
  await supersede(ctx, args, input, replacements);
  return { decisionIds: [...replacements.values()] };
}

export async function evaluateCallSubject(
  ctx: MutationCtx, args: EvaluateArgs,
): Promise<{ decisionIds: Id<"resultAutomationDecisions">[] }> {
  const tenant = await ctx.db.get("tenants", args.tenantId);
  if (!tenant || !callEvidenceWanted(tenant)) return { decisionIds: [] };
  const meeting = await ctx.db.get("meetings", args.meetingId);
  return meeting ? await evaluateLoaded(ctx, tenant, meeting, args) : { decisionIds: [] };
}

export const evaluateCall = evaluateCallSubject;

export const evaluateCallMeeting = internalMutation({
  args: { meetingId: v.id("meetings"), cause: callEvaluateCauseValidator },
  returns: v.object({ decisionIds: v.array(v.id("resultAutomationDecisions")) }),
  handler: async (ctx, { meetingId, cause }) => {
    const meeting = await ctx.db.get("meetings", meetingId);
    const tenant = meeting && await ctx.db.get("tenants", meeting.tenantId);
    if (!meeting || !tenant) return { decisionIds: [] };
    const now = Date.now();
    if (cause === "slot_ended" && now < slotEndAt(meeting)) {
      await scheduleCallEvaluation(ctx, tenant, meetingId, "slot_ended", slotEndAt(meeting));
    }
    if (cause === "alert_due" && effectiveAlertMode(tenant) !== "off") {
      const dueAt = slotEndAt(meeting) + (tenant.resultAutomation?.paidOnCallAlert?.graceMinutes ?? DEFAULT_ALERT_GRACE_MINUTES) * 60_000;
      if (now < dueAt) await scheduleCallEvaluation(ctx, tenant, meetingId, "alert_due", dueAt);
    }
    return await evaluateLoaded(ctx, tenant, meeting, { tenantId: tenant._id, meetingId, cause, now });
  },
});

/** Confirmers re-read all gates and compare the wordless fingerprint inside their write transaction. */
export async function rederiveCall(
  ctx: ReadCtx, decision: Decision, now: number,
): Promise<{ same: boolean; derived: DerivedCallDecision | null }> {
  const tenant = await ctx.db.get("tenants", decision.tenantId);
  if (!tenant || !callEvidenceWanted(tenant) || !decision.meetingId) return { same: false, derived: null };
  const meeting = await ctx.db.get("meetings", decision.meetingId);
  const loaded = meeting && await loadSubject(ctx, tenant, meeting, now);
  const derived = loaded && loaded.decisions.find((row) => row.kind === decision.kind);
  return { same: !!derived && await decisionKey(derived) === decision.inputKey, derived: derived ?? null };
}

const stopRecordingArgs = {
  tenantId: v.id("tenants"), recordingId: v.id("callRecordings"),
  code: v.union(v.literal("recording_moved"), v.literal("transcript_gone")), through: v.optional(v.number()),
};
type StopRecordingArgs = ObjectType<typeof stopRecordingArgs>;
const stopRecordingRef = makeFunctionReference<"mutation", StopRecordingArgs>("automation/callDecisions:stopRecordingPage");

async function stopRecordingBatch(ctx: MutationCtx, args: StopRecordingArgs) {
  let budget = BATCH;
  for (const state of OUTSTANDING) {
    const limit = budget;
    const rows = await decisionsForRecording(ctx, args.tenantId, args.recordingId, state).take(limit + 1);
    const through = args.through;
    const eligible = through === undefined ? rows : rows.filter((row) => row._creationTime <= through);
    for (const row of eligible.slice(0, limit)) {
      await ctx.db.patch("resultAutomationDecisions", row._id, { state: "stopped", stopCode: args.code, resolvedAt: Date.now() });
      budget--;
    }
    if (budget === 0) {
      let through = args.through;
      if (through === undefined) {
        const latest = await Promise.all(OUTSTANDING.map((state) =>
          decisionsForRecording(ctx, args.tenantId, args.recordingId, state).order("desc").first()));
        through = Math.max(...latest.map((row) => row?._creationTime ?? 0));
      }
      await ctx.scheduler.runAfter(0, stopRecordingRef, { ...args, through });
      return;
    }
  }
}

export const stopRecordingPage = internalMutation({
  args: stopRecordingArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await stopRecordingBatch(ctx, args);
    return null;
  },
});

export async function stopCallDecisionsForRecording(
  ctx: MutationCtx, recordingId: Id<"callRecordings">, code: StopRecordingArgs["code"], tenantId?: Id<"tenants">,
): Promise<void> {
  try {
    const scope = tenantId ?? (await ctx.db.get("callRecordings", recordingId))?.tenantId;
    if (scope) await stopRecordingBatch(ctx, { tenantId: scope, recordingId, code });
  } catch {
    log.warn("automation.call_recording_stop_failed", { recordingId });
  }
}

const proposalKindValidator = v.union(v.literal("call_back"), v.literal("payment_owed"), v.literal("refusal_loss"), v.literal("paid_on_call_alert"));
const rowValidator = v.object({
  ...automationTables.resultAutomationDecisions.validator.fields,
  _id: v.id("resultAutomationDecisions"),
  _creationTime: v.number(),
  personName: v.string(),
  closerName: v.union(v.string(), v.null()),
});

function nameOnly(value: string | undefined) {
  const name = value?.trim();
  return name && !name.includes("@") && !/^[+\d\s().-]+$/.test(name) ? name : undefined;
}

export const listCallProposals = query({
  args: { kind: v.optional(proposalKindValidator), state: v.optional(decisionStateValidator), paginationOpts: paginationOptsValidator },
  returns: v.object({ ...paginationResultValidator(rowValidator).fields, postFiltered: v.boolean() }),
  handler: async (ctx, { kind, state, paginationOpts }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    const rows = ctx.db.query("resultAutomationDecisions");
    const range = kind
      ? state
        ? rows.withIndex("by_tenantId_and_kind_and_state_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("kind", kind).eq("state", state))
        : rows.withIndex("by_tenantId_and_kind_and_createdAt", (q) => q.eq("tenantId", tenantId).eq("kind", kind))
      : state
        ? rows.withIndex("by_tenantId_and_state_and_createdAt", (q) => q.eq("tenantId", tenantId).eq("state", state))
        : rows.withIndex("by_tenantId_and_createdAt", (q) => q.eq("tenantId", tenantId));
    const page = await range.order("desc").paginate({
      ...paginationOpts, numItems: Math.min(paginationOpts.numItems, BATCH), maximumBytesRead: 256 * 1024,
    });
    // With every kind selected, skip Whop decisions while keeping creation order across call kinds.
    const proposals = page.page.filter((row) => isCallDecision(row.kind));
    const named = await Promise.all(proposals.map(async (row) => {
      const [person, closer] = await Promise.all([
        row.leadId && ctx.db.get("leads", row.leadId),
        row.assignedCloserId && ctx.db.get("users", row.assignedCloserId),
      ]);
      return {
        ...row,
        personName: leadDisplayFromShape(person?.tenantId === tenantId
          ? { fullName: nameOnly(person.fullName), leadId: person._id }
          : {}),
        closerName: closer?.tenantId === tenantId && closer.fullName?.trim()
          ? nameOnly(userTeamMemberName(closer)) ?? null
          : null,
      };
    }));
    return { ...page, page: named, postFiltered: proposals.length < page.page.length };
  },
});
