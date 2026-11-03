import type { Id } from "../_generated/dataModel";
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
