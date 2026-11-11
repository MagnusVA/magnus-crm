import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { log } from "../../lib/observability/log";
import { rejectRequest } from "../../lib/observability/errors";
import { sha256Hex, stableJson } from "../confirm";
import { MCP_TOOLSET_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { FEEDBACK_OUTCOMES } from "../schema";

/**
 * `magnus_send_feedback`: an agent's report on a conversation, for the Magnus
 * team. Every role with a toolset can send it. It changes no CRM record, so it
 * carries no write family and works while an admin's changes are switched off.
 *
 * `outcome` and the tool names are plain strings checked here: a validator
 * failure reaches the agent only as "Tool execution failed", while a
 * `rejectRequest` tells it what to fix. Refusals never echo the text sent.
 */
export const feedbackArgs = {
  summary: v.string(),
  outcome: v.string(),
  // Some clients send every optional field, as null or "": both mean omitted.
  worked: v.optional(v.union(v.string(), v.null())),
  failed: v.optional(v.union(v.string(), v.null())),
  couldNotDo: v.optional(v.union(v.string(), v.null())),
  toolsUsed: v.optional(v.union(v.array(v.string()), v.null())),
  toolsFailed: v.optional(v.union(v.array(v.string()), v.null())),
};

const SUMMARY_MAX = 2_000;
const TEXT_MAX = 4_000;
const TOOLS_MAX = 30;
// Clients prefix tool names (`mcp__<server>__magnus_today`, `server.magnus_today`),
// so the Magnus name is the trailing `magnus_…` after `__` or a separator.
const TRAILING_TOOL = /(?:^|__|[^a-z0-9_])(magnus_[a-z0-9_]{1,57})$/;
const TOOL_NAME = /^magnus_[a-z0-9]+(?:_[a-z0-9]+){0,15}$/;
/** A repeat of the same feedback inside this window is a retry. */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Reports per user per 24 hours; stops an agent stuck in a loop. */
export const FEEDBACK_DAILY_CAP = 30;

type Outcome = (typeof FEEDBACK_OUTCOMES)[number];
type ToolsetRole = (typeof MCP_TOOLSET_ROLES)[number];

function isToolsetRole(role: string): role is ToolsetRole {
  return (MCP_TOOLSET_ROLES as readonly string[]).includes(role);
}

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw rejectRequest(
      "feedback.invalid_text",
      `${field} must have between 1 and ${max.toLocaleString("en-US")} characters.`,
    );
  }
  return trimmed;
}

function optionalText(value: string | null | undefined, field: string): string | undefined {
  return value == null || !value.trim() ? undefined : text(value, field, TEXT_MAX);
}

function toolNames(values: string[] | null | undefined, field: string): string[] {
  if (!values) return [];
  if (values.length > TOOLS_MAX) {
    throw rejectRequest("feedback.too_many_tools", `${field} can list at most ${TOOLS_MAX} tools.`);
  }
  const names = values.map((name) => TRAILING_TOOL.exec(name.trim().toLowerCase())?.[1] ?? "");
  if (names.some((name) => !TOOL_NAME.test(name))) {
    throw rejectRequest(
      "feedback.invalid_tool",
      `Each name in ${field} must be a Magnus tool name, such as magnus_today.`,
    );
  }
  return [...new Set(names)].sort();
}

export const send = internalMutation({
  args: { caller: mcpCallerValidator, ...feedbackArgs },
  returns: v.object({
    feedbackId: v.id("mcpFeedback"),
    alreadySaved: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, { caller, ...args }) => {
    // First, so a blocked or switched-off caller can't even read a receipt.
    const me = await requireMcpUser(ctx, caller, MCP_TOOLSET_ROLES);
    // requireMcpUser already refused any other role; this narrows the type.
    if (!isToolsetRole(me.role)) throw new Error(`Unexpected MCP role: ${me.role}`);

    if (!(FEEDBACK_OUTCOMES as readonly string[]).includes(args.outcome)) {
      throw rejectRequest(
        "feedback.invalid_outcome",
        `outcome must be one of ${FEEDBACK_OUTCOMES.join(", ")}.`,
      );
    }
    const toolsFailed = toolNames(args.toolsFailed, "toolsFailed");
    const content = {
      summary: text(args.summary, "summary", SUMMARY_MAX),
      outcome: args.outcome as Outcome,
      worked: optionalText(args.worked, "worked"),
      failed: optionalText(args.failed, "failed"),
      couldNotDo: optionalText(args.couldNotDo, "couldNotDo"),
      // A tool that failed was used.
      toolsUsed: [...new Set([...toolNames(args.toolsUsed, "toolsUsed"), ...toolsFailed])].sort(),
      toolsFailed,
    };
    // Content only: a retry may come back through another client.
    const contentHash = await sha256Hex(stableJson(content));
    const now = Date.now();

    // One bounded read serves the retry check and the daily cap. The retry
    // check runs first, so a retry of the last report allowed still returns it.
    const recent = await ctx.db
      .query("mcpFeedback")
      .withIndex("by_tenantId_and_userId_and_createdAt", (q) =>
        q.eq("tenantId", me.tenantId).eq("userId", me.userId).gte("createdAt", now - DAY_MS),
      )
      .order("desc")
      .take(FEEDBACK_DAILY_CAP);
    const existing = recent.find(
      (row) => row.createdAt >= now - DEDUPE_WINDOW_MS && row.contentHash === contentHash,
    );
    if (existing) {
      return {
        feedbackId: existing._id,
        alreadySaved: true,
        message: "Already saved. Don't send it again for this task.",
      };
    }
    if (recent.length >= FEEDBACK_DAILY_CAP) {
      throw rejectRequest(
        "feedback.too_many",
        `You've sent ${FEEDBACK_DAILY_CAP} feedback reports in the last 24 hours. Send the next one tomorrow.`,
      );
    }

    const feedbackId = await ctx.db.insert("mcpFeedback", {
      tenantId: me.tenantId,
      userId: me.userId,
      role: me.role,
      agentClient: me.agentClient,
      ...content,
      contentHash,
      createdAt: now,
    });
    // IDs, codes and checked tool names only: the text stays in Convex.
    log.info("mcp.feedback.saved", {
      feedbackId,
      role: me.role,
      outcome: content.outcome,
      agentClient: me.agentClient,
      toolsFailed: content.toolsFailed.join(","),
    });
    return {
      feedbackId,
      alreadySaved: false,
      message: "Saved for the Magnus team. Don't send it again for this task.",
    };
  },
});
