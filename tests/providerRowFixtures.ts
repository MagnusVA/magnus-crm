import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { PaymentType } from "../convex/lib/paymentTypes";
import { insertPaymentAggregate } from "../convex/reporting/writeHooks";

/**
 * A payment row as the CRM stores one created from a provider payment
 * (docs/agents/payments.md): `origin` and `recordedVia` are `provider`.
 * `recorder: "absent"` is the row nobody confirmed. Inserted through the real
 * aggregate hook, so reports see it. Synthetic values only.
 */
export async function seedProviderRow(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    programId: Id<"tenantPrograms">;
    programName?: string;
    amountMinor: number;
    currency?: string;
    paymentType?: PaymentType;
    recordedAt: number;
    recorder: Id<"users"> | "absent";
    status?: "recorded" | "verified" | "disputed";
    meetingId?: Id<"meetings">;
    providerPaymentId?: Id<"providerPayments">;
    providerPaidAt?: number;
  },
): Promise<Id<"paymentRecords">> {
  const paymentId = await ctx.db.insert("paymentRecords", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    meetingId: args.meetingId,
    attributedCloserId: args.closerId,
    amountMinor: args.amountMinor,
    currency: args.currency ?? "USD",
    ...(args.recorder === "absent" ? {} : { recordedByUserId: args.recorder }),
    programId: args.programId,
    programName: args.programName ?? "Program A",
    paymentType: args.paymentType ?? "pif",
    status: args.status ?? "recorded",
    statusChangedAt: args.recordedAt,
    recordedAt: args.recordedAt,
    origin: "provider",
    recordedVia: "provider",
    providerPaymentId: args.providerPaymentId,
    providerPaidAt: args.providerPaidAt ?? args.recordedAt,
  });
  await insertPaymentAggregate(ctx, paymentId);
  return paymentId;
}
