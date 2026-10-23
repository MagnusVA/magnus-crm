import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DEFAULT_BUSINESS_DAY, type BusinessDaySetting } from "../../lib/businessDay";

// Contexts belong to one transaction. The auth guard already reads the tenant;
// share that read with nested reporting helpers without caching across requests.
const settings = new WeakMap<QueryCtx, Map<Id<"tenants">, BusinessDaySetting>>();
export function rememberTenantBusinessDay(ctx: QueryCtx, tenant: Doc<"tenants">) {
  let tenants = settings.get(ctx);
  if (!tenants) { tenants = new Map(); settings.set(ctx, tenants); }
  const setting = tenant.businessDay ?? DEFAULT_BUSINESS_DAY;
  tenants.set(tenant._id, setting);
  return setting;
}
export async function getTenantBusinessDay(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<BusinessDaySetting> {
  const cached = settings.get(ctx)?.get(tenantId);
  if (cached) return cached;
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) throw new Error(`Missing tenant ${tenantId}`);
  return rememberTenantBusinessDay(ctx, tenant);
}
