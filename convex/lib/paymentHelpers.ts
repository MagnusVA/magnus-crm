import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AssertablePaymentShape } from "./paymentTypes";

export type {
  AssertablePaymentShape,
  PaymentOrigin,
  PaymentType,
} from "./paymentTypes";

export function assertPaymentRow(row: AssertablePaymentShape): void {
  if (row.attributedCloserId === undefined) {
    throw new Error("[Payments] invariant: payment row must have attributedCloserId");
  }

  // Every payment is on a deal: the customer payment that had none is
  // retired (docs/plans/phase-4-customers.md §5).
  if (row.opportunityId === undefined) {
    throw new Error("[Payments] invariant: payment row must link to an opportunity");
  }
}

export async function requireActiveProgram(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms">,
) {
  const program = await ctx.db.get("tenantPrograms", programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found");
  }
  if (program.archivedAt !== undefined) {
    throw new Error(
      `Program "${program.name}" is archived and cannot accept new payments. Restore it in Settings → Programs first.`,
    );
  }
  return program;
}

export async function resolveProgramForWrite(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms">,
) {
  return await requireActiveProgram(ctx, tenantId, programId);
}
