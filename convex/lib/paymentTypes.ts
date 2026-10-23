import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";

export const PAYMENT_ORIGINS = [
  "closer_meeting",
  "closer_reminder",
  "admin_meeting",
  "admin_reminder",
  "admin_review_resolution",
  "closer_side_deal",
  "admin_side_deal",
  // Additional payments recorded against an already-won
  // opportunity (a customer making a further/installment payment).
  "closer_additional",
  "admin_additional",
] as const;

export const PAYMENT_TYPES = [
  "monthly",
  "split",
  "pif",
  "deposit",
] as const;

export type PaymentOrigin = (typeof PAYMENT_ORIGINS)[number];
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export type LegacyCompatiblePaymentFields = {
  attributedCloserId?: Id<"users">;
  closerId?: Id<"users">;
  origin?: string | null;
  recordedByUserId?: Id<"users">;
  loggedByAdminUserId?: Id<"users">;
  programName?: string;
};

export const paymentOriginValidator = v.union(
  v.literal("closer_meeting"),
  v.literal("closer_reminder"),
  v.literal("admin_meeting"),
  v.literal("admin_reminder"),
  v.literal("admin_review_resolution"),
  v.literal("closer_side_deal"),
  v.literal("admin_side_deal"),
  v.literal("closer_additional"),
  v.literal("admin_additional"),
);

export const paymentTypeValidator = v.union(
  v.literal("monthly"),
  v.literal("split"),
  v.literal("pif"),
  v.literal("deposit"),
);

const paymentOriginSet = new Set<string>(PAYMENT_ORIGINS);

/** A stored origin as one of today's; every legacy workflow is a deal payment. */
export function normalizePaymentOrigin(
  origin: string | undefined | null,
): PaymentOrigin {
  return origin && paymentOriginSet.has(origin)
    ? (origin as PaymentOrigin)
    : "closer_meeting";
}

export function resolvePaymentType(
  paymentType: PaymentType | undefined,
  fallback: PaymentType = "pif",
): PaymentType {
  return paymentType ?? fallback;
}

export function resolveLegacyCompatibleAttributedCloserId(
  payment: Pick<
    LegacyCompatiblePaymentFields,
    "attributedCloserId" | "closerId"
  >,
): Id<"users"> | undefined {
  if (payment.attributedCloserId !== undefined) {
    return payment.attributedCloserId;
  }
  return payment.closerId;
}

export function resolveLegacyCompatibleRecordedByUserId(
  payment: Pick<
    LegacyCompatiblePaymentFields,
    | "recordedByUserId"
    | "loggedByAdminUserId"
    | "closerId"
  >,
): Id<"users"> | undefined {
  if (payment.recordedByUserId !== undefined) {
    return payment.recordedByUserId;
  }
  if (payment.loggedByAdminUserId !== undefined) {
    return payment.loggedByAdminUserId;
  }
  return payment.closerId;
}

export function resolveLegacyCompatiblePaymentProgramName(
  payment: Pick<LegacyCompatiblePaymentFields, "programName">,
  customerProgramName?: string | null,
): string | undefined {
  const programName = payment.programName?.trim();
  if (programName) {
    return programName;
  }
  const fallbackProgramName = customerProgramName?.trim();
  return fallbackProgramName || undefined;
}

export type AssertablePaymentShape = {
  tenantId: Id<"tenants">;
  attributedCloserId: Id<"users"> | undefined;
  recordedByUserId: Id<"users">;
  origin: PaymentOrigin;
  opportunityId: Id<"opportunities"> | undefined;
  programId: Id<"tenantPrograms">;
  paymentType: PaymentType;
};
