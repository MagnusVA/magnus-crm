import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const supportTicketStatusValidator = v.union(
  v.literal("new"),
  v.literal("reviewed"),
  v.literal("closed"),
);

export const listSupportTickets = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(supportTicketStatusValidator),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const result =
      args.statusFilter !== undefined
        ? await ctx.db
            .query("supportTickets")
            .withIndex("by_status_and_createdAt", (q) =>
              q.eq("status", args.statusFilter!),
            )
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("supportTickets")
            .withIndex("by_createdAt")
            .order("desc")
            .paginate(args.paginationOpts);

    console.log("[Admin] listSupportTickets completed", {
      resultCount: result.page.length,
      isDone: result.isDone,
      statusFilter: args.statusFilter ?? "none",
    });

    return result;
  },
});
