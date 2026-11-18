import { makeFunctionReference } from "convex/server";
import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { emitDomainEvent } from "../lib/domainEvents";
import { expectedError } from "../lib/observability/errors";
import { hasPermission, PERMISSIONS } from "../lib/permissions";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { PAYMENT_RULE_VERSION } from "./derive";
import { automationModeValidator, resultAutomationSettingsValidator, settableModeValidator } from "./schema";

type Settings = NonNullable<Doc<"tenants">["resultAutomation"]>;
type Kind = keyof Settings["kinds"];
type Mode = Settings["kinds"]["payment_win"]["mode"];
type Decision = Doc<"resultAutomationDecisions">;
export const paymentDecisionKindValidator = v.union(v.literal("payment_win"), v.literal("additional_payment"));

/**
 * The rule version a kind's certificate must name. The call rule has no
 * version yet, so no call kind's certificate pointer can be current.
 */
function currentRuleVersionOf(kind: Kind): string | null {
  return kind === "payment_win" || kind === "additional_payment" ? PAYMENT_RULE_VERSION : null;
}

/**
 * The level a kind works at now. A stored "automatic" reads as "ask" unless
 * its certificate pointer names the current rule version and no breaker
 * holds; only promoteKind writes that pointer.
 */
export function effectiveKindMode(tenant: Doc<"tenants">, kind: Kind): Mode {
  if (!tenant.resultAutomation?.enabled) return "off";
  const policy = tenant.resultAutomation.kinds[kind];
  if (!policy) return "off";
  if (policy.mode !== "automatic") return policy.mode;
  const currentRuleVersion = currentRuleVersionOf(kind);
  const certified = policy.automatic !== undefined && policy.breaker === undefined &&
    currentRuleVersion !== null && policy.automatic.ruleVersion === currentRuleVersion;
  return certified ? "automatic" : "ask";
}

function initialSettings(userId: Id<"users">, now: number): Settings {
  const stamp = { changedAt: now, changedByUserId: userId };
  const off = { ...stamp, mode: "off", policyVersion: 0 } as const;
  return { ...stamp, enabled: false, activationVersion: 0, kinds: { payment_win: off, additional_payment: off } };
}

export const getSettings = query({
  args: {},
  returns: v.object({
    configured: v.union(resultAutomationSettingsValidator, v.null()),
    effective: v.object({ payment_win: automationModeValidator, additional_payment: automationModeValidator }),
    canRaise: v.boolean(),
    canLower: v.boolean(),
  }),
  handler: async (ctx) => {
    const { tenantId, role } = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:view"]]);
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw expectedError("auth.organization_mismatch", "Organization mismatch");
    return {
      configured: tenant.resultAutomation ?? null,
      effective: {
        payment_win: effectiveKindMode(tenant, "payment_win"),
        additional_payment: effectiveKindMode(tenant, "additional_payment"),
      },
      canRaise: hasPermission(role, "result-automation:raise"),
      canLower: hasPermission(role, "result-automation:lower"),
    };
  },
});

const states = ["shadow", "ready", "needs_person", "blocked"] as const;
const settingsStopArgs = {
  tenantId: v.id("tenants"),
  code: v.union(v.literal("paused"), v.literal("kind_lowered")),
  version: v.number(),
  now: v.number(),
  kind: v.optional(paymentDecisionKindValidator),
  state: v.union(v.literal("shadow"), v.literal("ready"), v.literal("needs_person"), v.literal("blocked")),
  cursor: v.union(v.string(), v.null()),
};
type SettingsStopArgs = ObjectType<typeof settingsStopArgs>;
const stopPageRef = makeFunctionReference<"mutation", SettingsStopArgs>("automation/settings:stopPolicyPage");
const stopPageSize = 50;

function oldDecisions(ctx: MutationCtx, args: SettingsStopArgs) {
  return ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_state_and_createdAt", (q) =>
      q.eq("tenantId", args.tenantId).eq("state", args.state).lte("createdAt", args.now));
}

async function stopRows(ctx: MutationCtx, args: SettingsStopArgs, rows: Decision[]) {
  for (const row of rows) {
    const old = args.kind
      ? row.kind === args.kind && row.policyVersion < args.version
      : row.activationVersion < args.version;
    if (old) await ctx.db.patch("resultAutomationDecisions", row._id, {
      state: "stopped", stopCode: args.code, resolvedAt: args.now,
    });
  }
}

async function stopPriorPolicy(ctx: MutationCtx, args: Omit<SettingsStopArgs, "state" | "cursor">) {
  for (const state of states) {
    const params = { ...args, state, cursor: null };
    const rows = await oldDecisions(ctx, params).take(stopPageSize + 1);
    await stopRows(ctx, params, rows.slice(0, stopPageSize));
    if (rows.length > stopPageSize) await ctx.scheduler.runAfter(0, stopPageRef, params);
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
    kind?: "payment_win" | "additional_payment" | "grader" | "activation";
    fromMode?: Mode;
    toMode?: Mode;
    policyVersion?: number;
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
  args: { kind: paymentDecisionKindValidator, mode: settableModeValidator },
  returns: v.null(),
  handler: async (ctx, { kind, mode }) => {
    const actor = await requireTenantUser(ctx, [...PERMISSIONS["result-automation:lower"]]);
    const now = Date.now();
    const tenant = await ctx.db.get("tenants", actor.tenantId);
    const settings = tenant?.resultAutomation ?? initialSettings(actor.userId, now);
    const previous = settings.kinds[kind];
    if (previous.mode === mode) return null;
    const raising = modeRank[mode] > modeRank[previous.mode];
    if (raising && !hasPermission(actor.role, "result-automation:raise")) {
      throw expectedError("auth.insufficient_permissions", "Insufficient permissions");
    }
    const policyVersion = previous.policyVersion + 1;
    const stamp = { changedAt: now, changedByUserId: actor.userId };
    await saveSettings(ctx, actor, {
      ...settings, ...stamp,
      kinds: { ...settings.kinds, [kind]: { ...stamp, mode, policyVersion } },
    }, { kind, fromMode: previous.mode, toMode: mode, policyVersion });
    if (!raising) {
      await stopPriorPolicy(ctx, { tenantId: actor.tenantId, kind, now, code: "kind_lowered", version: policyVersion });
    } else if (settings.enabled) {
      await ctx.scheduler.runAfter(0, refreshTenantPayments, {
        tenantId: actor.tenantId, activationVersion: settings.activationVersion,
      });
    }
    return null;
  },
});

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
