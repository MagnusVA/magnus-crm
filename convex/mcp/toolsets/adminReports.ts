import { defineMcpAction, type McpToolRegistration } from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { mcpCallerValidator } from "../guard";
import { numbersArgs, reportArgs } from "../reports/contracts";
const metadata = { roles: ["tenant_master", "tenant_admin"] };
const annotations = { readOnlyHint: true, openWorldHint: false };
export const adminReportTools: McpToolRegistration[] = [
  defineMcpAction({ name: "magnus_numbers", title: "Metrics and comparisons", description: "One or a few metrics, or a comparison. Magnus uses the current Scorecard, Calls, People or Operations page switch for each metric and plans live versus warehouse like that page, computes deltas and omitted groups, and labels separate non-additive windows. Money is per currency; final_cash excludes deposits. Rates compare in percentage points. Pending data has no numbers; retry the same arguments. Default 10 groups, maximum 25 and 60 period × group cells.", fn: internal.mcp.reports.tools.numbers, args: { caller: mcpCallerValidator, ...numbersArgs }, identityArg: "caller", annotations, metadata }),
  defineMcpAction({ name: "magnus_report", title: "Full report page", description: "One current Reports page: scorecard, calls, people, attribution or pipeline. People accepts memberId for a member's role sections; member work logs are omitted. Scorecard accepts programId and fieldKey, Calls accepts programId, closerId and callType. Uses the page's warehouse switch, range plan, readers and merges. Pipeline is current state and ignores range. Operations dashboards qualifications and lead_gen remain available separately; teamId filters lead_gen. Money stays per currency. Log is available in Magnus only. Pending data has no numbers; retry the same arguments. Default 10 rows, maximum 25, answer capped at 12 KiB.", fn: internal.mcp.reports.tools.report, args: { caller: mcpCallerValidator, ...reportArgs }, identityArg: "caller", annotations, metadata }),
];
