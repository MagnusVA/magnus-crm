import { internalQuery } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const requireTenantAdminForPortal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const access = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return {
      tenantId: access.tenantId,
      userId: access.userId,
      role: access.role,
    };
  },
});
