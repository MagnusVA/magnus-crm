import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { liveSuggestionForMeeting } from "../callInsights/suggest/state";
import type { Provenance } from "../mcp/guard";
import { isExpectedError, rejectRequest } from "./observability/errors";
import type { CrmRole } from "./roleMapping";

export type { Provenance } from "../mcp/guard";

/**
 * The resolved caller a core acts as (docs/plans/closer-assistant.md §5.1):
 * what `requireTenantUser` returns on the web and `requireMcpUser` returns
 * for an agent. Cores take the tenant, user and role from here, never from
 * their arguments.
 */
export type CoreActor = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: CrmRole;
};

/**
 * Server-only input. The confirmation caller writes its receipt and calls
 * noteHumanResult once, with consumeDecisionId, in the same mutation.
 */
export type AutomationCoreOptions = {
  decisionId: Id<"resultAutomationDecisions">;
  task?: {
    purpose: "call_back" | "payment_owed";
    expectedAmountMinor?: number;
    expectedCurrency?: string;
    promisedPaymentAt?: number;
    declineCode?: string;
  };
  refusal?: true;
  allowDueNow?: true;
  system?: boolean;
};

/** Validate the server decision and resolve an identity for the existing guards. */
export async function guardActorForOutcome(
  ctx: MutationCtx,
  actor: CoreActor | null,
  args: { opportunityId: Id<"opportunities">; meetingId?: Id<"meetings"> },
  automation: AutomationCoreOptions | undefined,
  role: "closer" | "tenant_admin",
): Promise<CoreActor> {
  if (actor && !automation) return actor;
  if (!automation || Boolean(actor) === Boolean(automation.system)) {
    throw new Error("Invalid outcome actor");
  }
  const decision = await ctx.db.get("resultAutomationDecisions", automation.decisionId);
  const deal = await ctx.db.get("opportunities", args.opportunityId);
  if (!deal || !decision || decision.tenantId !== deal.tenantId ||
      decision.opportunityId !== deal._id || decision.meetingId !== args.meetingId ||
      (automation.refusal && decision.kind !== "refusal_loss")) {
    throw new Error("Call decision does not belong to this outcome");
  }
  if (actor) return actor;
  if (!deal.assignedCloserId) throw new Error("No closer assigned to this opportunity");
  return { tenantId: deal.tenantId, userId: deal.assignedCloserId, role };
}

export function callAttendancePatch(automation: AutomationCoreOptions | undefined) {
  return automation ? {
    attendanceSource: "call_insights" as const,
    attendanceDecisionId: automation.decisionId,
  } : undefined;
}

export async function liveOutcomeSuggestion(
  ctx: MutationCtx,
  meeting: Doc<"meetings">,
  now: number,
) {
  const tenant = await ctx.db.get("tenants", meeting.tenantId);
  return tenant ? await liveSuggestionForMeeting(ctx, { tenant, meeting, now }) : null;
}

/** The web's provenance, for the public mutations. */
export const WEB: Provenance = { via: "web" };

/**
 * Refuses a role the core's public mutation never admits. The web guard
 * already filtered it, so this only stops another caller passing the wrong
 * actor.
 */
export function assertCoreRole<R extends CrmRole>(
  actor: CoreActor,
  roles: readonly R[],
): asserts actor is CoreActor & { role: R } {
  if (!(roles as readonly CrmRole[]).includes(actor.role)) {
    throw rejectRequest("auth.role_not_allowed", "This action isn't available for your role.", {
      userId: actor.userId,
      role: actor.role,
    });
  }
}

/**
 * A closer asking for a scheduling or reschedule link before an admin gave
 * them a personal calendar. The sentence tells them what to do, so it goes
 * out as a rejection they can read, not a bug.
 */
export function personalCalendarMissing() {
  return rejectRequest(
    "calendar.personal_not_configured",
    "No personal calendar configured. Ask your admin to assign one in Team settings.",
  );
}

/**
 * Fields the action's own domain event metadata gains for an agent's write
 * (§5.1). The web adds nothing, so its events stay as they were.
 */
export function provenanceMetadata(
  provenance: Provenance,
): { via?: "mcp"; agentClient?: string } {
  return provenance.via === "mcp"
    ? { via: "mcp", agentClient: provenance.agentClient }
    : {};
}

/** What a read-only check returns instead of throwing (decision 17). */
export type CheckResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

/**
 * Runs a core's checks and returns the refusal the core would throw as a
 * value. A check's plain `Error` carries its message here, inside the
 * function, so a caller can show it even where Convex would redact a thrown
 * one.
 */
export async function toCheckResult<T extends object>(
  check: () => Promise<T>,
): Promise<CheckResult<T>> {
  try {
    return { ok: true, ...(await check()) };
  } catch (error) {
    if (isExpectedError(error)) {
      return { ok: false, code: error.data.code, message: error.data.message };
    }
    // A check's refusal is a plain `Error`; a TypeError or the like is a bug.
    if (error instanceof Error && error.name === "Error") {
      return { ok: false, code: "outcome.refused", message: error.message };
    }
    throw error;
  }
}
