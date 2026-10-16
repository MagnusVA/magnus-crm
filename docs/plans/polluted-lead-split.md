# Polluted lead split: scope, attribution, and migration plan

Status: Deploy 1 (the §5.0 guards) shipped in #95, and Deploy 2 in #98 (staging, §5.1 to §5.5) and #99 (apply, verification and rollback, §5.6 to §5.9). On 2026-10-16 the 4 Tier A plans and 15 Tier B plans were applied to production and verified (§8.1). Next: restore the applied plans' activity times with `leadSplit/apply:restoreAppliedActivityTimes`, then retry the two restored deliveries (§5.10, §8.1); the 24-hour recheck; and the Tier D cleanup. The decisions on the open questions are recorded in §7.

This file holds IDs and counts only; it contains no personal data. The working dataset (PII) stays in `/tmp` on the analyst's machine.

## 1. Summary

Before commit 12e6a6e (2026-10-08), identity resolution used placeholder contact values as identity keys. Calendly's example phone `+1 234-567-8910` was one. Our analysis found three more classes of placeholder key that caused the same damage, and two of them are still live:

| Class | Example values | Still live? |
| --- | --- | --- |
| Placeholder phone on `normalizePhone`'s list | `+12345678910` | No, fixed by 12e6a6e |
| Fake phone missing from the list | `+12342342342`, `+12345678901` | **Yes** |
| Placeholder email used as the canonical email | `email@gmail.com`, `thisisnotanemail@notanemail.com` | **Yes**. `normalizeEmail` has no placeholder filter |
| Junk social handle | `g`, `na`, `j` | **Yes**. One lead each so far, no merges yet |

Four leads are polluted with certainty (Tier A). Together they hold **68 people**, **43 opportunities**, **85 meetings**, **2 customers**, and **2 payments**. Every meeting can be assigned to a person from data we already store, except 3 meetings that need a Calendly lookup. Another 22 leads (Tier B) show two people behind one lead. Most look like a setter reusing one email for a different invitee, or one person who changed handle or phone. Those need a human decision.

On 2026-10-13, polluted leads caused 1 blocked `identity_conflict` delivery and were linked to 3 `legacy_delivery_requires_review` deliveries. #92 has since dismissed all four (§3.3).

The plan:

1. Ship code guards so the keys can't re-pollute.
2. Snapshot each affected meeting's invitee from the Calendly API.
3. Build a per-lead split plan in staging tables.
4. Review and approve each plan.
5. Apply it one person at a time through `@convex-dev/migrations`, with paired `assert*` migrations.
6. Retry the blocked deliveries through `pipeline/recovery`.

## 2. Data and method

The snapshot was taken 2026-10-13 at about 07:10 UTC from the production tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant.

- **Identifier gap is closed.** The CLI export capped `leadIdentifiers` at 8000 rows per direction. To get the rest, we paged through the same read-only system query that `npx convex data` uses (`_system/cli/tableData`, with a pagination cursor). That returned all **19,188** identifiers, including the 2026-07-07 to 2026-08-04 window. We used the same method for the full `opportunities` table: 10,798 rows, where the earlier export stopped at 10,000. We did the same for leads, meetings, meetingFormResponses (42,865), customers, paymentRecords, followUps, leadNotes, slackQualificationEvents, operationsQualificationRows, leadGenAuditMatches, opportunitySearch, leadCustomerSearchRows, webhookDeliveries, calendlyBookingFacts, rawWebhookEvents, and meetingComments. We ran no mutations or actions.
- **Remaining uncertainty:**
  - Rows written after the snapshot.
  - Invitee names. Only 49 of the roughly 300 candidate meetings still have a raw payload, because of the 30-day retention. Without names, the offline analysis can't confirm that two clusters are really two people. That's why phase 2 snapshots the invitees.
- **Attribution keys, in order of strength:**
  1. An email identifier whose `sourceMeetingId` is the meeting. Proof that the meeting's booker used that email.
  2. That meeting's `meetingFormResponses` answers to the phone and Instagram questions, matched against the person's non-placeholder identifiers.
  3. The Calendly invitee resource (phase 2).

  Meetings are grouped into people with union-find over non-placeholder keys (email, phone, social).

## 3. Scope

### 3.1 Tier A: polluted by a placeholder key (split)

| Lead | Placeholder key | People | Opps | Meetings | Opps spanning more than one person | Unattributed meetings | Status | Customers / payments |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `jh74vyt52104n1w92w5hcdze35854cc7` | phone `+12345678910` | 53 | 28 | 65 | 20 | 0 | converted | 1 / 1 |
| `jh75xm6m0gj8pxwnp50gzzv0sh854wbr` | canonical email `email@gmail.com` | 9 (+ up to 3 meetings unresolved) | 10 | 14 | 2 | 3 | converted | 1 / 1 |
| `jh7bycbzs64cjawjgrk9s5q1vh89sbw3` | canonical email `thisisnotanemail@notanemail.com` and phone `+12345678901` | 4 | 4 | 4 | 0 | 0 | active | 0 / 0 |
| `jh713h2vz61fep1p09hrfy0ky5885k6m` | phone `+12342342342` | 2 | 1 | 2 | 1 | 0 | active | 0 / 0 |

Details:

- **`jh74vyt5…`**
  - 54 email identifiers belong to 53 people: one person used two emails, joined by a shared phone and handle.
  - The canonical email belongs to the first booker. The lead's `fullName` belongs to the booker of 2026-10-05.
  - The pipeline's reschedule heuristic attached most later bookers to an earlier person's canceled or no-show opportunity as "follow-up" meetings. So 20 of 28 opportunities mix 2 to 4 people.
  - The customer `kn77j2h9e3m2jny53x454ckhhx8b48ev` was converted from opportunity `js7a0x914hakbyjn1brbw35nq989cc03`, winning meeting `jn78ecey1r3qr1m9p7jt0d8pkd8azd4j`. That meeting belongs to a different person from the lead's canonical email. Under the Q5 decision, that person is the original: they keep the lead, the customer, and its payment `jx78kt0sr6497xkqtphttf1bpx8b5z8n`. The first booker, who owns the canonical email, moves out.
  - 7 Slack qualification events on this lead name handles of 4 different split-out people.
  - 434 form-response rows.
- **`jh75xm6m…`**
  - The original person (the first booker, who is also the customer `kn75pt08nyhv3zhyfrm8mj5t1n86zwvp`) has a real second email. It should become canonical.
  - The 8 other people have no email of their own on this lead; each booked with the placeholder email.
  - **7 of them already have their own lead**, matched by phone and handle, so their meetings should merge into that lead rather than a new one:
    - `jh7d52b123rjbfjt5dtkrmjg0x8708a6`
    - `jh7bt255wemq4bbfej5084gvvh87neyr`
    - `jh788b5ndf9ccgtqxnqg8rawd989cm8r`
    - `jh75vwwfvg8z9wfk8s37n61fx189g8vr`
    - `jh7ex69k588hpe29qrz4axrspd8aqwka`
    - `jh7bzhftv8dcawcsb5hj0ztdy98bfh32`
    - `jh78sxj15y8cg1yv03bgabs9jd8d3xnt`
  - Three meetings have no form answers and no sourced identifier, so they need the Calendly snapshot:
    - `jn7042pswjmyndvtyg5n5vdtts86zz9d` (on `js79z9qt64hwy69np4jk93ecvd86x420`)
    - `jn73z321v6ptvyqtrh993586hx8b1sst` and `jn7c3vjkkaa1k8grxmqxmwsegd8b20ek` (on `js75j7fwxxh98typdbxh2zht1s8b1e7v`)
- **`jh7bycbz…`**
  - Every booker used the placeholder email.
  - 2 of the 3 non-original people already have leads: `jh7d9vr2xfaqy1hvb2rs9wydy18bz0yk` and `jh7bva699ncrh3vcvf239y55ex8cad9d`.
  - The original person has no real email, so the lead's `email` must be cleared.
- **`jh713h2v…`**
  - A Slack-qualified opportunity (`js7cgq0p7z09y13dv9p7vm0199885qcx`) for person 1 picked up person 2's booking as a reschedule.
  - It has 1 Slack qualification event, 1 qualification row, and 1 lead-gen audit match. All of them belong to person 1.

### 3.2 Tier A totals and planned moves

| Item | Count |
| --- | --- |
| Polluted leads | 4 |
| Distinct people | 68 (4 stay on the original leads, 64 move out) |
| Moved people who already have their own lead (merge in) | 9 |
| New leads to create | 55 |
| Opportunities | 43: 6 stay on the original person, 37 move to another lead |
| Opportunities to split by meeting | 23 (IDs in Appendix A) |
| New opportunities created by splits | 35 |
| Meetings | 85: 39 change opportunity, 81 change lead |
| Lead identifiers | 134: 121 move, 5 placeholder identifiers deleted |
| `meetingFormResponses` rows to repoint (`leadId`, and `opportunityId` for moved meetings) | about 510 |
| Customers | 2: both stay. On `jh74vyt5…` the customer's person becomes the original (O6) |
| Payments | 2: no repointing needed (see rule O1) |
| Follow-ups / lead notes / portal edits | 0 / 0 / 0 |
| Slack qualification events (and their qualification rows) | 8 (IDs in Appendix A) |
| Lead-gen audit matches | 1 (stays) |
| Meeting comments | 6 (keyed by meeting, so no change) |
| `opportunitySearch` rows to rebuild | 43, plus 35 new |
| `leadCustomerSearchRows` to rebuild | 4 original leads, 55 new leads, and 9 existing leads that receive moves |

For the 23 split opportunities, the outcome can be derived without guesswork:

- 22 have a different person on their latest meeting than on their first.
- For every person who doesn't own the latest meeting, that person's own latest meeting is canceled (31) or no-show (4). None of them has a completed meeting needing a judgment call.
- The one `payment_received` opportunity stays with the owner of its latest (completed) meeting.

### 3.3 Deliveries tied to polluted leads

Update 2026-10-15: #92 dismissed all four deliveries below as part of the pre-#91 backlog. Each is now `ignored` with reason `dismissed_backlog`, and its raw payload is deleted 30 days after receipt:

- `t577r54…` and `t57exp269…`: payloads already deleted. They can't be retried and are dropped from §5.10.
- `t57c3dr68…`: payload deleted about 2026-10-20.
- `t57bkmwf…`: payload deleted about 2026-11-09.

Both were restored on 2026-10-15 with `pipeline/dismissal:restoreDismissedDeliveries` (2 restored, 0 skipped). `t57bkmwf…` is blocked again as `identity_conflict` and `t57c3dr68…` as `legacy_delivery_requires_review`. Restoring marks a raw payload unprocessed, and cleanup deletes only processed payloads, so neither payload has a deletion date any more.

On 2026-10-15, 9 deliveries are blocked: 7 `host_not_linked` and 2 `identity_conflict`. Neither conflict involves a Tier A or Tier B lead.

The table as of 2026-10-13:

| Delivery | Reason | Cause | Unblocked by |
| --- | --- | --- | --- |
| `t57bkmwfp0k502wfq8ts9nft558g1hh5` | `identity_conflict` | The booker's email and handle are secondary identifiers on `jh74vyt5…`, whose canonical email differs | The split, plus the phone-guard fix (the booking's phone answer is another fake: `+1 234-567-8945`) |
| `t577r54phw7vqpa598w0kerdfx8fzqfc` | `legacy_delivery_requires_review` | The booking's only match was the placeholder phone. Since 12e6a6e it resolves to a new lead | Already unblockable. Review the legacy status, then retry |
| `t57exp269mx8na6t4amcyex7qh8fyh0x` | `legacy_delivery_requires_review` | Same as above | Same as above |
| `t57c3dr68vxfnyphync2s8y9hx8fysen` | `legacy_delivery_requires_review` | The original person of `jh75xm6m…` booking with his real email. It would hit `identity_conflict`, because the canonical email is the placeholder | Finalize step F2 (real email becomes canonical) |

The other blocked deliveries are unrelated: 1 `identity_conflict` on `jh7axf7tgmhjqfrtzpb0sr6kts8f8qpg` (alias email on a Slack-qualified lead), 14 `host_not_linked`, and 311 other legacy rows.

### 3.4 Tier B: two people behind one lead, not a placeholder (human review)

These are 22 leads where meetings form two disjoint key clusters. They hold 47 opportunities, 59 meetings, 2 customers, 2 payments, 2 follow-ups, and 2 notes. Raw payloads confirm different invitee names on 5 of them: `jh72gjqp2ct41xcjswd71jh5q18ex5p5`, `jh73qkv2a0zffx07fy1kztat6n8fbk2f`, `jh750jsy569b0fvc75dhh01zb98exn0b`, `jh79ew1x6pspfbg68nfz0jf5q18fsvwp`, and `jh7f96mw4va0qergx4bbzay1ph8fw20a`. In the confirmed cases, a setter booked a second prospect with the first prospect's email. The rest look like either the same pattern or one person who changed handle or phone; only the invitee names can tell them apart.

All 22:

```
jh7bawmrtfk0j1ge99p0sw55gh85vzys jh7ee7febsya7nva2mj3mj2ynd86m42z jh744qe16tbt9k5zy1a2r6414986w9r8
jh7c6payqn4hkfgb7xdt9ztv6h86zkv7 jh78e8bhmrzqra3z1ajbd6s91d87hzpm jh73ka8wp4d8jjnhvk1meaegvh87sdk6
jh71gqy8x76fhae70m079gsb2d89z9rg jh7b28qpm94dej2pmh1h4zxsmh89zkng jh7902ynjk28s6emf5vjr3g6f58a2f92
jh7fpw15t3mqnxygm86eey1t4s8a9kag jh72y061p1chsex7m1gdy066hx8an1vt jh7cxxe3bjzckh8ms3w36yvs1x8c8bhe
jh77f6hvgbywc4gc2f4rw0t4h18dfwfq jh7eby7rt5nnwtrw2p2c49hpwd8dh6jt jh75wp5sa0v4gbza6c1e1azsvs8dqynj
jh7fvmppmdp2am47an1h56c5rn8dwkfw jh72gjqp2ct41xcjswd71jh5q18ex5p5 jh750jsy569b0fvc75dhh01zb98exn0b
jh73qkv2a0zffx07fy1kztat6n8fbk2f jh79ew1x6pspfbg68nfz0jf5q18fsvwp jh76qpm0fq7h4x8rpj066gw6d58fxafv
jh7f96mw4va0qergx4bbzay1ph8fw20a
```

Notes:

- `jh750jsy…`'s second person already has a lead (`jh70jd0jn2n2rxx8fqpdfqv8158brtqr`). The split there is a merge-in.
- `jh7fvmppmdp2am47an1h56c5rn8dwkfw` and `jh7902ynjk28s6emf5vjr3g6f58a2f92` are converted. Check whose meeting won before moving anything.
- When the second person booked with someone else's email, the extracted lead gets **no** email. The email belongs to the first person.

### 3.5 Excluded or cleanup-only

- **Staff and test leads (7, no action):** `jh7cg5zpd4ssny9bnh16qt9qf98559qg`, `jh7dn9nbzxm89dzdy2tds8hh2d85b9zm`, `jh74jtm0mb5ahn16n66e87xtq586f18d`, `jh792794knx7g04nspvmb7q7cx88ttm2`, `jh72ws8bxeeb2j5yb7zxemhdq989p4en`, `jh78h0mjp0dbsqpezgrw2hzghs8bjv5s`, `jh7b0dg5gkyznev20918tdky598bj78x`. These hold company-domain emails or test names.
- **Alias-email leads (33):** one person with two emails, joined by a real shared phone or handle. Nothing to split. Bookings with either email resolve to the lead, because the matcher accepts an email already stored as an identifier on the matched lead (Q4, resolved).
- **Single-person leads holding a live placeholder key (Tier D).** Delete or neutralise the key once the code guard ships:
  - canonical `email@yahoo.com`: `jh789dqeaqrarwjcvgx62r10vh876ktw`
  - canonical `email@icloud.com`: `jh7e7pnatzw4a5cxfed2g5rhkd89bx3c`
  - phone `+12123456789`: `jh73510wtnyyysz3bmbxb6df0x89qgkx`
  - an AU-format phone shared by 3 bookers' form answers: `jh7cfph9fczqhjwdkr9b1b727d8e13zb`
  - handle `g`: `jh77fwnfavb7ht9151fff1xx0585t5ya`
  - handle `na`: `jh72g76k82rx2hebpbyakja8098agbb5`
  - handle `j`: `jh703aahrv3zdxjra744n3s49s8cyc8k`
- **Fake sequential phones:** about 12 more single-lead phone identifiers look fake (patterns like `+1 234-…`, or a 3-digit group repeated). Each would become a magnet the first time a second booker types the same value. The exact list depends on the guard rule chosen in Q1.

Across the tenant, 290 meetings carry the placeholder phone answer, spread over 202 leads. Only the 60 on `jh74vyt5…` were mis-merged. The rest resolved through their own email.

## 4. Attribution rules

1. **Person key.** A person is a union-find cluster of meetings that share a non-placeholder key:
   - the snapshot invitee email
   - an email identifier sourced from that meeting
   - the normalized phone answer, or the identifier sourced from that meeting
   - the normalized Instagram answer, or the identifier sourced from that meeting

   Placeholder keys never join clusters. If clusters share no key but have the same snapshot name and email domain, they are flagged "possible same person" and merged only after human approval.
2. **Original person.** The person whose meeting sourced the lead's earliest identifier stays on the existing lead ID. In all four Tier A leads this is also the first booker. On a lead with a customer, the customer's person stays instead (Q5, §5.4).
3. **Merge-in target.** If a moved person's non-placeholder keys already resolve to exactly one other active lead, that lead receives the person; this checks identifiers, plus `leads.by_tenantId_and_email` for canonical emails. If they resolve to more than one lead, the person is flagged for review.
4. **Identifier ownership.**
   - An identifier goes to the person who owns its `sourceMeetingId`.
   - Identifiers with no source meeting (`slack_qualified`, `manual_entry`) stay with the original person unless their value matches a moved person's key.
   - Placeholder identifiers are deleted.
5. **Determinism, Tier A offline:**
   - 82 of 85 meetings attribute without guessing: 72 through an identifier sourced from that meeting, 10 through form answers matching an identifier sourced from another meeting of the same lead.
   - 3 meetings need the snapshot.
   - The snapshot should confirm all 85 before anything is applied. Any meeting where the snapshot email disagrees with the offline cluster is flagged.
6. **Tier B.** The plans can be computed, but each one stays `needs_review` until a reviewer confirms the people are distinct.

## 5. Migration design

### 5.0 Prerequisite code fixes (Deploy 1, before any data change)

Without these, the split leads re-pollute on the next booking and the retried deliveries recreate bad keys.

1. **Phone guard.** Extend `normalizePhone`'s placeholder check in `convex/lib/normalization.ts`. Add the known fakes (`12342342342`, `12345678901`, `12123456789`, `12345678945`) and a pattern rule; the exact rule is Q1. Add tests next to the existing normalization tests.
2. **Email guard.**
   - Add `isPlaceholderEmail()`: a denylist of `email@gmail.com`, `email@yahoo.com`, `email@icloud.com`, and `thisisnotanemail@notanemail.com`, plus local part `email` or domains like `notanemail.com`, `example.com`.
   - Do **not** make `normalizeEmail` return `undefined`. `inviteeCreated` treats a missing email as a fatal payload error.
   - Instead, in `resolveLeadIdentity`, `createLeadIdentifiers`, and `syncLeadFromBooking`:
     - skip the legacy `by_tenantId_and_email` lookup
     - skip the email identifier
     - never set `lead.email` from a placeholder
3. **Social guard.** In `normalizeSocialHandle`, reject handles with fewer than 2 alphanumeric characters, and a denylist (`na`, `n/a`, `none`, `-`, `...`).
4. **Optional split lock.** Add an optional field `leads.splitLockedAt`; adding an optional field is safe and needs no migration. `findLeadByIdentifier` and the email match call `blockBooking("identity_conflict")` when a matched lead is locked, so a booking arriving mid-split blocks and can be retried rather than landing on a half-split lead.

### 5.1 Widen: staging tables (Deploy 2; new tables, no backfill)

The tables live in `convex/leadSplit/schema.ts`. Every row carries `tenantId`.

| Table | Purpose | Key fields |
| --- | --- | --- |
| `leadSplitInviteeSnapshots` | Calendly invitee data per meeting | `meetingId`, `inviteeUri`, `outcome` (`ok` \| `not_found` \| `http_error` \| `network_error` \| `invalid_uri`), `httpStatus?`, `email?`, `name?`, `phone?`, `social?` (`platform`, `handle`), `fetchedAt`. Index `by_meetingId` |
| `leadSplitPlans` | One per source lead | `sourceLeadId`, `tier` (`A` \| `B`), `status` (`draft` \| `needs_review` \| `approved` \| `applying` \| `applied` \| `rolled_back` \| `failed` \| `dismissed`), `planVersion`, `discoveryReasons[]`, `flags[]`, `flagDetails[]` (IDs only), `placeholderIdentifierIds[]`, `unattributedMeetingIds[]`, `slackFieldsPersonKey?`, `overrides?`, `builtAt?`, `approvedBy?`, `approvedAt?`. Indexes `by_tenantId_and_sourceLeadId`, `by_tenantId_and_status` |
| `leadSplitPersons` | One per person in a plan | `planId`, `planVersion`, `personKey`, `candidateKeys[]`, `role` (`original` \| `new` \| `merge_into`), `targetLeadId?`, `mergeCandidateLeadIds[]`, `meetingIds[]`, `identifierIds[]`, `slackEventIds[]`, `opportunityPlan[]`, `canonical` (`email?`, `fullName?`, `phone?`, `customFieldsMeetingId?`), `extractedAt?` (apply's first pass is done), `status` (`pending` \| `applied` \| `skipped`). Indexes `by_planId_and_personKey`, `by_planId_and_status` |
| `leadSplitAudit` | Append-only undo log | `planId`, `personKey`, `step`, `table`, `docId`, `op` (`insert` \| `patch` \| `delete`), `before?` (full document, without system fields), `after?` (patched fields, cleared ones as null), `createdAt`, `revertedAt?`. Indexes `by_planId_and_personKey_and_step`, `by_planId_and_revertedAt` |

- `personKey` is `p_` plus the person's first meeting ID. A hash of the keys would change whenever a booking adds a key, which would orphan reviewer overrides.
- Each `opportunityPlan` entry has `opportunityId`, `kind` (`whole` \| `keep_document` \| `split_new`), the person's `meetingIds` on it, `statusAtBuild`, the resulting `status`, `inheritsOutcome`, and, once apply creates it, `newOpportunityId`. Apply stops if a document's status has moved since the build.
- `canonical.customFieldsMeetingId` names the meeting whose form answers become the lead's custom fields; apply rebuilds them from that meeting rather than storing a copy.

The arrays are bounded by plan size: at most 65 meetings, under 120 identifiers, and the largest plan has 53 persons. Move them to child rows if a plan ever exceeds about 1000 entries.

### 5.2 Phase 1: discover (read-only)

- `leadSplit/discover:listCandidatesPage` is an `internalQuery` with `paginationOpts` over the tenant's leads. For each lead it clusters the meetings from stored keys only (no snapshots) and returns leads that:
  - hold a placeholder key under the new guards, or
  - have meetings forming more than one key cluster, or
  - have more than one `calendly_booking` email identifier.
- Each candidate gets a tier: `A` (more than one person and a placeholder key), `B` (more than one person, no placeholder), `D` (a placeholder key, one person), `alias` (several booking emails, one person), or `bounds` (too large to read).
- `leadSplit/discover:discover` is an `internalAction` with arguments `{ tenantId, dryRun, excludeLeadIds?, pageSize? }`. It drives the query page by page and writes a `draft` plan for each Tier A and Tier B lead through `recordCandidates`. A lead that already has a plan keeps it, so a rerun creates nothing new. It returns every candidate, so Tier D and alias leads are reported without getting a plan.
- Staff and test leads are skipped through `excludeLeadIds`, the 7 IDs in §3.5.

### 5.3 Phase 2: snapshot invitees (read-only on our data)

- `leadSplit/snapshot:fetchInvitees` is an `internalAction` with arguments `{ planId, dryRun, limit?, refetch? }`. It loads `tenantId` from the plan and gets the token from `getValidAccessToken` in `convex/calendly/tokens.ts`. That helper may refresh the token, the same as the token cron does.
- For each meeting of the plan's lead, it sends `GET meeting.calendlyInviteeUri`. It writes one `leadSplitInviteeSnapshots` row per meeting: an upsert by `meetingId`, so it's idempotent.
  - Meetings that already have an `ok` snapshot are skipped unless `refetch` is set, and a failed fetch never replaces an `ok` snapshot.
  - With `dryRun` it fetches but stores nothing. `limit` caps the calls, so a dry run can probe one meeting.
  - It returns counts and meeting IDs only, never invitee data.
- The token only goes to `https://api.calendly.com/scheduled_events/<event>/invitees/<invitee>`, with redirects disabled (§6.1).
- About 150 calls in total, run sequentially. 429, 5xx and network failures are retried up to 4 times with backoff, honoring `Retry-After`, with `CALENDLY_FETCH_TIMEOUT_MS` per call. Three 401 or 403 responses in a row stop the run; a single forbidden invitee doesn't.
- The snapshot stores the invitee's email, name, phone (the mapped phone answer, or `text_reminder_number`), and handle.
- If a meeting gets a 404 or no response, it is flagged `snapshot_missing` and falls back to the offline keys.

### 5.4 Phase 3: build plans (staging writes only)

`leadSplit/plan:buildPlan` is an `internalMutation` with arguments `{ planId, dryRun, overrides? }`. The rules are in `convex/leadSplit/planner.ts`.

- It reads the lead, identifiers, opportunities, meetings, form responses, snapshots, customers, payments, follow-ups, and Slack events, then writes `leadSplitPersons`.
- A build replaces the persons of a `draft`, `needs_review`, `approved`, `dismissed` or `rolled_back` plan, bumps `planVersion`, and clears any approval.
- Reads are bounded per lead (`EVIDENCE_LIMITS` in `evidence.ts`, including totals of 300 meetings and 1,500 form answers). A lead past a bound is flagged `bounds_exceeded`, and discovery reports it as tier `bounds`.
- The status after a build:
  - `dismissed` when fewer than two persons remain
  - `needs_review` for Tier B or any flag
  - `draft` otherwise
- With `dryRun` it writes nothing and returns the would-be counts and flags (§6.1).

Rules:

- **Keys per meeting** (§2):
  - identifiers sourced from the meeting
  - its phone and handle answers
  - the snapshot's email, phone, and handle

  A form answer counts as a phone or handle when the event type's `customFieldMappings` names its question, by label or field key. Without a mapping it counts when the label says phone or Instagram, as every production label does. Placeholder values never become keys.
- **Persons** (§4 rule 1, and the §6.1 shared-email note).
  - Phones and handles join meetings outright.
  - An email joins two groups only when they don't conflict. Two groups conflict when:
    - both have phones and share none
    - both have handles and share none
    - both have snapshot names and neither name's words are all contained in the other's
  - So a setter who reuses a prospect's email for someone else can't merge two people.
  - An email that ends up with more than one person is flagged `shared_email`.
- **Unattributed meetings** (no key at all) join the person who owns the rest of their opportunity, or the original. They are flagged `unattributed_meeting`.
- **Original** (§4 rule 2, amended by Q5). On a lead with a customer, the original is the person who owns the customer's winning meeting, or, without one, the keeper of its winning opportunity.
  - The customer therefore never moves, and the lead never goes from `converted` back to `active` (ADR rule 8).
  - This replaces O6 and finalize step F3.
  - Otherwise the original is the person whose meeting sourced the lead's earliest identifier, or the first booker.
- Merge-in targets follow §4 rule 3:
  - More than one matching lead flags `merge_target_ambiguous`, until the `mergeTargets` override picks one or a new lead.
  - A target with a live plan of its own (`draft`, `needs_review`, `approved` or `applying`), or a split-locked target, flags `merge_target_in_plan`.
- Identifier ownership follows §4 rule 4, with one addition: a shared email goes to the original when they used it, otherwise to whoever booked with it first.
- **O1, which person keeps an opportunity document.** By default, the person on the latest meeting by `scheduledAt` keeps the existing document, with its status, outcome fields, closer, `calendlyEventUri`, payments, follow-ups, and `customers.winningOpportunityId`. Every other person gets a new opportunity.
  - Exception: when `source` isn't `calendly` (`slack_qualified` or `side_deal`), the document stays with the person its earliest Slack event's handle names. Without such a person, it stays with the first-meeting person. It keeps `source`, `qualifiedBy`, `manualCreationKey`, and the Slack event and qualification row.
  - The outcome fields move to the latest owner's new opportunity (`inheritsOutcome`).
  - The keeper's status becomes that of their own latest meeting. The change goes through `transitionOpportunity` with the `lead_split` exception, which allows `no_show` to `canceled` only.
  - Any other change is flagged `outcome_review`, even one the state machine allows: the document's other fields belong to its current status. So is a document whose outcome would leave its payments or follow-ups behind.
  - The Slack event stays with the document. When its handle doesn't name the keeper, the plan is flagged `slack_event_mismatch`.
  - Tier A has one such case: `js7cgq0p…`.
- **O2, status for people who don't keep the document.** Status comes from their own latest meeting: `scheduled`, `canceled`, or `no_show`. `canceledAt` and `noShowAt` come from the meeting. If their latest meeting is `completed`, the plan is flagged `outcome_review`. That never happens in Tier A.
- **O3, first-booking caches**, computed for every new or kept opportunity from its own earliest meeting:
  - `firstMeetingId` and `firstMeetingAt`
  - `firstBookedAt`
  - `utmParams`
  - `firstBookingProgram*` (from the meeting's `bookingProgram*`)
  - `attributionTeamId`, `dmCloserId`, and `attributionResolution*`
  - `createdAt` (set to the first meeting's `createdAt`)
  - `eventTypeConfigId`, copied from the source
- **O4, meeting fields.**
  - The earliest meeting on each resulting opportunity gets `callClassification: "new"`; the others get `follow_up`.
  - `rescheduledFromMeetingId` is cleared when it points at another person's meeting.
  - `leadName` is re-derived.
- **O5, canonical lead fields per person.**
  - `email`: the person's latest non-placeholder email they own (snapshot or identifier). The original keeps the lead's current email when it is theirs. Left unset if they have none (Q5).
  - `fullName`: the snapshot name from their latest meeting.
  - `phone`: the latest non-placeholder phone.
  - `customFields` and `customFieldLabels`: rebuilt from the form responses of their latest meeting with answers (`customFieldsMeetingId`).
  - `socialHandles` and `searchText`: rebuilt from identifiers.
  - `firstSeenAt`: their first meeting's `createdAt`.
  - Slack- and portal-entered fields (`country`, `leadType`, `initialSource`, `selfReportedIncome`) go to the person who owns the lead's latest Slack event, or to the original (`slackFieldsPersonKey`). Either way the plan is flagged `slack_fields_review`.
- **O6, customer.** The customer stays on the source lead with the original (see Original above).
  - The plan is flagged `winning_opportunity_mismatch` when the customer's winning meeting or winning opportunity would leave with another person.
  - A lead with more than one customer is flagged `customer_review`.
- **O7, other references.**
  - Slack qualification events are reassigned by `handleSnapshot` to the person who owns that handle. Their `opportunityId` becomes the person's opportunity open at `submittedAt`.
  - Follow-ups follow their opportunity document. A follow-up created between two different people's meetings is flagged.
  - Lead notes stay with the original person.
  - `linkPortalLeadEdits` (audit trail) and `domainEvents` stay as they are.
- **Flags** force `needs_review`. Every Tier B plan needs review too.
  - Non-blocking flags; a named reviewer may approve with them:
    - `snapshot_missing`
    - `snapshot_disagrees` (the snapshot email isn't the email the meeting sourced)
    - `possible_same_person` (no shared key, compatible names)
    - `shared_email`
    - `unattributed_meeting`
    - `followup_between_people`
    - `slack_fields_review`
    - `slack_event_mismatch`
  - Blocking flags; approval is refused until a rebuild clears them (`BLOCKING_FLAGS` in `plan.ts`):
    - `outcome_review`
    - `customer_review`
    - `winning_opportunity_mismatch`
    - `merge_target_ambiguous`
    - `merge_target_in_plan`
    - `stale_override`
    - `bounds_exceeded`

### 5.5 Phase 4: review and approve

- **Overrides.** Reviewer decisions are `buildPlan` overrides, stored on the plan and reapplied on every rebuild:
  - `merges`: groups of candidate persons that are one person
  - `separate`: groups of meetings pulled out as their own person
  - `skips`: candidate persons left on the source lead, as part of the original
  - `originalPersonKey`: the person who stays on the source lead. On a lead with a customer, the customer stays with its winning meeting's person, so naming anyone else is flagged `winning_opportunity_mismatch`. If the winning meeting is attributed to the wrong person, fix it with `separate` or `merges`.
  - `mergeTargets`: for a moved person, the lead to merge into (one of those their keys match), or none for a new lead.

  Overrides name candidate persons by their `candidateKeys`, so a merged person can still be referred to by its parts. An override that names a person or meeting that no longer exists is flagged `stale_override`.
- **Approval.** `leadSplit/plan:approve` is an `internalMutation` with arguments `{ planId, planVersion, reviewer }`.
  - It approves only a built `draft` or `needs_review` plan whose version matches the one reviewed, and only when it has no blocking flag.
  - A Tier A plan with no flags may be approved by the operator running the migration. A flagged plan needs a named reviewer.
- **Inspection.** All internal queries:
  - `leadSplit/plan:describe` prints a plan as IDs and counts, for review and for this document's appendix.
  - `leadSplit/plan:reviewPacket` adds each person's names, emails, phones and handles. Write it to `/tmp`, delete it after review, and never commit it.
  - `leadSplit/plan:listPlans` lists a tenant's plans.

### 5.6 Phase 5: apply (Deploy 2 code, run with the migrations component)

The code is in `convex/leadSplit/apply.ts`. Three migrations in `convex/migrations.ts`, each with `batchSize: 1`, run it one person or one plan per transaction. They act only on `approved` plans (and on `applying` ones, to resume), and skip everything else:

```
npx convex run migrations:run '{"fn":"migrations:applyLeadSplitExtractions","next":["migrations:applyLeadSplitPersons","migrations:finalizeLeadSplitPlans"]}'
```

A rerun after a later approval needs `"reset": true`. A split document only moves to its keeper's lead after every other person has taken their meetings out, so all extractions run first.

1. **`applyLeadSplitExtractions`** (`extractPerson`, pass 1). For each pending person:
   - The first person of a plan moves it from `approved` to `applying`.
   - Lock the source lead, and a `merge_into` target, with `splitLockedAt`. A target already locked by another plan stops the run, because that plan's finalize would unlock it and its rollback would overwrite this plan's writes.
   - **Target lead.** For `role: "new"`, insert the lead with its O5 fields, status `active`, and locked. Then call `insertLeadAggregate`, add 1 to `totalLeads`, emit `lead.created` (`source: "system"`, metadata `{ splitFromLeadId, planId }`), and rebuild its lead/customer row. The new lead's ID is stored on the person as `targetLeadId`.
   - **Split opportunities.** For each `split_new` entry, check the document is still on the source lead with its built status, then insert the new opportunity on the target lead:
     - `status` from the entry. The status fields come from the person's own latest meeting (O2); with `inheritsOutcome`, the document's outcome fields are copied instead (cancellation, lost, no-show and payment fields, and the sold program).
     - `source: "calendly"`, `calendlyEventUri` and `assignedCloserId` from the person's latest meeting, and the host fields only when that closer is the document's closer.
     - `eventTypeConfigId` from the document; the O3 caches from the first meeting without an internal UTM, as the pipeline fills them; `createdAt` from the first meeting.
     - `insertOpportunityAggregate`, the matching `updateTenantStats` delta, and `opportunity.created` with `{ splitFromOpportunityId, planId }`.
     - Each meeting moves with `moveMeetingToOpportunity` (`convex/leads/repointLeadReferences.ts`), which updates its aggregates and projection and repoints its form responses, webhook receipts and reassignment rows. The earliest meeting becomes `new` and the rest `follow_up`, and `rescheduledFromMeetingId` is cleared when it names another person's meeting (O4).
     - A meeting with a payment never moves; the extraction stops instead. No current plan has one.
     - Then `updateOpportunityMeetingRefs`, the qualification rows of both opportunities, and `requestOpportunityProjections` on the new one. The entry stores the new ID as `newOpportunityId`.
   - The person is marked `extractedAt`.
2. **`applyLeadSplitPersons`** (`movePerson`, pass 2). It refuses to start a plan whose persons aren't all extracted. For each pending person:
   - **Identifiers.** Each moves to the target lead, or is deleted when the target already has the same type and value. An identifier the person holds although another person's booking sourced it (a shared email kept by its owner) is re-sourced to the person's own latest meeting whose invitee used the value, or its source is cleared. `leadSplit/apply:resourceAppliedIdentifiers` does the same for a plan applied before this step existed.
   - A `merge_into` target that will hold the Slack fields (`slackFieldsPersonKey`) takes the ones it lacks, as a merge does.
   - **Checks.** Every whole or kept document must still be on the source lead with its built status and exactly its planned meetings. A new booking or a status change since the build stops the run.
   - **Kept documents.** The status becomes the keeper's through `transitionOpportunity` (`lead_split` exception). Then the O3 caches and `createdAt` are recomputed through `patchOpportunityLifecycle`, which re-keys the aggregates, and the O4 meeting fields are fixed.
   - **Moves.** For a moved person, each whole or kept document goes to the target lead with `moveOpportunityToLead`. The audit row keeps the duplicate flag the move clears. If a deal's lead gen match would merge into the target's own match for the same prospect, the run stops instead: `repointAuditMatch` deletes the loser, which rollback can't restore. No current plan has one.
   - **Slack events.** Each of the person's events moves to their lead (O7). It points at their part of the deal it named, or, if they had no part in it, at their first deal created at or after the qualification (else their latest). The qualification row is rebuilt.
   - **Refresh.** The target lead's `socialHandles` and `searchText` are rebuilt from identifiers, then the refresh chain runs: `refreshOpportunitySearchForLead` (which also rebuilds the lead/customer row), `syncLeadMeetingNames`, and `syncCustomerSnapshot`. The source lead's lead/customer row is rebuilt too.
   - The person is marked `applied`.
3. **`finalizeLeadSplitPlans`** (`finalizePlan`) acts on an `applying` plan once no person is pending.
   - F1: delete the placeholder identifiers.
   - F2: the source lead takes the original person's O5 fields: `email` (cleared when they have none), `fullName`, `phone` (cleared, so the placeholder phone goes), custom fields from their latest meeting with answers (cleared if none), and `firstSeenAt`. If the Slack fields went to another person, they are cleared here. The step stops if another active lead already has the email as its canonical email, because every booking with it would then be an identity conflict.
   - F4: the refresh chain above, which includes `syncCustomerSnapshot`, so the customer's name and email follow the corrected lead.
   - F5: the qualification rows of every opportunity and Slack event left on the lead.
   - Restore activity times: the split's writes set `updatedAt` on every deal it creates or moves. Each deal still at the split's write time gets back its time from before the split; a deal the split created gets the latest time on its own record. Without this, split deals sort to the top by activity, and the pipeline holds any earlier booking for those people as `historical_booking_requires_review`. `leadSplit/apply:restoreAppliedActivityTimes` does the same for an already-applied plan.
   - F6: clear `splitLockedAt` on the source and every target, emit `lead.split` (`{ planId, personsMoved, opportunitiesCreated, meetingsMoved }`), and set the plan to `applied`.

`firstSeenAt` for a person is their first meeting's `createdAt` or their first Slack qualification, whichever is earlier.

**Undo log.** Every write records a `leadSplitAudit` row in the same transaction (`convex/leadSplit/audit.ts`): an insert with its counter delta, or a patch or delete with the document as it was. The `step` names what to undo: `split:<opportunityId>`, `move:<opportunityId>`, `keep:<opportunityId>`, `identifier`, `slack_event`, `lock`, `refresh` or `finalize`. Projection rows, search rows and domain events are rebuilt or kept, not logged.

**Idempotency.** A batch that throws rolls back whole, audit rows included. `extractedAt` and person and plan statuses make every step safe to rerun, and a failed run resumes where it stopped.

**Failure.** A throw stops the whole chain. Plans finalized before it stay `applied` and unlocked. Plans that started and didn't finalize stay `applying` with their leads locked, so bookings for those people block as `identity_conflict`. Run `preflight` on every approved plan immediately before starting. If a run stops, check each plan's status, then fix the cause and rerun, or roll the unfinished plans back. Either way, retry the blocked deliveries afterward.

**Transaction size.** Tested with transaction limits on, a plan shaped like `jh74vyt5…` (53 people, 28 deals, 65 meetings, 434 form answers) applies and rolls back inside Convex's limits (`apply.test.ts`).

**Preflight.** `leadSplit/apply:preflight` is a read-only query that runs every check above against current data for an unapplied plan, and returns the problems by ID: a deal whose status or meetings changed since the build, a moved identifier, an unusable merge target, a payment on a meeting that would move, or an email another lead already holds.

### 5.7 Dry run and idempotency

- **Dry run.** Every phase-1 to phase-3 function takes `dryRun`. For apply, `preflight` is the dry run that reads real data. The migrations component's `dryRun: true` runs one batch and rolls it back, but the first batch is whichever person comes first in the table, so it shows little.
- **Rehearsal.** Import a production export into a dev deployment (`npx convex export --prod`, then `npx convex import` on dev) and run the whole pipeline there. Compare the assert results and dashboard totals.
  - Leave `tenantCalendlyConnections` and `slackInstallations` out of the import. Dev runs the token refresh and Slack reminder crons; with production's tokens it would rotate production's refresh tokens and post to the real workspace.
  - Without tokens, dev can't call Calendly. The rehearsal reuses the `leadSplitInviteeSnapshots` rows the production snapshot already wrote, which come with the export.
  - Export dev first: the import replaces its tables.

### 5.8 Verification

The code is in `convex/leadSplit/verify.ts`. Run the checks after the apply migrations, once the projection queue drains (status changes reach meetings through it), and again 24 hours later.

- **`assertLeadSplitPersonsApplied`** is a migration over `leadSplitPersons`. It throws for any person of a plan still `applying` or `failed`. For each person of an `applied` plan, it throws unless:
  - each of the person's meetings is on an opportunity on their target lead, and mirrors that opportunity's status
  - their form answers point at that meeting's opportunity and lead
  - their identifiers (the ones not deleted as duplicates) and Slack events are on the target lead
  - a new or original target lead's `email` is unset or the person's email
  - every deal apply rebuilt has exactly one `new` meeting, its earliest
- **`leadSplit/verify:verifyTenant`** is an action over the whole tenant. Rows outside the split fail these checks until Tier D is cleaned up and the Tier B plans are decided, so it reports a count and the first 50 failures by ID for each, instead of throwing:
  - `identifier_meeting_consistency`: an identifier's source meeting sits on a deal on the identifier's lead. This invariant detects any future pollution.
  - `placeholder_identifiers` and `placeholder_lead_emails`: no identifier value or canonical email passes the placeholder guards. Tier D rows are expected here.
  - `form_response_refs`, `follow_up_refs`, `slack_event_refs` and `customer_refs`: each row's lead and opportunity agree with its source.
  - `meeting_opportunity_status`: each meeting mirrors its opportunity's status.
- The existing `assertOpportunitySearchProjectionBackfilled` and `assertLeadCustomerSearchRowsBackfilled` must pass.
- **Counts:**
  - `reporting/verification:verifyTenantStatusCounters` must match.
  - `totalLeads` should rise by the plans' `newLeads` total: every new lead is active, and no lead changes status.
  - `totalOpportunities` should rise by the plans' `newOpportunities` total.
  - `verifyBackfillCounts` (`convex/reporting/verification.ts`) must pass.
  - Operations meeting projections must drain: the `rebuildMeetingProjections` assert family and `migrations.getStatus`.
- **Identity probe.** `leadSplit/verify:probeDelivery` replays the matching half of `resolveLeadIdentity` for a stored booking, read-only. It returns the matched lead IDs, any locks, and whether the one matched lead's `email` is the booking's. Run it on each blocked delivery in §3.3; after the split it must resolve to exactly one lead with the booking's email.

### 5.9 Rollback

1. **Before applying:** take `npx convex export --prod --path <secure location>` for forensics and a last-resort restore.
2. **Per plan:** `leadSplit/rollback:rollbackPlan` is an `internalMutation` with arguments `{ planId, batchSize? }`. It undoes up to `batchSize` audit rows (default 25) newest first, across all the plan's persons, and schedules itself until none are left. Undone rows get `revertedAt`.
   - A moved deal goes back with `moveOpportunityToLead`, and a moved meeting with `moveMeetingToOpportunity`.
   - A kept document's status goes back through `transitionOpportunity` with the `lead_split_rollback` exception (canceled to no-show only), and its other fields through `patchOpportunityLifecycle`.
   - Patched identifiers, leads and Slack events get their old fields back. Deleted identifiers are re-inserted, with new IDs.
   - Inserted opportunities are deleted with `deleteOpportunityAggregate`, which also deletes the search row, and the counters they added are reversed.
   - Inserted leads are deleted with their `leadTimeline` entry and lead/customer row, and `totalLeads` goes down.
   - Each batch ends with the refresh chain for every touched lead, and with meeting refs and qualification rows for every touched opportunity.
   - The last call resets the persons to `pending`, sets the plan to `rolled_back`, and emits `lead.split_rolled_back`. A rolled-back plan can be rebuilt.
3. Rollback is only safe while nothing new has attached to what the split created, because each batch commits. Before every batch, it checks that nothing changed since the split: no unplanned opportunity, identifier or Slack event on a new lead; no unplanned meeting, follow-up, payment or Slack event on a new opportunity; and no kept deal whose status moved on from the one apply gave it. It stops otherwise, and a read past its bound stops it too. The split lock covers the apply window; after finalize clears it, move any later rows off first.
4. Each batch recomputes a touched lead's `socialHandles` and `searchText` from its identifiers rather than restoring the stored copies.

### 5.10 Pipeline recovery after the split

1. Confirm that the phase 5.0 guards are deployed.
2. The dismissed deliveries were restored on 2026-10-15 (§3.3). Run the identity probe (5.8) on `t57bkmwfp0k502wfq8ts9nft558g1hh5` and `t57c3dr68vxfnyphync2s8y9hx8fysen`. `t577r54…` and `t57exp269…` lost their payloads and can't be retried.
3. As a tenant admin, call `pipeline/recovery:preview` with those IDs, then `pipeline/recovery:retry` with the returned manifest; there's a limit of 50 per call. The Operations pipeline recovery panel uses the same functions.
   - `retry` rejects stale manifests.
   - The raw payloads are retained, because they are unresolved.
   - The processor re-enqueues blocked sibling cancellations once the meeting exists.
4. **Legacy rows** need a reviewer to confirm that the event isn't a duplicate of an existing meeting (check `calendlyBookingFacts` and `meetings` by `calendlyEventUri`). They also need a check that the event is still relevant (not canceled, or a cancellation that should still be recorded) before retrying.
5. **Tier B leads:** after each approved plan, look for deliveries whose `inviteeUri` belongs to that lead's people and retry them the same way.

### 5.11 Narrow (Deploy 3)

- After 30 days with clean asserts:
  - delete the staging tables' rows (the snapshot table holds PII)
  - drop the tables
  - remove the split-lock check and the `leads.splitLockedAt` field (deprecate it first, then remove it once no document has it)
  - remove the migration definitions
- Keep `assertIdentifierMeetingConsistency` as a scheduled health check, or turn it into an operations health banner item.

## 6. Cases needing human review

- **Lead `jh75xm6m…` and merge-ins.**
  - Confirm that the 3 unattributed meetings on `jh75xm6m…` (listed in 3.1) belong to the person the snapshot names.
  - Confirm that the 7 merge-in targets for that lead, and the 2 for `jh7bycbz…`, are the same people. They match by phone and handle; there is no email.
- **Customer's person.** On `jh74vyt5…`, who stays on the lead with customer `kn77j2h9e3m2jny53x454ckhhx8b48ev` depends on winning meeting `jn78ecey…`. That meeting is attributed by its form answer (handle), not by a sourced email. The snapshot must confirm it.
- **Slack fields on `jh74vyt5…`.** Its `country`, `leadType`, and `customFields` are mixed. A reviewer should accept the O5 rebuild for the original person.
- **Slack-qualified opportunity `js7cgq0p…`.** Apply the O1 exception, and confirm the lead-gen audit match stays with person 1.
- **All 22 Tier B leads.** Decide distinct versus same person after the snapshot. For the confirmed shared-email cases, the extracted person gets no email.
- **Two converted Tier B leads** (`jh7fvmppmdp2am47an1h56c5rn8dwkfw`, `jh7902ynjk28s6emf5vjr3g6f58a2f92`). Decide which person owns the customer. The plan gives it to the winning meeting's person; if the snapshot shows that meeting belongs to someone else, correct the clusters with `separate` or `merges`. On `jh7902yn…` the winning October booking reused the July booker's email, so the email stays with the customer's person and the July booker leaves without one.

### 6.1 Design review notes (resolved in Deploy 2)

- **Shared emails.** An email joins two groups only when they don't conflict, and is flagged `shared_email` otherwise (§5.4). Reviewers split a cluster with the `separate` override (§5.5).
- **Dry run.** `buildPlan` takes `dryRun` and then writes nothing: no persons, no version bump.
- **Winning opportunity.** The customer's person is the original, and a plan whose winning meeting or opportunity would leave with someone else is flagged `winning_opportunity_mismatch`, which blocks approval.
- **Snapshot token.** `fetchInvitees` loads `tenantId` from the plan, calls only HTTPS invitee URLs on `api.calendly.com`, and disables redirects.

## 7. Decisions

Recorded 2026-10-15. The tenant is still a test tenant whose owner knows the data is mid-migration, so the decisions favour the simplest correct path.

- **Q1. Phone guard rule.** Resolved in #95: the known fakes plus a pattern rule for +1 numbers only (an ascending or descending run of 7, or a repeated 3-digit group).
- **Q2. Email guard scope.** Resolved in #95: a denylist, local part `email`, and domain `notanemail.com`.
- **Q3. Opportunity ownership.** Rule O1 as written, with one refinement: a Slack or side-deal document stays with the person its Slack event's handle names, falling back to the first-meeting person. Dashboards will show about 35 more opportunities, with `createdAt` dates moved to each one's first meeting.
- **Q4. Alias emails.** Resolved in #95.
- **Q5. Setter-reused emails.** The extracted person gets no email. Since #95, recording a payment for a lead without an email asks for one first. On a converted lead, the customer's person stays on the source lead and keeps the email, so the customer never moves (O6) and no lead leaves `converted` (F3 is gone).
- **Q6. Domain events.** Emit `lead.split`, and tag split-created `lead.created` and `opportunity.created` events with `{ splitFromLeadId | splitFromOpportunityId, planId }`.
  - Tagging fixes PostHog only. The in-app new-leads report counts by `_creationTime`, and `verifyBackfillCounts` requires that count to match the `leads` table, so the new leads show as created on the apply day. This is accepted; Phase 1 moves lead counts to stage entry.
  - New opportunities are backdated through `createdAt`.
- **Status changes.** The one kept-document status change in current data, `js7cgq0p…` from `no_show` to `canceled`, goes through `transitionOpportunity` with a named `lead_split` exception that allows that move only. Any other move is flagged `outcome_review`.
- **Rehearsal.** On dev, from a production export without `tenantCalendlyConnections` and `slackInstallations` (§5.7).
- **Q7. Raw read method.** The split reads inside the deployment through paginated internal queries. Offline audits use `npx convex export`, which gives a consistent snapshot without the 8,192-row cap and without handling the deploy key by hand. `_system/cli/tableData` is not used again.

## 8. Production run of the staging half (2026-10-15)

Run against the one tenant after #98 deployed. Only the staging tables were written; no lead, meeting, deal or customer changed.

**Discovery** (staff and test leads excluded) scanned 10,364 leads: 4 Tier A, 22 Tier B, 13 Tier D, 33 alias, 0 bounds. It created 26 plans (4 A, 22 B).

- The Tier A leads are the four in §3.1.
- Tier B differs from §3.4 by one lead each way:
  - `jh76qpm0fq7h4x8rpj066gw6d58fxafv` is gone. Its second booking's phone answer equals the first's, so it is one person who changed handle; the offline audit missed the phone.
  - `jh70dwq4m1p2x9kt07hzg58qys8cwd5e` is new: two bookings on 2026-10-14 share an August booking's email, with a different phone.
- Tier D found 13 leads, against the 7 in §3.5. Two of those seven aren't detected: `jh7cfph9fczqhjwdkr9b1b727d8e13zb` (the AU phone) and `jh703aahrv3zdxjra744n3s49s8cyc8k` (handle `j`). The placeholder rules need a look before the Tier D cleanup.

**Snapshots.** All 26 plans, 145 meetings: 145 `ok`, 0 not found, 0 failed.

**Builds.** No plan has a blocking flag. Tier A totals: 68 persons, 23 split deals, 55 new leads, 9 merge-ins, 5 placeholder identifiers, 120 identifiers moving (121 in the offline audit), 7 Slack events reassigned.

| Lead | Plan | Status | Version | Notes |
| --- | --- | --- | --- | --- |
| `jh713h2v…` | `v17a2pq76s0dka2rftaccrmq4n8gd90c` | draft | 1 | 2 persons; `js7cgq0p…` goes from no-show to canceled for its keeper |
| `jh7bycbz…` | `v170rcc0wd74rnqa01j8egm51s8gddrw` | draft | 1 | 4 persons, 2 merge-ins |
| `jh74vyt5…` | `v171kqhkscx9sfda6kkp9m8x998gcsh9` | needs_review | 1 | 53 persons, 52 new leads, 20 split deals, 107 identifiers. Flags `possible_same_person`, `slack_fields_review` |
| `jh75xm6m…` | `v176w13p4zr00kqkcd20hq7ezn8gccw7` | draft | 2 | 9 persons, 7 merge-ins; override below |

**Review decisions so far**, applied as `buildPlan` overrides (staging only; a rebuild without the override undoes one):

- `jh75xm6m…`: meetings `jn73z321v6ptvyqtrh993586hx8b1sst` and `jn7c3vjkkaa1k8grxmqxmwsegd8b20ek` were booked with a placeholder email and had defaulted to the original. Their booking names match person `p_jn7235mgj24a4ae3ysjcrmp6hd8aq52f`, who merges into `jh7ex69k588hpe29qrz4axrspd8aqwka`, so they are separated and merged into that person. The third meeting from §3.1 attributed from its snapshot.
- Five Tier B leads are one person each, merged and now `dismissed`: `jh72y061…`, `jh73ka8w…`, `jh77f6hv…`, `jh7bawmr…` and `jh7c6pay…`. Each shares one email and a compatible booking name, and the phones or handles differ by a typo. `jh75wp5s…` and `jh7b28qp…` were dismissed by the build, because their snapshots showed one person.
- The other 15 Tier B plans stay split and `needs_review`: the booking names differ, or only first names match.
- `jh74vyt5…`'s `possible_same_person` pair shares only a name, with nothing in common in email or handle, so it stays two people.
- On the converted Tier B leads `jh7fvmpp…` and `jh7902yn…`, the winning meeting belongs to the person who stays, so the customer doesn't move.
- The merge-ins whose target lead's name differs from the moving person's are all Slack-qualified leads matched on the handle the setter logged.

Final state: Tier A 3 `draft` and 1 `needs_review`; Tier B 7 `dismissed` and 15 `needs_review`. None is approved.

### 8.1 Apply (2026-10-16)

`#99` deployed, then a production export was taken for forensics and preflight passed on all 19 plans. Approvals were recorded as "Claude (delegated by Claudio)".

- **Tier A**, 4 plans: 68 persons applied, 55 new leads, 9 merge-ins, 34 new opportunities. `totalLeads` went from 10,113 to 10,168 and `totalOpportunities` from 11,020 to 11,054. Active opportunities (4,100) and customers (262) didn't change.
- **Tier B**, 15 plans: 30 persons applied, 4 new leads, 11 merge-ins, 2 new opportunities. `totalLeads` went to 10,172 and `totalOpportunities` to 11,056.
- Before Tier B, a dry-run rebuild of its 15 plans confirmed that none of their persons matched a lead Tier A had just created.

Verification after both:

- `assertLeadSplitPersonsApplied`: passed for all 98 persons.
- `assertOpportunitySearchProjectionBackfilled`, `assertLeadCustomerSearchRowsBackfilled`, `assertMeetingProjections`: passed.
- `verifyTenantStatusCounters`: match.
- `verifyTenant`: 0 failures on form response, follow-up, Slack event, customer and meeting-status refs.
  - Placeholder identifiers went from 18 to 13, and placeholder canonical emails from 4 to 2. Both remainders are Tier D.
  - `identifier_meeting_consistency` had 1 failure: the shared email on `jh7902yn…`, which the buyer keeps, was still sourced from the other booker's meeting. The re-sourcing step above fixes it.
- `verifyBackfillCounts` can't run on this tenant: it reads whole tables and passes Convex's 16 MB read limit. This is unrelated to the split.
- `resourceAppliedIdentifiers` re-sourced the 1 identifier on plan `v17bnz36dtq0dz0xx5e4k1h8b18gct53`, after which `identifier_meeting_consistency` was 0.
- **Retries held as historical.** Retrying `t57bkmwf…` and `t57c3dr68…` blocked both again as `historical_booking_requires_review`. On each lead, the only deal updated after the booking arrived was one the split had just written (`js7884jk…` and `js79z9qt…`); before the split those deals were last updated in June. All 91 deals the split touched still had the split's write time. Restoring activity times fixes both.
- **Identity probe.** `t57bkmwf…` resolves to one lead, `jh79mptftd4b41487tdx3mqd6d8gcwnc` (split from `jh74vyt5…`), and `t57c3dr68…` to `jh75xm6m…`. In both, the lead's email is the booking's. Neither booking has a meeting or a recorded cancellation; they were for 2026-09-29 and 2026-10-10.

## Appendix A: IDs

Split opportunities (23):

```
js7b38j8ve3qpcx73pqz5p3ca5854azv js7cvn7c4jtpxgpeye9vfbfz45855x2k js70mytygtg9s2mxes8b28f2sn85b71d
js77pgg1pfcmfgw3t90wr3392h85dj8g js794v3b7t3fvyz39ax9p33tqh85gxbp js77cvt5frz4dyg0qcwx5cb4d985qyg6
js7034cj03am7r9496sdja4q9d85zckg js79txsvb9t0pvhc4mw399ar4d8601zt js7769s9rphpnpzxrdbvme6vch868m50
js7d3v6m0tzvqrhkpkdffag3g986awv9 js710s3h3svpbbtg708m8shfsd86as6a js7bvgydz849a8k0r728q0ryr586cwjg
js7fzajxd250pase7h503gkkn586eq5z js7f24zbsaawvr0bx79s6m5h3n86p4h6 js735qr782dzhd37tp3cdrq9hn86p7pp
js7bc99qzakp6521zvcxdtyzrh88jrwa js7a0x914hakbyjn1brbw35nq989cc03 js70w6cn4ysj3n7wcfyepyjrkh89e2kg
js76z8whwzabsfa352w3jxnswd8bwdvr js7cs730cvncd8wfc29haame158e1v8k js79z9qt64hwy69np4jk93ecvd86x420
js71dedf9y1408sjt0v4yd2sh5871wv5 js7cgq0p7z09y13dv9p7vm0199885qcx
```

Slack qualification events to reassign (8):

```
ps73vcjy0ssd8m0d29bz0hrrp9884dhz ps7427j3qh7fsv7tcjyrcbx30d89fxd6 ps76zmyggpceefqgf7200psy1s89y6wx
ps75g1a31zj86aradxqrjqam9s8b1dcx ps7cbztwm72hc88ye0wj2fsx9n8f9dkn ps7bv5passes7jv2ngvzarsj9d8fj3fk
ps70m0y7xbz4hpb7ma1zqhkzv58fkks9 ps78gryfbr673zmwjexrcb7vtn8g0n7m
```

Customers: `kn77j2h9e3m2jny53x454ckhhx8b48ev` (moves), `kn75pt08nyhv3zhyfrm8mj5t1n86zwvp` (stays).

Payments: `jx78kt0sr6497xkqtphttf1bpx8b5z8n` and `jx7enf5zzpnvr9cgj40sx5k69h86z6gh`. Both stay on their opportunity documents.
