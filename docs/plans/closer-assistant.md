# Closer assistant

Status: built on branch `t3/closer-assistant`, 3 November 2026, against `main` at `10cafef`, as one PR that is safe to deploy alone. The tenant admin answered the first batch of decisions on 2 November, recorded in §12.2, and changed three things: the URL stays on Convex's domain, the design must take more roles later, and the agent can mark a deal lost. On 3 November they asked for a second opinion on each recorded call, from Jev on the Convex AI Gateway, which §6.9 designs, and asked for the build. Every decision still open in §12.3, §12.4 and §12.5 took its recommendation. Two departures from this plan are recorded where they apply: access tokens are verified in the `/mcp` mount rather than through `auth.config.ts` (§6.1), and the toolset has sixteen tools, with `magnus_move_callback` (decision 20) and `magnus_attach_proof` (decision 12a).

The design and its mockups are in the proposal, [`docs/reviews/closer-assistant-proposal.html`](../reviews/closer-assistant-proposal.html), scrubbed of personal data under decision 11. Seventeen animated scenes of the UX, three of them on the second opinion, with the rows each step writes, are in [`docs/reviews/closer-assistant-ux-prototype.html`](../reviews/closer-assistant-ux-prototype.html), a throwaway prototype. Terms follow [`CONTEXT.md`](../../CONTEXT.md), and the model is [ADR 0001](../adr/0001-lead-lifecycle-model.md). This file holds no personal data.

## 1. Summary

The beta tenant's closer wrote a spec for an AI agent that knows their day, writes their call notes and sends an end-of-day report to Slack. This plan builds the CRM side, so that any MCP client can do it and the CRM, not the model, decides what the day holds and what the numbers are. Closers are the first role. Access, tools, uploads and the audit trail work per role, so adding a role later means adding a toolset, not redesigning the endpoint.

1. **An MCP endpoint** at `https://<deployment>.convex.site/mcp`, through `convex-mcp-gateway` 2.1.1, with WorkOS AuthKit as the OAuth server. A user adds the URL to Claude, ChatGPT, Claude Code, Codex, Hermes or Cursor and signs in with their normal Magnus login. It answers a role only when the tenant turned it on for that role and a toolset exists for it. This PR ships the closer toolset. See §6.1.
2. **Sixteen closer tools**, listed in §6.2. Six read the day, a person, deals, tasks, a recording and the day's numbers. Ten write a call note, a call-back task, a call-back's new time, a no-show, a loss, a recording's meeting, a proof upload, a payment, a receipt for a payment that has none, and the end of the day. Moving a call-back is the only edit, and nothing deletes. A loss and a payment need the closer's yes in the conversation, and a payment also needs a proof file.
3. **Call notes.** A structured note the agent writes on a deal after a call, shown on the meeting page and on the person's timeline. See §6.4.
4. **Payments from the agent, with proof.** No proof file, no payment. ChatGPT passes the file the closer dropped into the chat, agents with a shell upload it to a single-use URL, and the Claude apps give the closer a link to the payment dialog with the values filled in. Proof also becomes required for closers in the four payment dialogs on the web. See §6.3.
5. **Fathom.** One connection per tenant, made with the key holder's API key. Recordings arrive by webhook, match to meetings and show on a Recording card on the meeting page. Recordings that match nothing wait in a queue. See §6.5.
6. **End of day.** The closer ends the day from the agent or from the Today page. Magnus counts everything since their last report, saves the report and posts it to the Slack channel an admin picked. See §6.6.
7. **A second opinion on recorded calls.** Once a call has a Fathom recording and a result, Magnus sends the transcript to Jev, TypeSafe's decision model, through the Convex AI Gateway. Jev answers four questions with labels and probabilities. Magnus compares them with the closer's record in code, and a disagreement waits in an admin queue. It never changes a record. It starts off, and turning it on starts a 14-day shadow run that only owners see. See §6.9.
8. **Screens**, in §7: an AI assistants card with a switch per role and a Fathom card in Settings → Integrations, an end-of-day row in the Slack channel picker, End my day on Today, call notes and the Recording card on the meeting page, the connection steps and a time zone on the profile page, two markers in Billing, and the second opinion's card, queue and settings row.

The schema change is additive. The only migration is the optional proof-hash backfill in decision 15. See §4.

## 2. Code facts the design rests on

At `f9ee537`.

### 2.1 Identity and roles

- `requireTenantUser`, at `convex/requireTenantUser.ts:21`, looks the user up in `users.by_workosUserId` with each value from `getWorkosUserIdCandidates` in `convex/lib/workosUserId.ts`. A token from a new issuer yields two candidates, `<issuer>|<id>` and the raw `<id>`. A user stored in the user-management form, `https://api.workos.com/user_management/<clientId>|<id>`, matches neither, so that user's MCP token from the AuthKit issuer would fail with `auth.user_not_found`. §6.1 adds the user-management form as a third candidate.
- The role comes from `users.role` and the org from `getIdentityOrgId`, which reads `organization_id`, `organizationId` and `org_id`. The guard rejects inactive users and ignores tenant status.
- `convex/lib/permissions.ts` maps permission slugs to roles, and `docs/agents/auth.md` says to gate a new feature on a slug when one fits.
- The external metrics API's keys, in `convex/analytics/api/keys.ts`, belong to a tenant and carry `metrics:read` only. They name no user, so they can't stand in for one.

### 2.2 Payments

Four public mutations insert payments. All four admit `closer`, `tenant_master` and `tenant_admin`, and all four take proof as optional.

| Path | Mutation |
| --- | --- |
| A meeting's result | `logPayment`, `convex/closer/payments.ts:30` |
| A call-back task | `logReminderPayment`, `convex/closer/reminderOutcomes.ts:122` |
| Another payment on a won deal | `recordAdditionalPayment`, `convex/closer/additionalPayment.ts:34` |
| A side deal | `logPayment`, `convex/sideDeals/logPayment.ts:21` |

- Phase 4 retired `recordCustomerPayment`.
- No helper owns a payment write. Each mutation inserts the row and calls the side effects in its own order: `recordPayment`, `insertPaymentAggregate`, `setSoldProgramCaches`, `transitionOpportunity` to Closed and won, `completeMeetingForOutcome`, `emitDomainEvent` and `syncPersonEnrollments`.
- A meeting payment needs a meeting that is still `scheduled` and a deal at Booked, through `assertCanRecordMeetingOutcome` in `convex/lib/outcomeEligibility.ts`. For a closer, it also can't come earlier than 5 minutes before the call. A task payment needs a pending manual reminder the closer owns, through `requirePendingReminderForPayment` at `convex/closer/reminderOutcomes.ts:75`.
- Payments land `recorded`. Revenue counts `recorded` and `verified`, and only `disputed` drops out. Admins review payments in Billing, at `/workspace/billing`, which the tenant's `billingOpsEnabled` flag gates.
- `paymentRecords` keeps `origin`, such as `closer_meeting`, with `recordedByUserId` and `attributedCloserId`. Nothing records how a payment was entered.
- Each of the four dialogs takes one file of up to 10 MB, a JPEG, PNG, GIF or PDF. The label reads "Proof file", and the form submits without one.

### 2.3 Deals, meetings and tasks

- The deal stages and outcomes live in `convex/opportunities/stages.ts`. Won and lost are final, apart from the named moves in `STAGE_TRANSITION_EXCEPTIONS`, and a loss a person recorded never reopens.
- `markNoShow`, at `convex/closer/noShowActions.ts:29`, marks the meeting no-show and closes the deal lost with the reason `no_show`. The closer can still reopen that deal at Follow-up by sending a reschedule link, which is one of the named exceptions.
- `markAsLost`, at `convex/closer/meetingActions.ts:46`, closes the deal lost with an optional reason and `lostByUserId`, and records a given meeting as held. `markReminderLost`, at `convex/closer/reminderOutcomes.ts:301`, does the same from a call-back task and completes the task.
- Only outcome actions record a call as held, through `completeMeetingForOutcome`, which sets `heldMarkedAt`. `createManualReminderFollowUpPublic`, at `convex/closer/followUpMutations.ts:280`, does so when it gets a `meetingId`, and it moves the deal to Follow-up.
- Tasks are `followUps` rows, either a `manual_reminder` to call or text or a `scheduling_link`. Each names its deal, person and closer. `getCloserTasks`, at `convex/closer/followUpQueries.ts:44`, returns up to 50 pending tasks of each kind.

### 2.4 Timeline and notes

- `domainEvents.source` is `closer`, `admin`, `pipeline` or `system`. `isLastTouchEvent`, at `convex/lib/respark/state.ts:66`, counts a deal move as a last touch unless its source is `system`, and the reporting backfills branch on `source`. A new source would mean auditing every reader. Writing with the user's own source means auditing none.
- `domainEvents.entityType` has no tenant value, so a tenant setting change can't be an event without widening it.
- `emitDomainEvent` derives the person and the actor's team member, and `touchChannel` in `convex/lib/touches.ts` decides which events are touches.
- `meetingComments` has user authors only and emits no event. `leadNotes` holds DM closers' notes. Neither can say a machine wrote it.

### 2.5 Days and numbers

- The business day is `tenants.businessDay`, a time zone and a start hour, and America/Tegucigalpa from 01:00 when unset. The helpers are in `lib/businessDay.ts`, and the closer's Today page counts by it.
- Neither `users` nor `teamMembers` stores a time zone. `slackUsers.timezone` exists, but only for people linked to a Slack user.
- `getPipelineSummary`, at `convex/closer/dashboard.ts:362`, takes any range. It's built from `readCloserMeetingDeals`, `countStripByStage` and the closer's cash readers in the same file. `readCloseRateCohort`, at `convex/reporting/lib/closeRateCohort.ts:123`, takes any range and a closer. The `meetingsByStatus` aggregate is keyed `[closerId, callClassification, status, scheduledAt]`, so `makeTupleDateBounds` counts any window.

### 2.6 Slack

- `slackInstallations` has four channel groups, each with an `Id`, a `Name` and an `Error`: notifications, stale reminders, lead gen and booking reviews.
- `setSlackNotifyChannels`, at `convex/slack/channels.ts:92`, saves them. An optional channel is left alone when omitted and turned off by `null`.
- Posts are internal actions scheduled from mutations, through `slackApiPostJson` in `convex/slack/webApi.ts`. `channel_not_found` and `is_archived` record the error and clear the channel, and `not_in_channel` records it.

### 2.7 Platform

- `convex/convex.config.ts` declares environment variables in `defineApp({ env })`. `convex/auth.config.ts` reads `process.env` and has two WorkOS providers.
- The repo runs `convex` 1.46. `convex-mcp-gateway` 2.1.1, published 7 October 2026 and still the latest, needs `convex` ^1.35. It registers Convex functions, internal ones included, as tools through `defineMcpQuery`, `defineMcpMutation` and `defineMcpAction`. It passes the caller's identity through to each tool, writes an audit row per call and exports a `convex-test` helper.
- A gateway tool takes `_meta`, which ChatGPT's file params need, and MCP `annotations` such as `readOnlyHint` and `destructiveHint`, which clients use to decide when to ask before running a tool.
- The gateway sends a generic message for a plain `Error` and passes a `ConvexError` through. The payment and outcome mutations throw plain `Error`s for their checks, such as "Outcome actions open 5 minutes before the scheduled time." `rejectRequest` and `expectedError` throw `ConvexError`s.
- The gateway never deletes its own sessions or audit rows. The host schedules `pruneSessions` and `pruneAuditEntries`.
- `convex/http.ts` mounts the Calendly, Slack, Fivetran and `/api/v1` routes and calls `authKit.registerRoutes(http)`.
- A meeting keeps a pasted Fathom link in `meetings.fathomLink`, edited through `FathomLinkField` and `saveFathomLink` at `convex/closer/meetingActions.ts:114`.
- Production runs on a Vercel subdomain, and the tenant has no domain of its own.

### 2.8 Upkeep a new table needs

- Deleting a tenant walks the table list in `convex/admin/tenantsMutations.ts`. The test-data reset counts and clears the tables listed in `convex/testing/operationalData.ts`.
- A person merge and a deal move go through `convex/leads/repointLeadReferences.ts`, which moves the rows keyed by a deal, its meetings or the person. A table that copies `leadId` or `opportunityId` has to join it.
- Fivetran copies Convex to ClickHouse every 6 hours. Under §7.4 of `docs/plans/clickhouse-reporting.md`, new tables arrive blocked, new columns on synced tables sync, and credential tables stay blocked. `paymentRecords` and `users` are synced.

### 2.9 The Convex AI Gateway

From `https://docs.convex.dev/ai-gateway/api` and the pages it links, read on 3 November 2026.

- Decisions is `POST https://ai-gateway.convex.dev/alpha/decisions`. It's in alpha, and "the request and response format may change during alpha". It doesn't stream.
- An action authenticates with `Authorization: Bearer` and a token from `getServiceToken("ai-gateway")` in `convex/server`, which needs `convex` 1.45. The docs say to call it before each request and never to store, cache or return the token. The repo runs 1.46, so no provider key is involved.
- The documented Decisions model is `typesafe/jev-1.13`. The models page lists it with a zero-data-retention endpoint as of 2 November 2026.
- A request has `model`, a `state` that can be a string, an object or an array, and `questions` keyed by name. A question is a `choice` with `instructions` and a `criteria` map, a `score` with an ordered `criteria` list, or a `noul`, a statement rated from 0 to 1. Each question is evaluated on its own, and the docs say to ask one decision per question and combine the answers in code. An optional `provider` takes `zdr`, `data_collection: "deny"`, `require_parameters` and `max_price`. The body can reach 16 MiB.
- The response has `id`, `model`, `answers` keyed like the questions, and `usage` with input and output tokens and, when present, `cost` in US dollars. `choice` and `score` answers may carry `confidence` and `probabilities`. Nothing in it is a reason or free text.
- Errors include 401 `invalid_api_key`, 413 `request_too_large` and 502 or 503 `upstream_error`. A provider's validation error keeps its own status.
- The gateway needs a paid Convex plan. It works on cloud production and dev deployments, and on local deployments linked to a project from `convex` 1.46. A call made with a deploy key or by a dashboard member needs a role that allows the gateway.
- Charges appear as an AI Gateway line on the Convex invoice. Settings → Usage Limits can set a dollar threshold, and "reaching the disable threshold disables the whole deployment, not just AI Gateway requests".
- Convex never retries a failed action, and the default runtime has `fetch`.
- The docs don't give Jev's price, its longest input, a rate limit, or a full example of a `noul` answer.

## 3. Production snapshot

Not taken yet. The build takes it first, read-only, with counts and IDs only.

| Count | What it decides |
| --- | --- |
| Active closers | Sizing |
| Payments in the last 90 days by origin, with and without proof | How often closers log without proof today, for decision 3 |
| Payments with a proof file, all time | The size of the backfill in decision 15 |
| Users by the stored form of `workosUserId`: raw, user-management or other | Whether the fix in §6.1 matters today or only guards later users |
| `billingOpsEnabled` on the tenant | Whether anyone reviews payments in Billing, agent payments included |
| Channel fields set on the tenant's `slackInstallations` row | The end-of-day row's starting state |
| Meetings per closer per business day over 30 days, median and maximum | The bounds on `magnus_today` and the day summary |
| Meetings with a `fathomLink` in the last 30 days | How many calls carry a recording today, which sizes the second opinion's monthly volume |

## 4. Schema

Every change is additive, as new tables and optional fields. Nothing is narrowed. Decision 15's proof-hash backfill is the only migration, and it fills a new optional field.

### 4.1 New tables

```ts
callNotes // one row per note an agent writes; append-only
  tenantId, opportunityId, authorUserId: Id<"users">
  meetingId?, followUpId?, recordingId?
  currentSituation, goal, bottleneck, objection: string // each at most 1,000 characters
  nextAction?: string
  financingProvider?: "clarity_pay" | "splitit" | "other"
  agentClient: string // clientInfo.name from initialize
  contentHash: string // for retries, §6.8
  createdAt
  indexes: by_tenantId_and_opportunityId_and_createdAt,
           by_tenantId_and_authorUserId_and_createdAt, by_meetingId

paymentProofUploads // a proof file an agent brought, before it backs a payment
  tenantId, userId: Id<"users">
  source: "upload_url" | "chatgpt_file"
  ticketHash?, ticketExpiresAt? // upload_url only: SHA-256 of the ticket, 10 minutes
  storageId?, contentType?, sizeBytes?, sha256?
  status: "pending" | "ready" | "attached" | "expired"
  paymentId?, createdAt
  indexes: by_ticketHash, by_tenantId_and_userId_and_status

endOfDayReports
  tenantId, userId: Id<"users">, role: "closer" // widened when another role ends days
  periodStart, periodEnd, timeZone
  previousReportId?, previousDayUnclosed: boolean
  numbers: { ... }, gaps: [ ... ] // a snapshot; validators in §6.6
  narrativeMarkdown?, note?
  endedVia: "agent" | "web", agentClient?
  slackStatus: "pending" | "posted" | "not_configured" | "failed"
  slackChannelId?, slackTs?, slackError?, postedAt?
  createdAt
  indexes: by_tenantId_and_userId_and_periodEnd, by_tenantId_and_periodEnd

tenantFathomConnections // one row per tenant, like tenantCalendlyConnections
  tenantId, apiKey, keyLast4, keyHolderEmail, keyHolderIsAccountAdmin?
  webhookId?, webhookSecret?, triggeredFor: string[]
  connectionStatus: "connected" | "invalid_key" | "disconnected"
  lastWebhookAt?, lastReconciledAt?, lastMemberSyncAt?, lastError?
  connectedByUserId, connectedAt
  index: by_tenantId

fathomOrgMembers // Fathom's roster, like calendlyOrgMembers
  tenantId, email, name?, fathomTeam?
  viewAccessLevel?, settingsAccessLevel? // only when the key holder is an account admin
  matchedUserId?: Id<"users">, ignored: boolean, lastSyncedAt
  indexes: by_tenantId_and_email, by_tenantId_and_matchedUserId

fathomWebhookEvents // raw deliveries, kept until processed
  tenantId, connectionId, webhookMessageId, receivedAt, payload: string
  status: "pending" | "processed" | "dropped" | "held" | "failed"
  holdUntil?, processedAt?, error?
  indexes: by_tenantId_and_webhookMessageId, by_status_and_receivedAt

callRecordings
  tenantId, connectionId, recordedByUserId?: Id<"users">, recordedByEmail
  meetingId? // the deal and the person come from the meeting
  fathomRecordingId: number, url, shareUrl, title, meetingTitle?
  scheduledStartAt?, scheduledEndAt?, recordingStartAt, recordingEndAt
  summaryMarkdown?, actionItems?: [{ description, assigneeEmail?, timestamp? }]
  transcriptStorageId?, transcriptLanguage?, transcriptDeletedAt?
  inviteeEmails: string[]
  matchStatus: "matched" | "unmatched" | "ignored"
  matchMethod?: "time_email" | "time_url" | "time_only" | "manual"
  rawEventId?, createdAt, matchedAt?, matchedByUserId?
  indexes: by_tenantId_and_recordedByUserId_and_matchStatus, by_meetingId,
           by_tenantId_and_fathomRecordingId

secondOpinions // one Jev check of one recorded call, §6.9
  tenantId, meetingId, recordingId: Id<"callRecordings">
  closerUserId: Id<"users"> // the meeting's closer when the check ran
  trigger: "result_recorded" | "recording_matched" | "day_closed"
  record?: { kind: "payment" | "call_back" | "lost" | "no_show"
             paymentType?, amountMinor?, currency?, lossReason? } // none for day_closed
  claim?: string // the statement Magnus built from the record
  inputKey: string // meetingId and recordingId, so a check runs once
  model: string // "typesafe/jev-1.13"
  status: "queued" | "answered" | "failed" | "skipped"
  attempts: number
  failure?: "upstream_error" | "format_changed" | "rejected" | "no_transcript" | "cap_reached"
  answers?: { attendance, ending, objection: { choice, confidence?, probabilities? }
              claim?: number }
  verdict?: "agrees" | "unsure" | "disagrees" | "hint" // hint: nothing recorded to compare
  evidence?: { recordedMinutes, closerMinutes, prospectMinutes, prospectFirstAt? }
  gatewayRequestId?, inputTokens?, outputTokens?, costUsd?
  closerNote?, closerNoteAt?
  reviewState?: "open" | "checked"
  review?: { outcome: "closer_right" | "second_opinion_right", byUserId, at
             reopened: boolean, note? }
  createdAt, answeredAt?
  indexes: by_meetingId, by_tenantId_and_inputKey,
           by_tenantId_and_reviewState_and_createdAt, by_tenantId_and_createdAt
```

- **Fields name the user, not the role.** `authorUserId`, `userId` and `recordedByUserId` hold a closer today and any role later, with no rename.
- **No copies of the person.** Neither `callNotes` nor `callRecordings` stores `leadId`. The person comes from the deal or the meeting, so a person merge needs nothing from these tables. A recording keeps only its meeting. A note keeps its deal, so when a meeting moves to another deal, its notes move with it, as §8 says.
- **`fathomOrgMembers` isn't a staff table.** It mirrors a vendor's roster the way `calendlyOrgMembers` does, links each member to a user, and holds no role, so ADR rule 3 doesn't apply.
- **`callRecordings.inviteeEmails` is Fathom's list.** It's there for matching and reassignment. It isn't a copy of the person's identifiers under rule 5, and no code reads it as identity.
- **`callNotes` holds content, not history.** Each note also emits an event through `emitDomainEvent`, so the timeline stays in `domainEvents`, as rule 9 asks.
- **Two more tables, as built.** `mcpConfirmations` holds decision 17's preview tokens, hashed, with the arguments' hash and the commit's result for retries. `mcpClientSessions` holds each MCP session's client name, because the gateway doesn't pass `clientInfo` to tools. Both are pruned daily.
- **`secondOpinions` keeps the meeting, not the person.** A person merge needs nothing from it, and a meeting moved to another deal keeps its check.
- **`secondOpinions` holds no transcript text.** The answers are labels and numbers, `claim` comes from Magnus's own templates, and `closerNote` is the closer's words.
- **The transcript goes to file storage.** A Convex document caps at 1 MiB, and a 60-minute call is 60 to 120 KB of JSON. The summary stays inline because `magnus_today` reads it.

### 4.2 Widened tables

```ts
paymentRecords
  recordedVia?: "web" | "mcp" // set on every new payment
  agentClient?: string
  proofSha256?: string // read from _storage when the payment is written
  proofReused?: boolean // another payment in the tenant has the same file
  new index: by_tenantId_and_proofSha256

slackInstallations
  eodReportChannelId?, eodReportChannelName?, eodReportChannelError?

users
  timezone?: string // IANA name, such as "America/Tegucigalpa"
  mcpBlockedAt?: number, mcpBlockedByUserId?: Id<"users"> // decision 14

tenants
  mcpAccess?: { roles: CrmRole[], changedAt: number, changedByUserId: Id<"users"> }
  secondOpinion?: { mode: "off" | "shadow" | "on", shadowUntil?: number, monthlyCapUsd: number,
                    changedAt: number, changedByUserId: Id<"users"> } // §6.9
```

### 4.3 Components

`convex/convex.config.ts` adds `app.use(mcpGateway)` from `convex-mcp-gateway/convex.config`, pinned to 2.1.1, which brings its own tables for sessions, the tool registry and the audit log. It also adds `@convex-dev/rate-limiter` for §6.8.

## 5. Rules

### 5.1 The agent acts as the user

Every tool runs as the signed-in user. Its writes use that user's `actorUserId` and the source their role writes with, `closer` for closers, so `emitDomainEvent` derives the team member, touches and last touch exactly as it does for a click in the web app. The action's own event adds `via: "mcp"` and `agentClient`, the `clientInfo.name` the client sent on `initialize`, to its metadata. Events the helpers emit downstream, such as `opportunity.stage_changed`, don't carry them; the payment row and the gateway's audit log do. `domainEvents.source` gets no new value.

### 5.2 What a closer's agent can change

| The agent can | Through |
| --- | --- |
| Write a call note | `callNotes`, append-only |
| Set a call-back or text task | The core of `createManualReminderFollowUpPublic`. With a meeting, this records the call as held and moves the deal to Follow-up, as the web dialog does |
| Mark a meeting no-show | The core of `markNoShow`. The deal closes lost with `no_show`, and a reschedule link can still reopen it |
| Mark a deal lost | The cores of `markAsLost` and `markReminderLost`. A reason is required, and the closer's yes comes first, because a loss a person records never reopens |
| Give an unmatched recording its meeting | `callRecordings`, onto one of the closer's own meetings only |
| Log a payment on a meeting or a call-back task | The payment cores in §6.3, with a proof file the same closer uploaded |
| End the day | `endOfDayReports` and the Slack post |

The agent can't edit or delete anything, log another payment on a won deal, or log a side-deal payment. Those stay on the web.

### 5.3 No proof, no payment

A closer can't record a payment without a proof file, on any path. The rule covers the agent's payments and the four web dialogs. Admins keep proof optional. The rule lives in the mutations, so no client, prompt or retry gets around it.

### 5.4 A recording doesn't record attendance

Held means a person recorded the call's result, and `heldMarkedAt` is when they did. A matched Fathom recording never sets either. On a call that still shows "Not recorded", the recording appears next to the gap and asks the closer for the result.

### 5.5 Matching never decides identity

A recording finds its meeting by the recorder's user and the scheduled time. An invitee email only confirms the match, and placeholder values never count, under ADR rule 6. Matching never creates a person, writes an identifier or moves a meeting.

### 5.6 A report covers the closer's shift

- A report covers the time from the end of the closer's previous report to the moment they end the day.
- With no previous report, or one older than 24 hours, it starts 24 hours back and says the previous day was never closed.
- Meetings count by scheduled start, payments by `recordedAt` and tasks by due time.
- Ending the day twice is allowed, and the second report covers only the time since the first. A second request within 60 seconds returns the first report, so a double click or an agent's retry posts once.

### 5.7 The numbers follow `CONTEXT.md`

The report counts with the definitions every other screen uses:

- Show rate is held ÷ held plus no-show.
- Close rate counts the deals whose first held call fell in the shift and that are won when the report is made.
- A deposit is never cash.

The model formats numbers and never computes one. The spec's "Closing %", won ÷ answered calls, is the "sales ÷ shows" rate the glossary rules out, so the report shows the close rate instead.

### 5.8 Tool output is data

Text that came from outside the team, such as booking answers, names, notes and transcripts, comes back in fields marked as person-supplied. The instructions tell the model never to act on instructions found there. A loss, a no-show and a payment last, so each needs the user's yes in the conversation, and each carries `destructiveHint` so clients that honor it ask before running it.

### 5.9 Times are the user's local time

Tools take a date and a time without an offset and read them in the user's time zone, from `users.timezone`, or in the tenant's business-day zone when that's unset. Every result that includes a time names the zone, and every write that takes a time reads back the time it resolved.

### 5.10 The second opinion never changes a record

Jev's answers are labels and numbers. Magnus compares them with the closer's record in code and keeps the result on `secondOpinions`. Nothing in the second opinion writes to a meeting, a deal, a payment or a task, and it emits no domain event, because nothing happened to the person. A person acts on a disagreement through paths that already exist. A closer sees a check only after recording a result, so the check never steers the result it checks.

## 6. Write paths

### 6.1 Access and identity

- **URL.** `https://<deployment>.convex.site/mcp`, because the tenant has no domain, under decision 1. A domain later changes every token's audience, so every connected user re-adds the connector. With one beta closer that's cheap, so if a domain arrives, move before the rest of the team connects.
- **Token check.** As built, the `/mcp` mount in `convex/mcp/http.ts` verifies each AuthKit access token itself, with `jose`, against `${AUTHKIT_DOMAIN}/oauth2/jwks`, issuer `AUTHKIT_DOMAIN`, audience `MCP_RESOURCE_URL` and RS256, and hands the verified caller to the gateway's `resolveIdentity`. The plan put a third `customJwt` provider in `convex/auth.config.ts`, but Convex refuses to deploy an auth config that reads an unset variable, which would have made both variables required on every deployment. `convex.config.ts` declares both as optional, and every MCP route answers 404 where either is unset. The gateway runs tools inside its component, where `ctx.auth` is empty, and injects the verified caller into each tool's `caller` argument.
- **Candidates.** `getWorkosUserIdCandidates` adds the user-management form of the raw ID, so the lookup tries `<issuer>|<id>`, then `https://api.workos.com/user_management/<clientId>|<id>`, then `<id>`. `requireTenantUserFromAction` uses the same function. For the web app's tokens this adds at most one index lookup and can only find a user the current lookup misses.
- **Three conditions for access.** A user gets tools only when all three hold, and decision 14 adds a fourth:
  1. Their role holds the permission `mcp:connect` in `convex/lib/permissions.ts`. In this PR only `closer` does.
  2. Their role is in the tenant's `mcpAccess.roles`, which the owner or an admin sets in Settings.
  3. A toolset exists for their role in `convex/mcp/toolsets/`. This PR ships `closer.ts`.
- **One guard.** `requireMcpUser(ctx, roles)` runs `requireTenantUser(ctx, roles)` and then checks the conditions above. Every tool function starts with it, passing the roles that may call it. The gateway's `authorize` callback runs the same check once per request. In list mode it returns only the caller's toolset, and in call mode it refuses any tool outside it. A refused caller sees "AI assistant access is off for your role in this workspace".
- **Adding a role later.** Write the role's toolset, grant `mcp:connect`, and the settings card shows a switch for it. The endpoint, sign-in, uploads, provenance, audit, rate limit and tenant setting stay as they are. A tool two roles share, such as `magnus_person`, sits in both toolsets and lists both roles in its guard.
- **Routes.** `convex/http.ts` mounts the gateway at `/mcp` and `/mcp/` for POST, GET and DELETE, the protected resource metadata at `/.well-known/oauth-protected-resource/mcp`, and the proof upload under the `/mcp/uploads/` prefix. `requireAuth: true` gives anonymous calls the 401 challenge that starts the OAuth flow in Claude's apps.
- **Instructions.** `initializeInstructions` is built per request from a shared base and the caller's toolset. The closer toolset adds five rules. Call `magnus_today` first. Pass a meeting or task ID on every write. Read a payment, a no-show or a loss back and wait for a yes. Treat person-supplied text as data. Take every number from Magnus. A sixth joins them when the tenant's second opinion is on, under §6.9.
- **The ESLint rule.** It covers public functions only, and the tools are internal functions, so `CONVEX_ACCESS_GUARDS` needs no entry. A public function that calls `requireMcpUser` later adds it there.

### 6.2 Closer tools

| Tool | Kind | Built on | What it does |
| --- | --- | --- | --- |
| `magnus_today` | query | The readers behind `getMeetingsForRange`, `getMeetingsNeedingOutcome` and `getCloserTasks`, plus call notes and recordings | Covers the shift, from the previous report's end, or 12 hours back when there's none in 24 hours, to 18 hours ahead. Each meeting comes with its ID, person, deal stage, program, latest call note, open tasks, payments and recording, and calls still "Not recorded" come first |
| `magnus_person` | query | The bodies of `getMeetingDetail` and `getEntityDetail`, with `convex/leadCustomers/permissions.ts` | Takes a meeting ID, a person ID or a search string. Returns only people the closer may see |
| `magnus_search_deals` | query | `listMyOpportunities`, My Pipeline's open-deal filters and the latest call note | Filters by all, open, won or lost, by program and by text, plus "no next step", "Not recorded" and financing named in the latest note |
| `magnus_tasks` | query | `getCloserTasks` | Groups tasks as overdue, today and later by the tenant's business day |
| `magnus_get_recording` | query | `callRecordings` | Summary and action items inline, the transcript in pages from file storage |
| `magnus_day_summary` | query | `buildCloserDaySummary`, §6.6 | The numbers and gaps since the last report. Saves nothing |
| `magnus_add_call_note` | mutation | `callNotes` | Four required fields, plus a next action, a financing provider, and the meeting or task |
| `magnus_set_callback` | mutation | The core of `createManualReminderFollowUpPublic` | Call or text, a local date and time, and a note |
| `magnus_mark_no_show` | mutation | The core of `markNoShow` | A meeting ID, a reason and a note |
| `magnus_mark_lost` | mutation | The cores of `markAsLost` and `markReminderLost` | A meeting ID or a task ID and a required reason. With a meeting, the call is recorded as held |
| `magnus_attach_recording` | mutation | `callRecordings` | Puts one of the closer's unmatched recordings on one of their meetings |
| `magnus_proof_upload_url` | mutation | `paymentProofUploads` | For agents with a shell. Returns a single-use URL that expires in 10 minutes |
| `magnus_log_payment` | action | The payment cores in §6.3 | Takes a meeting ID or a task ID, the amount, currency, payment type, program and proof. Without proof it returns the filled-in link |
| `magnus_end_day` | mutation | `endOfDayReports` and the Slack post | Takes the narrative and an optional note. Returns the report and its Slack status |
| `magnus_move_callback` | mutation | `followUps` | Decision 20: moves one of the closer's pending call-backs to a new local time and records `followUp.rescheduled` |
| `magnus_attach_proof` | action | `paymentRecords`, `paymentProofUploads` | Decision 12a: attaches a receipt to one of the closer's payments that has none |

- **Annotations.** The six reads carry `readOnlyHint`. `magnus_mark_no_show`, `magnus_mark_lost` and `magnus_log_payment` carry `destructiveHint`.
- **Splits.** The read tools build on exported functions split out of the existing queries. Each split keeps the query's auth in the query and moves the rest into a `build*` function, without changing behavior, as `docs/agents/reporting.md` describes for reports.

### 6.3 Payments and outcomes

**Cores.** Six public mutations split into a guard and an exported core, without changing behavior:

| Mutation | Core |
| --- | --- |
| `logPayment` in `convex/closer/payments.ts` | `recordMeetingPayment` |
| `logReminderPayment` | `recordTaskPayment` |
| `createManualReminderFollowUpPublic` | `createCallbackTask` |
| `markNoShow` | `recordNoShow` |
| `markAsLost` | `recordMeetingLoss` |
| `markReminderLost` | `recordTaskLoss` |

Each core takes the resolved caller, the arguments and a provenance of `{ via: "web" | "mcp", agentClient? }`. It keeps every check and side effect of today's handler, in today's order. Tests pin each split: the web path writes the same rows and events before and after.

**Routing.** `magnus_log_payment` and `magnus_mark_lost` take either a meeting or a task:

- A meeting goes to the meeting core, which needs a scheduled meeting and a deal at Booked.
- A task goes to the task core, which needs a pending manual reminder.
- For a payment, a won deal or a side deal gets an error that says to log it in Magnus, with the link.

**Losses.** `magnus_mark_lost` requires a reason of at least a few words and refuses an empty one, unlike the web, where the reason is optional. The tool description and the instructions say to read back the person, the deal and the reason and wait for a yes. The loss event carries `via: "mcp"`. Nothing undoes it, as on the web, under decision 13.

**Proof sources.**

| Client | How the file reaches Magnus |
| --- | --- |
| ChatGPT | The tool lists `proof` in `_meta["openai/fileParams"]`. ChatGPT passes `{ download_url, file_id, mime_type, file_name }`. The action fetches the file from OpenAI's file host only, checks it, stores it with `ctx.storage.store` and inserts a `chatgpt_file` upload. The download URL works as a bearer link, so it's never stored or logged. The host allowlist holds the host the first real call in dev uses, and the build records it here |
| Claude Code, Codex, Hermes, Cursor | The agent calls `magnus_proof_upload_url`, runs `curl --data-binary @receipt.pdf` against the URL, and passes the returned `uploadId` to `magnus_log_payment` |
| claude.ai, Claude Desktop, Claude mobile, others | The tool returns a link to the payment dialog with the values filled in, and no payment exists until the closer attaches the file there |

**Upload route.** `POST /mcp/uploads/<ticket>` is an `httpAction`. It hashes the ticket and claims the pending upload, refusing a used or expired ticket. It refuses a `Content-Length` over 10 MB before reading the body. It sniffs the first bytes for JPEG, PNG, GIF or PDF and stores the file. It marks the upload `ready` with the size, type and the `sha256` from `_storage`, and returns the `uploadId`. The ticket is 32 random bytes, and only its SHA-256 is stored. It can only upload, works once, belongs to one user and expires in 10 minutes. A `ready` upload that nothing attaches within an hour expires, and its file is deleted, through a function scheduled when the ticket is issued. The route never hands out a raw Convex upload URL, because a `_storage` ID alone doesn't say who uploaded the file.

**Retries.** An upload attaches once. A retry with an attached `uploadId` returns the payment it already backs, so an agent's retry never logs a second payment.

**The link.** The link is `/workspace/closer/meetings/<meetingId>?logPayment=1&amount=…&currency=…&type=…&program=<programId>`, or `/workspace/closer/reminders/<followUpId>?…` for a task. The page opens the existing payment dialog with those values. The closer's normal login and the page's ownership check apply, which the MCP spec requires of any URL a server hands out. The payment is recorded as `web`, since the closer finished it in the browser.

**Proof on the web.** All four public payment mutations reject a closer's payment without `proofFileId`, with `rejectRequest("payment.proof_required", …)`. They read the file's `_storage` row and refuse a missing file, more than 10 MB, or a type outside the four. The dialogs mark the field required for closers.

**Reuse.** Every new payment stores `proofSha256` from `_storage`. A payment whose file already backs another payment in the tenant gets `proofReused: true`. That isn't an error. Billing shows it to the reviewer, with links to the other payments. Decision 15 backfills the hash on existing payments, so the check also catches receipts used before the deploy.

**Row fields.** Every new payment sets `recordedVia`. An agent's payment also sets `agentClient`, and its `payment.recorded` event metadata carries `via: "mcp"`.

### 6.4 Call notes

`magnus_add_call_note` checks that the deal is the caller's, and that the meeting or task belongs to the deal when it gets one. It inserts the note and emits `opportunity.call_note_added` with the caller's source, the note's ID, the meeting and the client in the metadata. The event isn't a touch or a last touch, and `touchChannel` doesn't map it. Nothing edits or deletes a note. A wrong note gets a correcting note.

A closer without an agent keeps using meeting comments. `callNotes` has no web form in this PR.

### 6.5 Fathom

**Connect.** `fathom/connection.connect({ apiKey })` is an action for `settings:manage`, and it does four things:

1. It checks the key with `GET /team_members`, which works for any key, and upserts the roster into `fathomOrgMembers`. Members link to users by email. The rest wait in the card for an admin to link by hand, because closers often record from a personal address.
2. It tries `GET /users`. A 200 means the key holder is an account admin, and the response includes each member's view access, so the card can warn when the key can't see the sales team. A 403 is expected for a dedicated seat.
3. It creates the webhook with `triggered_for: ["my_recordings", "my_shared_with_team_recordings", "shared_team_recordings"]`, every include flag on, and `destination_url` set to `${CONVEX_SITE_URL}/webhooks/fathom?c=<connectionId>`.
4. It stores the key, its last four characters, the webhook ID and the `whsec_` secret, which only internal functions read. The browser only ever sees the last four.

Replace key swaps the key and the webhook. Disconnect deletes the webhook. Import last 30 days runs the reconciliation below over 30 days.

**Webhook.** `POST /webhooks/fathom` verifies the Standard Webhooks signature, which covers `webhook-id`, `webhook-timestamp` and `webhook-signature`, against the connection's secret, within 5 minutes. It dedupes on `webhook-id`, inserts a `pending` event, schedules the processor and returns 200. Fathom retries a failed delivery with the same `webhook-id`.

**Processor.** `fathom/processor.process` reads the event, then:

- It drops the payload of a member marked ignored, such as an owner who takes no calls, and of a call with no external invitee. Only a count remains.
- It holds the payload of a member nobody has linked yet for up to 7 days. Linking the member processes it, and the daily purge deletes it otherwise.
- Otherwise it matches and inserts a `callRecordings` row, with the transcript in file storage. A match emits `meeting.recording_matched` with `source: "system"`.

**Matching.** The candidates are the recorder's meetings that start within 30 minutes of the recording's start. One candidate matches by time. With several, an invitee email among the person's real identifiers, or the meeting's join URL, picks one. None, or a tie, leaves the recording unmatched. The closer assigns their own with `magnus_attach_recording` or on Today, and admins assign any in the Fathom card. Reassigning writes `manual`.

**Crons.**

- Every 30 minutes, reconciliation, member sync and the health check run per connected tenant. Reconciliation calls `GET /meetings` with `created_after` and `recorded_by[]` set to the linked users and no include flags, which keeps it a light request. It fetches anything Magnus doesn't have from the `/recordings` endpoints, no more than 30 a minute. The health check warns when a closer has three or more calls that started today with no recording, which usually means a private call or a bot that didn't join.
- Daily, the purge deletes processed and dropped raw events after 7 days and held ones once their hold ends. It also deletes transcripts older than 90 days, under decision 9, and sets `transcriptDeletedAt`.

### 6.6 End of day

**Builder.** `buildCloserDaySummary(ctx, { tenantId, userId, periodStart, periodEnd, now })` in `convex/closer/endOfDay.ts` reuses the closer dashboard's readers and the reporting helpers. Another role that ends days later gets its own builder and widens `endOfDayReports.role`. It returns `numbers` and `gaps`:

| Part | Source |
| --- | --- |
| New calls and follow-up calls: scheduled, held, no-show, canceled, Not recorded | The window's meetings by `callClassification`, with "Not recorded" by `meetingAttendanceDisplay`'s rule. Scheduled counts every call that started in the window, canceled ones included, so the four parts add up to it, as on Team |
| Show rate for each | Held ÷ held plus no-show |
| Close rate | `readCloseRateCohort` for the window and the closer |
| Won, deposits, lost and follow-up, per deal | `readCloserMeetingDeals` and `countStripByStage` for the deals behind the window's calls. A won deal whose payments are all deposits is a deposit. Lost counts losses a person recorded |
| Cash and deposits recorded in the window | `getNonDisputedPaymentsInRange` for the closer, through `summarizePaymentsForRevenueReporting` |
| Call-back tasks due in the window | Done and still pending |
| Overran | Held calls whose matched recording ended more than 10 minutes after the scheduled end. It needs Fathom |
| Gaps | Calls Not recorded, with any recording that landed for them; overdue tasks; and recordings without a meeting |

A test pins the builder against `getPipelineSummary`: for one business day, the shared counts agree.

**Writes.** `endMyDay({ note?, timeZone? })` is public, for closers, and `magnus_end_day` is the agent's. Both call `endDayCore`, which:

1. Works out the window under §5.6 and returns the previous report if it's under 60 seconds old.
2. Builds the summary and inserts the report with `slackStatus` set to `pending` when an end-of-day channel is set, and `not_configured` otherwise.
3. Sets `users.timezone` from `timeZone` the first time a browser sends it.
4. Schedules `internal.slack.eodReports.post` when a channel is set.

**Post.** The action builds the message. Its header gives the closer's name and the shift in the closer's time zone, or in the tenant's business-day zone when the closer has none. People appear as first name and last initial with the amount, with no emails and no loss reasons, under decision 10. The agent's narrative and the closer's note follow when present. It posts through `slackApiPostJson` and saves `slackTs` and `postedAt`. On failure, it records `eodReportChannelError` the way the other channels do, clearing the channel on `channel_not_found` and `is_archived`, and marks the report `failed`. `retryEndOfDayPost({ reportId })` lets the closer, for their own reports, or an admin post again.

### 6.7 Settings

- `mcpAccess.setRoles({ roles })` is for `settings:manage`. It accepts only roles that hold `mcp:connect` and have a toolset, writes `tenants.mcpAccess`, and logs `mcp.access_changed` with the roles and the actor. It isn't a domain event, because events have no tenant entity type.
- `mcpAccess.setUserBlocked({ userId, blocked })`, under decision 14, is for `settings:manage`. It sets or clears `users.mcpBlockedAt`.
- `setSlackNotifyChannels` gains `eodReportChannel`, which is left alone when omitted and turned off by `null`, like `bookingReviewChannel`.
- `updateMyTimezone({ timeZone })` is for any tenant user and checks the name against `Intl.supportedValuesOf("timeZone")`.

### 6.8 What every tool does

- **Errors the agent can explain.** Each tool wraps its core and turns the core's plain `Error` into a `ConvexError` with the same message, so the agent can tell the user why, such as "Outcome actions open 5 minutes before the scheduled time." Anything unexpected stays generic on the wire, and the audit row keeps the detail.
- **Retries.** Payments dedupe on the upload. A call note with the same author, deal and `contentHash` within 2 minutes returns the first note. A call-back with the same deal, time and method while one is pending returns that one. A second no-show or loss on the same meeting fails with a clear message, because the meeting is no longer scheduled.
- **Rate limit.** 60 calls a minute per user, with bursts of 20, through `@convex-dev/rate-limiter` in `authorize`. That's the external API's limit, and it stops an agent stuck in a loop.
- **Logs.** Each call logs `mcp.tool_called` with the tool, client, role, duration and result through `convex/lib/observability/log.ts`, so PostHog shows adoption and failures. Unexpected failures go through `reportError`.
- **Audit.** The gateway's audit redaction drops note text, transcript pages, `proof.download_url` and the upload ticket. A daily cron prunes audit rows older than 90 days, under decision 16, and sessions idle for 30 days.
- **Losing access.** A deactivated user is refused on their next call, because `requireTenantUser` rejects inactive users. Turning a role off in the tenant's setting refuses everyone in that role. Under decision 14, an admin can block one user.

### 6.9 Second opinion

On 3 November the tenant admin asked for Jev, through the Convex AI Gateway, to read the Fathom summary and transcript and say what it thinks happened on the call. Scenes 15 to 17 of the walkthrough show it. §2.9 has the gateway facts it rests on.

**Trigger.** `queueSecondOpinion(ctx, { meetingId, trigger })` runs inside the write that makes a call checkable:

- The meeting cores of §6.3, `recordMeetingPayment`, `createCallbackTask` with a meeting, `recordNoShow` and `recordMeetingLoss`, when the meeting has a matched recording. The web and the agent share these cores, so both trigger it.
- The Fathom processor and `magnus_attach_recording`, when the meeting already has a result.
- The business-day close, from the sweep in §8, for meetings with a recording and still no result. That check has no record to compare, so its verdict is `hint`.

It does nothing when the tenant's mode is `off`, when the recording has no transcript, or when a row with the same `inputKey` exists. A check runs once per meeting and recording. A result changed later doesn't run a second one, and neither does a result recorded after a `hint`, because the closer has seen Jev's answer by then. Otherwise it inserts a `queued` row and schedules `internal.secondOpinion.run.run` with the row's ID.

**Run.** `convex/secondOpinion/run.ts` is an internal action in the default runtime:

1. It reads the row, the recording and the meeting through an internal query. It skips with `cap_reached` when the tenant's `costUsd` for the month has reached the cap.
2. It reads the transcript from file storage and relabels the speakers. The recorder becomes "Closer", a speaker who matches an invitee email becomes "Prospect", and anyone else becomes "Other". From the timestamps it measures `evidence`: minutes recorded, minutes each side spoke, and when the prospect first spoke.
3. It builds `state` from the call's kind, program and length, Fathom's summary and action items, and the transcript. A call longer than two hours sends the summary and its last hour.
4. It asks four questions. `attendance`, `ending` and `objection` are fixed choices, written once in `convex/secondOpinion/questions.ts`. `claim` is a `noul` statement that a template per kind builds from the record:
   - A payment: "On this call the prospect agreed to pay {amount} today, {in full, as a deposit, or as the first of several payments}."
   - A call-back: "The prospect agreed to talk again before deciding."
   - A loss: "The prospect turned the offer down, mainly over {reason}."
   - A no-show: "The prospect never joined the call."
5. It calls `POST https://ai-gateway.convex.dev/alpha/decisions` with `model: "typesafe/jev-1.13"`, `provider: { zdr: true, data_collection: "deny" }`, and a fresh token from `getServiceToken("ai-gateway")`.
6. It validates the response. Every question needs an answer, every `choice` must be a key Magnus offered, and every number must fall between 0 and 1. Anything else fails the run as `format_changed` and goes to `reportError`, so an alpha format change never reaches a screen half read.
7. It saves the answers, the usage and the verdict through an internal mutation.

**Verdict.** `convex/secondOpinion/verdict.ts` is plain code with its own tests:

- Each record expects an answer. A payment expects held and paid, a call-back held and call_back, a loss held and lost, and a no-show expects no_show.
- **Disagrees** when Jev's top answer for attendance or ending contradicts the record with a confidence of 0.8 or more, or when the claim rates 0.2 or less.
- **Not sure** when the top answer that matters is under 0.6, or the claim rates between 0.2 and 0.5.
- **Agrees** otherwise.
- `objection` never decides the verdict. It shows beside the closer's loss reason.

The thresholds live in one constant, under decision 32.

**Retries.** A 502 or 503 `upstream_error` reschedules the run after 1 minute, then after 5. A third failure, any 4xx and a parse failure mark it `failed`, and the call shows no card. A call that answered never runs again.

**Who sees what.**

- In `shadow` mode, owners and admins, who hold `second-opinion:review`. They see the queue and the month's counts on the Fathom card, so they can check Jev against the calls they know (changed on 10 November 2026; owners only before). Closers and their agents see nothing until `on`.
- In `on` mode, the meeting page shows the card to the closer once the meeting has a result, and to admins always. The closer's agent gets `secondOpinion` on each meeting with a result in `magnus_today` and `magnus_get_recording`, as the verdict and the labels only, and a disagreement adds a gap in `magnus_day_summary`. The instructions gain a sixth rule: mention a disagreement once and never change a result because of it.
- After the business day closes, a `hint` shows under the call in Needs outcome.

**Review.** A disagreement sets `reviewState: "open"`. The closer can add one note on the web, through `secondOpinion.addCloserNote`; the agent gets no tool for it in this PR. Admins work the open rows in Pipeline → Second opinions, through `secondOpinion.listForReview`, gated on a new permission, `second-opinion:review`, held by `tenant_master` and `tenant_admin`. `secondOpinion.check({ id, outcome, reopen? })` records the review. With `reopen` on a no-show, it runs the core of `adminCreateFollowUp`, which moves the deal from lost to Follow-up through the `missed_meeting_next_step` exception. Attendance stays no-show, under decision 33.

**Settings.** `secondOpinion.setMode({ mode, monthlyCapUsd })` needs `second-opinion:manage`, held by `tenant_master` only, because turning it on sends every recorded call to a model provider. Turning it on writes `shadow` with `shadowUntil` 14 days out. Shadow mode never ends by itself; after 14 days the card asks the owner to open it to closers and admins. Each change logs `second_opinion.access_changed`, as `mcpAccess.setRoles` does.

**Strength (10 November 2026).** A blind review of the shadow run's first 17 checks, two graders a call, found Jev right on attendance every time and on the ending 11 times in 13, but only 1 of its 6 disagreements was a real catch. Three were false alarms: a 12-line transcript, a loss Jev heard as a soft call-back while rating the closer's reason as true, and a deposit paid in another currency. So a check now:

- Asks three small groups of questions in separate Decisions calls (attendance; ending and objection; the claim), and asks each group twice: with Fathom's summary and action items, and from the transcript alone. That's 4 or 6 calls a check. The answers' probabilities are averaged, and `split` names any question the two readings answered differently.
- Leads with the claim. Disagrees needs the claim at 0.2 or less, or a confident contradiction (0.8) while the claim is under 0.5. A contradiction of a claim Jev still believes, or a split on a question that matters, is Not sure.
- Words a payment claim so a payment that arrives after the call, through a link or a financing provider, or in another currency, still fits it.
- Skips (`thin_transcript`, no gateway call) a payment, loss or call-back when the non-closer side says under 100 words. A no-show and a day-close hint still run.
- Skips (`other_prospect`) a recording whose outside invitees exclude every email this prospect has: it is another person's call, matched by time.
- Labels a speaker with no email as the Prospect when no invitee spoke by email. Fathom often gives the prospect no email, and Jev was told a stranger did the talking.

**Rerun.** `secondOpinion.rerun({ secondOpinionId })` lets an owner or admin with `second-opinion:review` run Jev again on a meeting's latest check that isn't running, against the meeting's current record and recording. The new row has `trigger: "rerun"`, `rerunOf` and `requestedByUserId`; the old one gets `supersededById` and leaves the queue and the month's verdict counts, keeping any review. Its cost still counts toward the cap. Reviewers also see checks that are running, skipped or failed, with the reason, so they can run them again.

**Cost.** The cap check sums `costUsd` over the month's rows through `by_tenantId_and_createdAt`. The Fathom card shows the month's total against the cap. Convex's own AI Gateway limit stays unset, or far above every tenant's cap, because reaching it disables the whole deployment.

**Privacy.** Transcripts leave Convex for TypeSafe's endpoints through the gateway. `zdr: true` and `data_collection: "deny"` make a request fail rather than reach an endpoint that keeps data. The gateway still records the project and function behind each request, and Convex keeps usage and billing metadata. The 90-day transcript purge in §6.5 needs no change, because `secondOpinions` keeps no transcript text.

**Logs.** Each run logs `second_opinion.ran` with the verdict, duration, tokens and cost, and `second_opinion.failed` with the failure, through `convex/lib/observability/log.ts`.

## 7. Screens

| Screen | Change |
| --- | --- |
| Settings → Integrations | An AI assistants card for owners and admins, with a switch per role that has a toolset, closers only in this PR, the MCP URL with a copy button, steps per client, and a line saying that turning a role on sends lead data to each user's AI provider. A Fathom card with the connection, the members and their links, the health warnings, the unmatched recordings, Import last 30 days, Replace key and Disconnect |
| Settings → Integrations, Slack | An "End-of-day reports" row in `SlackChannelPickerDialog` |
| Settings → Team | Under decision 14, "Block AI assistant access" in each member's menu, and a Blocked badge |
| Profile | When the user's role is switched on, "Connect your AI assistant" with the URL and the steps. A time zone setting for every user, pre-filled from the browser |
| Closer Today | An End my day button in `TodayHeader`, which opens a sheet with the numbers, the gaps, a note and "End day and post to #channel". It names the window it covers and the channel, or says no channel is set. A "Recordings without a meeting" line in `NeedsOutcomeCard`, and under a call still Not recorded after the business day, the second opinion's hint |
| Meeting page | The Recording card replaces `FathomLinkField` once a recording matches, and the paste field stays when none has. A Call notes list, newest first, each tagged with its client and time. `?logPayment=` opens the payment dialog with the values. A Second opinion card under the result once the meeting has one: Agrees, Not sure or Disagrees, the four answers with their percentages, and on a disagreement the talk-time strip and a note field |
| Pipeline → Second opinions | New, for `second-opinion:review`. Tabs for Disagree, Not sure, Checked and All. Each row opens the closer's record beside Jev's answer, the measured evidence and the closer's note, with "The closer's record stands" and "The second opinion is right", which can reopen a no-show's deal with a call-back |
| Settings → Integrations, Fathom | A "Second opinion on recorded calls" row with an owner-only switch, a consent dialog, the shadow run's day count, the month's cost against the cap, and Raise cap |
| Task page | `?logPayment=` opens the payment dialog with the values |
| Person page | The timeline shows `opportunity.call_note_added` with the note's four fields, and `meeting.recording_matched` |
| Billing | The queue and the review page mark payments logged through an agent with the client's name, and payments whose proof matches another payment, with links |
| Payment dialogs | Proof is required for closers |

## 8. What else moves

- **Upkeep lists.** The eight new tables join the tenant deletion list in `convex/admin/tenantsMutations.ts` and the test-data reset in `convex/testing/operationalData.ts`. In `convex/leads/repointLeadReferences.ts`, moving a meeting to another deal also moves its call notes.
- **Fivetran.** Before deploy, confirm the connector still sets new tables to blocked, and keep all eight blocked. `tenantFathomConnections` holds an API key, the note and recording tables hold sensitive text, and `secondOpinions` holds closers' notes. The new columns on `paymentRecords` and `users` sync, which is fine.
- **Permissions.** `convex/lib/permissions.ts` gains `mcp:connect`, held by `closer`, `second-opinion:review`, held by `tenant_master` and `tenant_admin`, and `second-opinion:manage`, held by `tenant_master`.
- **Crons.** `convex/crons.ts` gains the 30-minute Fathom run, the daily Fathom purge, the daily gateway prune, and an hourly sweep that queues a `hint` check for each tenant whose business day closed in the past hour.
- **Docs.**
  - `CONTEXT.md` gains Call note, End-of-day report and Second opinion.
  - `docs/agents/convex.md` gains an MCP section covering the toolsets, `requireMcpUser`, provenance, the upload route and the upkeep lists. Its webhooks section gains a Fathom entry, and its write side effects gain the cores and the second opinion's trigger. A new AI Gateway section covers `getServiceToken`, the response check, retries and the cap.
  - `docs/agents/auth.md` adds the MCP endpoint to "Guards by surface" and documents the token check, the candidate fix and `mcp:connect`.
- **ESLint.** No change. The tools are internal functions, and the new public functions use `requireTenantUser`.
- **ADR 0001.** No change. §4.1 records why `fathomOrgMembers` and `callNotes` fit rules 3 and 9. The second opinion adds no stage move and no exception, and reuses `missed_meeting_next_step`.
- **`proxy.ts`.** No change. The MCP routes live on the Convex site, not in Next.js.

## 9. Commits in the PR

The PR is one deploy, but it's built and reviewed commit by commit. Each commit passes `pnpm lint`, `pnpm typecheck` and `pnpm test` on its own.

| # | Commit | Contains |
| --- | --- | --- |
| 1 | Widen the schema for the AI assistant | §4 in full, the two components, the optional env declarations, `mcp:connect`, and the new tables in the upkeep lists |
| 2 | Find WorkOS users stored in the user-management form from any issuer | The candidate fix in §6.1, with tests for each stored form and each issuer |
| 3 | Split six mutations into a guard and a core | The cores in §6.3, with parity tests. No behavior change |
| 4 | Require proof for closer payments, and mark reused proofs | The four mutations, the four dialogs, `proofSha256` and `proofReused`, `recordedVia`, the Billing markers, and decision 15's backfill with its assert |
| 5 | Mount the MCP endpoint with per-role access | The token check, the routes, `authorize`, `requireMcpUser`, the toolset registry, errors, rate limit, logs, the audit prune, the settings card, the Team page block and the profile steps |
| 6 | Read tools | `magnus_today`, `magnus_person`, `magnus_search_deals`, `magnus_tasks`, and the `build*` splits they read |
| 7 | Call notes and outcomes from the agent | `callNotes`, its event, the meeting page list, the timeline row, `magnus_set_callback`, `magnus_mark_no_show`, `magnus_mark_lost`, and the call notes in `repointLeadReferences` |
| 8 | Payments from the agent | The upload table and route, `magnus_proof_upload_url`, `magnus_log_payment` with ChatGPT file params, and the `?logPayment=` handling on both pages |
| 9 | Fathom | The connection, webhook, processor, matching, crons, Recording card, unmatched queue, `magnus_get_recording` and `magnus_attach_recording` |
| 10 | Second opinion | `secondOpinions`, the trigger in the cores and the Fathom processor, the run action, the verdict, the close sweep, the card, the queue, the Fathom row, the two permissions and `magnus_today`'s field. Nothing else depends on it, so it can move to its own PR |
| 11 | End of day | The builder, `endDayCore`, the Slack post and retry, the picker row, the Today sheet, the time zone, `magnus_day_summary` and `magnus_end_day` |
| 12 | Docs | §8's docs, and this file's status and log |

Commits 3 and 4 touch the payment write paths, which the repo maintains by hand. They go to a second reviewer with the parity tests.

## 10. Deploy order

Merging deploys to production, so everything the code needs exists first.

1. **Before merge.**
   - Set `AUTHKIT_DOMAIN` and `MCP_RESOURCE_URL` on production, and on any dev deployment that should serve MCP.
   - In the WorkOS dashboard's production environment, turn on Client ID Metadata Documents and add the MCP URL as a resource indicator. Turn on dynamic client registration only if a client in §11's manual checks needs it.
   - In Fivetran, confirm new tables arrive blocked.
   - Confirm the Convex team is on a paid plan, which the AI Gateway needs. Leave the AI Gateway usage limit unset, or far above the Magnus cap, since reaching it disables the deployment.
   - Tell the closers that proof becomes required.
2. **Merge.** The deploy adds the tables and fields and turns on the proof rule. No role is switched on, Fathom stays unconnected, the second opinion is off and no end-of-day channel is set, so nothing posts and `/mcp` gives every caller an empty tool list.
3. **After deploy.**
   - Run decision 15's backfill and its assert.
   - The owner or an admin switches on closers in the AI assistants card and picks the end-of-day channel.
   - The owner sets up Fathom: a Team or Business plan, the Sales team, external meetings at "User's Team" with the full lock, and the key holder's view access. Then they paste the key.
   - The beta closer connects Hermes and Claude Desktop.
   - After a week of matched recordings, the owner turns on the second opinion. For 14 days it runs in shadow mode. Then compare its verdicts with what admins know about those calls, tune the thresholds, and open it to closers and admins.
4. **Checks on production.** Run each with a test booking from `testing/calendly:bookTestInvitee`:
   - Read the day.
   - Write a call note.
   - Log a payment with proof from a shell agent.
   - Follow the payment link from Claude Desktop.
   - Mark a test deal lost, and see the agent ask first.
   - Match a recording.
   - End the day and see the Slack post.
   - With the second opinion in shadow mode, record a test call's result and see its row, its answers and its cost.

## 11. Tests

**`convex-test`**, with `convex-mcp-gateway/test` for the `/mcp` round trip:

- **Identity.** Candidates for each stored form of `workosUserId` and each issuer.
- **Access.** A closer gets the closer toolset only when `mcpAccess.roles` includes `closer`. An admin gets an empty list and is refused on every call. A blocked user and a deactivated user are refused.
- **Ownership.** Every tool refuses another closer's meeting, deal, task, recording and upload.
- **Cores.** The web paths write the same rows and events as before the split.
- **Proof rule.** A closer needs proof on all four paths and an admin doesn't. A file that is too big or of the wrong type is refused.
- **Uploads.** A ticket works once. An expired ticket is refused. A file whose first bytes aren't one of the four types is refused. A retry with an attached `uploadId` returns the same payment.
- **Reuse.** A second payment with the same file gets `proofReused`, and the backfill's assert finds every proof hashed.
- **Routing.** A meeting goes to the meeting core and a task to the task core, for payments and losses. A won deal or a side deal gets the payment error.
- **Losses.** An empty reason is refused. The loss event carries `via: "mcp"`.
- **Errors.** A core's check message reaches the client through the gateway.
- **Retries.** A repeated call note or call-back returns the first one.
- **Times.** A call-back's local time resolves in the user's zone, and in the business-day zone when the user has none.
- **Notes.** A call note emits its event, and that event is neither a touch nor a last touch.
- **End of day.**
  - The window with no previous report, with one older than 24 hours, and twice in a row.
  - The 60-second guard.
  - Parity with `getPipelineSummary` for one business day.
  - The Slack post's success and each failure code.
- **Fathom.**
  - The signature check, and a stale timestamp.
  - Dedupe on `webhook-id`.
  - Ignored, internal-only and unlinked members.
  - Matching with one candidate, several candidates and none.
  - The 90-day transcript purge.
  - A recording never sets `heldMarkedAt`.

- **Second opinion.**
  - The trigger fires from each meeting core when a recording exists, from the processor and `magnus_attach_recording` when a result exists, and from the close sweep, and never twice for one meeting and recording.
  - `off` queues nothing, and the cap skips with `cap_reached`.
  - The claim templates, one per kind.
  - The verdict at each threshold's edge.
  - A missing answer, an unknown label and a number outside 0 to 1 fail as `format_changed`.
  - With `fetch` stubbed: a 503 then a 200, three 503s, and a 400 that doesn't retry.
  - A closer gets no card before recording, and shadow mode shows nothing to closers or admins.
  - Reopening a no-show moves the deal to Follow-up through `missed_meeting_next_step` and leaves attendance no-show.
  - A run writes nothing outside `secondOpinions`.

**Manual, on dev.** Connect and call each tool from Claude Desktop, claude.ai, Claude Code, ChatGPT developer mode, Codex CLI and Hermes. Record which clients register through CIMD and which need dynamic registration, and which ones ask before running a `destructiveHint` tool. Record the ChatGPT file host for the allowlist. Run Jev on ten real transcripts, from a deploy key whose role allows the AI Gateway, and record the `noul` answer's shape, the latency, `usage.cost` and the longest transcript it accepts.

## 12. Decisions

### 12.1 Settled by the code

- **A recording never records attendance.** Held is a person's record, under §5.4.
- **The agent's writes keep the user's source**, under §5.1, because last touch and the backfills read `source`.
- **Payments and losses follow the stage machine.** A meeting's result needs a scheduled meeting and a Booked deal. A task's result needs a pending call-back task.
- **The numbers use the glossary's definitions**, under §5.7.
- **End of day counts by shift, and Today counts by the business day.** Both use the same helpers, so a call never counts differently, it's only grouped differently. The sheet names its window, and every dated screen says which day it counts by.
- **A tenant setting change is a log line, not an event**, because `domainEvents` has no tenant entity type.

### 12.2 First batch, answered on 2 November 2026

| # | Decision | Answer |
| --- | --- | --- |
| 1 | The MCP URL | No domain yet, so `https://<deployment>.convex.site/mcp`. A domain later means every connected user re-adds the connector |
| 2 | Who can connect | Closers now, built so other roles can be added later, under §6.1 |
| 3 | Proof on the web | Required for closers in all four payment dialogs, optional for admins. The answer also asked for agent uploads beyond this, which decision 12 pins down |
| 4 | Which payments the agent logs | A meeting's payment and a call-back task's payment |
| 5 | When agent payments count | On arrival, as `recorded`, like web payments |
| 6 | No-shows and losses | Changed. The agent marks no-shows and losses, each after the closer's yes, with a required reason for a loss |
| 7 | Call notes | As recommended, with no comment: saved as written, append-only and tagged, with no confirm step |
| 8 | Claude's apps | As recommended, with no comment: a filled-in link to the payment dialog, and no stored draft |
| 9 | Fathom privacy | As recommended, with no comment: transcripts kept 90 days and summaries for good, read by the closer and admins only |
| 10 | The Slack post | As recommended, with no comment: first name and last initial with the amount, no emails, no loss reasons, no fallback channel |
| 11 | The proposal in git | Scrub it. Done: it's `docs/reviews/closer-assistant-proposal.html`, and the proposal written for the closer stays out of git |

### 12.3 Second batch, for the tenant admin

12. **Agent uploads beyond new payments.** The answer to decision 3 asked to let users upload images from their agents too. It could mean three things:
    - (a) Attach a receipt from the agent to an existing payment that has none, such as one an admin logged.
    - (b) Admins upload proof through their agents, once an admin toolset exists.
    - (c) An upload card inside Claude's chat, so Claude's apps need no link.

    Recommendation: (a) in this PR, as `magnus_attach_proof`, through the same uploads. (b) comes with an admin toolset, and (c) waits until Claude's file support inside apps is confirmed.
13. **Undoing an agent's loss.** A loss a person records never reopens, from the web or the agent. An undo window would need a new named exception in the stage machine and an ADR amendment. Recommendation: no undo. The reason requirement and the yes in the conversation are the safeguard.
14. **Blocking one user.** An admin can block one user's agent access without switching off the whole role. Recommendation: yes, through `users.mcpBlockedAt` and a menu item on the Team page.
15. **Backfilling proof hashes.** Existing payments with proof get `proofSha256` from `_storage`, so the reuse check also catches receipts used before the deploy. It's a migration with an assert, over a few hundred rows. Recommendation: yes.
16. **Audit retention.** The gateway's audit log keeps 90 days, with note text, transcript pages and upload links redacted. Recommendation: yes.

### 12.4 Third batch, from the UX walkthrough

Playing the day through in the walkthrough turned up twelve more questions. Each has a recommendation, and the walkthrough shows the options.

| # | Decision | Recommendation |
| --- | --- | --- |
| 17 | Preview, then commit, for payments, no-shows and losses | Yes. Each takes two calls: `confirm: false` returns Magnus's own read-back text and a token that binds the arguments for 10 minutes, and `confirm: true` with the token writes. It takes the read-back out of the model's hands and works in every client |
| 18 | Where End my day lives | The board's last row, lime once every call has a result, and plain board text before that |
| 19 | Deposits and the close rate | A deposit wins the deal, so it counts toward the close rate. Keep that, and keep Won and Deposits as separate lines in the report |
| 20 | Moving a call-back | Allow one narrow edit, `magnus_move_callback`, for a pending call-back the closer owns, keeping its history |
| 21 | Reschedule links after a no-show | Leave them on the web in this PR, since they reopen the deal |
| 22 | Loss reasons | A short list, such as not a fit, price, timing, went quiet and other, plus free text. The agent maps what the closer says, and the preview shows the result |
| 23 | A recording of a call with no meeting | Let the closer mark it "Not a sales call", which sets it ignored |
| 24 | Today for closers abroad | Leave Today on the business day in this PR. The report already follows the shift |
| 25 | A second report on the same day | Post it as a reply in the first report's Slack thread |
| 26 | Client names on tags | Map known `clientInfo.name` values to display names, and show the raw name otherwise |
| 27 | Where the payment link lands on a phone | A page just for the receipt, `/workspace/closer/pay`, with the values read-only and the same proof rule |
| 28 | How much agent work shows on records | "via" tags on notes, outcomes, Billing rows and timeline events, and no activity card on Today |

### 12.5 Fourth batch, the second opinion

The tenant admin asked for a second opinion from Jev on 3 November. Scenes 15 to 17 of the walkthrough show these choices, and §6.9 builds the recommendations.

| # | Decision | Recommendation |
| --- | --- | --- |
| 29 | Switching it on | An owner-only switch on the Fathom card, off by default, with a consent line. Turning it on starts a 14-day shadow run that only owners see. It needs a paid Convex plan, and every request asks for zero-data-retention endpoints |
| 30 | When the closer sees it | After they record a result. Admins see every check, and the closer's agent gets the same labels in `magnus_today`. After the business day closes, a call still Not recorded shows Jev's answer as a hint |
| 31 | What Jev reads | Fathom's summary and action items and the whole transcript, with speakers relabeled Closer and Prospect. A call over two hours sends the summary and its last hour |
| 32 | When it counts as a disagreement | Disagrees at 0.8 or more against the record, or a claim rated 0.2 or less. Not sure under 0.6. Agrees otherwise. Tune all three after the shadow run. Disagreements wait in the queue, with no Slack post in this PR |
| 33 | A no-show the recording disproves | Flag it, and let an admin reopen the deal with a call-back through the existing exception. Attendance stays no-show. If the shadow run finds more than a few a month, add an admin correction to held, with an ADR note |
| 34 | Paying for it | Magnus's own monthly cap per tenant, summed from `usage.cost`, $40 to start and revised after the shadow run. Convex's AI Gateway limit stays unset or far above it |

### 12.6 Facts to get before the build

- WorkOS Connect pricing, which the MCP docs page doesn't list.
- Whether Billing review is on for the tenant, in §3. If it's off, nobody verifies any payment, the agent's included.
- The beta tenant's Fathom plan and seat count, and whether the owner accepts the lock.
- Fathom behavior the docs don't settle, to test on the beta tenant:
  - A `shared_team_recordings` webhook carries the transcript and summary for other members' calls.
  - A non-admin seat with view access to one team receives those webhooks.
  - Whether changing a call's visibility later fires a webhook. The 30-minute run covers it either way.
  - A recording shared to two teams arrives once. The processor dedupes on the recording ID regardless.
- Whether the Convex team is on a paid plan, which the AI Gateway needs.
- From real transcripts on dev, under §11: Jev's cost per call, its latency, the shape of a `noul` answer and the longest transcript it accepts. The docs give none of them.
- Whether `getServiceToken("ai-gateway")` works in an internal action the scheduler starts. The docs don't say either way.
- The beta closer's ChatGPT plan, which only matters if they move off Hermes. OpenAI's help center ties write-capable connectors to Business, Enterprise and Edu.

### 12.7 Left out on purpose

- An admin page that lists end-of-day reports and who hasn't closed a day. Slack shows who posted.
- Notes drafted on our side when a recording lands. The second opinion returns labels, not notes, and drafting would need a text model as well.
- Reasons from the second opinion. Jev returns none, and adding a text model to explain would bring free text back into what agents read.
- An agreement rate per closer on Team. It would turn the check into a score before anyone knows how often Jev is right.
- Corrections the second opinion makes by itself. A person acts on every disagreement.
- Agent tools for another payment on a won deal, and for side deals.
- Toolsets for admins and lead generators. The access model is ready for them.
- A Fathom OAuth app, and personal Fathom keys.

## 13. Rollback

- **Switch a role off.** Every MCP call from that role is refused from the next request. Tokens stay valid but can't reach a tool.
- **Disconnect Fathom.** The card deletes the webhook, and nothing new arrives.
- **Clear the end-of-day channel.** Reports still save and stop posting.
- **Switch the second opinion off.** Queued checks skip, and the cards stay as history. Nothing else depends on it.
- **Revert the PR.** The new tables and fields stay in the schema, since rows may exist, and the code that writes them goes. The proof rule goes with the revert. No data needs repair, because nothing existing was rewritten. The proof-hash backfill only filled a new optional field.

## 14. Production log

Empty until the build.
