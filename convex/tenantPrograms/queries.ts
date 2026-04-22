import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { listProgramsForTenant, sortProgramsForDisplay } from "./shared";

export const listPrograms = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, { includeArchived }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const programs = await listProgramsForTenant(ctx, tenantId);
    const filtered = includeArchived
      ? programs
      : programs.filter((program) => program.archivedAt === undefined);

    return sortProgramsForDisplay(filtered);
  },
});
