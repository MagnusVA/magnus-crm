# Phase 4 — Heuristic Reschedule Detection (B4)

**Goal:** Add a pipeline heuristic to `convex/pipeline/inviteeCreated.ts` that detects organic rebookings from leads who previously no-showed or canceled. When a lead rebooks within 14 days of a `no_show` or `canceled` opportunity (without CRM UTMs), the pipeline links the new meeting to the existing opportunity instead of creating a duplicate. If the booking lands on a different closer (round-robin), the opportunity is reassigned. After this phase, the system automatically reconnects organic rebookings to their original sales pipeline without any closer intervention.

**Prerequisite:** Phase 1 complete (schema deployed with `rescheduledFromMeetingId` on meetings, `no_show -> scheduled` and `canceled -> scheduled` transitions in `statusTransitions.ts`). Feature E (Identity Resolution) deployed and active in the pipeline.

**Runs in PARALLEL with:** Phase 2 (Mark No-Show Dialog -- different files: `noShowActions.ts`, `mark-no-show-dialog.tsx`), Phase 5 (Reschedule Chain Display -- different files: `reschedule-chain-banner.tsx`, `attribution-card.tsx`, `meetingDetail.ts`). Phase 3 pipeline changes (UTM routing for `noshow_resched`) modify a different section of the same file (`inviteeCreated.ts`) -- they target the UTM block (~line 937-1098) while Phase 4 targets the post-identity-resolution block (~line 1130-1230). If serialization is needed, complete 3E before 4A since they share the same file.

> **Critical path:** This phase is on the critical path for the organic reschedule detection flow. Pipeline changes in this phase are entirely backend -- no UI work.

**Skills to invoke:**
- `convex-performance-audit` -- audit the B4 heuristic query cost on the webhook hot path. The `by_tenantId_and_leadId` index scan with `for await` early break must stay within Convex function limits (bytes read, execution time) even for leads with many opportunities.
- `simplify` -- review the modified `inviteeCreated.ts` for code quality and reuse after the B4 block is integrated. The handler is already large; ensure the new section follows established patterns cleanly.

**Acceptance Criteria:**

1. When a lead who has a `no_show` opportunity updated within the last 14 days rebooks organically (no `utm_source=ptdom`), the pipeline links the new meeting to the existing `no_show` opportunity instead of creating a new one.
2. When a lead who has a `canceled` opportunity updated within the last 14 days rebooks organically, the pipeline links the new meeting to the existing `canceled` opportunity instead of creating a new one.
3. The linked opportunity transitions from `no_show` (or `canceled`) to `scheduled` via `validateTransition()`.
4. The new meeting's `rescheduledFromMeetingId` is set to the most recent meeting on the matched opportunity (looked up via `by_opportunityId` index, descending, `take(1)`).
5. If the new booking's assigned closer differs from the opportunity's original `assignedCloserId`, the opportunity is reassigned to the new closer. A `[Feature B4]` structured log captures the reassignment.
6. Any pending follow-ups on the matched opportunity are marked as `booked` via `internal.closer.followUpMutations.markFollowUpBooked`.
7. After the B4 early return, the handler does NOT proceed to follow-up detection or new opportunity creation -- it skips straight to processed marking.
8. The heuristic does NOT fire when `utm_source=ptdom` (those bookings are handled by Feature A's UTM routing, which exits earlier in the pipeline).
9. If no `no_show`/`canceled` opportunity is found within 14 days, the handler falls through to the existing follow-up detection and new opportunity creation unchanged.
10. If `validateTransition()` rejects the transition, the heuristic match is discarded and the handler falls through to normal flow (no crash).
11. Structured logs with `[Feature B4]` tags are emitted at: heuristic match found, closer reassignment, transition validation failure, and completion.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Heuristic detection logic) ───��──────────────────────┐
                                                          ├── 4C (Integration & guard rails)
4B (Opportunity linking + closer reassignment) ─��────────┘
```

**Optimal execution:**

1. Start **4A** and **4B** in parallel -- they write adjacent but non-overlapping code blocks in the same function. 4A writes the detection scan + match validation. 4B writes the opportunity patch + meeting creation + early return.
2. Once 4A and 4B are both done -> start **4C** (wire together: ensure the early return skips follow-up detection, add all structured logging, verify end-to-end flow).

**Estimated time:** 0.5-1 day

---

## Subphases

### 4A -- Heuristic Detection Logic

**Type:** Backend
**Parallelizable:** Yes -- writes a new code block between `resolveEventTypeConfigId` and the follow-up detection loop. Does not modify any existing code.

**What:** Add the B4 heuristic detection scan to `convex/pipeline/inviteeCreated.ts`. Define the `RESCHEDULE_WINDOW_MS` constant. Query the lead's opportunities via the `by_tenantId_and_leadId` index in descending order, looking for the most recent `no_show` or `canceled` opportunity updated within the 14-day window. Use `for await` with early break. If a match is found, validate the transition to `scheduled`. If validation fails, discard the match and fall through.

**Why:** This is the core detection mechanism for B4. Without it, organic rebookings from no-show leads create duplicate opportunities, fragmenting the sales pipeline. The heuristic must run AFTER identity resolution (which resolves the `lead`) and AFTER `resolveAssignedCloserId`/`resolveEventTypeConfigId` (which provide the closer and config for the new booking) but BEFORE follow-up detection (B4 has higher priority -- no-show/canceled status is a stronger signal than `follow_up_scheduled`).

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Define the reschedule window constant**

Add the constant near the top of the file, after the existing type definitions and before the helper functions:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

// ---------------------------------------------------------------------------
// Feature B4: Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age (in ms) of a no_show/canceled opportunity for the B4 heuristic
 * to consider it a reschedule candidate. Opportunities older than this are
 * ignored — the lead is treated as a new booking.
 */
const RESCHEDULE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
```

**Step 2: Insert the heuristic detection block**

This block goes AFTER `resolveEventTypeConfigId` (line ~1148) and BEFORE the existing `let existingFollowUp` declaration (line ~1151). The exact insertion point:

Before:
```typescript
// Path: convex/pipeline/inviteeCreated.ts (lines ~1142-1163)

		const eventTypeConfigId = await resolveEventTypeConfigId(ctx, {
			tenantId,
			eventTypeUri,
			scheduledEvent,
			latestCustomFields,
			now,
			preloadedConfig: earlyEventTypeConfig,
		});

		let existingFollowUp: Doc<"opportunities"> | null = null;
		const followUpCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");
		for await (const opportunity of followUpCandidates) {
			if (opportunity.status === "follow_up_scheduled") {
				existingFollowUp = opportunity;
				break;
			}
		}
```

After:
```typescript
// Path: convex/pipeline/inviteeCreated.ts (lines ~1142+)

		const eventTypeConfigId = await resolveEventTypeConfigId(ctx, {
			tenantId,
			eventTypeUri,
			scheduledEvent,
			latestCustomFields,
			now,
			preloadedConfig: earlyEventTypeConfig,
		});

		// === Feature B4: Heuristic reschedule detection ===
		// Scan the lead's opportunities for a recent no_show or canceled status.
		// If found, link the new booking to the existing opportunity instead of
		// creating a new one. This runs BEFORE follow-up detection because
		// no_show/canceled is a stronger signal than follow_up_scheduled.
		let autoRescheduleTarget: Doc<"opportunities"> | null = null;

		const reschedCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");

		for await (const opportunity of reschedCandidates) {
			if (
				(opportunity.status === "no_show" ||
					opportunity.status === "canceled") &&
				opportunity.updatedAt > now - RESCHEDULE_WINDOW_MS
			) {
				autoRescheduleTarget = opportunity;
				break;
			}
		}

		if (autoRescheduleTarget) {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule detected | opportunityId=${autoRescheduleTarget._id} status=${autoRescheduleTarget.status}`,
			);

			if (!validateTransition(autoRescheduleTarget.status, "scheduled")) {
				console.warn(
					`[Pipeline:invitee.created] [Feature B4] Invalid transition ${autoRescheduleTarget.status} -> scheduled | falling through to normal flow`,
				);
				autoRescheduleTarget = null; // Discard match, fall through
			}
		}
		// === End Feature B4: Heuristic reschedule detection ===

		let existingFollowUp: Doc<"opportunities"> | null = null;
		const followUpCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");
		for await (const opportunity of followUpCandidates) {
			if (opportunity.status === "follow_up_scheduled") {
				existingFollowUp = opportunity;
				break;
			}
		}
```

**Key implementation notes:**
- The `for await` with early `break` ensures we stop scanning after the first match. Most leads have 1-3 opportunities, so this is O(1) in practice.
- The `order("desc")` ensures we match the most recent opportunity first (handles the edge case in design doc section 13.5 where a lead has multiple no-show opportunities).
- Both `no_show` and `canceled` statuses are checked -- a canceled lead rebooking is semantically the same as a no-show rebooking.
- The `updatedAt > now - RESCHEDULE_WINDOW_MS` check uses the opportunity's `updatedAt` (set when the status changed to `no_show`/`canceled`), not `createdAt`. This correctly measures recency of the no-show/cancellation event.
- Setting `autoRescheduleTarget = null` on validation failure is a graceful fallback -- the handler proceeds as if no match was found. No exception, no crash.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add `RESCHEDULE_WINDOW_MS` constant and B4 detection block |

---

### 4B -- Opportunity Linking + Closer Reassignment

**Type:** Backend
**Parallelizable:** Yes -- writes a new `if (autoRescheduleTarget)` block that goes between the B4 detection (4A) and the existing follow-up detection. Independent of 4A's detection logic -- it consumes `autoRescheduleTarget` but writes in a separate location.

**What:** When the B4 heuristic finds a match, patch the opportunity to `scheduled` with the new closer from the webhook. Look up the most recent meeting on the opportunity for `rescheduledFromMeetingId`. Handle closer reassignment logging. Mark pending follow-ups as booked. Create the new meeting with the reschedule chain link. Perform all post-creation steps (opportunity meeting refs, lead identifiers, custom field key sync) and mark the raw event as processed. Return early to skip follow-up detection and new opportunity creation.

**Why:** This is the action taken when the heuristic detects a match. Without this block, the detection would have no effect -- the handler would always fall through to normal flow. The linking, reassignment, and early return are what make B4 functionally complete.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Insert the B4 linking block**

This block goes AFTER the B4 detection block from 4A (after `// === End Feature B4: Heuristic reschedule detection ===`) and BEFORE the follow-up detection (`let existingFollowUp`). It forms a complete early-return path.

Before (the gap between the end of 4A and the follow-up detection):
```typescript
// Path: convex/pipeline/inviteeCreated.ts

		// === End Feature B4: Heuristic reschedule detection ===

		let existingFollowUp: Doc<"opportunities"> | null = null;
```

After:
```typescript
// Path: convex/pipeline/inviteeCreated.ts

		// === End Feature B4: Heuristic reschedule detection ===

		// === Feature B4: Opportunity linking + closer reassignment ===
		if (autoRescheduleTarget) {
			const reschedOpportunityId = autoRescheduleTarget._id;

			// Find the most recent meeting on this opportunity (for rescheduledFromMeetingId)
			const previousMeetings = await ctx.db
				.query("meetings")
				.withIndex("by_opportunityId", (q) =>
					q.eq("opportunityId", reschedOpportunityId),
				)
				.order("desc")
				.take(1);
			const rescheduledFromMeetingId = previousMeetings[0]?._id;

			// Check for closer change (round-robin reassignment)
			const oldCloserId = autoRescheduleTarget.assignedCloserId;
			const closerChanged =
				assignedCloserId &&
				oldCloserId &&
				assignedCloserId !== oldCloserId;

			// Patch the opportunity: transition to scheduled, update closer and host info
			await ctx.db.patch(reschedOpportunityId, {
				status: "scheduled",
				calendlyEventUri,
				assignedCloserId:
					assignedCloserId ??
					autoRescheduleTarget.assignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId:
					eventTypeConfigId ??
					autoRescheduleTarget.eventTypeConfigId ??
					undefined,
				updatedAt: now,
				// NOTE: utmParams intentionally NOT included here.
				// The opportunity preserves attribution from its original creation.
				// The new meeting stores its own UTMs independently.
			});
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Opportunity relinked | opportunityId=${reschedOpportunityId} status=${autoRescheduleTarget.status}->scheduled`,
			);

			if (closerChanged) {
				console.log(
					`[Pipeline:invitee.created] [Feature B4] Opportunity reassigned | from=${oldCloserId} to=${assignedCloserId}`,
				);
			}

			// Mark any pending follow-ups as booked
			await ctx.runMutation(
				internal.closer.followUpMutations.markFollowUpBooked,
				{
					opportunityId: reschedOpportunityId,
					calendlyEventUri,
				},
			);

			// Create the meeting with reschedule chain link
			const meetingLocation = extractMeetingLocation(
				scheduledEvent.location,
			);
			const meetingNotes = getString(
				scheduledEvent,
				"meeting_notes_plain",
			);

			const meetingId = await ctx.db.insert("meetings", {
				tenantId,
				opportunityId: reschedOpportunityId,
				calendlyEventUri,
				calendlyInviteeUri,
				zoomJoinUrl: meetingLocation.zoomJoinUrl,
				meetingJoinUrl: meetingLocation.meetingJoinUrl,
				meetingLocationType: meetingLocation.meetingLocationType,
				scheduledAt,
				durationMinutes,
				status: "scheduled",
				notes: meetingNotes,
				leadName: lead.fullName ?? lead.email,
				createdAt: now,
				utmParams,
				rescheduledFromMeetingId,
			});
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Meeting created | meetingId=${meetingId} rescheduledFrom=${rescheduledFromMeetingId ?? "none"}`,
			);

			// Post-creation: update refs, identifiers, custom field keys
			await updateOpportunityMeetingRefs(ctx, reschedOpportunityId);
			await createLeadIdentifiers(
				ctx,
				tenantId,
				lead._id,
				meetingId,
				inviteeEmail,
				rawInviteeEmail,
				effectivePhone,
				extractedIdentifiers.socialHandle,
				now,
			);
			await syncKnownCustomFieldKeys(
				ctx,
				eventTypeConfigId,
				latestCustomFields,
			);

			await ctx.db.patch(rawEventId, { processed: true });
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule complete | meetingId=${meetingId} opportunityId=${reschedOpportunityId}`,
			);
			return;
		}
		// === End Feature B4: Opportunity linking + closer reassignment ===

		let existingFollowUp: Doc<"opportunities"> | null = null;
```

**Key implementation notes:**
- The `previousMeetings` query uses the existing `by_opportunityId` index with `desc` order and `take(1)` -- a single indexed read. This gives us the most recent meeting on the opportunity, which is the no-show meeting we want to link back to.
- `rescheduledFromMeetingId` may be `undefined` if the opportunity somehow has no meetings (defensive). The meeting insert handles `undefined` gracefully (field omitted from document).
- The `assignedCloserId ?? autoRescheduleTarget.assignedCloserId` pattern preserves the original closer when `resolveAssignedCloserId` returns `undefined` (e.g., unmatched Calendly host URI). This avoids accidentally removing the closer assignment.
- `utmParams` is intentionally NOT written to the opportunity patch. The opportunity preserves its original attribution. The new meeting stores its own UTMs independently (same pattern as the follow-up detection block at line ~1184).
- The `closerChanged` check requires BOTH `assignedCloserId` and `oldCloserId` to be defined AND different. If either is `undefined`, no reassignment log is emitted.
- The `return` at the end of the block is the critical early exit -- it prevents the handler from falling through to follow-up detection and new opportunity creation.
- The post-creation steps (`updateOpportunityMeetingRefs`, `createLeadIdentifiers`, `syncKnownCustomFieldKeys`, mark processed) mirror the same sequence used by both the UTM routing block (Feature A, lines ~1066-1091) and the existing new opportunity creation block (lines ~1255-1288).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add B4 linking block with opportunity patch, meeting creation, and early return |

---

### 4C -- Integration & Guard Rails

**Type:** Backend
**Parallelizable:** No -- depends on both 4A and 4B being complete. This subphase wires 4A and 4B together, verifies the complete insertion, and ensures the handler's control flow is correct end-to-end.

**What:** Verify the full B4 code block is correctly positioned in `inviteeCreated.ts`. Ensure the early return in 4B prevents execution of the follow-up detection and new opportunity creation paths. Add the `[Feature B4]` log tag for the "no match" case. Verify TypeScript compilation. Review the complete pipeline processing priority chain for correctness.

**Why:** The B4 block is inserted into a 1290-line handler with multiple early-return paths (duplicate detection, UTM routing, B4, follow-up detection, default). A single misplaced brace or incorrect variable scope would break the entire pipeline. This subphase is the integration verification step.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify -- minor additions)

**How:**

**Step 1: Add "no match" structured log**

After the B4 detection block (4A), when `autoRescheduleTarget` is `null` after the scan, add a log line for observability. This goes inside the detection block, after the `for await` loop:

Before:
```typescript
// Path: convex/pipeline/inviteeCreated.ts (inside the detection block)

		if (autoRescheduleTarget) {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule detected | opportunityId=${autoRescheduleTarget._id} status=${autoRescheduleTarget.status}`,
			);

			if (!validateTransition(autoRescheduleTarget.status, "scheduled")) {
				console.warn(
					`[Pipeline:invitee.created] [Feature B4] Invalid transition ${autoRescheduleTarget.status} -> scheduled | falling through to normal flow`,
				);
				autoRescheduleTarget = null; // Discard match, fall through
			}
		}
		// === End Feature B4: Heuristic reschedule detection ===
```

After:
```typescript
// Path: convex/pipeline/inviteeCreated.ts (inside the detection block)

		if (autoRescheduleTarget) {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule detected | opportunityId=${autoRescheduleTarget._id} status=${autoRescheduleTarget.status}`,
			);

			if (!validateTransition(autoRescheduleTarget.status, "scheduled")) {
				console.warn(
					`[Pipeline:invitee.created] [Feature B4] Invalid transition ${autoRescheduleTarget.status} -> scheduled | falling through to normal flow`,
				);
				autoRescheduleTarget = null; // Discard match, fall through
			}
		} else {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] No reschedule candidate found for leadId=${lead._id} | proceeding to follow-up detection`,
			);
		}
		// === End Feature B4: Heuristic reschedule detection ===
```

**Step 2: Verify the complete pipeline processing priority chain**

After integration, the `process` handler's control flow should read (in order):

```
1. Duplicate detection         (existing -- early return if duplicate)
2. UTM extraction              (Feature G -- extracts utmParams)
3. UTM deterministic linking   (Feature A -- early return if utm_source=ptdom match)
4. Identity resolution         (Feature E -- resolves lead)
5. Host/closer/config resolve  (existing -- resolveAssignedCloserId, resolveEventTypeConfigId)
6. B4 heuristic detection      (NEW -- scans for no_show/canceled opp within 14 days)
7. B4 opportunity linking      (NEW -- early return if autoRescheduleTarget found)
8. Follow-up detection         (existing -- scans for follow_up_scheduled opp)
9. Opportunity selection       (existing -- reuse follow-up or create new)
10. Meeting creation           (existing)
11. Post-creation steps        (existing -- refs, identifiers, custom field sync, mark processed)
```

Steps 6-7 are the new additions. The key invariant: if step 3 returns early (UTM match), steps 6-7 never execute. If step 7 returns early (B4 match), steps 8-11 never execute. The paths are mutually exclusive.

**Step 3: Run TypeScript compilation check**

```bash
pnpm tsc --noEmit
```

Verify zero errors. The B4 block uses only types and functions already available in scope:
- `Doc<"opportunities">` -- from `convex/_generated/dataModel` (already imported)
- `autoRescheduleTarget` -- typed as `Doc<"opportunities"> | null`
- `validateTransition` -- already imported from `../lib/statusTransitions`
- `updateOpportunityMeetingRefs` -- already imported from `../lib/opportunityMeetingRefs`
- `extractMeetingLocation` -- already imported from `../lib/meetingLocation`
- `internal.closer.followUpMutations.markFollowUpBooked` -- already used by Feature A block
- `createLeadIdentifiers` -- already defined in the same file (Feature E)
- `syncKnownCustomFieldKeys` -- already defined in the same file (Feature F)
- `lead`, `tenantId`, `assignedCloserId`, `eventTypeConfigId`, `hostUserUri`, `hostCalendlyEmail`, `hostCalendlyName`, `calendlyEventUri`, `calendlyInviteeUri`, `scheduledEvent`, `scheduledAt`, `durationMinutes`, `utmParams`, `inviteeEmail`, `rawInviteeEmail`, `effectivePhone`, `extractedIdentifiers`, `latestCustomFields`, `now`, `rawEventId` -- all in scope from the handler context

No new imports are needed.

**Step 4: Verify the complete before/after diff**

The complete modified section of `inviteeCreated.ts` (from `resolveEventTypeConfigId` through the follow-up detection) should read as a single continuous block:

```typescript
// Path: convex/pipeline/inviteeCreated.ts (complete B4 insertion — lines ~1142 to ~1290)

		const eventTypeConfigId = await resolveEventTypeConfigId(ctx, {
			tenantId,
			eventTypeUri,
			scheduledEvent,
			latestCustomFields,
			now,
			preloadedConfig: earlyEventTypeConfig,
		});

		// === Feature B4: Heuristic reschedule detection ===
		// Scan the lead's opportunities for a recent no_show or canceled status.
		// If found, link the new booking to the existing opportunity instead of
		// creating a new one. This runs BEFORE follow-up detection because
		// no_show/canceled is a stronger signal than follow_up_scheduled.
		let autoRescheduleTarget: Doc<"opportunities"> | null = null;

		const reschedCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");

		for await (const opportunity of reschedCandidates) {
			if (
				(opportunity.status === "no_show" ||
					opportunity.status === "canceled") &&
				opportunity.updatedAt > now - RESCHEDULE_WINDOW_MS
			) {
				autoRescheduleTarget = opportunity;
				break;
			}
		}

		if (autoRescheduleTarget) {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule detected | opportunityId=${autoRescheduleTarget._id} status=${autoRescheduleTarget.status}`,
			);

			if (!validateTransition(autoRescheduleTarget.status, "scheduled")) {
				console.warn(
					`[Pipeline:invitee.created] [Feature B4] Invalid transition ${autoRescheduleTarget.status} -> scheduled | falling through to normal flow`,
				);
				autoRescheduleTarget = null; // Discard match, fall through
			}
		} else {
			console.log(
				`[Pipeline:invitee.created] [Feature B4] No reschedule candidate found for leadId=${lead._id} | proceeding to follow-up detection`,
			);
		}
		// === End Feature B4: Heuristic reschedule detection ===

		// === Feature B4: Opportunity linking + closer reassignment ===
		if (autoRescheduleTarget) {
			const reschedOpportunityId = autoRescheduleTarget._id;

			// Find the most recent meeting on this opportunity (for rescheduledFromMeetingId)
			const previousMeetings = await ctx.db
				.query("meetings")
				.withIndex("by_opportunityId", (q) =>
					q.eq("opportunityId", reschedOpportunityId),
				)
				.order("desc")
				.take(1);
			const rescheduledFromMeetingId = previousMeetings[0]?._id;

			// Check for closer change (round-robin reassignment)
			const oldCloserId = autoRescheduleTarget.assignedCloserId;
			const closerChanged =
				assignedCloserId &&
				oldCloserId &&
				assignedCloserId !== oldCloserId;

			// Patch the opportunity: transition to scheduled, update closer and host info
			await ctx.db.patch(reschedOpportunityId, {
				status: "scheduled",
				calendlyEventUri,
				assignedCloserId:
					assignedCloserId ??
					autoRescheduleTarget.assignedCloserId,
				hostCalendlyUserUri: hostUserUri,
				hostCalendlyEmail,
				hostCalendlyName,
				eventTypeConfigId:
					eventTypeConfigId ??
					autoRescheduleTarget.eventTypeConfigId ??
					undefined,
				updatedAt: now,
			});
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Opportunity relinked | opportunityId=${reschedOpportunityId} status=${autoRescheduleTarget.status}->scheduled`,
			);

			if (closerChanged) {
				console.log(
					`[Pipeline:invitee.created] [Feature B4] Opportunity reassigned | from=${oldCloserId} to=${assignedCloserId}`,
				);
			}

			// Mark any pending follow-ups as booked
			await ctx.runMutation(
				internal.closer.followUpMutations.markFollowUpBooked,
				{
					opportunityId: reschedOpportunityId,
					calendlyEventUri,
				},
			);

			// Create the meeting with reschedule chain link
			const meetingLocation = extractMeetingLocation(
				scheduledEvent.location,
			);
			const meetingNotes = getString(
				scheduledEvent,
				"meeting_notes_plain",
			);

			const meetingId = await ctx.db.insert("meetings", {
				tenantId,
				opportunityId: reschedOpportunityId,
				calendlyEventUri,
				calendlyInviteeUri,
				zoomJoinUrl: meetingLocation.zoomJoinUrl,
				meetingJoinUrl: meetingLocation.meetingJoinUrl,
				meetingLocationType: meetingLocation.meetingLocationType,
				scheduledAt,
				durationMinutes,
				status: "scheduled",
				notes: meetingNotes,
				leadName: lead.fullName ?? lead.email,
				createdAt: now,
				utmParams,
				rescheduledFromMeetingId,
			});
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Meeting created | meetingId=${meetingId} rescheduledFrom=${rescheduledFromMeetingId ?? "none"}`,
			);

			// Post-creation: update refs, identifiers, custom field keys
			await updateOpportunityMeetingRefs(ctx, reschedOpportunityId);
			await createLeadIdentifiers(
				ctx,
				tenantId,
				lead._id,
				meetingId,
				inviteeEmail,
				rawInviteeEmail,
				effectivePhone,
				extractedIdentifiers.socialHandle,
				now,
			);
			await syncKnownCustomFieldKeys(
				ctx,
				eventTypeConfigId,
				latestCustomFields,
			);

			await ctx.db.patch(rawEventId, { processed: true });
			console.log(
				`[Pipeline:invitee.created] [Feature B4] Heuristic reschedule complete | meetingId=${meetingId} opportunityId=${reschedOpportunityId}`,
			);
			return;
		}
		// === End Feature B4: Opportunity linking + closer reassignment ===

		let existingFollowUp: Doc<"opportunities"> | null = null;
		const followUpCandidates = ctx.db
			.query("opportunities")
			.withIndex("by_tenantId_and_leadId", (q) =>
				q.eq("tenantId", tenantId).eq("leadId", lead._id),
			)
			.order("desc");
		for await (const opportunity of followUpCandidates) {
			if (opportunity.status === "follow_up_scheduled") {
				existingFollowUp = opportunity;
				break;
			}
		}
```

**Key implementation notes:**
- The B4 detection block and the follow-up detection block both query the same `by_tenantId_and_leadId` index. In the worst case (no B4 match), both scans run. This is acceptable because: (a) most leads have 1-3 opportunities, (b) both use `for await` with early break, and (c) both are indexed reads (no table scans). The `convex-performance-audit` skill should verify this is within function limits.
- The B4 block's early `return` means the follow-up detection code is never reached when a B4 match is found. This is intentional -- B4 has higher priority. If a lead has both a `no_show` opportunity and a `follow_up_scheduled` opportunity, B4 wins.
- The `RESCHEDULE_WINDOW_MS` constant is defined at file scope (not inside the handler) for clarity and to allow easy discovery. It is the only constant B4 adds.
- No new imports are required -- all dependencies are already imported or defined in the same file.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Add `else` branch log, verify complete integration, TypeScript compilation |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | 4A (constant + detection block), 4B (linking + early return), 4C (no-match log + verification) |

> **Single file change.** This entire phase modifies only `convex/pipeline/inviteeCreated.ts`. No new files are created. No other existing files are changed. The B4 heuristic is purely an additive code block inserted between two existing sections of the `process` handler.
