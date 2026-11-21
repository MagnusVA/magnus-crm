import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Binding = Doc<"paymentProviderBindings">["binding"];
type Connection = Pick<Doc<"providerPayments">, "tenantId" | "connectionId">;

/** Only the latest version can apply. Two enabled versions require review. */
export async function findEnabledBinding<K extends Binding["kind"]>(
  ctx: QueryCtx | MutationCtx,
  { tenantId, connectionId }: Connection,
  kind: K,
  externalId?: string,
): Promise<Extract<Binding, { kind: K }> | null | "ambiguous"> {
  if (!externalId) return null;
  const rows = await ctx.db
    .query("paymentProviderBindings")
    .withIndex("by_tenantId_and_connectionId_and_kind_and_externalId", (q) =>
      q.eq("tenantId", tenantId).eq("connectionId", connectionId)
        .eq("kind", kind).eq("externalId", externalId))
    .order("desc")
    .take(2);
  const [current, previous] = rows;
  if ((current && current.binding.kind !== kind) || previous?.enabled) return "ambiguous";
  if (!current?.enabled) return null;
  return current.binding as Extract<Binding, { kind: K }>;
}
