import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { businessDateForInstant, countBusinessDays, addBusinessDays } from "../../lib/businessDay";
import { resolveDashboardRange } from "../../lib/analyticsRange";
import { isExpectedError, rejectRequest } from "../lib/observability/errors";
import type { CrmRole } from "../lib/roleMapping";
import { rememberTenantBusinessDay } from "../lib/tenantBusinessDay";
import schema from "../schema";
import { mcpCallerValidator, requireMcpUser, type McpUser } from "./guard";

/**
 * Shared by the lead gen tools (docs/plans/lead-gen-assistant.md): the range
 * arguments every dated tool takes, and the access check an action runs
 * before it reads and again before it returns a delayed result.
 */
export const LEAD_GEN_RANGE_PRESETS = ["today", "this_week", "last_week", "this_month"] as const;
export type LeadGenRangePreset = (typeof LEAD_GEN_RANGE_PRESETS)[number];

export type LeadGenRangeArgs = {
  range?: LeadGenRangePreset;
  startDate?: string;
  endDate?: string;
};

export type LeadGenToolRange = {
  /** Inclusive business dates, "YYYY-MM-DD". */
  startDayKey: string;
  endDayKey: string;
  /** The preset the caller named, or "custom". */
  preset: LeadGenRangePreset | "custom";
  days: number;
};

/** `range`, or `startDate` and `endDate`, on every dated lead gen tool. */
export const leadGenRangeArgs = {
  range: v.optional(
    v.union(v.literal("today"), v.literal("this_week"), v.literal("last_week"), v.literal("this_month")),
  ),
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves a tool's range to inclusive business dates. A preset and dates
 * together, half a date pair, a future end or a range over `maxDays` is
 * refused with a message the model can act on. With nothing passed, today.
 */
export function resolveLeadGenRange(
  args: LeadGenRangeArgs,
  todayDayKey: string,
  options: { maxDays?: number } = {},
): LeadGenToolRange {
  const maxDays = options.maxDays ?? 120;
  const hasDates = args.startDate !== undefined || args.endDate !== undefined;
  if (args.range !== undefined && hasDates) {
    throw rejectRequest("range.invalid", "Pass range, or startDate and endDate, not both.");
  }
  if (!hasDates) {
    const preset = args.range ?? "today";
    const resolved = resolveDashboardRange({ kind: "preset", preset }, todayDayKey);
    return {
      startDayKey: resolved.startBusinessDate,
      endDayKey: resolved.endBusinessDateInclusive,
      preset,
      days: countBusinessDays(resolved.startBusinessDate, addBusinessDays(resolved.endBusinessDateInclusive, 1)),
    };
  }
  const { startDate, endDate } = args;
  if (!startDate || !endDate || !DAY_KEY.test(startDate) || !DAY_KEY.test(endDate)) {
    throw rejectRequest("range.invalid", 'Send startDate and endDate as business dates, "YYYY-MM-DD".');
  }
  // Date.parse rolls 2026-02-31 over to March, so compare the round trip.
  const exists = (day: string) => {
    const ms = Date.parse(`${day}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
  };
  if (!exists(startDate) || !exists(endDate)) {
    throw rejectRequest("range.invalid", "One of those dates doesn't exist.");
  }
  if (startDate > endDate) {
    throw rejectRequest("range.invalid", "startDate is after endDate.");
  }
  if (endDate > todayDayKey) {
    throw rejectRequest("range.invalid", `endDate is in the future. Today's business date is ${todayDayKey}.`);
  }
  const days = countBusinessDays(startDate, addBusinessDays(endDate, 1));
  if (days > maxDays) {
    throw rejectRequest("range.too_long", `A range can cover up to ${maxDays} days. That one covers ${days}.`);
  }
  return { startDayKey: startDate, endDayKey: endDate, preset: "custom", days };
}

const roleValidator = schema.tables.users.validator.fields.role;

export type LeadGenActionCaller = {
  userId: Id<"users">;
  tenantId: Id<"tenants">;
  role: CrmRole;
  timeZone: string;
  agentClient: string;
  businessDay: { timeZone: string; dayStartHour: number };
  todayDayKey: string;
};

export const leadGenActionCallerValidator = v.object({
  userId: v.id("users"),
  tenantId: v.id("tenants"),
  role: roleValidator,
  timeZone: v.string(),
  agentClient: v.string(),
  businessDay: v.object({ timeZone: v.string(), dayStartHour: v.number() }),
  todayDayKey: v.string(),
});

export function leadGenActionCaller(ctx: QueryCtx, me: McpUser): LeadGenActionCaller {
  const businessDay = rememberTenantBusinessDay(ctx, me.tenant);
  return {
    userId: me.userId,
    tenantId: me.tenantId,
    role: me.role,
    timeZone: me.timeZone,
    agentClient: me.agentClient,
    businessDay: { timeZone: businessDay.timeZone, dayStartHour: businessDay.dayStartHour },
    todayDayKey: businessDateForInstant(Date.now(), businessDay),
  };
}

/**
 * The access check for a lead gen action. Actions have no database, so they
 * run this first, and again before returning anything that took time, so a
 * role switched off or a member blocked mid-call gets no result.
 */
export const authorizeCaller = internalQuery({
  args: { caller: mcpCallerValidator, roles: v.array(roleValidator) },
  returns: leadGenActionCallerValidator,
  handler: async (ctx, { caller, roles }): Promise<LeadGenActionCaller> => {
    const me = await requireMcpUser(ctx, caller, roles);
    return leadGenActionCaller(ctx, me);
  },
});

/**
 * The cores refuse with plain `Error`s, as the web always did; the gateway
 * would send those as "Tool execution failed". Rethrow them so the agent
 * reads the sentence a person would see.
 */
export async function withAgentErrors<T>(code: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isExpectedError(error)) throw error;
    if (error instanceof Error && error.name === "Error") throw rejectRequest(code, error.message);
    throw error;
  }
}

/**
 * A list write's preview is a header, one numbered line per item, then notes.
 * The commit builds the lines again and refuses when one differs from what
 * was read back, except a line this same list already saved, which is
 * reported instead (docs/plans/lead-gen-assistant.md §7).
 */
export function listPreview(header: string, lines: string[], notes: string[]): string {
  return [header, ...lines.map((line, index) => `${index + 1}. ${line}`), ...notes].join("\n");
}

export function sameAsPreview(storedPreview: string, lines: string[], alreadyDone: boolean[]): boolean {
  const stored = storedPreview.split("\n").slice(1, lines.length + 1);
  if (stored.length !== lines.length) return false;
  return lines.every((line, index) => alreadyDone[index] || stored[index] === `${index + 1}. ${line}`);
}
