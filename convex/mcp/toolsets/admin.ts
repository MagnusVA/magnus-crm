import { defineMcpMutation, type McpToolRegistration } from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { v } from "convex/values";
import { mcpCallerValidator } from "../guard";
import { adminReadTools } from "./adminReads";
import { adminReportTools } from "./adminReports";
import { adminWriteTools } from "./adminWrites";

/**
 * The admin toolset (docs/plans/admin-assistant.md §2). Every tool is an
 * internal Convex function that takes the injected `caller` and starts with
 * `requireMcpAdmin`. `metadata.roles` is what the gateway's `authorize`
 * checks; `metadata.family` names a write tool's kind of change, and
 * `authorize` hides the tool while the owner has it switched off.
 *
 * Read tools carry `readOnlyHint`. Prepare tools store a draft and change no
 * record, so they are writes that aren't destructive. `magnus_commit` is the
 * only destructive tool, so the client's own prompt lands on the step that
 * changes Magnus.
 */
export const ADMIN = { roles: ["tenant_master", "tenant_admin"] };

export const adminTools: McpToolRegistration[] = [
  ...adminReadTools,
  ...adminReportTools,
  ...adminWriteTools,
  defineMcpMutation({
    name: "magnus_commit",
    title: "Apply a prepared change",
    description:
      "Applies one change a magnus_* prepare tool returned. Pass the prepare result's `commit` object unchanged: confirmToken, action, target and summary. Magnus checks them against what it prepared, re-reads every record the change depends on, and writes nothing if one changed (status stale). Call it only after reading the preview to the admin and hearing a clear yes. A plan (payment reviews, covering a closer, a loss) is approved in Magnus instead; this returns its link. A repeated commit returns the first result.",
    fn: internal.mcp.admin.commit.commit,
    args: {
      caller: mcpCallerValidator,
      confirmToken: v.string(),
      action: v.string(),
      target: v.object({ kind: v.string(), id: v.string(), label: v.string() }),
      summary: v.string(),
    },
    identityArg: "caller",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    metadata: { ...ADMIN, writes: true, auditArgs: { redact: ["confirmToken"] } },
  }),
];
