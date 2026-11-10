import { buildBookingHealthIssues } from "./bookingHealthCore";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listRecentBookingHealthIssues = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return await buildBookingHealthIssues(ctx, tenantId);
  },
});
