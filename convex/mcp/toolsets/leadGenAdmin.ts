import {
  defineMcpAction,
  defineMcpMutation,
  defineMcpQuery,
  type McpToolRegistration,
} from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { mcpCallerValidator } from "../guard";
import { floorArgs, rosterArgs } from "../tools/leadGenFloor";
import { reportArgs } from "../tools/leadGenReport";
import { submissionsArgs } from "../tools/leadGenSubmissions";
import { voidArgs } from "../tools/leadGenVoid";

/**
 * The admin's lead gen toolset (docs/plans/lead-gen-assistant.md §2): the
 * Operations report, today's floor, the roster, raw submissions and a void.
 * Both admin roles get it. The shared handle check is registered with the
 * lead gen toolset.
 */
const ADMIN = { roles: ["tenant_admin", "tenant_master"] };
const READ = { readOnlyHint: true, openWorldHint: false };

export const leadGenAdminTools: McpToolRegistration[] = [
  defineMcpAction({
    name: "magnus_lead_gen_report",
    title: "Lead gen report",
    description:
      "The Operations lead gen report. Pass range (today, this_week, last_week, this_month) or startDate and endDate as business dates (YYYY-MM-DD), and sections: overview, specialists, teams, top_posts, conversions, respark (default overview and specialists). The only filter is source (instagram or meta_business); rows carry specialist and team so you can cite one. Each section returns its rows, the filters it applied, its definitions, where the numbers came from (live, warehouse or snapshot), asOf and a state. A section that is pending, failed or rebuilding has no numbers: say so and try again shortly. capped and rankingPartial mean the list is incomplete. cursor continues one section. Read-only.",
    fn: internal.mcp.tools.leadGenReport.report,
    args: { caller: mcpCallerValidator, ...reportArgs },
    identityArg: "caller",
    annotations: READ,
    metadata: ADMIN,
  }),
  defineMcpQuery({
    name: "magnus_lead_gen_floor",
    title: "Lead gen floor today",
    description:
      "Today per specialist, starting from the roster and schedules: scheduled hours, captures, unique, dupes, resparks, not a fit, last capture time and open batch progress. Magnus sets the flags scheduled_no_entries, no_team and inactive_with_schedule. Pass teamId for one team; cursor continues the list. asOf says when Magnus counted; isPartial says a count is incomplete. A specialist with no captures yet may not have started; the tool can't tell why. Read-only.",
    fn: internal.mcp.tools.leadGenFloor.floor,
    args: { caller: mcpCallerValidator, ...floorArgs },
    identityArg: "caller",
    annotations: READ,
    metadata: ADMIN,
  }),
  defineMcpQuery({
    name: "magnus_lead_gen_roster",
    title: "Lead gen roster",
    description:
      "The lead gen roster: specialists with status, team and weekly scheduled hours, the teams, and the respark rules (inactive after days, batch size). Inactive specialists are left out unless includeInactive is true. cursor continues the list. Read-only.",
    fn: internal.mcp.tools.leadGenFloor.roster,
    args: { caller: mcpCallerValidator, ...rosterArgs },
    identityArg: "caller",
    annotations: READ,
    metadata: ADMIN,
  }),
  defineMcpAction({
    name: "magnus_lead_gen_submissions",
    title: "Raw lead gen submissions",
    description:
      "Raw captures, newest first, up to 25 a page: submissionId, handle, specialist, team at capture time, origin, time and void details. Pass range (today, this_week, last_week, this_month) or startDate and endDate as business dates (YYYY-MM-DD), and optionally workerId, teamId or source. isPartial with a cursor means Magnus stopped early; call again with the cursor. Use the submissionId with magnus_void_capture. Read-only.",
    fn: internal.mcp.tools.leadGenSubmissions.list,
    args: { caller: mcpCallerValidator, ...submissionsArgs },
    identityArg: "caller",
    annotations: READ,
    metadata: ADMIN,
  }),
  defineMcpMutation({
    name: "magnus_void_capture",
    title: "Void a capture",
    description:
      "Removes one wrong capture's report credit. Pass the submissionId from magnus_lead_gen_submissions or magnus_check_handles and a reason in the admin's words. A void can't be undone, and it does not rewind lifetime counters or past deal credit. Two calls: confirm: false returns Magnus's preview (handle, specialist, day, the credit removed and what stays) and a confirmToken; read it back word for word, and only after a clear yes call again with the same arguments, confirm: true and the token. A capture that is already voided gets no token.",
    fn: internal.mcp.tools.leadGenVoid.voidCapture,
    args: { caller: mcpCallerValidator, ...voidArgs },
    identityArg: "caller",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    metadata: { ...ADMIN, auditArgs: { redact: ["reason"] } },
  }),
];
