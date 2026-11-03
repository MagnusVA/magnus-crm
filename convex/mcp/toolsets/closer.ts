import { defineMcpMutation, defineMcpQuery, type McpToolRegistration } from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { mcpCallerValidator } from "../guard";

/**
 * The closer toolset (docs/plans/closer-assistant.md §6.2). Every tool is an
 * internal Convex function that takes the injected `caller` and starts with
 * `requireMcpUser`; `metadata.roles` is what the gateway's `authorize` checks
 * for `tools/list` and `tools/call`. Annotated as `McpToolRegistration[]`
 * because this module is part of the generated API.
 */
const CLOSER = { roles: ["closer"] };

export const closerTools: McpToolRegistration[] = [
  defineMcpQuery({
    name: "magnus_today",
    title: "Today in Magnus",
    description:
      "The closer's shift: every meeting with its ID, person, program, deal stage, attendance, latest call note, open tasks, payments, recording and second opinion; calls still Not recorded first; tasks overdue, today and later; recordings without a meeting. Call this first. Times are in the closer's zone. Read-only.",
    fn: internal.mcp.tools.today.run,
    args: { caller: mcpCallerValidator },
    identityArg: "caller",
    annotations: { readOnlyHint: true, openWorldHint: false },
    metadata: CLOSER,
  }),
  defineMcpMutation({
    name: "magnus_proof_upload_url",
    title: "Get a proof upload URL",
    description:
      "For agents with a shell. Returns a single-use URL that expires in 10 minutes. POST the receipt's raw bytes to it (curl --data-binary @file <url>), then pass the uploadId to magnus_log_payment. JPEG, PNG, GIF or PDF, up to 10 MB.",
    fn: internal.mcp.uploads.issueUploadUrl,
    args: { caller: mcpCallerValidator },
    identityArg: "caller",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    metadata: CLOSER,
  }),
];
