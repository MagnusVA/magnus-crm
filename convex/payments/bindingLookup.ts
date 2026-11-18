import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type BindingKind = Doc<"paymentProviderBindings">["kind"];

/** The enabled binding for one provider id, or null. */
export async function findEnabledBinding(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    connectionId: Id<"tenantPaymentConnections">;
    kind: BindingKind;
    externalId: string;
  },
): Promise<Doc<"paymentProviderBindings"> | null> {
  const rows = await ctx.db
    .query("paymentProviderBindings")
    .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("connectionId", args.connectionId)
        .eq("kind", args.kind)
        .eq("externalId", args.externalId),
    )
    .take(8);
  return rows.find((row) => row.enabled) ?? null;
}
