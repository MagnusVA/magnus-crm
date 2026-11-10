# Admin assistant

Status: built on branch `t3/admin-mcp-tools-design` as one PR, November 2026. The closer assistant ([`closer-assistant.md`](closer-assistant.md)) built the `/mcp` endpoint; this plan lets owners and admins connect to it with their own toolset. The design and its mockups are in [`docs/reviews/admin-assistant-proposal.html`](../reviews/admin-assistant-proposal.html). Terms follow [`CONTEXT.md`](../../CONTEXT.md). This file holds no personal data.

## 1. Summary

An admin connects Claude, ChatGPT or another MCP client to the same `/mcp` URL a closer uses and signs in with their Magnus login. Magnus serves a different toolset by role. Three kinds of admin tool:

- **Reads** report the floor, numbers and queues, look up one record, and check integration health. They change nothing.
- **Prepare tools** check one change and store it as a draft with a preview. Nothing in the CRM changes.
- **`magnus_commit`** applies a prepared single-record change. Payment reviews, covering a closer and losses are never applied from chat: they are *plans*, approved on a Magnus page at `/workspace/assistant/approvals/<planId>` under the admin's web session.

Admin access is off by default. Only the owner can switch it on, and reading and changing are separate switches. Changes are switched on per kind (§4).

## 2. Tools

The gateway registers one list for every role. `authorize` in `convex/mcp/http.ts` filters it by `metadata.roles`, by `metadata.family` against the caller's switched-on kinds of change, and hides every `metadata.writes` tool from an admin with none switched on.

| Tool | Kind | What it does | Code |
|---|---|---|---|
| `magnus_brief` | read | The floor now: today's numbers per closer, queue counts and ages, who is out, health and freshness. Call first | `convex/mcp/admin/reads/` |
| `magnus_numbers` | read | Report dictionary terms (`lib/reporting/definitions.ts`) as the pages compute them, from the pages' own readers and merges, optionally compared with another period and grouped where the page's data allows | `convex/mcp/reports/` |
| `magnus_report` | read | Scorecard, Calls, People (optionally one member, with team medians), Attribution or Pipeline as its page shows it, with the page's figures computed from the full answer before lists are cut; also the Operations Qualifications and Lead Gen dashboards | `convex/mcp/reports/` |
| `magnus_report_list` | read | The pages' paged lists and drill-downs: Pipeline's open deals and owed calls, the Log, a member's work log, a deal's credit chain, and the Scorecard's booking questions | `convex/mcp/reports/lists.ts` |
| `magnus_end_of_day` | read | Who saved an end-of-day report for a business day, and the numbers Magnus counted | `convex/mcp/admin/reads/endOfDay.ts` |
| `magnus_lookup` | read | Find or open one person, deal, meeting, payment or team member | `convex/mcp/admin/reads/` |
| `magnus_queue` | read | One review queue, or one item in it | `convex/mcp/admin/reads/queue.ts` |
| `magnus_health` | read | Calendly, Slack, Fathom, deliveries, projections and report freshness | `convex/mcp/admin/reads/health.ts` |
| `magnus_setup` | read | The configuration an admin maintains, with links to each editor | `convex/mcp/admin/reads/` |
| `magnus_correct_payment` | change: payments | Prepare a correction to one payment | `convex/mcp/admin/writes/payments.ts` |
| `magnus_review_payments` | plan: payments | Prepare marking 1 to 20 payments reviewed | `convex/mcp/admin/writes/payments.ts` |
| `magnus_record_result` | change or plan: results | A no-show (change) or a loss (plan) on a call that has started | `convex/mcp/admin/writes/results.ts` |
| `magnus_next_step` | change: results | Call-back, held with call-back, scheduling link, reschedule link, cancel a task | `convex/mcp/admin/writes/nextStep.ts` |
| `magnus_decide_second_opinion` | change: opinions | Decide an open second opinion; a disproved no-show can reopen as a call-back | `convex/mcp/admin/writes/opinions.ts` |
| `magnus_cover_closer` | read or plan: coverage | A closer's affected calls and who is free; prepare an absence and a reassignment plan | `convex/mcp/admin/writes/coverage.ts` |
| `magnus_repair` | change: repairs | Retry a delivery or projection, link a Fathom recorder, attach a recording | `convex/mcp/admin/writes/repairs.ts` |
| `magnus_set_goal` | change: goals | The daily qualification goal or a DM team's booking quota | `convex/mcp/admin/writes/goals.ts` |
| `magnus_commit` | commit | Apply one prepared change | `convex/mcp/admin/commit.ts` |

Everything else is a hand-off: the result links to the page that does it. That covers merging people, booking-review decisions, event-type sorting, program edits, Slack channel picks, business-day changes, Calendly and Fathom connections, invites, role changes, AI access switches and exports.

## 3. Output rules

- Text Magnus didn't compute and the calling admin didn't write comes back as `{ text, by }`, with `by` one of `person`, `closer`, `closer_agent`, `integration`, `admin`. That covers lead names, booking answers, notes, narratives and recording titles. The admin instructions tell the model it is data.
- Lists never carry email, phone, receipt links, reference codes, notes or transcripts. One record asked for by ID may include contact details or notes only when the call asks for them.
- Lists default to 10 rows, 25 at most, with `isPartial` and a reason when more exist.
- Every record carries `openInMagnus` and `allowedActions`: the admin tools that apply to it now, given its state and the caller's switches.
- Numbers come from Magnus, with the page's definition. A report's figures are worked out from the page's full answer with the page's own functions (`lib/reporting/pageFigures/`), before any list is cut, so they match the page. Where a page shows a figure as a lower bound, the tool returns it with `lowerBound: true`. A difference the tool computes itself (a comparison in `magnus_numbers`) is returned only when every input is complete; otherwise it carries `nullReason: "incomplete_input"`. Money is per currency, never summed across currencies.
- Report tools plan their source as the page does, including each page's warehouse switch. A cold warehouse answer returns `status: "pending"` with `retryAfterSeconds`, never zeros. The assistant has its own runner and request table (`mcpReportRequests`), never registers a web cache key, and holds at most one running and two waiting jobs, so the web always keeps a worker.
- Answers are capped at 12 KiB.

## 4. Access

- **Switches.** `tenants.mcpAccess.roles` gates reading per role, as for closers. `mcpAccess.writeRoles` lists the admin roles that may change things, and `mcpAccess.writeFamilies` the kinds of change: payments, results, opinions, coverage, repairs, goals. Absent means none. A role is refused a write switch while it can't read (`mcp.read_first`).
- **Who decides.** Only the owner (`mcp:manage-admin-access`) adds or removes an admin role, changes write switches, or blocks or unblocks an admin. `setRoles` keeps the fields it doesn't edit. An admin can still switch closers and block closers. Only the owner changes a teammate's role (`team:update-role`), on the server as well as in the UI.
- **Two checks.** `authorize` hides what the caller can't use. Inside every tool, `requireMcpAdmin(ctx, caller, { family, permission })` checks again: role, reading switch, kind of change, permission slug, block, active workspace. Tools are internal functions, so this guard is the boundary.
- **Workspace boundary.** Every ID loads through `loadInTenant`, which answers the same `mcp.not_found` for a missing row and another workspace's row. No tool takes a workspace or user argument.
- **Reconnect.** The gateway sends no tool-list change notice, so the settings card says an admin must reconnect to see a newly switched-on kind of change.

## 5. Prepare, commit, approve

Each change has a *committer* (`convex/mcp/admin/prepare.ts`, registered in `convex/mcp/admin/committers.ts`): the tool name, its kind of change, `single` or `plan`, the permission, `pins` (the fields the change depends on), an optional `check`, and `apply`, which calls the same core as the web with provenance `{ via: "mcp", agentClient }`.

1. **Prepare** checks the change, then stores a row on `mcpConfirmations` with the arguments, the pins, an echo (`action`, `target`, `summary`) and, for a plan, its table. A single change returns a preview and a `commit` object; a plan returns an approval link and no `commit`.
2. **Commit** (`magnus_commit`) takes the `commit` object unchanged. It refuses an echo that doesn't match the stored one, returns the stored result for a used token (`replay: true`), refuses an expired token, and returns the approval link for a plan token. Then, in one mutation, `applyPrepared` re-reads the pins (any difference returns `stale` and writes nothing), runs the check with the committer's actor, applies the daily cap, and calls the core.
3. **Approve** runs on the web page. `canApprove` checks, in order: the plan exists in this workspace; the approver is active, is the proposer or the owner, and passes every check the MCP guard would make, with no switch or block changed since the plan was made; the plan isn't decided; it hasn't expired. A second click returns the stored result.

Every outcome (applied, stale, refused, declined) is kept as a receipt for 365 days. A token or plan prepared before its kind of change was switched off, or before its admin was blocked, never works again, even after the switch comes back on.

`magnus_commit` is the only tool annotated `destructiveHint: true`, so a client's own permission prompt lands on the step that changes Magnus, and it shows the readable echo. The admin instructions and the settings card say that "always allow" on `magnus_commit` covers every kind of change switched on. That is why plans skip chat entirely.

**Limits.** Admin write calls draw on `mcpWrite` (10 a minute per user). Applied records draw on `mcpChangesDaily` (150 a day per workspace, a plan counting each record it changes); a change past the cap is refused with a receipt. Single changes expire after 10 minutes, plans after 24 hours; a coverage plan expires earlier, when the first upcoming call it covers starts.

## 6. Plans in detail

- **Payment reviews** take 1 to 20 payment IDs. Payments that are disputed, already reviewed, without a receipt, reusing another payment's receipt, or logged by the person approving are left out and listed. The same exclusions run again for the approver.
- **A loss** is a plan because a loss a person records never reopens, and the admin wasn't on the call. It needs a category and a reason of a few words.
- **Coverage** (`convex/unavailability/planner.ts`, `coverage.ts`) assigns one new owner per deal who is free for every upcoming call that moves, since reassignment moves every meeting on a deal. It never splits a deal, unlike the redistribute wizard, which is unchanged. A plan freezes each deal's meeting IDs with their start, duration and status, and is capped at 50 meetings, 25 deals and 8 candidates. Apply re-lists every deal's meetings and re-checks each slot; any drift refuses the whole plan with zero writes. It writes what the wizard writes, plus one `opportunity.reassigned` event per deal.

## 7. Provenance and events

The admin is the actor and `source` stays `"admin"`. Events an agent causes add `via: "mcp"` and `agentClient` to their metadata (`provenanceMetadata` in `convex/lib/outcomeCores.ts`). Two events are new and appear in the Activity report: `second_opinion.checked` (on the meeting) and `opportunity.reassigned` (on the deal, from the wizard and from coverage plans). Retries, Fathom links and goal changes write a log line with the provenance instead of an event.

## 8. Schema

Widen only; no backfill.

- `tenants.mcpAccess`: optional `writeRoles`, `writeFamilies`, `writeChangedAt`.
- `users`: optional `mcpBlockChangedAt`.
- `mcpConfirmations`: optional `kind`, `family`, `createdAt`, `argsJson`, `echoJson`, `pinsJson`, `planJson`, `status`, `approvedByUserId`, `approvedVia`, `agentClient`, `keepUntil`, and three indexes. Closer tokens leave them unset.
- New table `mcpReportRequests` for the assistant's report jobs, pruned when they expire.

The daily `mcp-prune` job now keeps receipts until `keepUntil`, prunes unused tokens an hour after they expire, and prunes expired report requests.

## 9. Rollback

Switching admin reading off for both roles stops every admin tool at once; switching one kind of change off stops that kind and every open token for it. Reverting the PR leaves the optional fields and `mcpReportRequests` in place, empty or ignored. Reassignments a coverage plan applied are undone only by a new reassignment.
