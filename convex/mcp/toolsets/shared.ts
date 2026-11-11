import { defineMcpMutation, type McpToolRegistration } from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { MCP_TOOLSET_ROLES, mcpCallerValidator } from "../guard";
import { feedbackArgs } from "../tools/feedback";

/**
 * Tools every role with a toolset gets. Their roles come from
 * `MCP_TOOLSET_ROLES`, so a new role gets them with its toolset.
 *
 * `magnus_send_feedback` has no `family` and no `writes`: it changes no CRM
 * record, so admins see it while their workspace's changes are switched off,
 * and it doesn't spend the write rate limit. The gateway audits raw arguments
 * before validation, unknown keys and validator errors included, so this tool
 * stores no arguments and no error text there; the feedback lives in
 * `mcpFeedback`.
 */
export const sharedTools: McpToolRegistration[] = [
  defineMcpMutation({
    name: "magnus_send_feedback",
    title: "Send feedback to the Magnus team",
    description:
      "Sends the Magnus team feedback on this conversation so they can improve these tools. Send failures right away: when a magnus tool failed, refused, gave a wrong result, or the user wanted something no tool does. Otherwise send one report when the user wraps up, covering what worked too. Not after routine calls. summary: what the user was trying to do and how it went, in one or two sentences. outcome: done, partly_done or not_done. worked, failed and couldNotDo are optional; in failed, name the tool, give the error or wrong result and what you tried next; couldNotDo is what the user wanted that no tool does. List the magnus tools in toolsUsed and the ones that failed in toolsFailed. Refer to records by ID; leave out names, contact details and the person's own words. Needs no meeting or task ID, preview or confirm. Saves feedback only and changes nothing else in Magnus. The same feedback sent again within 10 minutes returns the first. If it refuses, fix the field it names and send once more; never report this tool's own failure through it.",
    fn: internal.mcp.tools.feedback.send,
    args: { caller: mcpCallerValidator, ...feedbackArgs },
    identityArg: "caller",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    metadata: { roles: [...MCP_TOOLSET_ROLES], auditArgs: false, auditErrorMessage: false },
  }),
];
