import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const UNAVAILABILITY_REASONS = [
  "sick",
  "emergency",
  "personal",
  "other",
] as const;

export type UnavailabilityReason = (typeof UNAVAILABILITY_REASONS)[number];

export const unavailabilityReasonValidator = v.union(
  v.literal("sick"),
  v.literal("emergency"),
  v.literal("personal"),
  v.literal("other"),
);

type UnavailabilityRangeInput = {
  date: number;
  isFullDay: boolean;
  startTime?: number;
  endTime?: number;
};

type TenantContext = QueryCtx | MutationCtx;

export function getEffectiveRange({
  date,
  isFullDay,
  startTime,
  endTime,
}: UnavailabilityRangeInput): {
  rangeStart: number;
  rangeEnd: number;
} {
  if (isFullDay) {
    return {
      rangeStart: date,
      rangeEnd: date + ONE_DAY_MS,
    };
  }

  if (startTime === undefined || endTime === undefined) {
    throw new Error(
      "Partial-day unavailability must include both startTime and endTime",
    );
  }

  return {
    rangeStart: startTime,
    rangeEnd: endTime,
  };
}

export function isMeetingInRange(
  meetingStart: number,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  return meetingStart >= rangeStart && meetingStart < rangeEnd;
}

export async function validateCloser(
  ctx: TenantContext,
  closerId: Id<"users">,
  tenantId: Id<"tenants">,
) {
  const closer = await ctx.db.get(closerId);

  if (!closer || closer.tenantId !== tenantId) {
    throw new Error("Closer not found");
  }

  if (closer.role !== "closer") {
    throw new Error("Only closers can be marked unavailable");
  }

  return closer;
}
