import { buildDirectory } from "./directoryCore";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { directoryValidator } from "./contracts";

export const getDirectory = query({
  args: {}, returns: directoryValidator,
  handler: async ctx => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    return await buildDirectory(ctx, tenantId);
  },
});
