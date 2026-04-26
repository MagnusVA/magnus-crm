import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";

export const COMMISSIONABLE_ORIGINS = [
  "closer_meeting",
  "closer_reminder",
  "admin_meeting",
  "admin_reminder",
  "admin_review_resolution",
  "closer_side_deal",
  "admin_side_deal",
] as const;

export const NON_COMMISSIONABLE_ORIGINS = [
  "customer_direct",
  "bookkeeper_direct",
] as const;

export const LEGACY_NON_COMMISSIONABLE_ORIGINS = [
  "customer_flow",
] as const;

export const PAYMENT_TYPES = [
  "monthly",
  "split",
  "pif",
  "deposit",
] as const;

export type CommissionableOrigin = (typeof COMMISSIONABLE_ORIGINS)[number];
export type NonCommissionableOrigin = (typeof NON_COMMISSIONABLE_ORIGINS)[number];
export type LegacyNonCommissionableOrigin =
  (typeof LEGACY_NON_COMMISSIONABLE_ORIGINS)[number];
export type PaymentOrigin = CommissionableOrigin | NonCommissionableOrigin;
export type LegacyCompatiblePaymentOrigin =
  | PaymentOrigin
  | LegacyNonCommissionableOrigin;
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export type LegacyCompatibleCustomerFields = {
  programName?: string;
  programType?: string;
};
export type LegacyCompatiblePaymentFields = {
  attributedCloserId?: Id<"users">;
  closerId?: Id<"users">;
  commissionable?: boolean;
  contextType: "opportunity" | "customer";
  origin?: string | null;
  recordedByUserId?: Id<"users">;
  loggedByAdminUserId?: Id<"users">;
  programName?: string;
};

export const commissionableOriginValidator = v.union(
  v.literal("closer_meeting"),
  v.literal("closer_reminder"),
  v.literal("admin_meeting"),
  v.literal("admin_reminder"),
  v.literal("admin_review_resolution"),
  v.literal("closer_side_deal"),
  v.literal("admin_side_deal"),
);

export const nonCommissionableOriginValidator = v.union(
  v.literal("customer_direct"),
  v.literal("bookkeeper_direct"),
);

export const paymentOriginValidator = v.union(
  v.literal("closer_meeting"),
  v.literal("closer_reminder"),
  v.literal("admin_meeting"),
  v.literal("admin_reminder"),
  v.literal("admin_review_resolution"),
  v.literal("closer_side_deal"),
  v.literal("admin_side_deal"),
  v.literal("customer_direct"),
  v.literal("bookkeeper_direct"),
);

export const paymentTypeValidator = v.union(
  v.literal("monthly"),
  v.literal("split"),
  v.literal("pif"),
  v.literal("deposit"),
);

const commissionableOriginSet = new Set<string>(COMMISSIONABLE_ORIGINS);
const nonCommissionableOriginSet = new Set<string>(NON_COMMISSIONABLE_ORIGINS);
const legacyNonCommissionableOriginSet = new Set<string>([
  ...NON_COMMISSIONABLE_ORIGINS,
  ...LEGACY_NON_COMMISSIONABLE_ORIGINS,
]);

export function isCommissionableOrigin(
  origin: string | undefined | null,
): origin is CommissionableOrigin {
  return origin !== undefined && origin !== null && commissionableOriginSet.has(origin);
}

export function isNonCommissionableOrigin(
  origin: string | undefined | null,
): origin is NonCommissionableOrigin {
  return (
    origin !== undefined &&
    origin !== null &&
    nonCommissionableOriginSet.has(origin)
  );
}

export function isLegacyCompatibleNonCommissionableOrigin(
  origin: string | undefined | null,
): origin is NonCommissionableOrigin | LegacyNonCommissionableOrigin {
  return (
    origin !== undefined &&
    origin !== null &&
    legacyNonCommissionableOriginSet.has(origin)
  );
}

export function normalizePaymentOrigin(
  origin: string | undefined | null,
  contextType: "opportunity" | "customer",
): PaymentOrigin {
  if (origin === "customer_flow") {
    return "customer_direct";
  }
  if (isCommissionableOrigin(origin) || isNonCommissionableOrigin(origin)) {
    return origin;
  }
  return contextType === "customer" ? "customer_direct" : "closer_meeting";
}

export function resolvePaymentType(
  paymentType: PaymentType | undefined,
  fallback: PaymentType = "pif",
): PaymentType {
  return paymentType ?? fallback;
}

export function resolveLegacyCompatiblePaymentCommissionable(
  payment: Pick<
    LegacyCompatiblePaymentFields,
    "commissionable" | "contextType" | "origin"
  >,
): boolean {
  if (payment.commissionable !== undefined) {
    return payment.commissionable;
  }
  return !isLegacyCompatibleNonCommissionableOrigin(
    normalizePaymentOrigin(payment.origin, payment.contextType),
  );
}

export function resolveLegacyCompatibleAttributedCloserId(
  payment: Pick<
    LegacyCompatiblePaymentFields,
    "attributedCloserId" | "closerId" | "commissionable" | "contextType" | "origin"
  >,
): Id<"users"> | undefined {
  if (payment.attributedCloserId !== undefined) {
    return payment.attributedCloserId;
  }
  return resolveLegacyCompatiblePaymentCommissionable(payment)
    ? payment.closerId
    : undefined;
}

export function resolveLegacyCompatibleRecordedByUserId(
  payment: Pick<
    LegacyCompatiblePaymentFields,
    | "recordedByUserId"
    | "loggedByAdminUserId"
    | "closerId"
    | "commissionable"
    | "contextType"
    | "origin"
  >,
): Id<"users"> | undefined {
  if (payment.recordedByUserId !== undefined) {
    return payment.recordedByUserId;
  }
  if (payment.loggedByAdminUserId !== undefined) {
    return payment.loggedByAdminUserId;
  }
  return resolveLegacyCompatiblePaymentCommissionable(payment)
    ? payment.closerId
    : payment.closerId;
}

export function resolveLegacyCompatibleCustomerProgramName(
  customer: LegacyCompatibleCustomerFields,
): string | undefined {
  const programName = customer.programName?.trim();
  if (programName) {
    return programName;
  }
  const legacyProgramType = customer.programType?.trim();
  return legacyProgramType || undefined;
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
  commissionable: boolean;
  attributedCloserId: Id<"users"> | undefined;
  recordedByUserId: Id<"users">;
  origin: PaymentOrigin;
  contextType: "opportunity" | "customer";
  opportunityId: Id<"opportunities"> | undefined;
  customerId: Id<"customers"> | undefined;
  programId: Id<"tenantPrograms">;
  paymentType: PaymentType;
};
