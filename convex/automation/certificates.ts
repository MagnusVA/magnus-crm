import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { followMergeChain } from "../leads/identityResolution";
import { emitDomainEvent } from "../lib/domainEvents";
import { expectedError } from "../lib/observability/errors";
import { PERMISSIONS } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";
import { automationCommandRefusalValidator, refuseAutomation } from "../payments/commandResult";
import { assertAutomaticAllowed, breakerCauseOpen, type AutomaticAllowance } from "./breaker";
import { automationKindOf, isPaymentKind, paymentEvidenceOf, type AutomationKind } from "./proposals";
import { automationKindValidator } from "./schema";
import { currentRuleVersion, setKindModeCore } from "./settings";

type Sample = Doc<"automationSamples">;
type Decision = Doc<"resultAutomationDecisions">;
type Tenant = Doc<"tenants">;
type ReadCtx = QueryCtx | MutationCtx;
type BindingId = Id<"paymentProviderBindings">;
type LeadId = Id<"leads">;

export const CERTIFICATE_TARGET = {
  payment_win: 300, additional_payment: 300, call_back: 60, payment_owed: 60, refusal_loss: 300,
} as const;
export const CASE_MAX_AGE_MS = 365 * 86_400_000;
const SCOPE_LIMIT = 100;
const BACKFILL_SCAN_LIMIT = 350;
const RECENT_DAYS = 90;

const sampleStatus = v.union(
  v.literal("collecting"), v.literal("full"), v.literal("certified"), v.literal("failed"), v.literal("lapsed"),
);
const certificateFailure = v.union(
  v.literal("no_sample"), v.literal("not_full"), v.literal("ungraded"), v.literal("wrong"),
  v.literal("unsure"), v.literal("aged_out"), v.literal("rule_changed"),
);
const standingValidator = v.object({
  members: v.number(), target: v.number(), correct: v.number(), wrong: v.number(), unsureOpen: v.number(),
  ungraded: v.number(), exposed: v.number(), distinctPeople: v.number(), oldestCaseAt: v.optional(v.number()),
  policyVersion: v.optional(v.number()), status: sampleStatus,
});
export type SampleStanding = typeof standingValidator.type;
const progressValidator = v.object({
  ...standingValidator.fields, sampleId: v.id("automationSamples"), kind: automationKindValidator,
  ruleVersion: v.string(), scopeBindingIds: v.array(v.id("paymentProviderBindings")),
});
type CertificateCheck =
  | { ok: true; sample: Sample; oldestCaseAt: number }
  | { ok: false; code: typeof certificateFailure.type };

export function latestSample(ctx: ReadCtx, tenant: Tenant, kind: AutomationKind): Promise<Sample | null> {
  return ctx.db.query("automationSamples")
    .withIndex("by_tenantId_and_kind_and_ruleVersion", (q) =>
      q.eq("tenantId", tenant._id).eq("kind", kind).eq("ruleVersion", currentRuleVersion(tenant, kind)))
    .order("desc").first();
}

export function priorSampleForKind(
  ctx: ReadCtx, tenantId: Id<"tenants">, kind: AutomationKind,
): Promise<Sample | null> {
  return ctx.db.query("automationSamples").withIndex("by_tenantId_and_kind_and_ruleVersion", (q) =>
    q.eq("tenantId", tenantId).eq("kind", kind)).first();
}

function sampleRows(ctx: ReadCtx, sample: Sample) {
  return ctx.db.query("resultAutomationDecisions").withIndex("by_tenantId_and_sampleId_and_leadId", (q) =>
    q.eq("tenantId", sample.tenantId).eq("sampleId", sample._id));
}

export function readSampleMembers(ctx: ReadCtx, sample: Sample): Promise<Decision[]> {
  return sampleRows(ctx, sample).take(CERTIFICATE_TARGET[sample.kind] + 1);
}

function matchesSample(row: Decision, sample: Sample) {
  return row.tenantId === sample.tenantId && row.kind === sample.kind && row.ruleVersion === sample.ruleVersion &&
    row.wouldWrite && !!row.leadId && (row.mode === "shadow" || row.mode === "ask");
}

function verdictOf(row: Decision) {
  return row.grade?.secondLook?.verdict ?? row.grade?.verdict;
}

function standingOf(sample: Sample, rows: Decision[], people?: Set<LeadId>): SampleStanding {
  const result: SampleStanding = {
    members: rows.length, target: sample.target, correct: 0, wrong: 0, unsureOpen: 0, ungraded: 0,
    exposed: 0, distinctPeople: people?.size ?? new Set(rows.flatMap((row) => row.leadId ? [row.leadId] : [])).size,
    oldestCaseAt: sample.firstCaseAt, policyVersion: rows[0]?.policyVersion, status: sample.status,
  };
  for (const row of rows) {
    result.oldestCaseAt = Math.min(result.oldestCaseAt ?? row.createdAt, row.createdAt);
    if (!row.grade) result.ungraded++;
    else {
      if (!row.grade.gradedBeforeSeeing || row.grade.gradedByUserId === row.resolvedByUserId) result.exposed++;
      switch (verdictOf(row)) {
        case "correct": result.correct++; break;
        case "wrong": result.wrong++; break;
        case "unsure": result.unsureOpen++; break;
      }
    }
  }
  return result;
}

function resolvePeople(ctx: ReadCtx, tenantId: Id<"tenants">) {
  const cache = new Map<LeadId, Promise<LeadId | undefined>>();
  return (id: LeadId) => {
    const existing = cache.get(id);
    if (existing) return existing;
    const lookup = (async () => {
      const lead = await ctx.db.get("leads", id);
      return lead?.tenantId === tenantId ? (await followMergeChain(ctx, lead))?._id : undefined;
    })();
    cache.set(id, lookup);
    return lookup;
  };
}

async function distinctPeople(ctx: ReadCtx, sample: Sample, rows: Decision[]) {
  const resolve = resolvePeople(ctx, sample.tenantId);
  const people = await Promise.all(rows.map((row) => row.leadId && resolve(row.leadId)));
  return new Set(people.flatMap((person) => person ? [person] : []));
}

export async function sampleStanding(ctx: ReadCtx, sampleId: Id<"automationSamples">): Promise<SampleStanding> {
  const sample = await ctx.db.get("automationSamples", sampleId);
  if (!sample) throw new Error("Missing automation sample");
  const rows = await sampleRows(ctx, sample).take(CERTIFICATE_TARGET[sample.kind] + 1);
  return standingOf(sample, rows, await distinctPeople(ctx, sample, rows));
}

function agedOut(sample: Sample, now: number) {
  return sample.firstCaseAt !== undefined && sample.firstCaseAt < now - CASE_MAX_AGE_MS;
}

async function markLapsed(ctx: MutationCtx, sample: Sample, now: number, reason?: "aged_out" | "rule_changed") {
  await ctx.db.patch("automationSamples", sample._id, { status: "lapsed", lapsedAt: now, lapseReason: reason });
}

async function collectingSample(ctx: ReadCtx, tenantId: Id<"tenants">, kind: AutomationKind) {
  return await ctx.db.query("automationSamples")
    .withIndex("by_tenantId_and_kind_and_status", (q) =>
      q.eq("tenantId", tenantId).eq("kind", kind).eq("status", "collecting"))
    .order("desc").first();
}

/** A mode change closes an unfinished cohort. Full cohorts keep their original policy through grading. */
export async function closeCollectingSample(
  ctx: MutationCtx, tenantId: Id<"tenants">, kind: AutomationKind, now: number,
): Promise<void> {
  const sample = await collectingSample(ctx, tenantId, kind);
  if (sample) await markLapsed(ctx, sample, now);
}

async function openCollecting(
  ctx: MutationCtx, tenant: Tenant, kind: AutomationKind, now: number, startAfterCertificate: boolean,
): Promise<Sample | null> {
  const version = currentRuleVersion(tenant, kind);
  const latest = await latestSample(ctx, tenant, kind);
  if (latest?.status === "failed" || (latest?.status === "certified" && !startAfterCertificate)) return null;
  if (latest?.status === "full" && !agedOut(latest, now)) return latest;
  const collecting = await collectingSample(ctx, tenant._id, kind);
  if (collecting) {
    if (collecting.ruleVersion !== version) await markLapsed(ctx, collecting, now, "rule_changed");
    else if (agedOut(collecting, now)) await markLapsed(ctx, collecting, now, "aged_out");
    else return collecting;
  }
  if (latest?.status === "full") await markLapsed(ctx, latest, now, "aged_out");
  const sampleId = await ctx.db.insert("automationSamples", {
    tenantId: tenant._id, kind, ruleVersion: version, target: CERTIFICATE_TARGET[kind],
    status: "collecting", createdAt: now,
  });
  return await ctx.db.get("automationSamples", sampleId);
}

async function appendCases(ctx: MutationCtx, sample: Sample, candidates: Decision[], now: number, members?: Decision[]) {
  if (sample.status !== "collecting") return false;
  members ??= await readSampleMembers(ctx, sample);
  const resolve = resolvePeople(ctx, sample.tenantId);
  const resolved = await Promise.all(members.map((row) => row.leadId && resolve(row.leadId)));
  const people = new Set(resolved);
  const policyVersion = members[0]?.policyVersion;
  const scope = new Set(sample.scopeBindingIds);
  const bindings = new Map<BindingId, Doc<"paymentProviderBindings"> | null>();
  let firstCaseAt = sample.firstCaseAt;
  let count = members.length;
  let attached = false;
  for (const row of candidates) {
    if (count >= sample.target) break;
    if (!matchesSample(row, sample) || row.sampleId || row.grade || row.answer || row.createdAt < now - CASE_MAX_AGE_MS ||
        (policyVersion !== undefined && row.policyVersion !== policyVersion)) continue;
    const person = row.leadId && await resolve(row.leadId);
    if (!person || people.has(person)) continue;
    const evidenceIds = isPaymentKind(row.kind) ? paymentEvidenceOf(row)?.bindingIds ?? [] : [];
    if (evidenceIds.length > 4) continue;
    const mappings: BindingId[] = [];
    let outsideFrozenScope = false;
    for (const id of evidenceIds) {
      if (!bindings.has(id)) bindings.set(id, await ctx.db.get("paymentProviderBindings", id));
      const binding = bindings.get(id);
      if (binding?.tenantId !== sample.tenantId ||
          (binding.kind !== "product_program" && binding.kind !== "variant_type")) continue;
      // Mapping edits create new binding rows. Only versions that existed
      // when this cohort opened can enter its eventual certified scope.
      if (binding._creationTime > sample._creationTime ||
          (binding.automaticHeldAt !== undefined && row.createdAt <= binding.automaticHeldAt)) {
        outsideFrozenScope = true;
        break;
      }
      if (!scope.has(id)) mappings.push(id);
    }
    if (outsideFrozenScope || scope.size + mappings.length > SCOPE_LIMIT) continue;
    people.add(person);
    mappings.forEach((id) => scope.add(id));
    await ctx.db.patch("resultAutomationDecisions", row._id, { sampleId: sample._id });
    firstCaseAt = Math.min(firstCaseAt ?? row.createdAt, row.createdAt);
    count++;
    attached = true;
  }
  if (attached) await ctx.db.patch("automationSamples", sample._id, {
    firstCaseAt,
    scopeBindingIds: isPaymentKind(sample.kind) ? [...scope] : undefined,
    ...(count === sample.target ? { status: "full", fullAt: now } : {}),
  });
  return attached;
}

/** Enroll a new eligible decision in its own inserting mutation, before a grader can see it. */
export async function enrollInSample(ctx: MutationCtx, decision: Decision): Promise<Id<"automationSamples"> | null> {
  const kind = automationKindOf(decision.kind);
  if (!kind || !decision.wouldWrite || !decision.leadId || decision.mode === "automatic" || decision.grade) return null;
  if (decision.sampleId) return decision.sampleId;
  const tenant = await ctx.db.get("tenants", decision.tenantId);
  const now = Date.now();
  if (!tenant || tenant.resultAutomation?.kinds[kind]?.policyVersion !== decision.policyVersion ||
      currentRuleVersion(tenant, kind) !== decision.ruleVersion || decision.createdAt < now - CASE_MAX_AGE_MS) return null;
  const sample = await openCollecting(ctx, tenant, kind, now, false);
  return sample && await appendCases(ctx, sample, [decision], now) ? sample._id : null;
}

/** A wrong verdict permanently closes this cohort, including a wrong second look. */
export async function noteSampleGrade(ctx: MutationCtx, decision: Decision): Promise<void> {
  if (!decision.sampleId || verdictOf(decision) !== "wrong") return;
  const sample = await ctx.db.get("automationSamples", decision.sampleId);
  if (sample && matchesSample(decision, sample) && (sample.status === "collecting" || sample.status === "full")) {
    await ctx.db.patch("automationSamples", sample._id, {
      status: "failed", failedAt: Date.now(), failedDecisionId: decision._id,
    });
  }
}

const fillPageArgs = {
  sampleId: v.id("automationSamples"), policyVersion: v.number(),
  cursor: v.union(v.null(), v.string()), openedAt: v.number(),
};
type FillPageArgs = ObjectType<typeof fillPageArgs>;
const fillPageRef = makeFunctionReference<"mutation", FillPageArgs>("automation/certificates:fillSamplePage");

async function fillCasePage(ctx: MutationCtx, sample: Sample, args: FillPageArgs, now: number) {
  const members = await readSampleMembers(ctx, sample);
  const pageSize = BACKFILL_SCAN_LIMIT - members.length;
  const page = await ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
      q.eq("tenantId", sample.tenantId).eq("kind", sample.kind).eq("ruleVersion", sample.ruleVersion)
        .gte("createdAt", args.openedAt - CASE_MAX_AGE_MS).lte("createdAt", args.openedAt))
    .order("desc").paginate({
      cursor: args.cursor, numItems: pageSize, maximumRowsRead: pageSize, maximumBytesRead: 512 * 1024,
    });
  await appendCases(ctx, sample, page.page.filter((row) => row.policyVersion === args.policyVersion), now, members);
  if (!page.isDone && (await ctx.db.get("automationSamples", sample._id))?.status === "collecting") {
    await ctx.scheduler.runAfter(0, fillPageRef, { ...args, cursor: page.continueCursor });
  }
}

export const fillSamplePage = internalMutation({
  args: fillPageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const sample = await ctx.db.get("automationSamples", args.sampleId);
    if (sample?.status !== "collecting") return null;
    const tenant = await ctx.db.get("tenants", sample.tenantId);
    if (!tenant || tenant.resultAutomation?.kinds[sample.kind]?.policyVersion !== args.policyVersion ||
        currentRuleVersion(tenant, sample.kind) !== sample.ruleVersion || agedOut(sample, Date.now())) return null;
    await fillCasePage(ctx, sample, args, Date.now());
    return null;
  },
});

export const openSample = mutation({
  args: { kind: automationKindValidator },
  returns: v.union(v.id("automationSamples"), v.null()),
  handler: async (ctx, { kind }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:raise"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    const policy = tenant?.resultAutomation?.kinds[kind];
    if (!tenant || !policy || policy.mode === "off") return null;
    const now = Date.now();
    const sample = await openCollecting(ctx, tenant, kind, now, true);
    if (!sample || sample.status !== "collecting") return sample?._id ?? null;
    await fillCasePage(ctx, sample, { sampleId: sample._id, policyVersion: policy.policyVersion, cursor: null, openedAt: now }, now);
    return sample._id;
  },
});

function progress(sample: Sample, standing: SampleStanding, tenant: Tenant, now: number): typeof progressValidator.type {
  const promoted = tenant.resultAutomation?.kinds[sample.kind]?.automatic;
  const hasCurrentPromotion = promoted?.sampleId === sample._id && !agedOut(sample, promoted.promotedAt);
  const lapsed = sample.ruleVersion !== currentRuleVersion(tenant, sample.kind) ||
    (agedOut(sample, now) && !hasCurrentPromotion);
  return {
    ...standing, sampleId: sample._id, kind: sample.kind, ruleVersion: sample.ruleVersion,
    scopeBindingIds: sample.scopeBindingIds ?? [], status: lapsed ? "lapsed" : standing.status,
  };
}

export const getSampleProgress = query({
  args: { sampleId: v.id("automationSamples") },
  returns: v.union(progressValidator, v.null()),
  handler: async (ctx, { sampleId }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    const [tenant, sample] = await Promise.all([ctx.db.get("tenants", tenantId), ctx.db.get("automationSamples", sampleId)]);
    if (!tenant || sample?.tenantId !== tenantId) return null;
    return progress(sample, await sampleStanding(ctx, sampleId), tenant, Date.now());
  },
});

/** Recompute eligibility before certification or promotion. Age is measured at promotion. */
export async function certificateCurrent(
  ctx: ReadCtx, tenant: Tenant, kind: AutomationKind, sampleId: Id<"automationSamples">, now: number,
): Promise<CertificateCheck> {
  const sample = await ctx.db.get("automationSamples", sampleId);
  if (sample?.tenantId !== tenant._id || sample.kind !== kind) return { ok: false, code: "no_sample" };
  if (sample.ruleVersion !== currentRuleVersion(tenant, kind)) return { ok: false, code: "rule_changed" };
  if (agedOut(sample, now)) return { ok: false, code: "aged_out" };
  if (sample.status === "failed") return { ok: false, code: "wrong" };
  if (sample.status !== "full" && sample.status !== "certified") return { ok: false, code: "not_full" };
  const target = CERTIFICATE_TARGET[kind];
  const rows = await sampleRows(ctx, sample).take(target + 1);
  if (sample.target !== target || rows.length !== target ||
      rows.some((row) => !matchesSample(row, sample) || row.policyVersion !== rows[0].policyVersion)) {
    return { ok: false, code: "not_full" };
  }
  if (rows.some((row) => row.createdAt < now - CASE_MAX_AGE_MS || row.createdAt > now)) {
    return { ok: false, code: "aged_out" };
  }
  if (rows.some((row) => verdictOf(row) === "wrong")) return { ok: false, code: "wrong" };
  if (rows.some((row) => verdictOf(row) === "unsure")) return { ok: false, code: "unsure" };
  if (rows.some((row) => verdictOf(row) !== "correct")) return { ok: false, code: "ungraded" };
  if ((await distinctPeople(ctx, sample, rows)).size !== target) return { ok: false, code: "not_full" };
  return { ok: true, sample, oldestCaseAt: rows.reduce((oldest, row) => Math.min(oldest, row.createdAt), now) };
}

export const certify = mutation({
  args: { sampleId: v.id("automationSamples") },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), code: certificateFailure })),
  handler: async (ctx, { sampleId }) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:raise"]]);
    const [tenant, sample] = await Promise.all([ctx.db.get("tenants", tenantId), ctx.db.get("automationSamples", sampleId)]);
    if (!tenant || sample?.tenantId !== tenantId) return { ok: false as const, code: "no_sample" as const };
    const now = Date.now();
    const check = await certificateCurrent(ctx, tenant, sample.kind, sampleId, now);
    if (!check.ok) {
      if (sample.status === "collecting" || sample.status === "full") {
        if (check.code === "aged_out" || check.code === "rule_changed") await markLapsed(ctx, sample, now, check.code);
        if (check.code === "wrong") {
          const wrong = (await sampleRows(ctx, sample).take(CERTIFICATE_TARGET[sample.kind] + 1))
            .find((row) => verdictOf(row) === "wrong");
          if (wrong) await noteSampleGrade(ctx, wrong);
        }
      }
      return check;
    }
    if (sample.status !== "certified" || sample.firstCaseAt !== check.oldestCaseAt || sample.certifiedAt === undefined) {
      await ctx.db.patch("automationSamples", sampleId, {
        status: "certified", certifiedAt: sample.certifiedAt ?? now, firstCaseAt: check.oldestCaseAt,
      });
    }
    return { ok: true as const };
  },
});

export const promoteKind = mutation({
  args: { kind: automationKindValidator, sampleId: v.id("automationSamples") },
  returns: v.union(automationCommandRefusalValidator, v.object({
    ok: v.literal(true), alreadyApplied: v.boolean(), sampleId: v.id("automationSamples"),
  })),
  handler: async (ctx, { kind, sampleId }) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:raise"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    const settings = tenant?.resultAutomation;
    if (!tenant || !settings) return refuseAutomation("kind_off");
    const now = Date.now();
    const check = await certificateCurrent(ctx, tenant, kind, sampleId, now);
    if (!check.ok) return refuseAutomation(check.code === "aged_out" || check.code === "rule_changed"
      ? "certificate_lapsed" : "certificate_required");
    if (await breakerCauseOpen(ctx, tenant, kind, now)) return refuseAutomation("needs_review");
    const { sample } = check;
    if (sample.status !== "certified" || sample.certifiedAt === undefined || sample.firstCaseAt === undefined) return refuseAutomation("certificate_required");
    const policy = settings.kinds[kind];
    if (policy?.mode === "automatic" && policy.automatic?.sampleId === sampleId) {
      return policy.breaker ? refuseAutomation("kind_off") : { ok: true as const, alreadyApplied: true, sampleId };
    }

    // A new certificate can release a hold only with evidence collected after that hold.
    const held = [];
    for (const bindingId of sample.scopeBindingIds ?? []) {
      const binding = await ctx.db.get("paymentProviderBindings", bindingId);
      if (binding?.tenantId === tenantId && binding.automaticHeldAt !== undefined &&
          binding.automaticHeldAt < sample.certifiedAt) held.push({ bindingId, since: binding.automaticHeldAt });
    }
    if (held.length > 0) {
      const rows = await sampleRows(ctx, sample).take(sample.target + 1);
      for (const { bindingId, since } of held) {
        const usesBinding = rows.filter((row) => paymentEvidenceOf(row)?.bindingIds.includes(bindingId));
        if (usesBinding.length > 0 && usesBinding.every((row) => row.createdAt > since)) {
          await ctx.db.patch("paymentProviderBindings", bindingId, { automaticHeldAt: undefined, automaticHeldDecisionId: undefined });
        }
      }
    }
    const policyVersion = (policy?.policyVersion ?? 0) + 1;
    const stamp = { changedAt: now, changedByUserId: userId };
    await closeCollectingSample(ctx, tenantId, kind, now);
    await ctx.db.patch("tenants", tenantId, {
      resultAutomation: {
        ...settings, ...stamp, kinds: { ...settings.kinds, [kind]: {
          ...stamp, mode: "automatic", policyVersion,
          automatic: { promotedAt: now, promotedByUserId: userId, sampleId, ruleVersion: sample.ruleVersion, writes: 0 },
        } },
      },
    });
    await emitDomainEvent(ctx, {
      tenantId, entityType: "user", entityId: userId, actorUserId: userId, source: "admin", occurredAt: now,
      eventType: "automation.kind_promoted", metadata: { kind, sampleId, ruleVersion: sample.ruleVersion, policyVersion },
    });
    return { ok: true as const, alreadyApplied: false, sampleId };
  },
});

/** Executor adapter for callers that already have the tenant; the gate re-reads it in the mutation. */
export function requireAutomatic(
  ctx: MutationCtx, tenant: Tenant, decision: Decision, now: number,
): Promise<AutomaticAllowance> {
  const kind = automationKindOf(decision.kind);
  if (!kind) return Promise.resolve({ ok: false, code: "kind_off", gate: "kind_off" });
  return assertAutomaticAllowed(ctx, { tenantId: tenant._id, kind, decision }, now);
}

export const demoteKind = mutation({
  args: { kind: automationKindValidator },
  returns: v.null(),
  handler: async (ctx, { kind }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:lower"]]);
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    if (tenant?.resultAutomation?.kinds[kind]?.mode === "automatic") await setKindModeCore(ctx, actor, tenant, kind, "ask");
    return null;
  },
});

const certificateViewValidator = v.object({
  kind: automationKindValidator, target: v.number(), sample: v.union(progressValidator, v.null()),
  notEnoughRecordedCalls: v.boolean(), recentEligiblePeople: v.number(), recentEligibleCapped: v.boolean(),
});

export const getCertificates = query({
  args: {},
  returns: v.array(certificateViewValidator),
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw expectedError("auth.organization_mismatch", "Organization mismatch");
    const now = Date.now();
    const resolve = resolvePeople(ctx, tenantId);
    return await Promise.all(automationKindValidator.members.map(async ({ value: kind }) => {
      const target = CERTIFICATE_TARGET[kind];
      const sample = await latestSample(ctx, tenant, kind) ?? await priorSampleForKind(ctx, tenantId, kind);
      const members = sample ? await sampleRows(ctx, sample).take(target + 1) : [];
      // The rate only needs the first quarter of the annual target.
      const recent = await ctx.db.query("resultAutomationDecisions")
        .withIndex("by_tenantId_and_kind_and_ruleVersion_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).eq("kind", kind).eq("ruleVersion", currentRuleVersion(tenant, kind))
            .gte("createdAt", now - RECENT_DAYS * 86_400_000))
        .order("desc").take(101);
      const people = new Set<LeadId>();
      for (const row of recent.slice(0, 100)) {
        if (!row.leadId || !row.wouldWrite) continue;
        const person = await resolve(row.leadId);
        if (person) people.add(person);
      }
      return {
        kind, target, sample: sample ? progress(sample, standingOf(sample, members), tenant, now) : null,
        notEnoughRecordedCalls: !isPaymentKind(kind) && recent.length <= 100 && people.size < target / 4,
        recentEligiblePeople: people.size, recentEligibleCapped: recent.length > 100,
      };
    }));
  },
});
