import {
  defineMcpAction,
  defineMcpQuery,
  type McpToolRegistration,
} from "convex-mcp-gateway";
import { internal } from "../../_generated/api";
import { mcpCallerValidator } from "../guard";
import { floorArgs, rosterArgs } from "../tools/leadGenFloor";
import { submissionsArgs } from "../tools/leadGenSubmissions";

/**
 * The admin's lead gen toolset (docs/plans/lead-gen-assistant.md §2): the
 * floor, roster and raw submissions under the admin assistant's access.
 * Both admin roles get it. The shared handle check is registered with the
 * lead gen toolset.
 */
const ADMIN = { roles: ["tenant_admin", "tenant_master"] };
const READ = { readOnlyHint: true, openWorldHint: false };

export const leadGenAdminTools: McpToolRegistration[] = [
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
      "Raw captures, newest first, up to 25 a page: submissionId, handle, specialist, team at capture time, origin, time and void details. Pass range (today, this_week, last_week, this_month) or startDate and endDate as business dates (YYYY-MM-DD), and optionally workerId, teamId or source. isPartial with a cursor means Magnus stopped early; call again with the cursor. Open the Operations lead gen page to void a capture. Read-only.",
    fn: internal.mcp.tools.leadGenSubmissions.list,
    args: { caller: mcpCallerValidator, ...submissionsArgs },
    identityArg: "caller",
    annotations: READ,
    metadata: ADMIN,
  }),
];
