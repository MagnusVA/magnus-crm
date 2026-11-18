import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { effectiveSettings as effectiveCallInsights } from "../callInsights/settings";
import { CALL_CHECKS_VERSION, DEFAULT_EXTRACTION_MODEL, EVIDENCE_PROMPT_VERSION, THRESHOLDS_VERSION } from "../callInsights/validators";
import { emitDomainEvent } from "../lib/domainEvents";
import { log } from "../lib/observability/log";
import { expectedError } from "../lib/observability/errors";
import { hasPermission, PERMISSIONS } from "../lib/permissions";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { breakerCauseOpen, promotedCertificate, whopIsLagging } from "./breaker";
import { CASE_MAX_AGE_MS, closeCollectingSample, priorSampleForKind, latestSample } from "./certificates";
import { callRuleVersion } from "./callRule";
import { stopDecision } from "./decisions";
import { PAYMENT_RULE_VERSION } from "./derive";
import { isCallKind, isPaymentKind } from "./proposals";
import {
  automationKindValidator, automationModeValidator, breakerReasonValidator, decisionKindValidator, resultAutomationSettingsValidator,
  settableAlertModeValidator, settableModeValidator,
} from "./schema";

type Settings = NonNullable<Doc<"tenants">["resultAutomation"]>;
type Kind = keyof Settings["kinds"];
type Mode = Settings["kinds"]["payment_win"]["mode"];
type Decision = Doc<"resultAutomationDecisions">;
type AlertMode = NonNullable<Settings["paidOnCallAlert"]>["mode"];
export const DEFAULT_ALERT_GRACE_MINUTES = 120;
export const paymentDecisionKindValidator = v.union(v.literal("payment_win"), v.literal("additional_payment"));

/** The serving rule a certificate must name today. */
export function currentRuleVersion(tenant: Doc<"tenants">, kind: Kind): string {
  return isPaymentKind(kind) ? PAYMENT_RULE_VERSION : callRuleVersion({
    promptVersion: EVIDENCE_PROMPT_VERSION,
    model: tenant.callInsights?.model ?? DEFAULT_EXTRACTION_MODEL,
    thresholdsVersion: THRESHOLDS_VERSION,
    checksVersion: CALL_CHECKS_VERSION,
  });
}

export function effectiveKindMode(tenant: Doc<"tenants">, kind: Kind): Mode {
  // pausedAt records the last pause, including after an owner resumes.
  if (tenant.status !== "active" || !tenant.resultAutomation?.enabled) return "off";
  if (isCallKind(kind) && !effectiveCallInsights(tenant)) return "off";
  const policy = tenant.resultAutomation.kinds[kind];
  if (!policy) return "off";
  if (policy.mode !== "automatic") return policy.mode;
  const certified = policy.automatic !== undefined && policy.breaker === undefined &&
    policy.automatic.ruleVersion === currentRuleVersion(tenant, kind);
  return certified ? "automatic" : "ask";
}

export function effectiveAlertMode(tenant: Doc<"tenants">): AlertMode {
  if (tenant.status !== "active" || !tenant.resultAutomation?.enabled || !effectiveCallInsights(tenant)) return "off";
  return tenant.resultAutomation.paidOnCallAlert?.mode ?? "off";
}

function initialSettings(userId: Id<"users">, now: number): Settings {
  const stamp = { changedAt: now, changedByUserId: userId };
  const off = { ...stamp, mode: "off", policyVersion: 0 } as const;
  return { ...stamp, enabled: false, activationVersion: 0, kinds: { payment_win: off, additional_payment: off } };
}

const breakerEntry = v.object({
  kind: automationKindValidator, trippedAt: v.number(), reason: breakerReasonValidator,
  decisionId: v.optional(v.id("resultAutomationDecisions")),
});
const automaticStatus = v.object({
  certificateState: v.union(v.literal("none"), v.literal("sampling"), v.literal("certified"), v.literal("lapsed")),
  sampleId: v.union(v.id("automationSamples"), v.null()),
  breaker: v.union(breakerEntry, v.null()),
  canPromote: v.boolean(),
  automaticBlockedReason: v.union(
    v.literal("certificate_required"), v.literal("whop_stale"), v.literal("paused"), ...breakerReasonValidator.members, v.null(),
  ),
});
const kindStatuses = v.object({
  payment_win: automaticStatus, additional_payment: automaticStatus, call_back: automaticStatus,
  payment_owed: automaticStatus, refusal_loss: automaticStatus,
});

export const getSettings = query({
  args: {},
  returns: v.object({
    configured: v.union(resultAutomationSettingsValidator, v.null()),
    effective: v.object({ payment_win: automationModeValidator, additional_payment: automationModeValidator }),
    callEffective: v.optional(v.object({
      call_back: automationModeValidator, payment_owed: automationModeValidator,
      refusal_loss: automationModeValidator, paid_on_call_alert: settableAlertModeValidator,
    })),
    automatic: kindStatuses,
    paused: v.boolean(),
    whopLagging: v.boolean(),
    breakers: v.array(breakerEntry),
    canRaise: v.boolean(),
    canLower: v.boolean(),
  }),
  handler: async (ctx) => {
    const { tenantId, role } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw expectedError("auth.organization_mismatch", "Organization mismatch");
    const now = Date.now();
    const canRaise = hasPermission(role, "result-automation:raise");
    const paused = tenant.status !== "active" || Boolean(tenant.resultAutomation && !tenant.resultAutomation.enabled);
    const whopLagging = await whopIsLagging(ctx, tenantId, now);
    const readKind = async (kind: Kind): Promise<typeof automaticStatus.type> => {
      const policy = tenant.resultAutomation?.kinds[kind];
      const [latest, promoted] = await Promise.all([
        latestSample(ctx, tenant, kind), promotedCertificate(ctx, tenant, kind),
      ]);
      const previous = latest || policy?.automatic ? null : await priorSampleForKind(ctx, tenantId, kind);
      const ageOk = latest?.firstCaseAt === undefined || latest.firstCaseAt >= now - CASE_MAX_AGE_MS;
      const candidate = latest?.status === "certified" && ageOk ? latest : null;
      const certificateState = promoted || candidate ? "certified" :
        latest?.status === "lapsed" || !ageOk || policy?.automatic || previous ? "lapsed" : latest ? "sampling" : "none";
      const breaker = policy?.breaker ? { kind, ...policy.breaker } : null;
      const automaticBlockedReason = breaker?.reason ?? (policy?.mode !== "automatic" ? null : paused ? "paused" :
        !policy.automatic ? "certificate_required" : !promoted ? "certificate_lapsed" :
        isPaymentKind(kind) && whopLagging ? "whop_stale" : null);
      return {
        certificateState, sampleId: candidate?._id ?? promoted?._id ?? latest?._id ?? policy?.automatic?.sampleId ?? previous?._id ?? null,
        breaker, automaticBlockedReason,
        canPromote: canRaise && Boolean(candidate) &&
          !(policy?.mode === "automatic" && candidate?._id === policy.automatic?.sampleId) &&
          !await breakerCauseOpen(ctx, tenant, kind, now),
      };
    };
    const [payment_win, additional_payment, call_back, payment_owed, refusal_loss] = await Promise.all(
      automationKindValidator.members.map(({ value }) => readKind(value)),
    );
    const automatic = { payment_win, additional_payment, call_back, payment_owed, refusal_loss };
    return {
      automatic, paused, whopLagging, breakers: Object.values(automatic).flatMap(({ breaker }) => breaker ? [breaker] : []),
      configured: tenant.resultAutomation ?? null,
      effective: {
        payment_win: effectiveKindMode(tenant, "payment_win"),
        additional_payment: effectiveKindMode(tenant, "additional_payment"),
      },
      callEffective: tenant.callInsights || tenant.resultAutomation?.kinds.call_back || tenant.resultAutomation?.kinds.payment_owed ||
          tenant.resultAutomation?.kinds.refusal_loss || tenant.resultAutomation?.paidOnCallAlert ? {
        call_back: effectiveKindMode(tenant, "call_back"),
        payment_owed: effectiveKindMode(tenant, "payment_owed"),
        refusal_loss: effectiveKindMode(tenant, "refusal_loss"),
        paid_on_call_alert: effectiveAlertMode(tenant),
      } : undefined,
      canRaise,
      canLower: hasPermission(role, "result-automation:lower"),
    };
  },
});

const states = ["shadow", "ready", "needs_person", "blocked", "notice"] as const;
const settingsStopArgs = {
  tenantId: v.id("tenants"),
  code: v.union(v.literal("paused"), v.literal("kind_lowered"), v.literal("breaker"), v.literal("certificate_lapsed")),
  version: v.optional(v.number()),
  now: v.number(),
  kind: v.optional(decisionKindValidator),
  callInsightsDisabled: v.optional(v.boolean()),
  throughCreationTime: v.optional(v.number()),
  state: v.union(v.literal("shadow"), v.literal("ready"), v.literal("needs_person"), v.literal("blocked"), v.literal("notice")),
  cursor: v.union(v.string(), v.null()),
};
type SettingsStopArgs = ObjectType<typeof settingsStopArgs>;
const stopPageRef = makeFunctionReference<"mutation", SettingsStopArgs>("automation/settings:stopPolicyPage");
const stopPageSize = 50;
const rederiveCallRef = makeFunctionReference<"mutation", {
  meetingId: Id<"meetings">; cause: "settings";
}>("automation/callDecisions:evaluateCallMeeting");

function oldDecisions(ctx: MutationCtx, args: SettingsStopArgs) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_state_and_createdAt", (q) =>
      q.eq("tenantId", args.tenantId).eq("state", args.state).lte("createdAt", args.now));
}

async function stopRows(ctx: MutationCtx, args: SettingsStopArgs, rows: Decision[]) {
  for (const row of rows) {
    const old = args.callInsightsDisabled
      ? !isPaymentKind(row.kind)
      : args.version !== undefined && (args.kind
        ? row.kind === args.kind && row.policyVersion < args.version
        : row.activationVersion < args.version);
    if (!old || (args.throughCreationTime !== undefined && row.createdAt === args.now &&
      row._creationTime > args.throughCreationTime)) continue;
    if (row.state === "notice") {
      await stopDecision(ctx, row._id, null, args.code);
      if (row.meetingId && (args.code === "breaker" || args.code === "certificate_lapsed")) {
        await ctx.scheduler.runAfter(0, rederiveCallRef, { meetingId: row.meetingId, cause: "settings" });
      }
    } else await ctx.db.patch("resultAutomationDecisions", row._id, {
      state: "stopped", stopCode: args.code, resolvedAt: args.now,
    });
  }
}

async function stopPriorPolicy(ctx: MutationCtx, args: Omit<SettingsStopArgs, "state" | "cursor">) {
  for (const state of states) {
    if (state === "notice" && args.kind && args.kind !== "refusal_loss") continue;
    const params = { ...args, state, cursor: null };
    const range = oldDecisions(ctx, params);
    const rows = await range.take(stopPageSize + 1);
    await stopRows(ctx, params, rows.slice(0, stopPageSize));
    if (rows.length > stopPageSize) {
      const throughCreationTime = args.callInsightsDisabled ? (await range.order("desc").first())?._creationTime : undefined;
      await ctx.scheduler.runAfter(0, stopPageRef, { ...params, throughCreationTime });
    }
  }
}

export async function stopBreakerNotices(
  ctx: MutationCtx, tenantId: Id<"tenants">, now: number, version: number, code: "breaker" | "certificate_lapsed",
): Promise<void> {
  const args = { tenantId, kind: "refusal_loss", now, version, code, state: "notice", cursor: null } as const;
  const rows = await oldDecisions(ctx, args).take(stopPageSize + 1);
  await stopRows(ctx, args, rows.slice(0, stopPageSize));
  if (rows.length > stopPageSize) await ctx.scheduler.runAfter(0, stopPageRef, args);
}

export async function stopCallDecisionsForDisabledInsights(ctx: MutationCtx, tenant: Doc<"tenants">, now: number): Promise<void> {
  if (!tenant.resultAutomation?.enabled) return;
  try {
    await stopPriorPolicy(ctx, { tenantId: tenant._id, now, code: "kind_lowered", callInsightsDisabled: true });
  } catch {
    log.warn("automation.call_settings_stop_failed", { tenantId: tenant._id });
  }
}

export const stopPolicyPage = internalMutation({
  args: settingsStopArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await oldDecisions(ctx, args).paginate({
      cursor: args.cursor, numItems: stopPageSize, maximumBytesRead: 256 * 1024,
    });
    await stopRows(ctx, args, page.page);
    if (!page.isDone) await ctx.scheduler.runAfter(0, stopPageRef, { ...args, cursor: page.continueCursor });
    return null;
  },
});

async function saveSettings(
  ctx: MutationCtx, actor: TenantUserResult, settings: Settings,
  metadata: {
    kind?: Decision["kind"] | "grader" | "activation" | "refusal_notice_hours";
    fromMode?: Mode | AlertMode;
    toMode?: Mode | AlertMode;
    policyVersion?: number;
    graceMinutes?: number;
    hours?: number;
    graderUserId?: Id<"users">;
  },
) {
  await ctx.db.patch("tenants", actor.tenantId, { resultAutomation: settings });
  await emitDomainEvent(ctx, {
    tenantId: actor.tenantId,
    entityType: "user",
    entityId: actor.userId,
    actorUserId: actor.userId,
    eventType: "automation.settings_changed",
    source: "admin",
    occurredAt: settings.changedAt,
    metadata: { ...metadata, activationVersion: settings.activationVersion },
  });
}

export const setEnabled = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { enabled }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS[enabled ? "result-automation:raise" : "result-automation:lower"]]);
    const now = Date.now();
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    const settings = tenant?.resultAutomation ?? initialSettings(actor.userId, now);
    if (settings.enabled === enabled) return null;
    const activationVersion = settings.activationVersion + 1;
    await saveSettings(ctx, actor, {
      ...settings, enabled, activationVersion, changedAt: now, changedByUserId: actor.userId,
      pausedAt: enabled ? settings.pausedAt : now,
    }, { kind: "activation", fromMode: enabled ? "off" : undefined, toMode: enabled ? undefined : "off" });
    if (!enabled) await stopPriorPolicy(ctx, { tenantId: actor.tenantId, now, code: "paused", version: activationVersion });
    return null;
  },
});

const modeRank = { off: 0, shadow: 1, ask: 2, automatic: 3 };
const refreshTenantPayments = makeFunctionReference<"mutation", {
  tenantId: Id<"tenants">; activationVersion: number;
}>("automation/sweep:tenantPayments");

export const setKindMode = mutation({
  args: { kind: automationKindValidator, mode: settableModeValidator },
  returns: v.null(),
  handler: async (ctx, { kind, mode }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:lower"]]);
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    if (!tenant) throw expectedError("auth.organization_mismatch", "Organization mismatch");
    await setKindModeCore(ctx, actor, tenant, kind, mode);
    return null;
  },
});

export async function setKindModeCore(
  ctx: MutationCtx, actor: TenantUserResult, tenant: Doc<"tenants">, kind: Kind, mode: typeof settableModeValidator.type,
): Promise<void> {
  const now = Date.now();
  const settings = tenant.resultAutomation ?? initialSettings(actor.userId, now);
  const previous = settings.kinds[kind];
  const previousMode = previous?.mode ?? "off";
  if (previousMode === mode) return;
  const raising = modeRank[mode] > modeRank[previousMode];
  if (raising && !hasPermission(actor.role, "result-automation:raise")) {
    throw expectedError("auth.insufficient_permissions", "Insufficient permissions");
  }
  const policyVersion = (previous?.policyVersion ?? 0) + 1;
  const stamp = { changedAt: now, changedByUserId: actor.userId };
  await closeCollectingSample(ctx, tenant._id, kind, now);
  await saveSettings(ctx, actor, {
    ...settings, ...stamp,
    kinds: { ...settings.kinds, [kind]: { ...previous, ...stamp, mode, policyVersion } },
  }, { kind, fromMode: previousMode, toMode: mode, policyVersion });
  if (!raising) {
    await stopPriorPolicy(ctx, { tenantId: actor.tenantId, kind, now, code: "kind_lowered", version: policyVersion });
  } else if (settings.enabled && isPaymentKind(kind)) {
    await ctx.scheduler.runAfter(0, refreshTenantPayments, {
      tenantId: actor.tenantId, activationVersion: settings.activationVersion,
    });
  }
}

export const setGrader = mutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:raise"]]);
    const [tenant, grader] = await Promise.all([ctx.db.get("tenants", actor.tenantId), ctx.db.get("users", userId)]);
    if (grader?.tenantId !== actor.tenantId || grader.isActive === false || !hasPermission(grader.role, "result-automation:grade")) {
      throw expectedError("automation.invalid_grader", "Choose an active owner or admin from this organization.");
    }
    const now = Date.now();
    const settings = tenant?.resultAutomation ?? initialSettings(actor.userId, now);
    if (settings.graderUserId === userId) return null;
    await saveSettings(ctx, actor, {
      ...settings, graderUserId: userId, changedAt: now, changedByUserId: actor.userId,
    }, { kind: "grader", graderUserId: userId });
    return null;
  },
});


const alertModeRank = { off: 0, shadow: 1, on: 2 };

export const setAlertMode = mutation({
  args: { mode: settableAlertModeValidator, graceMinutes: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { mode, graceMinutes }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:lower"]]);
    const now = Date.now();
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    const settings = tenant?.resultAutomation ?? initialSettings(actor.userId, now);
    const previous = settings.paidOnCallAlert;
    const previousMode = previous?.mode ?? "off";
    const previousGrace = previous?.graceMinutes ?? DEFAULT_ALERT_GRACE_MINUTES;
    const grace = graceMinutes ?? previousGrace;
    if (!Number.isFinite(grace) || grace < 30 || grace > 1440) {
      throw expectedError("automation.invalid_alert_grace", "Set a grace period from 30 to 1440 minutes.");
    }
    if (mode === previousMode && grace === previousGrace) return null;
    if ((alertModeRank[mode] > alertModeRank[previousMode] || grace !== previousGrace) &&
        !hasPermission(actor.role, "result-automation:raise")) {
      throw expectedError("auth.insufficient_permissions", "Insufficient permissions");
    }
    const policyVersion = (previous?.policyVersion ?? 0) + 1;
    const stamp = { changedAt: now, changedByUserId: actor.userId };
    await saveSettings(ctx, actor, {
      ...settings, ...stamp, paidOnCallAlert: { ...stamp, mode, graceMinutes: grace, policyVersion },
    }, { kind: "paid_on_call_alert", fromMode: previousMode, toMode: mode, policyVersion, graceMinutes: grace });
    await stopPriorPolicy(ctx, {
      tenantId: actor.tenantId, kind: "paid_on_call_alert", now, code: "kind_lowered", version: policyVersion,
    });
    return null;
  },
});

export const setRefusalNoticeHours = mutation({
  args: { hours: v.number() },
  returns: v.null(),
  handler: async (ctx, { hours }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:raise"]]);
    if (!Number.isFinite(hours) || hours < 24 || hours > 168) {
      throw expectedError("automation.invalid_notice_hours", "Set the refusal notice from 24 to 168 hours.");
    }
    const now = Date.now();
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    const settings = tenant?.resultAutomation ?? initialSettings(actor.userId, now);
    if ((settings.refusalNoticeHours ?? 48) === hours) return null;
    await saveSettings(ctx, actor, {
      ...settings, changedAt: now, changedByUserId: actor.userId, refusalNoticeHours: hours,
    }, { kind: "refusal_notice_hours", hours });
    return null;
  },
});
