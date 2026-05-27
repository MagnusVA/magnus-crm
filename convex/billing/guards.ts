import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Permission } from "../lib/permissions";
import { hasPermission } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";

const BILLING_ROLES = ["tenant_master", "tenant_admin"] as const;

export class BillingOpsDisabledError extends Error {
  constructor() {
    super("Billing Ops is not enabled for this tenant.");
    this.name = "BillingOpsDisabledError";
  }
}

export async function requireBillingPermission(
  ctx: QueryCtx | MutationCtx,
  permission: Permission,
) {
  const session = await requireTenantUser(ctx, [...BILLING_ROLES]);
  if (!hasPermission(session.role, permission)) {
    throw new Error("Insufficient Billing permissions.");
  }
  return session;
}

export async function requireBillingOpsEnabled(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
) {
  const tenant = await ctx.db.get(tenantId);
  if (!tenant || tenant.billingOpsEnabled !== true) {
    throw new BillingOpsDisabledError();
  }
  return tenant;
}
