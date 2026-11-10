import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { isExpectedError, rejectRequest } from "../../../lib/observability/errors";
import type { CheckResult } from "../../../lib/outcomeCores";
import type { McpUser } from "../../guard";
import { formatLocal, parseLocalDateTime } from "../../time";
import type { AdminActor, Pins } from "../prepare";

/** Shared pieces of the admin change tools (docs/plans/admin-assistant.md §2, §4). */

export function actorOf(me: McpUser): AdminActor {
  return { userId: me.userId, tenantId: me.tenantId, role: me.role, agentClient: me.agentClient };
}

/**
 * A core's refusal: an expected error, a plain `Error` (cores refuse with
 * those, as the web does), or Billing being off. Anything else is a bug.
 */
export function isCoreRefusal(error: unknown): error is Error {
  return (
    isExpectedError(error) ||
    (error instanceof Error && (error.name === "Error" || error.name === "BillingOpsDisabledError"))
  );
}

/** Cores refuse with plain `Error`s, as the web does; the agent reads the same sentence. */
export async function asAgentError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isExpectedError(error)) throw error;
    if (isCoreRefusal(error)) throw rejectRequest("change.refused", error.message);
    throw error;
  }
}

export function refuse(result: { ok: false; code: string; message: string }): never {
  throw rejectRequest(result.code, result.message);
}

export const ok: CheckResult<object> = { ok: true };

/** An agent may record a result only once the call has started (fix 4). */
export function startedCheck(meeting: Doc<"meetings">, timeZone: string, now = Date.now()): CheckResult<object> {
  if (meeting.scheduledAt > now) {
    return {
      ok: false,
      code: "result.not_started",
      message: `That call starts ${formatLocal(meeting.scheduledAt, timeZone)}. A result can be recorded once it has started.`,
    };
  }
  return ok;
}

export async function closerZone(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  closerId: Id<"users"> | undefined,
): Promise<{ timeZone: string; closerName: string }> {
  const closer = closerId ? await ctx.db.get("users", closerId) : null;
  const tenant = await ctx.db.get("tenants", tenantId);
  return {
    timeZone: closer?.timezone ?? tenant?.businessDay?.timeZone ?? "America/Tegucigalpa",
    closerName: closer?.fullName ?? closer?.email ?? "the closer",
  };
}

/** Parses a local date and time in a zone, as a refusal the agent can read. */
export function parseLocal(date: string, time: string, timeZone: string): number {
  try {
    return parseLocalDateTime(date, time, timeZone);
  } catch {
    throw rejectRequest("change.time_invalid", "Use a real date (YYYY-MM-DD) and time (HH:MM, 24-hour).");
  }
}

export function meetingPins(meeting: Doc<"meetings"> | null): Pins {
  if (!meeting) return { meeting: "missing" };
  return {
    "meeting.status": meeting.status,
    "meeting.scheduledAt": meeting.scheduledAt,
    "meeting.assignedCloserId": meeting.assignedCloserId,
    "meeting.opportunityId": meeting.opportunityId,
  };
}

export function dealPins(deal: Doc<"opportunities"> | null): Pins {
  if (!deal) return { deal: "missing" };
  return {
    "deal.stage": deal.stage ?? null,
    "deal.outcome": deal.outcome ?? null,
    "deal.assignedCloserId": deal.assignedCloserId ?? null,
    "deal.leadId": deal.leadId,
  };
}

export function personName(name: string | undefined | null): { text: string; by: "person" } {
  return { text: name?.trim() || "Unknown", by: "person" };
}
