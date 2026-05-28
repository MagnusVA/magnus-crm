import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { getOverviewDashboardData } from "./overviewBuilders";
import { overviewRangeValidator } from "./overviewRange";

export const getOverviewDashboard = query({
  args: {
    range: overviewRangeValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return await getOverviewDashboardData(ctx, {
      tenantId,
      range: args.range,
      now: Date.now(),
    });
  },
});
