import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { providerEnvironmentValidator } from "../payments/schema";
import { CASE_MAX_AGE_MS, latestSample, noteSampleGrade, readSampleMembers } from "./certificates";
import { callEvidenceOf, isPaymentKind, paymentProposalOf, refusalProposalOf, taskProposalOf, type AutomationKind } from "./proposals";
import { automationGateValidator, automationKindValidator, refusalProposalValidator, taskProposalValidator, wrongFieldValidator } from "./schema";
import { currentRuleVersion } from "./settings";

type Decision = Doc<"resultAutomationDecisions">;
const decisionArgs = { decisionId: v.id("resultAutomationDecisions") };
const sampleValidator = v.union(v.literal("writes"), v.literal("abstentions"));
const settledVerdict = v.union(v.literal("correct"), v.literal("wrong"));
const verdictValidator = v.union(v.literal("correct"), v.literal("wrong"), v.literal("unsure"));
const answerValidator = v.object({
  abstain: v.boolean(),
  leadId: v.optional(v.id("leads")),
  opportunityId: v.optional(v.id("opportunities")),
  amountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  paymentType: v.optional(paymentTypeValidator),
  programId: v.optional(v.id("tenantPrograms")),
  attributedCloserId: v.optional(v.id("users")),
  taskPurpose: v.optional(v.union(v.literal("call_back"), v.literal("payment_owed"))),
  reminderAt: v.optional(v.number()),
  contactMethod: v.optional(v.union(v.literal("call"), v.literal("text"))),
  expectedAmountMinor: v.optional(v.number()),
  expectedCurrency: v.optional(v.string()),
  refusal: v.optional(v.boolean()),
  attendanceHeld: v.optional(v.boolean()),
});
type GradeAnswer = Infer<typeof answerValidator>;

const evidenceValidator = v.union(v.null(), v.object({
  amountMinor: v.optional(v.number()),
  currency: v.string(),
  paidAt: v.optional(v.number()),
  productTitle: v.optional(v.string()),
  variantTitle: v.optional(v.string()),
  payerEmail: v.optional(v.string()),
  billingReason: v.optional(v.string()),
  hasMembership: v.boolean(),
  environment: v.union(providerEnvironmentValidator, v.null()),
}));

const proposalValidator = v.object({
  amountMinor: v.number(), currency: v.string(), paymentType: paymentTypeValidator,
  programId: v.id("tenantPrograms"), attributedCloserId: v.id("users"),
  completesFollowUpId: v.optional(v.id("followUps")), expiresFollowUpIds: v.array(v.id("followUps")),
});

const revealedDecisionValidator = v.object({
  proposal: v.optional(proposalValidator),
  callProposal: v.optional(v.union(taskProposalValidator, refusalProposalValidator)),
  leadId: v.optional(v.id("leads")),
  opportunityId: v.optional(v.id("opportunities")),
  wouldWrite: v.boolean(),
  gates: v.array(automationGateValidator),
  kind: automationKindValidator,
});

const gradingScanLimit = 500;
const callReferenceValidator = v.object({
  meetingId: v.optional(v.id("meetings")), recordingId: v.id("callRecordings"), runId: v.id("callInsightRuns"),
});
function callReference(row: Decision) {
  const evidence = callEvidenceOf(row);
  return evidence ? { meetingId: row.meetingId, recordingId: evidence.recordingId, runId: evidence.runId } : undefined;
}
const pageSize = 50;

async function designatedGrader(ctx: QueryCtx | MutationCtx, tenantId: Id<"tenants">) {
  return (await ctx.db.get("tenants", tenantId))?.resultAutomation?.graderUserId;
}

/** Mutations refuse anyone but the named grader. Queries return nothing instead, so the panel still renders. */
async function assertDesignatedGrader(ctx: QueryCtx | MutationCtx, tenantId: Id<"tenants">, userId: Id<"users">) {
  const grader = await designatedGrader(ctx, tenantId);
  if (grader && grader !== userId) {
    throw expectedError("automation.not_designated_grader", "Only the designated grader can grade cases.");
  }
  return grader;
}

async function scopedDecisions(ctx: QueryCtx, tenantId: Id<"tenants">, kind: AutomationKind, includeSample = false) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) return { rows: [], capped: false };
  const version = tenant.resultAutomation?.kinds[kind]?.policyVersion ?? 0;
  const cutoff = Date.now() - CASE_MAX_AGE_MS;
  const sample = includeSample ? await latestSample(ctx, tenant, kind) : null;
  const members = sample && (sample.status === "collecting" || sample.status === "full") &&
    (sample.firstCaseAt === undefined || sample.firstCaseAt >= cutoff) ? await readSampleMembers(ctx, sample) : [];
  const memberIds = new Set(members.map((row) => row._id));
  const rows = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", kind).eq("ruleVersion", currentRuleVersion(tenant, kind))
        .gte("createdAt", cutoff)).take(gradingScanLimit + 1);
  return {
    rows: [...members, ...rows.filter((row) =>
      !memberIds.has(row._id) && row.policyVersion === version && row.mode !== "automatic")
      .slice(0, gradingScanLimit - members.length)],
    capped: rows.length > gradingScanLimit,
  };
}

async function personIds(ctx: QueryCtx, tenantId: Id<"tenants">, rows: Decision[]) {
  const people = new Map<Id<"leads">, Id<"leads"> | undefined>();
  for (const { leadId } of rows) {
    if (!leadId || people.has(leadId)) continue;
    const lead = await ctx.db.get("leads", leadId);
    people.set(leadId, lead?.tenantId === tenantId ? (await followMergeChain(ctx, lead))?._id : undefined);
  }
  return people;
}

async function getEvidence(ctx: QueryCtx, row: Decision) {
  if (!row.providerPaymentId) return null;
  const payment = await ctx.db.get("providerPayments", row.providerPaymentId);
  if (payment?.tenantId !== row.tenantId) return null;
  const connection = await ctx.db.get("tenantPaymentConnections", payment.connectionId);
  return {
    amountMinor: payment.totalMinor,
    currency: payment.currency,
    paidAt: payment.paidAt,
    productTitle: payment.productTitle,
    variantTitle: payment.variantTitle,
    payerEmail: payment.payerDetailsExpireAt === undefined || payment.payerDetailsExpireAt > Date.now()
      ? payment.payerEmail
      : undefined,
    billingReason: payment.billingReason,
    hasMembership: Boolean(payment.membershipId),
    environment: connection?.tenantId === row.tenantId ? connection.environment : null,
  };
}

export const listToGrade = query({
  args: { kind: automationKindValidator, sample: sampleValidator },
  returns: v.object({
    cases: v.array(v.object({
      decisionId: v.id("resultAutomationDecisions"),
      createdAt: v.number(),
      answerCommitted: v.boolean(),
      evidence: evidenceValidator,
      call: v.optional(callReferenceValidator),
    })),
    capped: v.boolean(),
    // True when someone else is the named grader: the queue is theirs alone.
    notGrader: v.optional(v.boolean()),
  }),
  handler: async (ctx, { kind, sample }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const grader = await designatedGrader(ctx, tenantId);
    if (grader && grader !== userId) return { cases: [], capped: false, notGrader: true };
    const { rows, capped } = await scopedDecisions(ctx, tenantId, kind, sample === "writes");
    const people = await personIds(ctx, tenantId, rows);
    const seen = new Set<Id<"leads">>();
    const cases = [];
    for (const row of rows) {
      const person = row.leadId && people.get(row.leadId);
      if (!person || (isPaymentKind(kind) ? !row.providerPaymentId : !callReference(row)) || row.wouldWrite !== (sample === "writes") || seen.has(person)) continue;
      seen.add(person);
      // The named grader takes over a case someone else answered and never graded.
      if (row.grade || (row.answer && row.answer.committedByUserId !== userId && grader !== userId)) continue;
      cases.push(row);
      if (cases.length > pageSize) break;
    }
    return {
      cases: await Promise.all(cases.slice(0, pageSize).map(async (row) => ({
        decisionId: row._id,
        createdAt: row.createdAt,
        answerCommitted: row.answer?.committedByUserId === userId,
        evidence: await getEvidence(ctx, row),
        call: callReference(row),
      }))),
      capped: capped || cases.length > pageSize,
    };
  },
});

type GradeDecision = Decision & { kind: AutomationKind };

async function gradeCase(
  ctx: QueryCtx, tenantId: Id<"tenants">, decisionId: Id<"resultAutomationDecisions">,
): Promise<GradeDecision> {
  const [row, tenant] = await Promise.all([ctx.db.get("resultAutomationDecisions", decisionId), ctx.db.get("tenants", tenantId)]);
  if (row?.tenantId !== tenantId || !tenant || row.kind === "paid_on_call_alert" || row.mode === "automatic" ||
      row.ruleVersion !== currentRuleVersion(tenant, row.kind)) {
    throw expectedError("automation.decision_not_found", "Decision not found.");
  }
  return { ...row, kind: row.kind };
}

function submittedAnswer(answer: NonNullable<Decision["answer"]>): GradeAnswer {
  const { committedByUserId, committedAt, ...fields } = answer;
  void committedByUserId;
  void committedAt;
  return fields;
}

function canGradeBlind(row: Decision, userId: Id<"users">) {
  return row.resolvedByUserId !== userId && !row.revealedToUserIds?.includes(userId);
}

export const getMyAnswer = query({
  args: decisionArgs,
  returns: v.union(v.null(), v.object({ answer: answerValidator, blind: v.boolean() })),
  handler: async (ctx, { decisionId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const grader = await designatedGrader(ctx, tenantId);
    if (grader && grader !== userId) return null;
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.answer?.committedByUserId !== userId) return null;
    const blind = row.grade
      ? row.grade.gradedBeforeSeeing && row.resolvedByUserId !== userId
      : canGradeBlind(row, userId);
    return { answer: submittedAnswer(row.answer), blind };
  },
});

function revealedDecision(row: Decision, kind: AutomationKind) {
  const { leadId, opportunityId, wouldWrite, gates } = row;
  return {
    proposal: paymentProposalOf(row), callProposal: taskProposalOf(row) ?? refusalProposalOf(row),
    leadId, opportunityId, wouldWrite, gates, kind,
  };
}

async function verifyAnswer(ctx: MutationCtx, tenantId: Id<"tenants">, answer: GradeAnswer) {
  const rows = await Promise.all([
    answer.leadId && ctx.db.get("leads", answer.leadId),
    answer.opportunityId && ctx.db.get("opportunities", answer.opportunityId),
    answer.programId && ctx.db.get("tenantPrograms", answer.programId),
    answer.attributedCloserId && ctx.db.get("users", answer.attributedCloserId),
  ]);
  const ids = [answer.leadId, answer.opportunityId, answer.programId, answer.attributedCloserId];
  if (rows.some((row, i) => ids[i] !== undefined && row?.tenantId !== tenantId) ||
      (answer.amountMinor !== undefined && (!Number.isSafeInteger(answer.amountMinor) || answer.amountMinor < 0)) ||
      (answer.expectedAmountMinor !== undefined && (!Number.isSafeInteger(answer.expectedAmountMinor) || answer.expectedAmountMinor <= 0)) ||
      (answer.reminderAt !== undefined && !Number.isFinite(answer.reminderAt)) ||
      [answer.currency, answer.expectedCurrency].some((currency) => currency !== undefined && !/^[A-Z]{3}$/.test(currency))) {
    throw expectedError("automation.invalid_answer", "Enter a valid answer using records from this organization.");
  }
}

export const commitAnswer = mutation({
  args: { ...decisionArgs, answer: answerValidator },
  returns: v.null(),
  handler: async (ctx, { decisionId, answer }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const grader = await assertDesignatedGrader(ctx, tenantId, userId);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.answer?.committedByUserId === userId) return null;
    // The named grader replaces an answer another person left ungraded.
    if (row.grade || (row.answer && grader !== userId)) {
      throw expectedError("automation.answer_committed", "An answer is already committed.");
    }
    await verifyAnswer(ctx, tenantId, answer);
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      answer: { ...answer, committedByUserId: userId, committedAt: Date.now() },
    });
    return null;
  },
});

export const reveal = mutation({
  args: decisionArgs,
  returns: revealedDecisionValidator,
  handler: async (ctx, { decisionId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    await assertDesignatedGrader(ctx, tenantId, userId);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.answer?.committedByUserId !== userId) {
      const exposed = row.revealedToUserIds ?? [];
      if (!exposed.includes(userId)) {
        if (exposed.length >= 10) throw expectedError("automation.exposure_limit", "This case has reached its exposure limit.");
        await ctx.db.patch("resultAutomationDecisions", decisionId, { revealedToUserIds: [...exposed, userId] });
      }
    }
    return revealedDecision(row, row.kind);
  },
});

export const recordGrade = mutation({
  args: { ...decisionArgs, verdict: verdictValidator, wrongFields: v.array(wrongFieldValidator) },
  returns: v.null(),
  handler: async (ctx, { decisionId, verdict, wrongFields }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    await assertDesignatedGrader(ctx, tenantId, userId);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.grade?.gradedByUserId === userId) return null;
    if (row.grade || row.answer?.committedByUserId !== userId) {
      throw expectedError("automation.answer_required", "Commit your answer before grading.");
    }
    if (wrongFields.length > wrongFieldValidator.members.length || (verdict === "correct" && wrongFields.length > 0)) {
      throw expectedError("automation.invalid_grade", "Check the verdict and the fields marked wrong.");
    }
    const grade = {
      verdict, wrongFields: [...new Set(wrongFields)], gradedByUserId: userId, gradedAt: Date.now(),
      gradedBeforeSeeing: canGradeBlind(row, userId),
    };
    await ctx.db.patch("resultAutomationDecisions", decisionId, { grade });
    await noteSampleGrade(ctx, { ...row, grade });
    return null;
  },
});

export const listUnsure = query({
  args: { kind: automationKindValidator },
  returns: v.array(v.object({
    decisionId: v.id("resultAutomationDecisions"),
    createdAt: v.number(),
    gradedAt: v.number(),
    gradedByName: v.union(v.string(), v.null()),
    wrongFields: v.array(wrongFieldValidator),
    evidence: evidenceValidator,
    call: v.optional(callReferenceValidator),
    proposal: revealedDecisionValidator,
    answer: v.union(answerValidator, v.null()),
  })),
  handler: async (ctx, { kind }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:resolve-unsure"]]);
    const { rows } = await scopedDecisions(ctx, tenantId, kind, true);
    const unsure = rows.flatMap((row) =>
      row.grade?.verdict === "unsure" && !row.grade.secondLook ? [{ row, grade: row.grade }] : [],
    );
    return await Promise.all(unsure.slice(0, pageSize).map(async ({ row, grade }) => {
      const [evidence, grader] = await Promise.all([
        getEvidence(ctx, row),
        ctx.db.get("users", grade.gradedByUserId),
      ]);
      return {
        decisionId: row._id,
        createdAt: row.createdAt,
        gradedAt: grade.gradedAt,
        gradedByName: grader?.tenantId === tenantId ? grader.fullName?.trim() || grader.email : null,
        wrongFields: grade.wrongFields,
        evidence,
        call: callReference(row),
        proposal: revealedDecision(row, kind),
        answer: row.answer ? submittedAnswer(row.answer) : null,
      };
    }));
  },
});

export const resolveUnsure = mutation({
  args: { ...decisionArgs, verdict: settledVerdict },
  returns: v.null(),
  handler: async (ctx, { decisionId, verdict }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:resolve-unsure"]]);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.grade?.verdict !== "unsure") throw expectedError("automation.grade_not_unsure", "This case has no unsure grade.");
    if (row.grade.secondLook) {
      if (row.grade.secondLook.verdict === verdict) return null;
      throw expectedError("automation.grade_resolved", "This grade is already resolved.");
    }
    const grade = { ...row.grade, secondLook: { verdict, byUserId: userId, at: Date.now() } };
    await ctx.db.patch("resultAutomationDecisions", decisionId, { grade });
    await noteSampleGrade(ctx, { ...row, grade });
    return null;
  },
});

const tallyValidator = v.object({
  cleanBlind: v.number(), wrong: v.number(), unsure: v.number(), blind: v.number(), exposed: v.number(),
});
type PersonGrade = { clean: boolean; wrong: boolean; unsure: boolean; blind: number; exposed: number };

function tally(people: Map<Id<"leads">, PersonGrade>) {
  const result = { cleanBlind: 0, wrong: 0, unsure: 0, blind: 0, exposed: 0 };
  for (const grade of people.values()) {
    if (grade.clean && !grade.wrong && !grade.unsure) result.cleanBlind += 1;
    if (grade.wrong) result.wrong += 1;
    if (grade.unsure) result.unsure += 1;
    result.blind += grade.blind;
    result.exposed += grade.exposed;
  }
  return result;
}

export const getGradeTally = query({
  args: { kind: automationKindValidator },
  returns: v.object({ writes: tallyValidator, abstentions: tallyValidator, capped: v.boolean() }),
  handler: async (ctx, { kind }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const { rows, capped } = await scopedDecisions(ctx, tenantId, kind);
    const people = await personIds(ctx, tenantId, rows);
    const samples = { writes: new Map<Id<"leads">, PersonGrade>(), abstentions: new Map<Id<"leads">, PersonGrade>() };
    for (const row of rows) {
      const person = row.leadId && people.get(row.leadId);
      if (!row.grade || !person) continue;
      const sample = row.wouldWrite ? samples.writes : samples.abstentions;
      const current = sample.get(person) ?? { clean: false, wrong: false, unsure: false, blind: 0, exposed: 0 };
      const verdict = row.grade.secondLook?.verdict ?? row.grade.verdict;
      const blind = row.grade.gradedBeforeSeeing && row.grade.gradedByUserId !== row.resolvedByUserId;
      if (blind) current.blind += 1;
      else current.exposed += 1;
      if (verdict === "wrong") current.wrong = true;
      if (verdict === "unsure") current.unsure = true;
      if (verdict === "correct" && blind) current.clean = true;
      sample.set(person, current);
    }
    return { writes: tally(samples.writes), abstentions: tally(samples.abstentions), capped };
  },
});
