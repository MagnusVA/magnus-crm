import type {
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { BillingCountArgs } from "./types";

export function assertBillingDateRange(filters: BillingCountArgs) {
  if (
    filters.startAt !== undefined &&
    filters.endAt !== undefined &&
    filters.endAt <= filters.startAt
  ) {
    throw new Error("End date must be after start date.");
  }
}

export async function paginateBillingPaymentQuery(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  filters: BillingCountArgs,
  paginationOpts: PaginationOptions,
): Promise<PaginationResult<Doc<"paymentRecords">>> {
  assertBillingDateRange(filters);

  if (filters.programId && filters.paymentType) {
    const programId = filters.programId;
    const paymentType = filters.paymentType;
    return await ctx.db
      .query("paymentRecords")
      .withIndex(
        "by_tenantId_status_programId_paymentType_recordedAt",
        (q) => {
          const range = q
            .eq("tenantId", tenantId)
            .eq("status", filters.status)
            .eq("programId", programId)
            .eq("paymentType", paymentType);
          if (filters.startAt !== undefined && filters.endAt !== undefined) {
            return range
              .gte("recordedAt", filters.startAt)
              .lt("recordedAt", filters.endAt);
          }
          if (filters.endAt !== undefined) {
            return range.lt("recordedAt", filters.endAt);
          }
          if (filters.startAt !== undefined) {
            return range.gte("recordedAt", filters.startAt);
          }
          return range;
        },
      )
      .order("desc")
      .paginate(paginationOpts);
  }

  if (filters.programId) {
    const programId = filters.programId;
    return await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_programId_and_recordedAt", (q) => {
        const range = q
          .eq("tenantId", tenantId)
          .eq("status", filters.status)
          .eq("programId", programId);
        if (filters.startAt !== undefined && filters.endAt !== undefined) {
          return range
            .gte("recordedAt", filters.startAt)
            .lt("recordedAt", filters.endAt);
        }
        if (filters.endAt !== undefined) {
          return range.lt("recordedAt", filters.endAt);
        }
        if (filters.startAt !== undefined) {
          return range.gte("recordedAt", filters.startAt);
        }
        return range;
      })
      .order("desc")
      .paginate(paginationOpts);
  }

  if (filters.paymentType) {
    const paymentType = filters.paymentType;
    return await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_paymentType_and_recordedAt", (q) => {
        const range = q
          .eq("tenantId", tenantId)
          .eq("status", filters.status)
          .eq("paymentType", paymentType);
        if (filters.startAt !== undefined && filters.endAt !== undefined) {
          return range
            .gte("recordedAt", filters.startAt)
            .lt("recordedAt", filters.endAt);
        }
        if (filters.endAt !== undefined) {
          return range.lt("recordedAt", filters.endAt);
        }
        if (filters.startAt !== undefined) {
          return range.gte("recordedAt", filters.startAt);
        }
        return range;
      })
      .order("desc")
      .paginate(paginationOpts);
  }

  return await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_status_and_recordedAt", (q) => {
      const range = q.eq("tenantId", tenantId).eq("status", filters.status);
      if (filters.startAt !== undefined && filters.endAt !== undefined) {
        return range
          .gte("recordedAt", filters.startAt)
          .lt("recordedAt", filters.endAt);
      }
      if (filters.endAt !== undefined) {
        return range.lt("recordedAt", filters.endAt);
      }
      if (filters.startAt !== undefined) {
        return range.gte("recordedAt", filters.startAt);
      }
      return range;
    })
    .order("desc")
    .paginate(paginationOpts);
}

export async function takeBillingPaymentQuery(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  filters: BillingCountArgs,
  limit: number,
): Promise<Array<Doc<"paymentRecords">>> {
  assertBillingDateRange(filters);

  if (filters.programId && filters.paymentType) {
    const programId = filters.programId;
    const paymentType = filters.paymentType;
    return await ctx.db
      .query("paymentRecords")
      .withIndex(
        "by_tenantId_status_programId_paymentType_recordedAt",
        (q) => {
          const range = q
            .eq("tenantId", tenantId)
            .eq("status", filters.status)
            .eq("programId", programId)
            .eq("paymentType", paymentType);
          if (filters.startAt !== undefined && filters.endAt !== undefined) {
            return range
              .gte("recordedAt", filters.startAt)
              .lt("recordedAt", filters.endAt);
          }
          if (filters.endAt !== undefined) {
            return range.lt("recordedAt", filters.endAt);
          }
          if (filters.startAt !== undefined) {
            return range.gte("recordedAt", filters.startAt);
          }
          return range;
        },
      )
      .order("desc")
      .take(limit);
  }

  if (filters.programId) {
    const programId = filters.programId;
    return await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_programId_and_recordedAt", (q) => {
        const range = q
          .eq("tenantId", tenantId)
          .eq("status", filters.status)
          .eq("programId", programId);
        if (filters.startAt !== undefined && filters.endAt !== undefined) {
          return range
            .gte("recordedAt", filters.startAt)
            .lt("recordedAt", filters.endAt);
        }
        if (filters.endAt !== undefined) {
          return range.lt("recordedAt", filters.endAt);
        }
        if (filters.startAt !== undefined) {
          return range.gte("recordedAt", filters.startAt);
        }
        return range;
      })
      .order("desc")
      .take(limit);
  }

  if (filters.paymentType) {
    const paymentType = filters.paymentType;
    return await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_paymentType_and_recordedAt", (q) => {
        const range = q
          .eq("tenantId", tenantId)
          .eq("status", filters.status)
          .eq("paymentType", paymentType);
        if (filters.startAt !== undefined && filters.endAt !== undefined) {
          return range
            .gte("recordedAt", filters.startAt)
            .lt("recordedAt", filters.endAt);
        }
        if (filters.endAt !== undefined) {
          return range.lt("recordedAt", filters.endAt);
        }
        if (filters.startAt !== undefined) {
          return range.gte("recordedAt", filters.startAt);
        }
        return range;
      })
      .order("desc")
      .take(limit);
  }

  return await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_status_and_recordedAt", (q) => {
      const range = q.eq("tenantId", tenantId).eq("status", filters.status);
      if (filters.startAt !== undefined && filters.endAt !== undefined) {
        return range
          .gte("recordedAt", filters.startAt)
          .lt("recordedAt", filters.endAt);
      }
      if (filters.endAt !== undefined) {
        return range.lt("recordedAt", filters.endAt);
      }
      if (filters.startAt !== undefined) {
        return range.gte("recordedAt", filters.startAt);
      }
      return range;
    })
    .order("desc")
    .take(limit);
}
