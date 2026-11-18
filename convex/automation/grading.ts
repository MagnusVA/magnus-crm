import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import { paymentTypeValidator } from "../lib/paymentTypes";
import { PAYMENT_RULE_VERSION } from "./derive";
import { paymentDecisionKindValidator } from "./settings";

type Decision = Doc<"resultAutomationDecisions">;
const decisionArgs = { decisionId: v.id("resultAutomationDecisions") };
const sampleValidator = v.union(v.literal("writes"), v.literal("abstentions"));
const settledVerdict = v.union(v.literal("correct"), v.literal("wrong"));
const verdictValidator = v.union(v.literal("correct"), v.literal("wrong"), v.literal("unsure"));
const wrongFieldValidator = v.union(
  v.literal("person"), v.literal("deal"), v.literal("amount"), v.literal("currency"), v.literal("type"),
  v.literal("program"), v.literal("credit"), v.literal("should_abstain"), v.literal("should_write"),
);
const answerValidator = v.object({
  abstain: v.boolean(),
  leadId: v.optional(v.id("leads")),
  opportunityId: v.optional(v.id("opportunities")),
  amountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  paymentType: v.optional(paymentTypeValidator),
  programId: v.optional(v.id("tenantPrograms")),
  attributedCloserId: v.optional(v.id("users")),
});
type GradeAnswer = Infer<typeof answerValidator>;

const gradingScanLimit = 500;
const maxCaseAgeMs = 365 * 86_400_000;
const pageSize = 50;

async function scopedDecisions(ctx: QueryCtx, tenantId: Id<"tenants">, kind: Infer<typeof paymentDecisionKindValidator>) {
  const tenant = await ctx.db.get("tenants", tenantId);
  const version = tenant?.resultAutomation?.kinds[kind].policyVersion ?? 0;
  const rows = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("kind", kind).eq("ruleVersion", PAYMENT_RULE_VERSION)
        .gte("createdAt", Date.now() - maxCaseAgeMs)).take(gradingScanLimit + 1);
  return {
    rows: rows.slice(0, gradingScanLimit).flatMap((row) => row.policyVersion === version ? [row] : []),
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

export const listToGrade = query({
  args: { kind: paymentDecisionKindValidator, sample: sampleValidator },
  returns: v.object({
    cases: v.array(v.object({
      decisionId: v.id("resultAutomationDecisions"),
      providerPaymentId: v.id("providerPayments"),
      createdAt: v.number(),
      answerCommitted: v.boolean(),
    })),
    capped: v.boolean(),
  }),
  handler: async (ctx, { kind, sample }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const { rows, capped } = await scopedDecisions(ctx, tenantId, kind);
    const people = await personIds(ctx, tenantId, rows);
    const seen = new Set<Id<"leads">>();
    const cases = [];
    for (const row of rows) {
      const person = row.leadId && people.get(row.leadId);
      if (!person || !row.providerPaymentId || row.wouldWrite !== (sample === "writes") || seen.has(person)) continue;
      seen.add(person);
      if (row.grade || (row.answer && row.answer.committedByUserId !== userId)) continue;
      cases.push({
        decisionId: row._id, providerPaymentId: row.providerPaymentId, createdAt: row.createdAt,
        answerCommitted: row.answer?.committedByUserId === userId,
      });
    }
    return { cases: cases.slice(0, pageSize), capped: capped || cases.length > pageSize };
  },
});

async function gradeCase(ctx: MutationCtx, tenantId: Id<"tenants">, decisionId: Id<"resultAutomationDecisions">) {
  const row = await ctx.db.get("resultAutomationDecisions", decisionId);
  if (row?.tenantId !== tenantId || row.ruleVersion !== PAYMENT_RULE_VERSION ||
      (row.kind !== "payment_win" && row.kind !== "additional_payment")) {
    throw expectedError("automation.decision_not_found", "Decision not found.");
  }
  return row;
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
      (answer.currency !== undefined && !/^[A-Z]{3}$/.test(answer.currency))) {
    throw expectedError("automation.invalid_answer", "Enter a valid answer using records from this organization.");
  }
}

export const commitAnswer = mutation({
  args: { ...decisionArgs, answer: answerValidator },
  returns: v.null(),
  handler: async (ctx, { decisionId, answer }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.answer?.committedByUserId === userId) return null;
    if (row.grade || row.answer) throw expectedError("automation.answer_committed", "An answer is already committed.");
    await verifyAnswer(ctx, tenantId, answer);
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      answer: { ...answer, committedByUserId: userId, committedAt: Date.now() },
    });
    return null;
  },
});

const proposalValidator = v.object({
  amountMinor: v.number(), currency: v.string(), paymentType: paymentTypeValidator,
  programId: v.id("tenantPrograms"), attributedCloserId: v.id("users"),
  completesFollowUpId: v.optional(v.id("followUps")), expiresFollowUpIds: v.array(v.id("followUps")),
});

export const reveal = mutation({
  args: decisionArgs,
  returns: v.union(v.null(), proposalValidator),
  handler: async (ctx, { decisionId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.answer?.committedByUserId === userId) return row.proposal ?? null;
    const exposed = row.revealedToUserIds ?? [];
    if (!exposed.includes(userId)) {
      if (exposed.length >= 10) throw expectedError("automation.exposure_limit", "This case has reached its exposure limit.");
      await ctx.db.patch("resultAutomationDecisions", decisionId, { revealedToUserIds: [...exposed, userId] });
    }
    return null;
  },
});

export const recordGrade = mutation({
  args: { ...decisionArgs, verdict: verdictValidator, wrongFields: v.array(wrongFieldValidator) },
  returns: v.null(),
  handler: async (ctx, { decisionId, verdict, wrongFields }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:grade"]]);
    const row = await gradeCase(ctx, tenantId, decisionId);
    if (row.grade?.gradedByUserId === userId) return null;
    if (row.grade || row.answer?.committedByUserId !== userId) {
      throw expectedError("automation.answer_required", "Commit your answer before grading.");
    }
    if (wrongFields.length > wrongFieldValidator.members.length || (verdict === "correct" && wrongFields.length > 0)) {
      throw expectedError("automation.invalid_grade", "Check the verdict and the fields marked wrong.");
    }
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      grade: {
        verdict, wrongFields: [...new Set(wrongFields)], gradedByUserId: userId, gradedAt: Date.now(),
        gradedBeforeSeeing: row.resolvedByUserId !== userId && !row.revealedToUserIds?.includes(userId),
      },
    });
    return null;
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
    await ctx.db.patch("resultAutomationDecisions", decisionId, {
      grade: { ...row.grade, secondLook: { verdict, byUserId: userId, at: Date.now() } },
    });
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
  args: { kind: paymentDecisionKindValidator },
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
