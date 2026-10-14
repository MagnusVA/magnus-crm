# Polluted lead split: scope, attribution, and migration plan

Status: proposal, nothing applied. This file holds IDs and counts only; it contains no personal data. The working dataset (PII) stays in `/tmp` on the analyst's machine.

## 1. Summary

Before commit 12e6a6e (2026-10-08), identity resolution used placeholder contact values as identity keys. Calendly's example phone `+1 234-567-8910` was one. Our analysis found three more classes of placeholder key that caused the same damage, and two of them are still live:

| Class | Example values | Still live? |
| --- | --- | --- |
| Placeholder phone on `normalizePhone`'s list | `+12345678910` | No, fixed by 12e6a6e |
| Fake phone missing from the list | `+12342342342`, `+12345678901` | **Yes** |
| Placeholder email used as the canonical email | `email@gmail.com`, `thisisnotanemail@notanemail.com` | **Yes**. `normalizeEmail` has no placeholder filter |
| Junk social handle | `g`, `na`, `j` | **Yes**. One lead each so far, no merges yet |

Four leads are polluted with certainty (Tier A). Together they hold **68 people**, **43 opportunities**, **85 meetings**, **2 customers**, and **2 payments**. Every meeting can be assigned to a person from data we already store, except 3 meetings that need a Calendly lookup. Another 22 leads (Tier B) show two people behind one lead. Most look like a setter reusing one email for a different invitee, or one person who changed handle or phone. Those need a human decision.

Right now polluted leads cause 1 blocked `identity_conflict` delivery. They are also linked to 3 `legacy_delivery_requires_review` deliveries.

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
  - The customer `kn77j2h9e3m2jny53x454ckhhx8b48ev` was converted from opportunity `js7a0x914hakbyjn1brbw35nq989cc03`, winning meeting `jn78ecey1r3qr1m9p7jt0d8pkd8azd4j`. That meeting belongs to a different person from the lead's canonical email. So the customer and its payment `jx78kt0sr6497xkqtphttf1bpx8b5z8n` must move to that person's new lead.
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
| Customers | 2: 1 moves (`kn77j2h9…`), 1 stays (`kn75pt08…`) |
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

### 3.3 Blocked deliveries tied to polluted leads

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
2. **Original person.** The person whose meeting sourced the lead's earliest identifier stays on the existing lead ID. In all four Tier A leads this is also the first booker.
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

| Table | Purpose | Key fields |
| --- | --- | --- |
| `leadSplitInviteeSnapshots` | Calendly invitee data per meeting | `tenantId`, `meetingId`, `inviteeUri`, `email?`, `name?`, `phone?`, `instagram?`, `httpStatus`, `fetchedAt`. Index `by_meetingId` |
| `leadSplitPlans` | One per source lead | `tenantId`, `sourceLeadId`, `tier` (`A` \| `B`), `status` (`draft` \| `needs_review` \| `approved` \| `applying` \| `applied` \| `rolled_back` \| `failed`), `flags[]`, `approvedBy?`, `approvedAt?`, `planVersion` |
| `leadSplitPersons` | One per person in a plan | `planId`, `personKey` (stable hash of sorted keys), `role` (`original` \| `new` \| `merge_into`), `targetLeadId?`, `meetingIds[]`, `identifierIds[]`, `opportunityPlan[]`, `canonical` (`email?`, `fullName?`, `phone?`, `customFields?`), `status` (`pending` \| `applied` \| `skipped`). Indexes `by_planId`, `by_status` |
| `leadSplitAudit` | Append-only undo log | `planId`, `personKey`, `step`, `table`, `docId`, `op` (`insert` \| `patch` \| `delete`), `before?` (full document), `after?` (patched fields). Index `by_planId` |

The arrays are bounded by plan size: at most 65 meetings, under 120 identifiers, and the largest plan has 53 persons. Move them to child rows if a plan ever exceeds about 1000 entries.

### 5.2 Phase 1: discover (read-only)

- `leadSplit/discover:listCandidatesPage` is an `internalQuery` with `paginationOpts`. It scans `leadIdentifiers` and `leads` and returns leads that:
  - hold a placeholder key under the new guards, or
  - have meetings forming more than one key cluster, or
  - have more than one `calendly_booking` email identifier.
- An `internalAction` drives it page by page and writes `leadSplitPlans` drafts through an internal mutation. It is idempotent per `sourceLeadId` and `planVersion`.
- Staff and test leads are skipped by an explicit allowlist passed as an argument.

### 5.3 Phase 2: snapshot invitees (read-only on our data)

- `leadSplit/snapshot:fetchInvitees` is an `internalAction` with arguments `{ planId, dryRun }`. Use the existing `getValidAccessToken` from `convex/calendly/tokens.ts`.
- For each meeting of the plan's lead, it sends `GET meeting.calendlyInviteeUri`. It writes one `leadSplitInviteeSnapshots` row per meeting: an upsert by `meetingId`, so it's idempotent.
- About 150 calls in total. Run sequentially with backoff on 429, using `calendlyHttpError` and `CALENDLY_FETCH_TIMEOUT_MS` from `convex/calendly/apiErrors.ts`.
- If a meeting gets a 404 or no response, it is flagged `snapshot_missing` and falls back to the offline keys.

### 5.4 Phase 3: build plans (staging writes only)

`leadSplit/plan:buildPlan` is an `internalMutation` with arguments `{ planId }`. It reads the lead, identifiers, opportunities, meetings, form responses, snapshots, customers, payments, follow-ups, Slack events, and audit matches, then writes `leadSplitPersons`. Rebuilding replaces the persons for a `draft` or `needs_review` plan and bumps `planVersion`. Rules:

- Persons, original, merge-in targets, and identifier ownership follow section 4.
- **O1, which person keeps an opportunity document.** By default, the person on the latest meeting by `scheduledAt` keeps the existing document, with its status, outcome fields, closer, `calendlyEventUri`, payments, follow-ups, and `customers.winningOpportunityId`. Every other person gets a new opportunity.
  - Exception: when `source` isn't `calendly` (`slack_qualified` or `side_deal`), the document stays with the first-meeting person, together with `source`, `qualifiedBy`, `manualCreationKey`, and the Slack event and qualification row. The outcome fields move to the latest owner's new opportunity. Tier A has one such case: `js7cgq0p…`.
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
  - `email`: the person's non-placeholder snapshot or identifier email. Left unset if they have none.
  - `fullName`: the snapshot name from their latest meeting.
  - `phone`: the latest non-placeholder phone.
  - `customFields` and `customFieldLabels`: rebuilt from the form responses of their latest meeting.
  - `socialHandles` and `searchText`: rebuilt from identifiers.
  - `firstSeenAt`: their first meeting's `createdAt`.
  - Slack- and portal-entered fields (`country`, `leadType`, `initialSource`, `selfReportedIncome`) stay on the original person unless a Slack event's handle matches a moved person, in which case they follow that person. Either way they are flagged for review.
- **O6, customer.** If `customers.winningMeetingId` belongs to a moved person, the customer moves:
  - `customers.leadId` is set to that person's lead.
  - That lead is created with `status: "converted"`.
  - The source lead returns to `active`.

  The move requires a non-placeholder email for the target person, because `customers.email` is required. Without one, the plan is flagged.
- **O7, other references.**
  - Slack qualification events are reassigned by `handleSnapshot` to the person who owns that handle. Their `opportunityId` becomes the person's opportunity open at `submittedAt`.
  - Follow-ups follow their opportunity document. A follow-up created between two different people's meetings is flagged.
  - Lead notes stay with the original person.
  - `linkPortalLeadEdits` (audit trail) and `domainEvents` stay as they are.
- **Flags** that force `needs_review`:
  - `snapshot_missing`
  - `snapshot_disagrees`
  - `possible_same_person`
  - `merge_target_ambiguous`
  - `outcome_review`
  - `customer_without_email`
  - `followup_between_people`
  - every Tier B plan

### 5.5 Phase 4: review and approve

- `leadSplit/plan:approve` is an `internalMutation` with arguments `{ planId, planVersion, reviewer, personMerges? }`. It sets `approved` only when the version matches.
- A reviewer can merge two person clusters (same person), or mark a person `skipped` (left on the source lead).
- A Tier A plan with no flags may be approved by the operator running the migration. A flagged plan needs a named reviewer.
- `leadSplit/plan:describe` is an `internalQuery` that prints a plan as IDs and counts, for review and for this document's appendix.

### 5.6 Phase 5: apply (Deploy 2 code, run with the migrations component)

Two `migrations.define` migrations in `convex/migrations.ts`, each paired with an `assert*` migration:

- `applyLeadSplitPersons` runs over `leadSplitPersons` with `batchSize: 1`. Each `migrateOne` handles one person. It returns early unless the plan is `approved` or `applying`, the person is `pending`, and the role isn't `original`. Steps, all in one transaction, each recorded in `leadSplitAudit`:
  1. **Target lead.**
     - For `role: "new"`:
       - insert the lead with O5 fields and the final status (`active`, or `converted` for an O6 customer move)
       - call `insertLeadAggregate`
       - call `updateTenantStats({ totalLeads: +1 })` when the status is `active`
       - emit `lead.created` (`source: "system"`, metadata `{ splitFromLeadId, planId }`)
     - For `merge_into`: load the existing lead and leave its canonical fields alone.
     - Idempotency: on retry, look up an audit `insert` for `(planId, personKey, "lead")` before inserting again.
  2. **Identifiers.**
     - For each of the person's identifiers: if the target already has the same `(type, value)`, delete the source row; otherwise patch `leadId`. Patching keeps `source`, `sourceMeetingId`, and `createdAt`.
     - Placeholder identifiers are never moved. Finalize deletes them.
  3. **Whole opportunities** (every meeting belongs to this person):
     - patch `opportunities.leadId`, and clear `potentialDuplicateLeadId` if it points at the target
     - call `upsertOpportunitySearchProjection`
     - patch the `leadId` on `followUps`, `meetingFormResponses`, `slackQualificationEvents`, `leadGenAuditMatches`, and `webhookDeliveries` for that opportunity
     - call `rebuildQualificationRowsForOpportunity`

     `patchOpportunityLifecycle({ leadId })` does not call `replaceOpportunityAggregate`. That is safe, because `opportunityByStatus` keys on `[status, assignedCloserId, createdAt]`. Call it anyway whenever O3 changes `createdAt`.
  4. **Split opportunities.**
     - If this person doesn't keep the document:
       - insert a new opportunity (O2 or the inherited outcome, plus O3)
       - call `insertOpportunityAggregate`
       - call `updateTenantStats({ totalOpportunities: +1, activeOpportunities: +1 if active, wonDeals / lostDeals as applicable })`
       - emit `opportunity.created` (metadata `{ splitFromOpportunityId }`)
     - For each moved meeting:
       - read the old snapshot
       - patch `opportunityId` and the O4 fields
       - call `replaceMeetingAggregate(old, id)`, which also re-syncs `meetings.opportunityStatus` and enqueues the meeting projection
       - patch `meetingFormResponses.opportunityId` and `leadId`
       - repoint any `paymentRecords` with that `meetingId` to the new opportunity
     - Then:
       - call `updateOpportunityMeetingRefs` on both opportunities
       - if the kept document's status, outcome, or `createdAt` changed: patch it, call `replaceOpportunityAggregate(old, id)` (which also enqueues `requestOpportunityProjections` when the status changed), and apply the matching `updateTenantStats` delta to `activeOpportunities`, `wonDeals`, and `lostDeals`
       - call `requestOpportunityProjections` on the new opportunity
       - call `rebuildQualificationRowsForOpportunity` on both
       - move the Slack event and qualification row per O7, then rebuild the row
  5. **Customer (O6).**
     - Patch `customers.leadId`.
     - Call `syncCustomerSnapshot` for the target lead, then `syncCustomerPaymentSummary`.
     - No new `customerConversions` aggregate entry and no `totalCustomers` delta, because the customer is moved, not created.
  6. **Refresh the target.**
     - Recompute `socialHandles` and `searchText` from identifiers.
     - Call `refreshOpportunitySearchForLead`.
     - Call `syncLeadMeetingNames(leadDisplayString(lead, identifiers))`.
     - Call `rebuildLeadCustomerSearchRow`.
  7. **Mark done.** Set the person to `applied`, and the plan to `applying`.
- `finalizeLeadSplitPlans` runs over `leadSplitPlans` with `batchSize: 1`. It only acts on `applying` plans where every non-original person is `applied` or `skipped`.
  1. F1: delete the placeholder identifiers.
  2. F2: patch the original lead's canonical fields (O5). For `jh75xm6m…`, the real email becomes canonical; for `jh7bycbz…`, the email is cleared.
  3. F3: status. If the customer moved away, set `converted` to `active`. This deliberately bypasses `validateLeadTransition`, because `converted` has no outgoing transitions. Emit `lead.status_changed` with `reason: "lead_split"` and apply `updateTenantStats({ totalLeads: +1 })`.
  4. F4: refresh chain, the same as step 6, plus `syncCustomerSnapshot` and `rebuildLeadCustomerSearchRow`.
  5. F5: rebuild qualification rows for every opportunity left on the lead.
  6. F6: emit `lead.split` (metadata `{ planId, personsMoved, opportunitiesCreated, meetingsMoved }`), clear `splitLockedAt`, and set the plan to `applied`.

The split lock: `applyLeadSplitPersons` sets `splitLockedAt` on the source lead and all target leads in its first step, and finalize clears it.

**Transaction size.** The largest single person in Tier A touches about 4 meetings, 30 form responses, 2 to 4 opportunities, and the refresh loops over that person's lead. The original lead's refresh loops over at most 28 opportunities and 65 meetings, then shrinks. Everything stays far below Convex read/write limits with `batchSize: 1`. Do **not** process a whole plan in one `migrateOne`: the 53-person plan would mean thousands of writes in one transaction.

### 5.7 Dry run and idempotency

- **Dry run:**
  - Every phase-1 to phase-3 function takes `dryRun` and writes nothing when it is set. They return the would-be plan.
  - The apply migrations use the component's `dryRun: true`, which runs one batch and rolls it back: `npx convex run migrations:run '{"fn":"migrations:applyLeadSplitPersons","dryRun":true}'`.
  - Each `migrateOne` also logs a structured `leadSplit.apply.preview` event with IDs and counts, through `log` from `convex/lib/observability/log.ts`.
- **Rehearsal.** Before production, import a production export into a dev deployment (`npx convex export --prod`, then `npx convex import` on dev) and run the whole pipeline there. Compare the assert results and dashboard totals.
- **Idempotency:**
  - Each person and plan carries a status, and audit rows are keyed by `(planId, personKey, step, docId)`.
  - A retried batch skips steps whose audit `after` state already matches the document.
  - Moves are expressed as "set field to target"; nothing is incremented. The exception is `updateTenantStats`, which runs only in the same transaction as the insert it accompanies.

### 5.8 Verification

Paired `assert*` migrations, plus internal queries. Run the asserts after the apply migrations, and run them again 24 hours later.

- `assertLeadSplitPersonsApplied` (over `leadSplitPersons`):
  - each meeting in `meetingIds` sits on an opportunity whose `leadId` equals `targetLeadId`
  - each identifier in `identifierIds` has `leadId` equal to `targetLeadId`
  - the target lead's `email` is either unset or the person's email
- `assertIdentifierMeetingConsistency` (over `leadIdentifiers`, tenant-wide). For every identifier with `sourceMeetingId`, the meeting's opportunity's `leadId` must equal the identifier's `leadId`. This invariant detects any future pollution. Today it fails on all four Tier A leads, and the expected failures for Tier B rows are listed in their plans.
- `assertNoPlaceholderKeys` (over `leadIdentifiers` and `leads`). No identifier value or `leads.email` passes the new placeholder guards. Tier D rows are expected until they are cleaned up.
- The existing `assertOpportunitySearchProjectionBackfilled` and `assertLeadCustomerSearchRowsBackfilled` must pass.
- `assertDenormalizedLeadRefs` (over `meetingFormResponses`, `followUps`, `slackQualificationEvents`, and `customers`):
  - each row's `leadId` and `opportunityId` match the source opportunity
  - `customers.winningOpportunityId` points at an opportunity on `customers.leadId`
  - `meetings.opportunityStatus` matches its opportunity's status
- Each opportunity has exactly one `callClassification: "new"` meeting, and it is the earliest.
- **Counts:**
  - `tenantStats` must match a recompute from `seedTenantStatsInternal` logic (compare, don't write). `totalLeads` should rise by 55: 54 new active leads, plus 1 lead returned to active. The lead that receives customer `kn77j2h9…` is created as converted and doesn't count.
  - `totalOpportunities` should rise by 35.
  - `verifyBackfillCounts` (`convex/reporting/verification.ts`) must pass.
  - Operations meeting projections must drain: the `rebuildMeetingProjections` assert family and `migrations.getStatus`.
- **Identity probe.** For each blocked delivery in 3.3, an internal query replays `resolveLeadIdentity`'s matching read-only and must return exactly one lead whose `email` equals the booking email.

### 5.9 Rollback

1. **Before applying:** take `npx convex export --prod --path <secure location>` for forensics and a last-resort restore.
2. **Per plan:** `leadSplit/rollback:rollbackPlan` is an `internalMutation` with arguments `{ planId, personKey? }`, batched one person per call and scheduled forward. It walks `leadSplitAudit` in reverse:
   - restores patched fields from `before`
   - re-inserts deleted identifiers (the IDs change, which is acceptable)
   - deletes inserted opportunities with `deleteOpportunityAggregate` and then the opportunity search row
   - deletes inserted leads. `leadTimeline` has no delete hook, so call `leadTimeline.delete` from `reporting/aggregates.ts` directly
   - applies the reverse `updateTenantStats` deltas
   - re-runs `replaceMeetingAggregate` and the refresh chain for every touched meeting, opportunity, and lead
   - sets the plan to `rolled_back`
3. Rollback is only safe while no new bookings have attached to the new leads. The split lock covers the apply window. After it is cleared, check for new opportunities on the target leads before rolling back.

### 5.10 Pipeline recovery after the split

1. Confirm that the phase 5.0 guards are deployed.
2. Run the identity probe (5.8) on `t57bkmwfp0k502wfq8ts9nft558g1hh5`, `t577r54phw7vqpa598w0kerdfx8fzqfc`, `t57exp269mx8na6t4amcyex7qh8fyh0x`, and `t57c3dr68vxfnyphync2s8y9hx8fysen`.
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
- **Customer move.** Moving customer `kn77j2h9e3m2jny53x454ckhhx8b48ev` and lead status depends on winning meeting `jn78ecey…`. That meeting is attributed by its form answer (handle), not by a sourced email. The snapshot must confirm it.
- **Slack fields on `jh74vyt5…`.** Its `country`, `leadType`, and `customFields` are mixed. A reviewer should accept the O5 rebuild for the original person.
- **Slack-qualified opportunity `js7cgq0p…`.** Apply the O1 exception, and confirm the lead-gen audit match stays with person 1.
- **All 22 Tier B leads.** Decide distinct versus same person after the snapshot. For the confirmed shared-email cases, the extracted person gets no email.
- **Two converted Tier B leads** (`jh7fvmppmdp2am47an1h56c5rn8dwkfw`, `jh7902ynjk28s6emf5vjr3g6f58a2f92`). Decide which person owns the customer.

### 6.1 Design review notes to resolve before implementation

- **Shared emails.** A booking email that several people used (Tier B) must not join a cluster by itself in `buildPlan`, and reviewers need a way to split a cluster.
- **Dry run.** `buildPlan` needs a `dryRun` argument that builds the plan without replacing `leadSplitPersons` or bumping `planVersion`, so phases 1–3 stay write-free on a dry run.
- **Winning opportunity.** Before applying, check that the opportunity O1 keeps belongs to the lead that O6 assigns the customer to, or remap `customers.winningOpportunityId`. Reject the plan otherwise.
- **Snapshot token.** `fetchInvitees` loads `tenantId` from the plan and passes it to `getValidAccessToken`. It only calls HTTPS URLs on `api.calendly.com` and disables redirects, so the token can't be sent elsewhere.

## 7. Open questions

- **Q1. Phone guard rule.** An explicit list is safe but leaks new fakes. A pattern rule (an ascending run of 7 or more digits, or a 3-digit group repeated 3 times) catches about 28 current identifiers. It also catches some plausible non-US numbers (Indonesian, Kenyan, Swedish formats). Pick a rule, and decide whether existing single-lead matches lose their identifier.
- **Q2. Email guard scope.** Is a fixed denylist enough, or do we also want "local part is `email`" or "domain has no MX"? Placeholder emails still need to be stored on the meeting, just not used as identity.
- **Q3. Opportunity ownership.** Confirm rule O1: the latest-meeting owner keeps the document, except for Slack-qualified or side-deal opportunities. Dashboards will show 35 more opportunities and different `createdAt` dates for split opportunities.
- **Q4. Alias emails (resolved).** A booking email already stored as an identifier on the matched lead now counts as a match, and an Instagram handle match adds the new email as an identifier. Phone-only matches with a new email still block.
- **Q5. Setter-reused emails (Tier B).** Should the extracted person's lead keep the shared email as a non-identity note, or carry no email? Without an email, that lead can't be converted, because `executeConversion` requires `lead.email`.
- **Q6. Domain event naming.** Is `lead.split` (plus `opportunity.created` and `lead.created` with split metadata) acceptable for PostHog dashboards, or should split-created rows be excluded from "created" metrics?
- **Q7. Raw read method.** The full identifier export used the paginated `_system/cli/tableData` query directly, because `npx convex data` can't page past 8192 rows. Is that acceptable for future audits, or should we add an internal paginated export query?

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
