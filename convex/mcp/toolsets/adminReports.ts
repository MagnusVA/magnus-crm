import { defineMcpAction, type McpToolRegistration } from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { mcpCallerValidator } from "../guard";
import { numbersArgs, reportArgs } from "../reports/contracts";
const metadata = { roles: ["tenant_master", "tenant_admin"] };
const annotations = { readOnlyHint: true, openWorldHint: false };
export const adminReportTools: McpToolRegistration[] = [
  defineMcpAction({ name: "magnus_numbers", title: "Metrics and comparisons", description: "One or a few metrics, or a comparison. Magnus plans live versus warehouse like the page, computes deltas and omitted groups, and labels separate non-additive windows. Money is per currency; final_cash excludes deposits. Rates compare in percentage points. Pending data has no numbers; retry the same arguments. Default 10 groups, maximum 25 and 60 period × group cells.", fn: internal.mcp.reports.tools.numbers, args: { caller: mcpCallerValidator, ...numbersArgs }, identityArg: "caller", annotations, metadata }),
  defineMcpAction({ name: "magnus_report", title: "Full report page", description: "A page's full breakdown: revenue, booked_vs_sold, team, pipeline, goals, leads, reminders, qualifications or lead_gen. Uses that page's source switch and builders. Pipeline distribution and aging are current state; goals use the last 30 completed business days. Blended currency totals are withheld. Pending data has no numbers; retry the same arguments. Default 10 rows, maximum 25.", fn: internal.mcp.reports.tools.report, args: { caller: mcpCallerValidator, ...reportArgs }, identityArg: "caller", annotations, metadata }),
];
