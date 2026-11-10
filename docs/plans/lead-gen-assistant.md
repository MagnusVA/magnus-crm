# Lead gen assistant: the MCP toolsets for lead generators and admins

This plan adds two toolsets to the MCP endpoint the closer assistant already uses (docs/plans/closer-assistant.md): one for lead generators and one for admins. It came out of a planning council of five drafts, a critique round and three votes; sections 5 to 7 record the objections and what changed. Release 1 is the 13 tools marked 1a and 1b below. Release 2 and the later items are not built. The walk-throughs are docs/reviews/lead-gen-assistant-proposal.html and docs/reviews/lead-gen-assistant-demo.html.

## 1. Shape
- One flat catalog on the existing `/mcp` endpoint: `[...closerTools, ...leadGenTools, ...leadGenAdminTools]`, filtered by `metadata.roles`. Every tool starts with `requireMcpUser`; actions reach it through a guarded internal query (the pattern in convex/mcp/tools/recordings.ts:84) and recheck access before returning a delayed result.
- LG = `lead_generator`. AD = `tenant_admin`, `tenant_master`. In release 1 the lead gen day tools are LG only. Admins get the admin tools plus the shared handle check. This removes the silent worker provisioning problem (`requireOperationalLeadGenWorker`, convex/leadGen/capture.ts:500-544, creates or reactivates a worker row for an admin on capture, claim and every mark; for a lead generator it rejects a missing or inactive profile first, capture.ts:500). So the cores need no `provisionWorker` option yet. It becomes required the day admins get the day tools.
- Zero schema change in release 1. Provenance `{via:"mcp", agentClient}` goes into existing domain-event metadata.

## 2. Catalog

Release 1a (reads) and 1b (writes) are one catalog shipped in two deploys.

| # | Tool | Roles | Kind | Confirm | Args | Returns | Backend | Rel |
|---|---|---|---|---|---|---|---|---|
| 1 | `magnus_lead_gen_today` | LG | query | none | none | profile status (active / inactive / none, team or noTeam, never zeros for an inactive profile), Today / Unique / Dupes, scheduled hours today, respark today, open batch progress, pool bucket counts, batch size, held-until, last origin used, asOf, isPartial. Counts only, no cards | cores from leadGen/activity.ts:239, respark/queries.ts:95,126 | 1a |
| 2 | `magnus_check_handles` | LG, AD | query | none | 1 to 10 handles | per handle: normalized handle or invalid reason; verdict new / known / captured before / not a fit / do not contact / conflict; stage; disposition. Counts nothing, writes nothing. LG sees "you" or "a teammate" and no meeting time. AD also gets each capture's submissionId, worker, time, origin and void state (bounded, paged) | NEW: read-only lookup on `by_tenantId_and_dedupeKey` + non-creating person resolution + capture-confirmation rules; AD detail from a paged submission reader on the prospect index (schema.ts:388) | 1a |
| 3 | `magnus_my_lead_gen_activity` | LG | action | none | range (today, this_week, this_month, or business dates, ≤120 days), cursor | raw leads, resparks, entries, not a fit, scheduled hours, leads/hour; 25 recent rows with a voided flag; asOf, source, state | activity.ts:35,146,199 + `my_activity.summary` + mergeMyActivitySummary | 1a |
| 4 | `magnus_respark_batch` | LG | query | none | cursor | caller's held batch: progress, heldUntil, 25 cards per page (itemId, handle, bucket, stage, disposition, captured date, newest deal outcome, last touches with payment events removed, blockedReason); "captured by" is "you" or "a teammate" | core from respark/queries.ts:58 with a projection (the web card passes `payment.recorded` touches, lib/respark/people.ts:128) | 1a |
| 5 | `magnus_respark_person` | LG | query | none | 1 to 5 itemIds | the panel: masked phone/email, no payments; booking answers, notes, loss reason wrapped `personSupplied` | core from respark/queries.ts:155 | 1a |
| 6 | `magnus_lead_gen_report` | AD | action | none | range (today, this_week, last_week, this_month, or business dates), sections[] (overview, specialists, teams, top_posts, conversions, respark; default overview + specialists), source? ONLY. No teamId or workerId in release 1: the snapshot route cannot honour them (jobs.ts:1053 takes range/source only, contracts.ts:321 keys exclude team/worker, worker.ts:46 passes null), and the page itself filters by source only. Any other filter is rejected with an error, never ignored. Rows carry specialist and team so the model can cite one person. A per-section cursor continues a section past the row cap; the cursor is bound to the range, source, section and the result generation it came from, so a continuation cannot mix two answers | per section: rows, effective filters (conversions take dates only; respark takes dates + source, and the source applies to its raw-capture column only, resparkReports.ts:165-197), definitions (unique = prospect-days; team rollup by current team; posts by capture-time team), source live / warehouse / snapshot, asOf, capped flags, `rankingPartial` on split top posts, state ready / pending / failed / rebuilding. Pending or failed never returns zeros | builders reporting.ts:739,798,682; conversions.ts:115; resparkReports.ts:89; team rollup extracted from specialists-section.tsx:44; NEW coordinator that follows the page's routes PER SECTION (live; warehouse + today merge; on an unswitched tenant over 7 days or capped, the Operations snapshot substitutes overview, specialists, teams and top posts only, while conversions and respark keep their own readers, as lead-gen-admin-page-client.tsx:154-211 does), one 25 s deadline | 1a |
| 7 | `magnus_lead_gen_floor` | AD | query | none | teamId?, cursor | today, per specialist starting from the roster and dated schedules: scheduled hours, captures, unique, dupes, resparks, not a fit, last capture time, open batch progress, asOf, isPartial; flags set by Magnus: `scheduled_no_entries`, `no_team`, `inactive_with_schedule` | NEW reader: roster + schedules joined to today's daily stats; last capture via the worker + submittedAt index (schema.ts:373) | 1a |
| 8 | `magnus_lead_gen_roster` | AD | query | none | includeInactive?, cursor | specialists (active, team, weekly hours), teams, respark rules | workers.ts:79,106,123; respark/settings.ts:24 | 1a |
| 9 | `magnus_lead_gen_submissions` | AD | ACTION | none | range, workerId?, teamId?, source?, cursor | up to 25 raw rows a page: submissionId, handle, worker, capture-time team, origin, time, void metadata; isPartial + cursor when the budget runs out | An action that runs the existing page query (exports.ts:651, which scans two rows a page with native `.paginate()`, exports.ts:293) as separately executed queries and accumulates them under one total read and time budget. A single query cannot call a native paginated read twice, so this is not a query. Tests: more than two matching rows, empty filtered pages, continuation with no missing or repeated submission | 1a |
| 10 | `magnus_capture_prospects` | LG | mutation | preview + token | requestKey, source, origin {kind, value}, 1 to 10 handles, includeDoNotContact?, confirm, confirmToken | preview: per line verdict and will-save (lines that normalize to the same handle are merged), origin warnings (a profile URL used as origin; origin not used before today); commit: per line submissionId + the web's confirmation line, with `alreadySaved` lines listed separately with their void state | `submitCaptureCore` from capture.ts:65 | 1b |
| 11 | `magnus_claim_respark_batch` | LG | mutation | idempotent one-call | none | batchId, resumed, size, heldUntil, noTeam, endedOtherTeamBatch | core from respark/batches.ts:86 | 1b |
| 12 | `magnus_mark_respark_items` | LG | mutation | preview + token | 1 to 20 marks {itemId, result: resparked / not_a_fit / skipped}, confirm, confirmToken | preview: effect per person; commit: per item recorded or alreadyRecorded | cores from batches.ts:245,269,291 | 1b |
| 13 | `magnus_void_capture` | AD | mutation | preview + token | submissionId, reason, confirm, confirmToken | preview: handle, worker, day, credit removed, what does not rewind; an already-voided capture gets no token | core from corrections.ts:25 | 1b |
| 14 | `magnus_my_lead_gen_outcomes` | LG | query | none | capture range, cursor | own capture cohort by stage (in conversation, qualified, booked, showed, customer) and the people in each; no money, no closer names | NEW worker-scoped reader on the conversions aggregate; new index `[tenantId, firstCapturedByWorkerId, firstCapturedAt]` (widen only) | 2 |
| 15 | `magnus_lead_gen_post_outcomes` | AD | action | none | capture range, source?, teamId?, cursor | posts and reels ranked by credited deals that booked (cash only if the owner approves); whole-range aggregation before ranking; matching web panel | NEW builder over attribution, event, submission origin, deal | 2 |
| 16 | `magnus_set_lead_gen_worker` | AD | mutation | idempotent one-call, read-back | workerId, isActive, teamId (required: id or null) | saved profile | workers.ts:211 (it clears the team when teamId is omitted, so the tool requires it) | 2 |
| 17 | `magnus_set_respark_rules` | AD | mutation | idempotent one-call | inactiveAfterDays, batchSize, dryRun | pool preview, saved rules | respark/settings.ts:24,63 | 2 |
| 18 | `magnus_lead_gen_export` | AD | action | idempotent one-call | range, format, requestKey; or jobId | job state, then an owner-scoped link valid 10 minutes | operations/reports/jobs.ts:181,314 (helpers need extraction) | 2 |
| 19 | `magnus_post_lead_gen_digest` | AD | action | preview + token | range, channel | the report summary Magnus counted, posted to Slack | NEW Slack poster over the report core | 2 |
| 20 | `magnus_end_lead_gen_shift` | LG | action | preview + token | narrative?, note? | saved shift report posted to Slack, numbers from Magnus | NEW builder + new table | later |
| 21 | `magnus_flag_capture` | LG | mutation | idempotent one-call | submissionId, reason | flag for an admin's review queue | NEW table + admin surface | later |
| 22 | `magnus_set_lead_gen_schedule` | AD | mutation | idempotent one-call | workerId, week or null | saved hours, effective date | workSchedules.ts:152, only after its writer stops deleting rows (workSchedules/datedRows.ts:174,185) | later |

## 3. Rules the tools enforce
- Confirm: `redeemConfirmation` is changed first so it checks user, tool, tenant and the argument hash BEFORE replaying a used token (today convex/mcp/confirm.ts:86 replays before the check at :92), and its messages become role-neutral.
- List writes: every line is validated before any write; one transaction; if any line fails nothing is saved and the token stays unused. Captures run sequentially inside the mutation (the daily and origin aggregate rows contend). Caps start at 10 captures and 20 marks per commit and rise only after transaction measurements.
- Capture retry: per-line `clientSubmissionKey` = sha256(userId, requestKey, source, dedupeKey, originKey). Same requestKey + same line returns the saved row; a deliberate repeat capture uses a new requestKey and is counted as the web counts it. The key does not depend on the token.
- Do-not-contact lines are left out unless `includeDoNotContact` is true (part of the hashed args). A handle that resolves to two people is a `conflict` line and is never saved.
- Resparked is committed only after the lead gen says the message was sent. The assistant drafts openers; it never sends.
- Results: default 25 rows, max 50 including nested rows, 64 KiB; text trimmed to 500 chars with a flag; no avatars or preview images; prospect text wrapped `personSupplied`.
- Handle check is audited and rate limited (60/min) and capped at 10 handles per call.

## 4. Rollout
1. Fix `confirm.ts` (order of checks, tenant check, neutral copy) with tests. No behaviour change for closers except a changed-args replay now errors.
2. Extract READ cores with the web as thin wrappers for deploy 1a: activity, respark readers (paginating batch items before hydrating cards), exports page, report builders' private helpers, team rollup. The WRITE cores (capture, respark claim/marks, void) are extracted in deploy 1b, so the read-only pilot changes no write path. Web tests pass unchanged.
3. New readers: handle lookup, floor, report coordinator (three routes), action guard bridge.
4. Toolsets `convex/mcp/toolsets/leadGen.ts` and `leadGenAdmin.ts`, tools in `convex/mcp/tools/leadGen*.ts`, `instructionsFor(role)` in instructions.ts, one concatenated catalog in http.ts. Harness gains `seedTenantWithLeadGen`. Catalog and role-filter tests pass before any role can connect.
5. Access in the same PR as the tools: `MCP_TOOLSET_ROLES` and `mcp:connect` gain the roles; tenant switches stay off. Settings card gets real switches per role with a capability summary; team and profile cards lose closer-only copy.
6. Pilot 1a: block every lead gen but one, enable `lead_generator` and one admin, watch the audit log (tool, client, outcome, latency, refusals) for a week. Then deploy 1b writes the same way. Rollback: remove the roles from `mcpAccess.roles`; committed records stay.
7. Release 2 with its one index (widen only), then the later items with their own migration plans.

Extra tests from vote 1: source-filter parity on the live, warehouse and snapshot routes with two workers sharing a team and origin, and rejection of any other filter; a catalog transition 1a, then 1b, then back to 1a with the role disabled before the revert, checking closers still list and call; a list commit whose LAST line fails, asserting earlier lines, aggregates, scheduled Slack posts and the token all roll back; replay of a successful marks list; floor flags for a scheduled specialist with zero entries; one `asOf` + isPartial contract shared by today and floor.

Tests (tests/mcpHarness.ts style: signed token, stubbed JWKS, real gateway, JSON-RPC): parity of every report section and my-activity against the web query on frozen data for live, single past day, warehouse + today, snapshot, rebuild, capped, pending and failed; cross-tenant and cross-worker isolation on every tool; `tools/list` per role with closer regression; confirm expiry, replay, changed args, wrong user; list capture commit twice and retry after a lost response (no extra submissions, touches, credit or Slack posts); two agents marking one item; inactive worker and no team; prompt-injection fixtures in captions, booking answers and notes; no payment event or contact detail in any lead gen result.

## 5. Critique objections and decisions
| Objection (who raised it) | Decision |
|---|---|
| Used token replays before the args check (correctness, verification, smallest, product) | Fixed first, step 1 |
| Batch cards carry payment touches and teammate names (correctness, product, smallest) | MCP card projection drops payment touches and names; the web card is unchanged and flagged as an open question |
| Admin capture/claim provisions a worker row (correctness, product) | Day tools are LG only in release 1; cores never provision from MCP |
| Day/source/handle/origin key suppresses deliberate repeats (smallest, verification, data) | Key now includes a requestKey and is hashed |
| Key from the token duplicates after a re-preview (correctness, product) | Key no longer depends on the token |
| "Keeps the rest" partial commits (correctness) | All-or-nothing |
| One-call skip breaks the confirm rule (smallest) | Skip goes through the marks list with preview + token |
| "Use the page" for unswitched tenants (verification, data) | Coordinator implements the snapshot route |
| Split top-post merge is candidate-limited (data, verification) | `rankingPartial` flag |
| Floor cannot find workers with no captures from the performance builder (data) | Floor starts from roster + schedules |
| Admin handle detail cited the audit-match reader (data) | Separate paged submission reader |
| Schedule writer deletes rows (verification, smallest, product) | Schedule tool moved to "later" |
| `updateWorkerProfile` clears the team when teamId is omitted (correctness, product) | teamId required |
| Slack recap in one call (verification) | Slack-posting tools use preview + token |
| 25-handle check is an enumeration oracle (correctness) | 10 handles, no meeting time or identity for LG |
| Access-first order can connect a role to an empty catalog (verification) | Tools and access ship together, switches off |

Disagreements kept open (dissent):
- Single-item writes (favoured by the smallest-change and verification critics) vs list writes (favoured by the correctness and product critics). Decision: list writes, atomic, small caps. Reason: 45 marks at two calls each is 90 calls against a burst limit of 20 and a confirmation per person; one critic verified an atomic list commit is feasible after core extraction.
- Read-only first release (verification) vs writes in release 1 (product, smallest). Decision: one release in two deploys, reads then writes after a week's pilot.
- Floor tool in release 1 (product, correctness) vs dropped (smallest). Decision: keep; it is the admin's live companion and needs no schema change.
- Admins using capture/respark tools themselves (drafts A to D) vs LG only (draft E). Decision: LG only until the owner asks for it.

## 6. Vote 1 and what changed
Vote 1: approve 8, approve 8, approve 8, BLOCK 8, BLOCK 7. Both blocks were the same gap: the report tool promised teamId/workerId filters, but the snapshot route cannot honour them and would have returned tenant-wide numbers. Fix: release 1's report tool takes `source` only, the page's own filter, and rejects anything else. Also adopted: section-specific routing, read cores in 1a and write cores in 1b, no `provisionWorker` option yet, bounded accumulation for the submissions page, a per-section cursor, and the extra tests above. Also from vote 1: state is re-checked at commit and a change fails the whole commit so the agent previews again; lines that normalize to the same handle merge at preview; commit reports `alreadySaved` separately; `magnus_respark_person` takes up to 5 itemIds; `magnus_lead_gen_team` is renamed `magnus_lead_gen_roster`; a `last_week` preset exists. Not adopted: dropping `magnus_lead_gen_floor` (kept as dissent; the report cannot see a scheduled specialist with no captures).

## 7. Vote 2 and what changed
Vote 2: approve 8, approve 8, approve 8, approve 8, BLOCK 8. The block: tool 9 promised to accumulate pages of the existing submissions reader inside one query, but that reader uses native `.paginate()` capped at two rows, and Convex allows one native paginated call per query execution. Fix: tool 9 is now an ACTION that accumulates separately executed queries under one budget (row 9 above). Also folded into the catalog rows above, as the smallest-change voter asked: itemIds on the person tool, merged duplicate lines, `alreadySaved` with void state, asOf and isPartial on today and floor, the respark source-filter note, and cursors bound to their result. One rule for both list writes: a line already saved under the same key, or an item the same user already marked the same way, is reported and not failed; any other change since the preview fails the whole commit and leaves the token unused. Each day tool passes `["lead_generator"]` to its own `requireMcpUser` call as well as `metadata.roles`. Added tests: access revoked during report polling and between preview and commit (no delayed result, no write); a stale preview (disposition or pool eligibility changed) fails the whole list.

## 8. Release 2: the rest of the lead gen side

Built after a lead generator's feedback on the demo. The lead gen items from rows 14 to 22 are built here, with one item the first plan did not have: a contact-again date. The admin change tools (rows 16 to 19 and 22) and admin post outcomes (row 15) are left to the admin assistant. A second planning council (five drafts, five critiques, two votes) settled the design; section 9 records it.

### What was added

| Tool | Roles | Kind | Confirm | What it does |
|---|---|---|---|---|
| `magnus_my_lead_gen_outcomes` | LG | query | none | The lead gen's own capture cohort by stage, 25 people a page. A person who didn't show carries up to 3 no-shows with category and the closer's note. No money, no closer names |
| `magnus_set_contact_again` | LG | mutation | one idempotent call, read back | Saves or clears the date a person asked to be contacted again, with a note |
| `magnus_flag_capture` | LG | mutation | one idempotent call | Flags one of the lead gen's own captures for an admin to review. One flag per capture |
| `magnus_end_lead_gen_shift` | LG | mutation | preview + token | Saves the day's report Magnus counts and posts it to the lead gen Slack channel |

Existing tools gained: the post's author and date in the capture preview when Magnus already has them; the contact-again date on the respark batch, the respark person, the handle check and the outcomes; a capture's flag state on the lead gen's activity, the admin's submissions and the admin's handle check.

### Rules

- **Contact-again date.** Stored on the person (`leads.contactAgain`, convex/lib/contactAgain.ts). Until the date arrives no respark claim picks the person, and nobody can mark them resparked; Skip and Not a fit still work. A lead gen sets it for a person they captured or a person in their own held batch, worked or not, so they can mark resparked first and then save the date. Admins set it for anyone; closers read it. It is refused for, and never shown on, a do-not-contact, customer or merged person, and it is cleared when a person becomes one. At a merge the later date wins. There is no cron: every check compares the date with now. Pool counts leave out people whose date is ahead; past 512 of them on a team the counts are returned unavailable, never wrong.
- **No-show notes for a lead gen.** The category is always shown. The closer's note is shown for a no-show at or after the lead gen's first capture, including notes written before this release. Before a lead gen reads a note, contact details are masked and the tenant's staff names and amounts of money are replaced (convex/leadGen/assistantText.ts). If the staff roster is too large to read in full, the note is withheld. A nickname Magnus doesn't know, or money written as prose, can't be caught. Contact-again notes get the same treatment for lead gens. The no-show dialog tells the closer that lead gens can read the note.
- **End of shift.** One report per worker per business day, in its own table (`leadGenShiftReports`), never in the closer's `endOfDayReports`. The token is bound to the business day; at commit Magnus counts again and saves nothing if a number changed. Scheduled hours are read apart from capture rows, and an incomplete schedule read gives unknown hours, never zero. A later call the same day returns the saved report and retries a Slack post that failed, had no channel, or stayed pending past its lease.
- **Flags.** One per capture, ever (`leadGenCaptureFlags`). A flag changes no number. A void closes it in the same transaction; an admin can dismiss it with a note on the Operations lead gen page.

### Schema

All additive, with no backfill: an optional `contactAgain` on `leads` with one index, and two new tables. A person with no date is unrestricted, and both tables start empty.

### Not built

A pace target, shift start times, the admin change tools, and admin post outcomes. The respark claim's read accounting for skip and merge-history documents is as it was before; it is a follow-up.

## 9. The second council

Scores from the critique round, by reviewer lens and draft:

| Reviewer | A | B | C | D | E |
|---|---|---|---|---|---|
| Smallest change | 9 | 4 | 8 | 7 | 7 |
| Correctness | 7 | 7.5 | 6 | 5 | 5 |
| Verification | 7 | 5 | 8 | 8 | 7.5 |
| Data and performance | 6.5 | 4 | 7 | 8.5 | 7.5 |
| Product and architecture | 8 | 5.5 | 7.5 | 8 | 8.5 |

Vote 1 on the merged plan: approve 8, approve 8, approve 8, approve 8, block 8. The block: a lead gen could save a date only from a respark batch, so a freshly captured person needed an agent. Fix: the date dialog is also on the lead gen's own capture rows in My Activity. Vote 2: five approvals at 8.

Decisions against a reviewer's advice:

- The claim's read budget was not rewritten (data reviewer). The date is on the person document the claim already loads, so the skip adds no read.
- Older no-show notes are shown to lead gens, with redaction (one draft wanted only notes written after this release). The owner asked for the reasons, and the redaction covers names, amounts and contact details.
- No-show history has no cursors of its own (data draft). A person carries their 3 newest qualifying no-shows and a `historyPartial` flag.
- The shift report's hours can differ from My Activity on a day with no captures, where the page shows zero.
