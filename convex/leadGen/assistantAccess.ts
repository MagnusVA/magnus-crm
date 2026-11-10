import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { rejectRequest } from "../lib/observability/errors";

export type LeadGenAssistantCaller = {
  tenantId: Id<"tenants">;
  userId: Id<"users">;
  role: string;
};

/** Resolve only an existing, active worker. Assistant reads never provision staff. */
export async function requireOwnLeadGenWorker(ctx: QueryCtx, caller: LeadGenAssistantCaller) {
  const [user, worker] = await Promise.all([
    ctx.db.get("users", caller.userId),
    ctx.db.query("leadGenWorkers").withIndex("by_tenantId_and_userId", q =>
      q.eq("tenantId", caller.tenantId).eq("userId", caller.userId)).unique(),
  ]);
  if (caller.role !== "lead_generator" || !user?.isActive || user.deletedAt !== undefined ||
      user.role !== "lead_generator" || user.tenantId !== caller.tenantId ||
      !worker?.isActive || worker.tenantId !== caller.tenantId || worker.userId !== caller.userId) {
    throw rejectRequest("lead_gen.inactive", "Lead gen access isn't active for you. Ask an admin.");
  }
  return worker;
}
