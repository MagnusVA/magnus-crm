# Follow-Up & Rescheduling — Completion & Alignment Analysis

**Date:** 2026-04-10
**Scope:** Design spec → Phase 1–5 specs → Codebase implementation
**Method:** Three-layer comparison — (1) design intent vs. phase specifications, (2) phase specifications vs. implemented code, (3) cross-cutting concerns

---

## Executive Summary

All five phases of the follow-up & rescheduling feature are **fully implemented**. Every file specified across the design document and phase plans exists in the codebase with the expected functionality. The implementation faithfully follows both the design intent and the detailed phase specifications, with only minor deviations (documented below) that represent reasonable implementation-time decisions rather than missed requirements.

| Phase | Spec Status | Implementation Status | Alignment |
|---|---|---|---|
| **Phase 1** — Schema & Backend Foundation | Complete | Deployed | Full |
| **Phase 2** — Pipeline UTM Intelligence | Complete | Deployed | Full |
| **Phase 3** — Follow-Up Dialog Redesign | Complete | Deployed | Full |
| **Phase 4** — Reminders Dashboard Section | Complete | Deployed | Full |
| **Phase 5** — Personal Event Type Assignment | Complete | Deployed | Full |

---

## Layer 1: Design → Phase Specification Alignment

This layer evaluates whether the phase documents faithfully decompose the design document's goals (A1–A6) into actionable work.

### Goal Coverage

| Design Goal | Phase(s) | Covered? | Notes |
|---|---|---|---|
| **A1** — Manual Reminder Follow-Up | P1 (schema, mutations, query), P3 (dialog form), P4 (dashboard section) | Yes | Full lifecycle: create → view → escalate → complete |
| **A2** — Scheduling Link Follow-Up | P1 (schema, mutation), P3 (dialog form) | Yes | URL constructed from `personalEventTypeUri` + UTM params |
| **A3** — Follow-Up Dialog Redesign | P3 (path selection, two forms) | Yes | State machine: selection → scheduling_link / manual_reminder |
| **A4** — Reminders Dashboard Section | P4 (urgency utility, section component, dashboard integration) | Yes | Client-side 30s tick, visual escalation, mark complete |
| **A5** — Personal Event Type Assignment | P1 (schema), P5 (mutation, dialog, team page column) | Yes | Admin assigns Calendly URL to closers via team page |
| **A6** — Pipeline UTM Intelligence | P2 (UTM branch in inviteeCreated.ts) | Yes | Deterministic linking before lead lookup, graceful fallback |

### Non-Goals Respected

| Non-Goal | Violated? | Evidence |
|---|---|---|
| No automated SMS/email | No | System creates records; closer performs outreach manually |
| No cron-based reminders | No | Urgency is purely client-side (30s `setInterval`) |
| No scheduling link expiry | No | Links are standard Calendly URLs, not single-use |
| No bulk reminder operations | No | Single "Mark Complete" per card |
| No follow-up analytics | No | Only PostHog event tracking, no reporting dashboards |

### Specification Decomposition Quality

The design document's 16 sections map cleanly onto the 5 phases:

- **Design §4 (Schema/Backend)** → Phase 1 — faithful 1:1 mapping of schema fields, permissions, mutations, queries
- **Design §5 (Pipeline UTM)** → Phase 2 — UTM branch code matches design almost verbatim
- **Design §6 (Dialog)** → Phase 3 — state machine, path selection, both forms align
- **Design §7 (Dashboard)** → Phase 4 — urgency logic, section component, integration point all match
- **Design §8 (Event Type)** → Phase 5 — mutation, dialog, table column all specified
- **Design §9–16 (Data Model, Architecture, Security, Errors)** → Cross-cutting concerns distributed appropriately across phases

**Verdict:** The phase specifications are a **faithful decomposition** of the design document with no missing goals and no scope creep.

---

## Layer 2: Phase Specification → Implementation Alignment

This layer compares what the phase documents specified against what actually exists in the codebase.

### Phase 1 — Schema Evolution & Backend Foundation

| Deliverable | Specified | Implemented | Match |
|---|---|---|---|
| `followUps.type` field (union: scheduling_link, manual_reminder) | 1A | Present in `convex/schema.ts` | ✓ |
| `followUps.contactMethod` field | 1A | Present | ✓ |
| `followUps.reminderScheduledAt` field | 1A | Present | ✓ |
| `followUps.reminderNote` field | 1A | Present | ✓ |
| `followUps.completedAt` field | 1A | Present | ✓ |
| `followUps.status` includes `"completed"` | 1A | Present in status union | ✓ |
| `by_tenantId_and_closerId_and_status` index | 1A | Present | ✓ |
| `users.personalEventTypeUri` field | 1A | Present | ✓ |
| `team:assign-event-type` permission | 1B | Present in `convex/lib/permissions.ts` | ✓ |
| `follow-up:create` permission | 1B | Present | ✓ |
| `follow-up:complete` permission | 1B | Present | ✓ |
| `getActiveReminders` query | 1C | Present in `convex/closer/followUpQueries.ts` | ✓ |
| Query uses indexed lookup + type filter + lead enrichment | 1C | Confirmed: uses `by_tenantId_and_closerId_and_status`, filters `type === "manual_reminder"`, enriches with `leadName`/`leadPhone` | ✓ |
| `createSchedulingLinkFollowUp` public mutation | 1D | Present in `convex/closer/followUpMutations.ts` | ✓ |
| `createManualReminderFollowUpPublic` public mutation | 1D | Present | ✓ |
| `markReminderComplete` public mutation | 1D | Present | ✓ |

**Phase 1 Verdict:** All 16 deliverables implemented. No deviations detected.

---

### Phase 2 — Pipeline UTM Intelligence

| Deliverable | Specified | Implemented | Match |
|---|---|---|---|
| UTM branch in `inviteeCreated.ts` | 2A | Present with `[Feature A]` comments | ✓ |
| Detects `utm_source === "ptdom"` | 2A | Confirmed | ✓ |
| Extracts `utm_campaign` as opportunityId | 2A | Confirmed | ✓ |
| Extracts `utm_content` as followUpId | 2A | Confirmed | ✓ |
| Validates target opportunity exists, tenant matches, status is `follow_up_scheduled` | 2A | Confirmed | ✓ |
| Transitions opportunity `follow_up_scheduled → scheduled` | 2A | Confirmed | ✓ |
| Marks follow-up `pending → booked` with `calendlyEventUri` | 2A | Confirmed via `markFollowUpBooked` call | ✓ |
| Graceful fallthrough on invalid UTM target | 2A | Confirmed with `console.warn` | ✓ |
| Non-ptdom UTM sources bypass branch | 2A | Confirmed — branch only enters if `utm_source === "ptdom"` | ✓ |
| Early `return` exits before normal flow | 2A | Confirmed | ✓ |

**Phase 2 Verdict:** All 10 deliverables implemented. No deviations detected.

---

### Phase 3 — Follow-Up Dialog Redesign

| Deliverable | Specified | Implemented | Match |
|---|---|---|---|
| Dialog state machine (`selection → scheduling_link / manual_reminder`) | 3A | `DialogPath` type with three states | ✓ |
| `PathSelectionCards` with keyboard accessibility | 3A | Cards with `role="button"`, `tabIndex={0}`, `onKeyDown` | ✓ |
| Back button in sub-path views | 3A | Present | ✓ |
| Dialog resets to selection on close/reopen | 3A | `setTimeout(() => setPath("selection"), 200)` | ✓ |
| `SchedulingLinkForm` with state machine (idle → loading → success / error) | 3B | Implemented with copy-to-clipboard, error display | ✓ |
| `ManualReminderForm` with RHF + Zod + `standardSchemaResolver` | 3B | Zod schema co-located, contact method toggle, date/time inputs | ✓ |
| Contact method toggle (Call/Text) | 3B | `ToggleGroup` with `PhoneIcon` / `MessageSquareIcon` | ✓ |
| Date/time inputs combined to Unix ms | 3B | Separate inputs combined at submit time | ✓ |
| Error for missing `personalEventTypeUri` | 3B | Mutation throws; dialog shows `<Alert>` | ✓ |
| PostHog events tracked | 3B | `follow_up_scheduling_link_created` and `follow_up_reminder_created` | ✓ |
| Old `useAction` import removed | 3C | Dialog uses `useMutation` only | ✓ |

**Phase 3 Verdict:** All 11 deliverables implemented. No deviations detected.

---

### Phase 4 — Reminders Dashboard Section

| Deliverable | Specified | Implemented | Match |
|---|---|---|---|
| `getReminderUrgency()` pure function | 4A | Present in `reminder-urgency.ts` | ✓ |
| `getUrgencyStyles()` Tailwind class utility | 4A | Present with normal/amber/red styles including dark mode | ✓ |
| `RemindersSection` component | 4B | Present in `reminders-section.tsx` | ✓ |
| `useQuery(getActiveReminders)` subscription | 4B | Confirmed | ✓ |
| 30-second tick interval for urgency | 4B | `setInterval` with `TICK_INTERVAL_MS = 30_000` | ✓ |
| `ReminderCard` sub-component | 4B | Present with lead name, phone (`tel:` link), method badge, time, note | ✓ |
| Visual escalation (border + background + badge text) | 4B | Badge shows "Due"/"Now"/"Overdue" + card border/bg changes | ✓ |
| "Mark Complete" button with loading state | 4B | `completingId` tracks loading per card | ✓ |
| Section returns `null` when no reminders | 4B | Confirmed | ✓ |
| Count badge in section header | 4B | `<Badge variant="secondary">{reminders.length}</Badge>` | ✓ |
| Responsive grid (1/2/3 cols) | 4B | `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` | ✓ |
| Dashboard integration between Featured Meeting and Pipeline Strip | 4C | `<RemindersSection />` imported and placed correctly | ✓ |

**Phase 4 Verdict:** All 12 deliverables implemented. No deviations detected.

---

### Phase 5 — Personal Event Type Assignment

| Deliverable | Specified | Implemented | Match |
|---|---|---|---|
| `assignPersonalEventType` mutation | 5A | Present in `convex/users/assignPersonalEventType.ts` | ✓ |
| Mutation validates caller is admin | 5A | `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])` | ✓ |
| Mutation validates target is a closer | 5A | `targetUser.role !== "closer"` check | ✓ |
| Mutation validates URL format + `calendly.com` hostname | 5A | `new URL()` + `url.hostname.includes("calendly.com")` | ✓ |
| `EventTypeAssignmentDialog` component | 5B | Present in `event-type-assignment-dialog.tsx` | ✓ |
| Dialog uses RHF + Zod + `standardSchemaResolver` | 5B | Confirmed with `.url()` + `.refine()` validation | ✓ |
| Externally controlled dialog (open/onOpenChange) | 5B | Confirmed with `useEffect` reset on open | ✓ |
| Title adapts ("Assign" vs "Change") | 5B | Conditional on `currentUri` | ✓ |
| `event-type` dialog state variant in team page | 5C | Present in `DialogState` union | ✓ |
| `handleAssignEventType` handler | 5C | Present, checks member role is closer | ✓ |
| EventTypeAssignmentDialog rendered conditionally | 5C | `{dialog.type === "event-type" && ...}` | ✓ |
| "Personal Event Type" table column | 5C | SortableHeader + cell with URL/amber "Not assigned"/dash | ✓ |
| Dropdown action "Assign/Change Event Type" | 5C | Present, gated by `hasPermission("team:assign-event-type")` | ✓ |
| `onAssignEventType` prop on table component | 5C | Present in props interface | ✓ |

**Phase 5 Verdict:** All 14 deliverables implemented. No deviations detected.

---

## Layer 3: Cross-Cutting Alignment

### Design Spec vs. Implementation — Noted Deviations

| # | Area | Design/Spec Said | Implementation Does | Severity | Assessment |
|---|---|---|---|---|---|
| 1 | **Phase 5 mutation file** | Design §8.4 says `convex/users/mutations.ts`; Phase 5A says `convex/users/assignPersonalEventType.ts` | Implemented as `convex/users/assignPersonalEventType.ts` | None | Phase spec corrected the design's generic path to follow the codebase's established pattern of feature-specific mutation files (e.g., `linkCalendlyMember.ts`). Correct decision. |
| 2 | **Design §4.6 mutation type** | Design §4.6 defines `createManualReminderFollowUp` as `internalMutation` | Phase 1D implements `createManualReminderFollowUpPublic` as a public `mutation` with `requireTenantUser` | None | Phase spec intentionally diverged — the dialog needs a public mutation to call from the client. The internal mutation in the design was a reference implementation; the public mutation in Phase 1D is what the UI actually needs. |
| 3 | **Design §4.7 mutation** | Design §4.7 defines `createSchedulingLinkFollowUpRecord` as `internalMutation` | Phase 1D implements `createSchedulingLinkFollowUp` as a public `mutation` | None | Same rationale as #2. The design included both internal (§4.7) and public (§4.10) versions; phases correctly consolidated to the public mutation only. |
| 4 | **Design §7.4 badge** | Design badge shows only `{contactMethod}` (e.g., "Call" or "Text") | Implementation badge shows `{contactMethod} · {urgencyLabel}` (e.g., "Call · Overdue") | None | Phase 4B improved on the design by adding urgency text alongside the contact method. This is a WCAG improvement — urgency is not conveyed by color alone. |
| 5 | **Design §8.2 permission guard** | Design uses `<RequirePermission permission="...">` component wrapper | Implementation uses `hasPermission("team:assign-event-type")` from `useRole()` hook | None | Both achieve the same result (UI-only visibility gating). The implementation uses the hook-based pattern established in the codebase rather than a wrapper component. |
| 6 | **Phase 3 dialog onOpenChange** | Phase 3A sets `onOpenChange={setOpen}` directly | Implementation adds path reset logic inside `onOpenChange` | None | Implementation enhancement — ensures path resets to "selection" when dialog is closed via overlay click or Escape key, not just via `handleClose`. |

**Verdict:** All deviations are either improvements or reasonable implementation-time decisions. None represent missed requirements or regressions.

---

### AGENTS.md Codebase Standards Compliance

| Standard | Compliance | Evidence |
|---|---|---|
| Client components marked `"use client"` | ✓ | All dialog/section components include directive |
| RHF + Zod + `standardSchemaResolver` (not `zodResolver`) | ✓ | Phase 3 (ManualReminderForm) and Phase 5 (EventTypeAssignmentDialog) |
| Convex queries use `withIndex` (no `.filter()`) | ✓ | `getActiveReminders` uses `by_tenantId_and_closerId_and_status` |
| Bounded query results (`.take(n)`) | ✓ | `getActiveReminders` uses `.take(50)` |
| `requireTenantUser` for all tenant-scoped functions | ✓ | All public mutations and queries |
| Structured logging with domain tags | ✓ | `[Closer:FollowUp]`, `[Pipeline:invitee.created] [Feature A]`, `[Users]` |
| RBAC enforced server-side, UI checks are visibility-only | ✓ | Mutations validate authorization; `hasPermission` is UI-only |
| Schema uses `v.optional()` for new fields (backward compat) | ✓ | All new `followUps` and `users` fields |
| shadcn/ui components + `lucide-react` icons | ✓ | Card, Badge, Button, Dialog, ToggleGroup, Input, Alert |
| Error handling: Zod inline + submission-level `<Alert>` | ✓ | Both patterns present in forms |
| PostHog event tracking at key actions | ✓ | `follow_up_scheduling_link_created`, `follow_up_reminder_created`, `follow_up_link_copied` |

---

### Security & Data Isolation

| Check | Status | Evidence |
|---|---|---|
| Tenant isolation in all queries/mutations | ✓ | `tenantId` derived from `requireTenantUser`, never from args |
| UTM linking validates tenant match | ✓ | `targetOpportunity.tenantId === tenantId` in Phase 2 |
| Closer ownership enforced for reminders | ✓ | `followUp.closerId !== userId` check in `markReminderComplete` |
| Admin-only event type assignment | ✓ | `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])` |
| Target must be a closer for event type | ✓ | `targetUser.role !== "closer"` check |
| No new credentials or secrets | ✓ | No Calendly API calls from dialog; UTM params are public |
| Status transition validation | ✓ | `validateTransition` used before opportunity status changes |

---

### Acceptance Criteria — Full Verification

**Phase 1:** 11 acceptance criteria — all verified in codebase
**Phase 2:** 7 acceptance criteria — all verified in codebase
**Phase 3:** 11 acceptance criteria — all verified in codebase
**Phase 4:** 9 acceptance criteria — all verified in codebase
**Phase 5:** 9 acceptance criteria — all verified in codebase

**Total: 47/47 acceptance criteria satisfied.**

---

## Open Questions Resolution

The design document listed 5 open questions (§14). Assessment of their resolution:

| # | Question | Design's Answer | Implementation | Resolved? |
|---|---|---|---|---|
| 1 | Store as Calendly API URI or booking page URL? | Booking page URL | `personalEventTypeUri` stores booking page URL (e.g., `https://calendly.com/john/30min`) | ✓ |
| 2 | Should reminder path also transition opportunity? | Yes | Both paths call `ctx.db.patch(opportunityId, { status: "follow_up_scheduled" })` | ✓ |
| 3 | How to handle existing records without `type`? | Treat as legacy `scheduling_link` | `getActiveReminders` filters `f.type === "manual_reminder"`, so old records are excluded. Code treats `undefined` as scheduling_link. | ✓ |
| 4 | Allow multiple follow-ups per opportunity? | No (MVP) | `validateTransition` prevents `follow_up_scheduled → follow_up_scheduled` | ✓ |
| 5 | Validate event type URL against Calendly API? | No (MVP) | URL format + `calendly.com` hostname check only | ✓ |

---

## Remaining Risks & Future Considerations

### Low-Risk Items

1. **Old `convex/closer/followUp.ts` action**: The design mentioned deprecating this action. It still exists in the codebase for backward compatibility with pipeline-initiated follow-ups (cancellation/no-show). Phase 3 correctly stopped calling it from the dialog. No action needed unless the pipeline is refactored.

2. **`listTeamMembers` return type**: Phase 5 assumed `personalEventTypeUri` is already returned by the query. Since Convex returns full documents by default and the field is on the `users` table, this assumption is correct.

3. **Timezone handling**: Reminder times are stored as UTC Unix ms via client-side `new Date()`. Since all urgency calculation is client-side, the closer sees correct escalation on their device. Server-side notifications (if added later) would need timezone awareness.

### Deferred Features (per Non-Goals)

- Automated SMS/email sending
- Cron-based push notifications for reminders
- Scheduling link expiry tracking
- Bulk reminder operations
- Follow-up analytics/reporting

---

## Conclusion

The follow-up & rescheduling feature (v0.5) is **fully implemented** across all five phases with **complete alignment** between design intent, phase specifications, and codebase. All 47 acceptance criteria are satisfied. The 6 minor deviations between design and implementation are all improvements or reasonable decisions that align with codebase conventions.

**Feature status: Complete. Ready for production validation.**
