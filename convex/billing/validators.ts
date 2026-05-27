import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { paymentTypeValidator } from "../lib/paymentTypes";

export const billingStatusValidator = v.union(
  v.literal("recorded"),
  v.literal("verified"),
  v.literal("disputed"),
);

export const billingQueueFiltersValidator = {
  status: billingStatusValidator,
  programId: v.optional(v.id("tenantPrograms")),
  paymentType: v.optional(paymentTypeValidator),
  startAt: v.optional(v.number()),
  endAt: v.optional(v.number()),
};

export const listPaymentsArgsValidator = {
  ...billingQueueFiltersValidator,
  paginationOpts: paginationOptsValidator,
};

export const correctPaymentArgsValidator = {
  paymentRecordId: v.id("paymentRecords"),
  amount: v.optional(v.number()),
  paymentType: v.optional(paymentTypeValidator),
  programId: v.optional(v.id("tenantPrograms")),
  referenceCode: v.optional(v.string()),
  note: v.optional(v.string()),
  reason: v.string(),
};

export const correctPaymentReturnValidator = v.object({
  paymentRecordId: v.id("paymentRecords"),
  status: billingStatusValidator,
  returnedToReview: v.boolean(),
  changed: v.boolean(),
});

export const exportPaymentsArgsValidator = {
  ...billingQueueFiltersValidator,
  limit: v.optional(v.number()),
};
