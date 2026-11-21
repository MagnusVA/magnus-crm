import type { Doc } from "../_generated/dataModel";

const DAY_MS = 86_400_000;

export function payerDetailsDeadline(
  payment: Pick<Doc<"providerPayments">, "firstSeenAt" | "payerDetailsExpireAt">,
  state: Doc<"providerPayments">["reviewState"],
  resolvedAt?: number,
) {
  const initialDeadline = payment.payerDetailsExpireAt ??
    payment.firstSeenAt + (state === "needs_person" ? 180 : 90) * DAY_MS;
  return resolvedAt === undefined ? initialDeadline : Math.min(initialDeadline, resolvedAt + 90 * DAY_MS);
}
