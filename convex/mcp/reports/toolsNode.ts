"use node";

import { v } from "convex/values";
import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { mcpCallerValidator } from "../guard";
import { numbersArgs, reportArgs } from "./contracts";
import { runReportTool } from "./tools";

// The report tools run in Node (512 MiB): one answer can be several
// megabytes, and a request merges and projects several of them.
export const numbers = internalAction({ args: { caller: mcpCallerValidator, ...numbersArgs }, returns: v.any(), handler: async (ctx, { caller, memberId, programId, closerId, ...args }): Promise<Record<string, unknown>> => runReportTool(ctx, caller, { kind: "numbers", ...args, ...await ctx.runQuery(internal.mcp.reports.planning.normalizeRequestIds, { memberId, programId, closerId }) }) });
export const report = internalAction({ args: { caller: mcpCallerValidator, ...reportArgs }, returns: v.any(), handler: async (ctx, { caller, memberId, programId, closerId, teamId, ...args }): Promise<Record<string, unknown>> => runReportTool(ctx, caller, { kind: "report", ...args, ...await ctx.runQuery(internal.mcp.reports.planning.normalizeRequestIds, { memberId, programId, closerId, teamId }) }) });
