import type { TestConvex } from "convex-test";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { QueryCtx } from "../convex/_generated/server";
import type schema from "../convex/schema";
import {
  callEvidenceOf,
  isCallKind,
  paymentEvidenceOf,
  refusalProposalOf,
  type DecisionKind,
} from "../convex/automation/proposals";
import { earliestCountingPayment, paymentCounts } from "../convex/lib/enrollments";
import { RESERVED_LOSS_REASONS } from "../convex/opportunities/stages";

// The fourteen automation invariants of the phase 3 build contract (§5).
// Every phase 3 backend test calls `assertAutomationInvariants` after each
// step, beside `assertPaymentInvariants`. It reads every row in scope inside
// one `t.run` and throws one error listing each broken invariant with ids.
// Test-only: reads are bounded, and past a bound it throws rather than check
// part of a range.

export const AUTOMATION_INVARIANT_IDS = [
  "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14",
] as const;
export type AutomationInvariantId = (typeof AUTOMATION_INVARIANT_IDS)[number];

export type AutomationInvariantScope = {
  tenantId: Id<"tenants">;
  opportunityIds?: Id<"opportunities">[];
  meetingIds?: Id<"meetings">[];
};

const SCOPE_LIMIT = 200;
const ROWS_PER_DEAL_LIMIT = 100;
const MEETINGS_PER_DEAL_LIMIT = 50;
const TASKS_PER_DEAL_LIMIT = 100;
const ROW_LIST_LIMIT = 500;
const HOUR_MS = 3_600_000;

type Decision = Doc<"resultAutomationDecisions">;
type DecisionState = Decision["state"];
type Purpose = NonNullable<Doc<"followUps">["purpose"]>;

const DECISION_STATES = [
  "shadow", "needs_person", "ready", "applied", "stopped", "superseded", "blocked", "undone", "corrected", "notice",
] as const satisfies readonly DecisionState[];
// The states a newer call decision of the same family supersedes (contract §2.4).
const OUTSTANDING_CALL_STATES = new Set<DecisionState>(["shadow", "needs_person", "ready", "blocked", "notice"]);
const NEW_EVENT_TYPES = [
  "automation.notice_acknowledged", "automation.notice_stopped", "automation.alert_answered",
  "automation.kind_promoted", "automation.breaker_tripped", "automation.audit_recorded",
  "meeting.attendance_withdrawn",
] as const;
// The I16 allowlist (tests/paymentInvariants.ts), plus the call rule, prompt,
// model, thresholds and checks versions.
const ALLOWED_STRINGS = [
  /^[a-z_]+$/, // fixed codes
  /^[A-Z]{3}$/, // ISO currency
  /^[0-9a-f]{64}$/, // sha256 hex
  /^payment-rule@\d+$/, // rule version
  /^\d+[A-Za-z]+$/, // ids in convex-test (a counter, then the table)
  /^[0-9a-z]{31,37}$/, // ids on a deployment
  /^call-rule@\d+$/,
  /^call-rule@\d+\|p\d+\|[a-z0-9_-]+\/[a-z0-9._-]+\|t\d+\|cc\d+$/,
  /^p\d+$/,
  /^[a-z0-9_-]+\/[a-z0-9._-]+$/, // model id, such as anthropic/claude-sonnet-5.5
  /^t\d+$/,
  /^cc\d+$/,
];
// What a task a decision wrote may be for: the decision's own purpose, or a
// call-back for a refusal's Stop or reopen, or the alert's payment-owed task.
const TASK_PURPOSES: Record<DecisionKind, readonly Purpose[]> = {
  payment_win: [],
  additional_payment: [],
  call_back: ["call_back"],
  payment_owed: ["payment_owed"],
  refusal_loss: ["call_back"],
  paid_on_call_alert: ["payment_owed"],
};

type Violation = { id: AutomationInvariantId; detail: string };

function overflow(what: string, limit: number): never {
  throw new Error(`assertAutomationInvariants: more than ${limit} ${what} in scope`);
}

async function bounded<T>(rows: Promise<T[]>, limit: number, what: string): Promise<T[]> {
  const list = await rows;
  if (list.length > limit) overflow(what, limit);
  return list;
}

function stringsIn(value: unknown, path: string, out: Array<[string, string]>) {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => stringsIn(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) stringsIn(item, `${path}.${key}`, out);
  }
}

function freeText(value: unknown): Array<[string, string]> {
  const strings: Array<[string, string]> = [];
  stringsIn(value, "", strings);
  return strings.filter(([, text]) => !ALLOWED_STRINGS.some((pattern) => pattern.test(text)));
}

function callFamily(kind: DecisionKind): "task" | "refusal" | "alert" | null {
  if (kind === "call_back" || kind === "payment_owed") return "task";
  if (kind === "refusal_loss") return "refusal";
  if (kind === "paid_on_call_alert") return "alert";
  return null;
}

function isCallRefusal(reason: string | undefined): boolean {
  return reason?.trim().toLowerCase() === RESERVED_LOSS_REASONS.call_refusal;
}

/** Whether the sample was certified: it may have lapsed since, but it was the certificate in force. */
function wasCertified(sample: Doc<"automationSamples">): boolean {
  return sample.certifiedAt !== undefined && (sample.status === "certified" || sample.status === "lapsed");
}

async function collect(ctx: QueryCtx, scope: AutomationInvariantScope): Promise<Violation[]> {
  const { tenantId } = scope;
  const violations: Violation[] = [];
  const fail = (id: AutomationInvariantId, detail: string) => violations.push({ id, detail });
  const whole = !scope.opportunityIds && !scope.meetingIds;

  const tenant = await ctx.db.get("tenants", tenantId);
  const deals = scope.opportunityIds
    ? (await Promise.all(scope.opportunityIds.map((id) => ctx.db.get("opportunities", id))))
      .flatMap((deal) => deal && deal.tenantId === tenantId ? [deal] : [])
    : await bounded(ctx.db.query("opportunities").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(SCOPE_LIMIT + 1), SCOPE_LIMIT, "deals");
  const dealIds = new Set<string>(deals.map((deal) => deal._id));

  const meetingsById = new Map<string, Doc<"meetings">>();
  for (const deal of deals) {
    const rows = await bounded(ctx.db.query("meetings")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", deal._id))
      .take(MEETINGS_PER_DEAL_LIMIT + 1), MEETINGS_PER_DEAL_LIMIT, "meetings on one deal");
    for (const meeting of rows) meetingsById.set(meeting._id, meeting);
  }
  for (const meetingId of scope.meetingIds ?? []) {
    const meeting = await ctx.db.get("meetings", meetingId);
    if (meeting?.tenantId === tenantId) meetingsById.set(meeting._id, meeting);
  }
  const meetings = [...meetingsById.values()];

  const decisions: Decision[] = [];
  for (const state of DECISION_STATES) {
    const rows = await bounded(ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_state_and_createdAt", (q) => q.eq("tenantId", tenantId).eq("state", state))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, `${state} decisions`);
    decisions.push(...rows.filter((decision) => whole ||
      (decision.opportunityId !== undefined && dealIds.has(decision.opportunityId)) ||
      (decision.meetingId !== undefined && meetingsById.has(decision.meetingId))));
  }

  const tasksByDeal = new Map<string, Doc<"followUps">[]>();
  const rowsByDeal = new Map<string, Doc<"paymentRecords">[]>();
  for (const deal of deals) {
    tasksByDeal.set(deal._id, await bounded(ctx.db.query("followUps")
      .withIndex("by_opportunityId_and_status_and_reason", (q) => q.eq("opportunityId", deal._id))
      .take(TASKS_PER_DEAL_LIMIT + 1), TASKS_PER_DEAL_LIMIT, "tasks on one deal"));
    rowsByDeal.set(deal._id, await bounded(ctx.db.query("paymentRecords")
      .withIndex("by_opportunityId_and_recordedAt", (q) => q.eq("opportunityId", deal._id))
      .take(ROWS_PER_DEAL_LIMIT + 1), ROWS_PER_DEAL_LIMIT, "rows on one deal"));
  }
  const pendingTasks = (dealId: string) => (tasksByDeal.get(dealId) ?? [])
    .filter((task) => task.status === "pending" && task.reason !== "stale_opportunity_nudge");
  const countingRows = (dealId: string) => (rowsByDeal.get(dealId) ?? [])
    .filter((row) => row.tenantId === tenantId && paymentCounts(row));

  // A1: a held mark names the call receipt that wrote it, including task-only corrections.
  for (const meeting of meetings) {
    const fromCall = meeting.attendanceSource === "call_insights";
    if (fromCall !== (meeting.attendanceDecisionId !== undefined)) {
      fail("A1", `meeting ${meeting._id} has attendanceSource ${meeting.attendanceSource ?? "unset"} and attendanceDecisionId ${meeting.attendanceDecisionId ?? "unset"}`);
    }
    if (!meeting.attendanceDecisionId) continue;
    const decision = await ctx.db.get("resultAutomationDecisions", meeting.attendanceDecisionId);
    const retainsHeldMark = decision && (decision.state === "corrected" || decision.state === "undone") &&
      (decision.kind === "call_back" || decision.kind === "payment_owed") &&
      decision.writtenFollowUpId !== undefined && decision.callBefore?.meetingId === meeting._id;
    if (!decision || decision.tenantId !== meeting.tenantId || (decision.state !== "applied" && !retainsHeldMark) ||
        !isCallKind(decision.kind) || decision.meetingId !== meeting._id) {
      fail("A1", `meeting ${meeting._id} names decision ${meeting.attendanceDecisionId}, which is not an applied call decision on it`);
    }
    if (meeting.status !== "held") fail("A1", `meeting ${meeting._id} carries a call held mark but is ${meeting.status}`);
  }

  // A2: tasks a decision wrote, and every payment-owed task.
  for (const deal of deals) {
    for (const task of tasksByDeal.get(deal._id) ?? []) {
      if (task.automationDecisionId) {
        if (task.reason !== "call_insights") fail("A2", `task ${task._id} from decision ${task.automationDecisionId} has reason ${task.reason}`);
        const decision = await ctx.db.get("resultAutomationDecisions", task.automationDecisionId);
        if (!decision || decision.tenantId !== task.tenantId) {
          fail("A2", `task ${task._id} names missing or other-tenant decision ${task.automationDecisionId}`);
        } else if (!task.purpose || !TASK_PURPOSES[decision.kind].includes(task.purpose)) {
          fail("A2", `task ${task._id} has purpose ${task.purpose ?? "unset"} for a ${decision.kind} decision`);
        }
        if (task.reminderNote !== undefined) fail("A2", `task ${task._id} from decision ${task.automationDecisionId} holds a note`);
      }
      if (task.purpose === "payment_owed" && !(
        task.expectedAmountMinor !== undefined && task.expectedAmountMinor > 0 &&
        task.expectedCurrency !== undefined && /^[A-Z]{3}$/.test(task.expectedCurrency) &&
        task.promisedPaymentAt !== undefined)) {
        fail("A2", `payment-owed task ${task._id} lacks an amount, an ISO currency or a promised date`);
      }
    }
  }

  // A3: a call refusal loss is the receipt of an applied refusal decision.
  for (const deal of deals) {
    if (deal.outcome !== "lost" || !isCallRefusal(deal.lostReason)) continue;
    const applied = await bounded(ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_opportunityId_and_state", (q) =>
        q.eq("tenantId", tenantId).eq("opportunityId", deal._id).eq("state", "applied"))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "applied decisions on one deal");
    const owner = applied.find((decision) => decision.kind === "refusal_loss" && decision.resolvedAt === deal.lostAt &&
      (deal.lostByUserId !== undefined
        ? decision.resolvedByUserId === deal.lostByUserId
        : decision.mode === "automatic"));
    if (deal.lostReason !== RESERVED_LOSS_REASONS.call_refusal || !owner) {
      fail("A3", `deal ${deal._id} lost with ${deal.lostReason} at ${deal.lostAt ?? "unset"} by ${deal.lostByUserId ?? "nobody"} and no applied refusal decision that wrote it`);
    }
  }

  for (const decision of decisions) {
    // A4: a notice is an automatic refusal; its clock starts on acknowledgment.
    if (decision.state === "notice") {
      if (decision.kind !== "refusal_loss" || decision.mode !== "automatic" || !decision.noticeUserId) {
        fail("A4", `notice ${decision._id} is ${decision.kind} at ${decision.mode} with noticeUserId ${decision.noticeUserId ?? "unset"}`);
      }
      if ((decision.dueAt !== undefined) !== (decision.acknowledgedAt !== undefined)) {
        fail("A4", `notice ${decision._id} has dueAt ${decision.dueAt ?? "unset"} and acknowledgedAt ${decision.acknowledgedAt ?? "unset"}`);
      } else if (decision.acknowledgedAt !== undefined &&
          (decision.noticeHours === undefined || decision.dueAt !== decision.acknowledgedAt + decision.noticeHours * HOUR_MS)) {
        fail("A4", `notice ${decision._id} is due at ${decision.dueAt}, not ${decision.noticeHours ?? "unset"} hours after its acknowledgment`);
      }
    }

    // A5: an outstanding refusal waits on an open deal and its scheduled call.
    if (decision.kind === "refusal_loss" && (decision.state === "ready" || decision.state === "notice")) {
      const deal = decision.opportunityId && await ctx.db.get("opportunities", decision.opportunityId);
      const meetingId = decision.meetingId ?? refusalProposalOf(decision)?.meetingId;
      const meeting = meetingId && await ctx.db.get("meetings", meetingId);
      if (!deal || deal.tenantId !== tenantId || deal.outcome !== "open") {
        fail("A5", `${decision.state} refusal ${decision._id} is on deal ${decision.opportunityId ?? "none"}, which is not open`);
      } else {
        const counting = dealIds.has(deal._id) ? countingRows(deal._id).length : 0;
        const pending = dealIds.has(deal._id) ? pendingTasks(deal._id).length : 0;
        if (counting > 0 || pending > 0) {
          fail("A5", `${decision.state} refusal ${decision._id} on deal ${deal._id} with ${counting} counting payments and ${pending} pending tasks`);
        }
      }
      if (!meeting || meeting.tenantId !== tenantId || meeting.status !== "scheduled") {
        fail("A5", `${decision.state} refusal ${decision._id} names meeting ${meetingId ?? "none"}, which is not scheduled`);
      }
    }

    // A6: an automatic write names the certificate in force.
    if (decision.mode === "automatic" && decision.state === "applied") {
      const sample = decision.certificateSampleId && await ctx.db.get("automationSamples", decision.certificateSampleId);
      if (!sample || sample.tenantId !== tenantId || !wasCertified(sample) || sample.kind !== decision.kind ||
          sample.ruleVersion !== decision.ruleVersion) {
        fail("A6", `automatic write ${decision._id} names sample ${decision.certificateSampleId ?? "none"}, not a certificate of ${decision.kind} at ${decision.ruleVersion}`);
      }
    }

    // A9 is read from the payment rows below; A11's other parts follow.
    if (decision.auditOpenDueAt !== undefined && (decision.state !== "applied" || decision.mode !== "automatic")) {
      fail("A11", `decision ${decision._id} has an open audit but is ${decision.state} at ${decision.mode}`);
    }
    const sameKey = await ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_inputKey", (q) => q.eq("tenantId", tenantId).eq("inputKey", decision.inputKey))
      .take(2);
    if (sameKey.length > 1) fail("A11", `decision ${decision._id} shares its input key`);

    // A14: an automatic task write whose meeting is back to scheduled was undone.
    if ((decision.kind === "call_back" || decision.kind === "payment_owed") && decision.mode === "automatic" &&
        decision.callBefore) {
      const meeting = await ctx.db.get("meetings", decision.callBefore.meetingId);
      if (meeting?.status === "scheduled" && decision.state !== "undone") {
        fail("A14", `automatic ${decision.kind} write ${decision._id} is ${decision.state} while meeting ${meeting._id} is scheduled`);
      }
    }
  }

  // A11: one outstanding call decision per meeting and family.
  const outstanding = new Map<string, Id<"resultAutomationDecisions">[]>();
  for (const decision of decisions) {
    const family = callFamily(decision.kind);
    if (!family || !decision.meetingId || !OUTSTANDING_CALL_STATES.has(decision.state)) continue;
    const key = `${decision.meetingId}:${family}`;
    outstanding.set(key, [...outstanding.get(key) ?? [], decision._id]);
  }
  for (const [key, ids] of outstanding) {
    if (ids.length > 1) fail("A11", `meeting and family ${key} has ${ids.length} outstanding call decisions: ${ids.join(", ")}`);
  }

  // A7, A8: the tenant's certificates and samples.
  const samples = await bounded(ctx.db.query("automationSamples")
    .withIndex("by_tenantId_and_kind_and_status", (q) => q.eq("tenantId", tenantId))
    .take(SCOPE_LIMIT + 1), SCOPE_LIMIT, "samples");
  const membersOf = async (sample: Doc<"automationSamples">) => await bounded(ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_sampleId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("sampleId", sample._id))
    .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "members of one sample");
  const settings = tenant?.resultAutomation;
  for (const [kind, policy] of Object.entries(settings?.kinds ?? {})) {
    if (policy?.mode !== "automatic") continue;
    const sample = policy.automatic && await ctx.db.get("automationSamples", policy.automatic.sampleId);
    const members = sample ? (await membersOf(sample)).length : 0;
    if (!policy.automatic || !sample || sample.tenantId !== tenantId || sample.kind !== kind || !wasCertified(sample) ||
        sample.ruleVersion !== policy.automatic.ruleVersion || members !== sample.target) {
      fail("A7", `${kind} is automatic with sample ${policy.automatic?.sampleId ?? "none"}, not a full certificate at ${policy.automatic?.ruleVersion ?? "no rule version"}`);
    }
  }
  for (const sample of samples) {
    const members = await membersOf(sample);
    if (members.length > sample.target) fail("A8", `sample ${sample._id} has ${members.length} members, target ${sample.target}`);
    const people = new Set<string>();
    for (const member of members) {
      if (!member.leadId || people.has(member.leadId)) {
        fail("A8", `sample ${sample._id} member ${member._id} has person ${member.leadId ?? "none"}, already in it or missing`);
      }
      if (member.leadId) people.add(member.leadId);
      if (!member.wouldWrite || member.kind !== sample.kind || member.ruleVersion !== sample.ruleVersion ||
          (member.mode !== "shadow" && member.mode !== "ask")) {
        fail("A8", `sample ${sample._id} member ${member._id} is ${member.kind} at ${member.ruleVersion}, ${member.mode}, wouldWrite ${member.wouldWrite}`);
      }
    }
  }

  for (const deal of deals) {
    // A9: a row with no recorder is an automatic write's.
    for (const row of rowsByDeal.get(deal._id) ?? []) {
      if (row.recordedByUserId) continue;
      const decision = row.automationDecisionId && await ctx.db.get("resultAutomationDecisions", row.automationDecisionId);
      if (row.origin !== "provider" || !decision || decision.tenantId !== row.tenantId ||
          decision.state !== "applied" || decision.mode !== "automatic") {
        fail("A9", `row ${row._id} has no recorder and decision ${row.automationDecisionId ?? "none"} is not an applied automatic one`);
      }
    }

    // A10: a won deal's first payment closed its payment-owed tasks in that currency.
    if (deal.outcome !== "won") continue;
    const first = earliestCountingPayment(countingRows(deal._id));
    if (!first) continue;
    for (const task of pendingTasks(deal._id)) {
      if (task.purpose === "payment_owed" && task.expectedCurrency === first.currency) {
        fail("A10", `won deal ${deal._id} keeps pending payment-owed task ${task._id} in ${first.currency}`);
      }
    }
  }

  // A12: words. Decisions, samples, pinned lines, new events, new task fields, purged quotes.
  for (const decision of decisions) {
    for (const [path, text] of freeText(decision)) fail("A12", `decision ${decision._id}${path} holds "${text}"`);
  }
  for (const sample of samples) {
    for (const [path, text] of freeText(sample)) fail("A12", `sample ${sample._id}${path} holds "${text}"`);
  }
  for (const deal of deals) {
    for (const task of tasksByDeal.get(deal._id) ?? []) {
      const { purpose, expectedCurrency, declineCode, automationDecisionId } = task;
      for (const [path, text] of freeText({ purpose, expectedCurrency, declineCode, automationDecisionId })) {
        fail("A12", `task ${task._id}${path} holds "${text}"`);
      }
    }
  }
  const users = await bounded(ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(SCOPE_LIMIT + 1), SCOPE_LIMIT, "users");
  for (const user of users) {
    const lines = await bounded(ctx.db.query("closerPinnedLines")
      .withIndex("by_tenantId_and_userId_and_dismissedAt_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("userId", user._id))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "pinned lines for one user");
    for (const line of lines) {
      if (!dealIds.has(line.opportunityId)) continue;
      for (const [path, text] of freeText(line)) fail("A12", `pinned line ${line._id}${path} holds "${text}"`);
    }
  }
  for (const eventType of NEW_EVENT_TYPES) {
    const events = await bounded(ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) => q.eq("tenantId", tenantId).eq("eventType", eventType))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, `${eventType} events`);
    for (const event of events) {
      const fields = {
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reason: event.reason,
        metadata: event.metadata ? JSON.parse(event.metadata) as unknown : undefined,
      };
      for (const [path, text] of freeText(fields)) fail("A12", `event ${event._id}${path} holds "${text}"`);
    }
  }
  const runIds = new Set<Id<"callInsightRuns">>();
  for (const decision of decisions) {
    if (decision.runId) runIds.add(decision.runId);
    const evidence = callEvidenceOf(decision);
    if (evidence) runIds.add(evidence.runId);
  }
  for (const runId of runIds) {
    const run = await ctx.db.get("callInsightRuns", runId);
    if (run?.quotesPurgedAt !== undefined && run.evidence?.statements.some((statement) => statement.quote !== "")) {
      fail("A12", `run ${run._id} keeps statement quotes after its purge`);
    }
  }

  // A13: a held mapping takes no automatic write after it was held.
  const bindings = await bounded(ctx.db.query("paymentProviderBindings")
    .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) => q.eq("tenantId", tenantId))
    .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "bindings");
  for (const binding of bindings) {
    const heldAt = binding.automaticHeldAt;
    if (heldAt === undefined) continue;
    const later = await bounded(ctx.db.query("resultAutomationDecisions")
      .withIndex("by_tenantId_and_mode_and_state_and_resolvedAt", (q) =>
        q.eq("tenantId", tenantId).eq("mode", "automatic").eq("state", "applied").gt("resolvedAt", heldAt))
      .take(ROW_LIST_LIMIT + 1), ROW_LIST_LIMIT, "automatic writes after a held mapping");
    for (const decision of later) {
      if (paymentEvidenceOf(decision)?.bindingIds.includes(binding._id)) {
        fail("A13", `automatic write ${decision._id} used binding ${binding._id} after it was held at ${heldAt}`);
      }
    }
  }

  return violations;
}

/** Reads every row in scope inside t.run and throws one error listing each broken invariant with ids. */
export async function assertAutomationInvariants(
  t: TestConvex<typeof schema>,
  scope: AutomationInvariantScope,
  options: { skip?: AutomationInvariantId[] } = {},
): Promise<void> {
  const violations = await t.run(async (ctx) => await collect(ctx, scope));
  const skip = new Set<AutomationInvariantId>(options.skip ?? []);
  const broken = violations.filter((violation) => !skip.has(violation.id));
  if (broken.length > 0) {
    throw new Error(`Automation invariants broken:\n${broken.map(({ id, detail }) => `${id}: ${detail}`).join("\n")}`);
  }
}
