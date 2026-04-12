# Version 0.5 — Product Specification

**Date:** April 8, 2026
**Status:** Draft — Product Definition
**Scope:** Half-way milestone toward full product vision
**Audience:** Development team, product owner

---

## Table of Contents

1. [Vision & Scope](#1-vision--scope)
2. [Entity Model Evolution](#2-entity-model-evolution)
3. [Feature Area A — Follow-Up & Rescheduling Overhaul](#3-feature-area-a--follow-up--rescheduling-overhaul)
4. [Feature Area B — No-Show Management](#4-feature-area-b--no-show-management)
5. [Feature Area C — Lead Manager](#5-feature-area-c--lead-manager)
6. [Feature Area D — Lead-to-Customer Conversion](#6-feature-area-d--lead-to-customer-conversion)
7. [Feature Area E — Lead Identity Resolution](#7-feature-area-e--lead-identity-resolution)
8. [Feature Area F — Event Type Intelligence](#8-feature-area-f--event-type-intelligence)
9. [Feature Area G — UTM Tracking & Attribution](#9-feature-area-g--utm-tracking--attribution)
10. [Feature Area H — Closer Unavailability & Workload Redistribution](#10-feature-area-h--closer-unavailability--workload-redistribution)
11. [Feature Area I — Meeting Detail Enhancements](#11-feature-area-i--meeting-detail-enhancements)
12. [Feature Area J — Form Handling Modernization](#12-feature-area-j--form-handling-modernization)
13. [Schema Changes Summary](#13-schema-changes-summary)
14. [Permissions Matrix Update](#14-permissions-matrix-update)
15. [Implementation Phases](#15-implementation-phases)

---

## 1. Vision & Scope

### What v0.5 represents

Version 0.5 is the **half-way milestone** — it brings the CRM from a functional pipeline tracker to a lead-centric sales management platform. The current system (v0.4) handles the core loop well: Calendly events arrive, meetings are tracked, closers log outcomes. What's missing is the intelligence layer — identity resolution, lead lifecycle management, workload distribution, and the operational tooling that makes the difference between "we track meetings" and "we manage our sales operation."

### Guiding principles

1. **Calendly remains the source of truth** for scheduling, cancellations, and calendar state. We never write to Calendly's calendar — we read from it and build intelligence on top.
2. **Reduce friction at every touchpoint.** If a closer needs 3 clicks, find a way to make it 1. If an admin needs to cross-reference two screens, put the data on one.
3. **Identity is the hardest problem.** Leads use different emails, different names, different social handles across bookings. The system must be smart about deduplication without being wrong about it.
4. **Graceful degradation.** Every new feature should fail safely — if identity resolution is uncertain, surface it as a suggestion, not an automatic merge.

### What v0.5 does NOT include

- Advanced analytics / reporting dashboards (v0.7+)
- Automated outbound sequences / email campaigns (v0.8+)
- Multi-product / multi-program management (v0.9+)
- Customer success / post-sale management beyond placeholder (v0.6+)
- AI-powered lead scoring (v1.0)
- Mobile-native app (post-v1.0)

---

## 2. Entity Model Evolution

### Current model (v0.4)

```
Lead (1) → (N) Opportunity → (N) Meeting
                                    ↓
                              PaymentRecord
                              FollowUp
```

### Target model (v0.5)

```
Lead (1) → (N) Opportunity → (N) Meeting
  │                │                ↓
  │                │          PaymentRecord
  │                │          FollowUp
  │                │
  ├──→ (1) Customer ←── (N) Opportunity (closed-won)
  │         │
  │         └──→ CustomerRelationship { leadId, opportunityId, meetingIds[] }
  │
  ├──→ (N) LeadIdentifier { type: "email"|"phone"|"instagram"|"tiktok"|"other", value }
  │
  └──→ (N) LeadMergeHistory { sourceLeadId, targetLeadId, mergedBy, mergedAt }
```

### Key changes

| Entity | Change | Rationale |
|--------|--------|-----------|
| **User** | Add `personalEventTypeUri` | Closer's personal Calendly event type for follow-up/reschedule link generation |
| **Lead** | Add `socialHandles`, `status` field (`active` / `converted` / `merged`), `mergedIntoLeadId` | Lead lifecycle tracking, dedup support |
| **Customer** | New table | Converted leads become customers with full relationship graph |
| **LeadIdentifier** | New table | Multi-channel identity resolution (email, phone, social handles) |
| **LeadMergeHistory** | New table | Audit trail for lead merges |
| **Opportunity** | Add `utmParams` object, `programType` | Attribution tracking, program identification |
| **Meeting** | Add `utmParams`, `customFormData` (per-meeting copy), `rescheduledFromMeetingId`, `reassignedFromCloserId`, `meetingOutcome` | Per-meeting form data, reschedule chain, reassignment tracking |
| **EventTypeConfig** | Add `customFieldMappings`, `knownCustomFieldKeys` | CRM-only overlays on read-only Calendly data (field mapping for identity resolution) |
| **FollowUp** | Add `type` (`scheduling_link` / `manual_reminder`), `reminderMethod` (`call` / `text`), `reminderScheduledAt` | Support both follow-up types |

---

## 3. Feature Area A — Follow-Up & Rescheduling Overhaul

### Current state

The follow-up dialog currently has a single action: generate a Calendly scheduling link. The link is single-use and auto-linked to the opportunity via the pipeline processor.

### Target state

Two distinct follow-up options on the meeting detail page, each serving a different use case:

### A1. Manual Reminder Follow-Up

**Use case:** The closer wants to personally reach out to the lead (call or text) to re-engage and potentially set up a new meeting outside of the automated flow.

**UI:** New option in the follow-up dialog — "Set a Reminder"

**Behavior:**
1. Closer selects follow-up type: **"Set a Reminder"**
2. Closer picks a reminder method: **Call** or **Text**
3. Closer sets a reminder date/time (date picker + time selector)
4. Optional: Closer adds a note about what to say / context
5. System creates a `followUp` record with `type: "manual_reminder"`
6. At the scheduled time, the closer sees:
   - A notification in the notification center (real-time via Convex subscription)
   - The meeting card on the dashboard highlights with an "Action Required" badge
   - The lead's phone number is prominently displayed for quick access
7. The opportunity transitions to `follow_up_scheduled`
8. Once the closer completes the manual outreach, they mark the reminder as "completed" — this logs in the system that the closer performed the call/text/email
   - If a new meeting is being scheduled, the closer generates a scheduling link (option B)
   - If the lead is unresponsive, the closer can mark as "lost"

**Reminder delivery — in-app only:**
- A dedicated **"Reminders"** section on the closer's dashboard shows all pending reminders sorted by scheduled time
- Each reminder card shows: lead name, phone number (prominent for quick access), reminder method (call/text), scheduled time, and optional note
- When the scheduled time arrives (or passes), the card visually escalates (amber → red) and an in-app notification fires
- The closer clicks "Mark Complete" to log that they performed the outreach — this transitions the followUp to `completed` with a `completedAt` timestamp
- **The system does NOT send SMS, email, or any external message.** The closer does the outreach themselves. We track that they did it.
- **No cron needed.** The closer's dashboard subscribes to their pending reminders via `useQuery`. The client compares `reminderScheduledAt` against `Date.now()` on a local interval (same pattern as `useMeetingStartWindow`) to drive visual escalation (normal → amber → red). Fully reactive — when a reminder is marked complete the UI updates instantly via Convex subscription.

### A2. Scheduling Link Follow-Up (Enhanced)

**Use case:** Generate a booking link so the lead can self-schedule a new meeting.

**Enhancement over current:** The scheduling link must be for the **same closer's personal Calendly** — not a round-robin. This ensures continuity with the lead.

**Personal event type assignment:** Each closer must have a **personal event type** configured in the CRM. This is a Calendly event type that belongs specifically to that closer (not a round-robin pool). An admin assigns this in the CRM (likely during the Calendly member linking step at invite time, or in team settings). The `users` table gets a new field: `personalEventTypeUri`.

**How this works end-to-end:**
- Calendly manages the closer's Google Calendar integration and availability
- The CRM generates a link to the closer's personal Calendly event type (with UTMs)
- The lead clicks the link, sees only the closer's available slots, and books
- Calendly fires `invitee.created` webhook with the UTMs intact
- The pipeline processes it and links it to the right opportunity via UTMs

**We never create a meeting record directly. We never write to any calendar. We generate the link, the lead books through Calendly, and the webhook gives us everything we need.**

**Behavior:**
1. Closer selects follow-up type: **"Send Scheduling Link"**
2. System generates the scheduling link:
   - Reads the closer's `personalEventTypeUri` from their user record
   - If no personal event type is assigned → show error: "No personal calendar configured. Ask your admin to assign one in Team settings."
   - Builds the URL: `{closer's Calendly booking page URL}?{UTM params}`
3. The generated URL includes **reschedule UTM parameters** (see [Feature Area G](#9-feature-area-g--utm-tracking--attribution)) so the pipeline processor can automatically identify this as a follow-up booking
4. Link is displayed in a copy-friendly input with one-click copy
5. Opportunity transitions to `follow_up_scheduled`
6. When the lead books via the link, the pipeline processor:
   - Detects the UTM params identifying this as a reschedule
   - Links the new meeting to the existing opportunity
   - Transitions the opportunity back to `scheduled`
   - Marks the followUp record as `booked`

**UTM parameters appended to scheduling links** (Calendly only supports 5 standard UTM fields — see [Feature G2](#g2-crm-generated-utms-on-follow-up--reschedule-links) for full rationale):

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `utm_source` | `ptdom` | Unambiguous CRM flag — pipeline uses this to detect CRM-generated bookings |
| `utm_medium` | `follow_up` | Distinguishes from organic or no-show-reschedule bookings |
| `utm_campaign` | `{opportunityId}` | **Primary key** — deterministically links back to the opportunity |
| `utm_content` | `{followUpId}` | Links to the specific follow-up record |
| `utm_term` | `{closerId}` | Identifies which closer generated the link |

### A3. Follow-Up Dialog Redesign

The current single-purpose dialog becomes a two-tab or two-card selection:

```
┌─────────────────────────────────────────────┐
│  Schedule Follow-up                          │
│                                              │
│  How would you like to follow up?            │
│                                              │
│  ┌─────────────────┐  ┌─────────────────┐   │
│  │ 📅              │  │ 📞              │   │
│  │ Send Link       │  │ Set Reminder    │   │
│  │                 │  │                 │   │
│  │ Generate a      │  │ Set a reminder  │   │
│  │ booking link    │  │ to call or text │   │
│  │ for the lead    │  │ the lead        │   │
│  └─────────────────┘  └─────────────────┘   │
│                                              │
└─────────────────────────────────────────────┘
```

After selection, the dialog content changes to the relevant form.

---

## 4. Feature Area B — No-Show Management

### Current state

No-shows are detected via Calendly's `invitee_no_show.created` webhook and automatically mark the meeting and opportunity as `no_show`. The closer can then schedule a follow-up (scheduling link only).

### Target state

Two distinct no-show handling paths, plus automatic reschedule detection:

### B1. Simple No-Show (Mark Only)

**Use case:** The lead simply didn't show up. No further action needed on this opportunity right now.

**Behavior:**
1. The Calendly webhook fires `invitee_no_show.created` → meeting and opportunity marked `no_show` (no change from current)
2. On the meeting detail page, the closer sees a **"No Show Actions"** bar:
   - **"Confirm No-Show"** — Acknowledges the no-show, no further pipeline action. The opportunity stays in `no_show` status. This is the "do nothing" path.
   - **"Request Reschedule"** — See B2 below
   - **"Schedule Follow-Up"** — Uses the enhanced follow-up dialog from Feature Area A

**Important:** Marking a no-show does NOT require any interaction with Calendly. Calendly already fired the webhook. Our system just needs to record the closer's chosen response.

### B2. Reschedule on Request

**Use case:** The lead didn't show but wants to reschedule. The closer needs to send a rebook link for **the same closer's calendar.**

**Behavior:**
1. Closer clicks **"Request Reschedule"** from the no-show action bar
2. System generates a single-use scheduling link (same as A2) with no-show-specific UTM params (see [Feature G2](#g2-crm-generated-utms-on-follow-up--reschedule-links)):
   - `utm_source=ptdom` (CRM flag)
   - `utm_medium=noshow_resched` (distinguishes from regular follow-ups)
   - `utm_campaign={opportunityId}` (deterministic opportunity linking)
   - `utm_content={noShowMeetingId}` (original meeting reference)
   - `utm_term={closerId}` (closer attribution)
3. The link targets the closer's **personal Calendly event type** (same as A2 — read from `users.personalEventTypeUri`). The lead sees only this closer's availability and books directly through Calendly.
4. The opportunity transitions from `no_show` → `follow_up_scheduled`
5. When the lead books through Calendly, the `invitee.created` webhook fires with UTMs intact. The pipeline:
   - Detects `utm_source=ptdom` → reads `utm_campaign` as opportunity ID
   - Links the new meeting to the existing opportunity (no new opportunity created)
   - The new meeting's `rescheduledFromMeetingId` points to the no-show meeting
   - Opportunity transitions to `scheduled`
   - Follow-up record marked as `booked`

### B3. Automatic Reschedule Detection

**Use case:** Sometimes leads no-show but then independently go back to the original Calendly link and book a new meeting without the closer's intervention. The original link is typically a round-robin, so the new booking will likely be assigned to a **different closer** than the one who had the no-show.

**Problem:** The current pipeline treats this as a brand new lead + opportunity because the old meeting was no-show'd and a fresh `invitee.created` webhook fires.

**Solution — Pipeline Enhancement:**

When the pipeline processor receives an `invitee.created` event, before creating a new opportunity, it should check:

1. **Email match:** Does a lead with this email already have an opportunity in `no_show` or `canceled` status?
2. **Recency check:** Was the no-show/canceled opportunity updated within the last 14 days? (configurable per tenant)

If both conditions match:
- **Link the new meeting to the existing opportunity** (don't create a new one)
- Transition the opportunity from `no_show`/`canceled` → `scheduled`
- Set `rescheduledFromMeetingId` on the new meeting
- **Reassign the opportunity to the new closer** from the webhook's `event_memberships` host — since this came through a round-robin link, the lead got whoever was available, and that's the closer who should own it now
- Update `opportunity.assignedCloserId` to the new host
- Log a `[Pipeline] auto-reschedule detected | reassigned from closer_A to closer_B` event
- The new closer sees it on their dashboard; the old closer no longer owns this opportunity

**Note on closer assignment:** Unlike CRM-generated reschedule links (B2) which explicitly target the same closer's personal calendar, organic rebookings through a round-robin link land on whichever closer Calendly assigns. This is correct behavior — the lead no-showed on the original closer, so there's no expectation of continuity. The system should respect Calendly's assignment.

**Partial match (weaker signal):**
- If email doesn't match but a social handle or phone does (via identity resolution from Phase 7):
  - Create the new opportunity normally but flag it as a **"Potential Reschedule"** with a link to the suspected original opportunity (`potentialDuplicateLeadId`)
  - Surface this to the admin/closer for manual resolution

---

## 5. Feature Area C — Lead Manager

### Current state

Leads exist only as a backing entity for opportunities. There is no dedicated UI to view, search, or manage leads. The closer sees lead data only within meeting detail pages.

### Target state

A full **Lead Manager** — a lead-centric UI that serves as the central hub for contact management.

### C1. Lead Manager — Route & Layout

**Route:** `/workspace/leads` (accessible to all roles)
**Navigation:** New sidebar item between "Pipeline" and "Team" (or contextually appropriate position)

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Leads                                          [+ New Lead]│
│                                                              │
│  🔍 Search leads...          [Status ▼] [Has Meetings ▼]   │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Name          │ Email         │ Social   │ Status │ Mtgs ││
│  ├──────────────────────────────────────────────────────────┤│
│  │ John Doe      │ john@...      │ @johnd   │ Active │  3   ││
│  │ Jane Smith    │ jane@...      │ @janes   │ Active │  1   ││
│  │ Bob Wilson    │ bob@...       │ —        │ Conv.  │  2   ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  Showing 1-25 of 142 leads                    [< 1 2 3 4 >]│
└─────────────────────────────────────────────────────────────┘
```

### C2. Lead Detail Page

Clicking a lead row opens a **full detail page** at `/workspace/leads/[leadId]` in a **new browser tab** (focused). This lets the user keep the lead list open for cross-referencing while working with a specific lead.

**Header:**
- Back link to lead list, lead name, status badge, contact info (email, phone, social handles)
- Quick actions: Edit, Merge Lead (navigates to `/workspace/leads/[leadId]/merge`), Convert to Customer

**Tabs:**
1. **Overview** — Summary card with key identifiers, first seen date, total meetings, current opportunity status
2. **Meetings** — Chronological list of all meetings across all opportunities
   - Each entry: date, closer name, event type, status, outcome
   - Clicking a meeting navigates to the meeting detail page
3. **Opportunities** — All opportunities linked to this lead
   - Status, assigned closer, created date, outcome
4. **Activity** — Timeline of all events (meetings scheduled, no-shows, payments, follow-ups, merges)
5. **Custom Fields** — All custom form data collected across all bookings, with source attribution (which meeting provided which data)

### C3. Lead Search

**Full-text search across:**
- `fullName`
- `email`
- All values in `socialHandles` (instagram, tiktok, etc.)
- `phone`

**Implementation:** Convex search index on the `leads` table, or a `searchLeads` query that checks multiple fields via compound conditions. For v0.5, a client-filtered approach on paginated results may suffice if lead volume per tenant stays under 5,000. Beyond that, a Convex search index is required.

**Search behavior:**
- Debounced input (300ms)
- Results update reactively (Convex subscription)
- Highlights matching field in search results
- Empty state: "No leads found matching '{query}'"

### C4. Lead Permissions

| Action | tenant_master | tenant_admin | closer |
|--------|:---:|:---:|:---:|
| View all leads | ✓ | ✓ | ✓ (read-only) |
| Search leads | ✓ | ✓ | ✓ |
| Edit lead info | ✓ | ✓ | ✗ |
| Create lead manually | ✓ | ✓ | ✗ |
| Delete lead | ✓ | ✗ | ✗ |
| Merge leads | ✓ | ✓ | ✓ |
| Convert to customer | ✓ | ✓ | ✗ |
| Export leads | ✓ | ✓ | ✗ |

**New permissions to add:**

```
lead:view-all       → [tenant_master, tenant_admin, closer]
lead:edit           → [tenant_master, tenant_admin]
lead:create         → [tenant_master, tenant_admin]
lead:delete         → [tenant_master]
lead:merge          → [tenant_master, tenant_admin, closer]
lead:convert        → [tenant_master, tenant_admin]
lead:export         → [tenant_master, tenant_admin]
```

### C5. Lead Merge

**Use case:** A closer recognizes that a lead who booked a new meeting is actually the same person as an existing lead (different email, same Instagram handle, etc.).

**Who can merge:**
- **All roles** — closers, admins, and owners can merge directly. Closers are the primary merge actors because they interact with leads daily and are best positioned to spot duplicates.

**Merge flow (all roles):**
1. User opens Lead A's detail panel
2. Clicks "Merge Lead"
3. Search dialog appears — user searches for Lead B (the target)
4. System shows a **merge preview:**
   - Side-by-side comparison of both leads
   - Which fields will be kept (target lead wins, with option to pick source values)
   - What will be merged: all opportunities, meetings, payment records, follow-ups
   - Identifier consolidation: all emails, phones, social handles become identifiers on the target lead
5. User confirms → merge executes:
   - All opportunities on Lead A are re-pointed to Lead B
   - Lead A's unique identifiers are added to Lead B
   - Lead A is soft-deleted (`status: "merged"`, `mergedIntoLeadId: leadB._id`)
   - A `leadMergeHistory` record is created for audit

**Audit trail for admins:**
- Every merge is recorded in `leadMergeHistory` with: who merged, when, which leads, how many identifiers and opportunities were moved.
- Admins can review merge history in the Lead Manager's Activity tab and on the lead detail page.
- Merged leads are never physically deleted — they stay in the database with `status: "merged"` and a pointer to the target lead.

**Merge safety:**
- Merges are **irreversible** in the UI (user must confirm they understand this)
- A `leadMergeHistory` record preserves the full audit trail
- Merged leads are never physically deleted — they stay in the database with `status: "merged"`
- All references update atomically (within Convex transaction limits, or batched if needed)

---

## 6. Feature Area D — Lead-to-Customer Conversion

### Current state

When a closer records a payment and the deal is closed-won, the opportunity reaches `payment_received` (terminal). The lead remains a lead forever.

### Target state

Closed-won leads are **converted to customers**, creating a new entity with full relationship tracking.

### D1. Customer Entity

**Schema:**

```typescript
customers: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),                    // The lead that converted
  fullName: v.string(),                      // Denormalized from lead
  email: v.string(),                         // Primary email
  phone: v.optional(v.string()),
  socialHandles: v.optional(v.object({       // Denormalized from lead
    instagram: v.optional(v.string()),
    tiktok: v.optional(v.string()),
    other: v.optional(v.string()),
  })),
  convertedAt: v.number(),                   // When conversion happened
  convertedByUserId: v.id("users"),          // Which closer/admin triggered it
  winningOpportunityId: v.id("opportunities"), // The opportunity that closed
  winningMeetingId: v.optional(v.id("meetings")), // The meeting where the deal closed
  programType: v.optional(v.string()),       // From event type config
  notes: v.optional(v.string()),
  status: v.union(
    v.literal("active"),
    v.literal("churned"),
    v.literal("paused"),
  ),
  createdAt: v.number(),
})
.index("by_tenantId", ["tenantId"])
.index("by_tenantId_and_leadId", ["tenantId", "leadId"])
.index("by_tenantId_and_status", ["tenantId", "status"])
.index("by_tenantId_and_convertedAt", ["tenantId", "convertedAt"])
```

**No `totalPaid` field.** Total paid is computed on-demand by summing `paymentRecords` linked to this customer. Storing a running total is an antipattern — it drifts from the source of truth and becomes a maintenance burden. The query aggregates from the actual records every time.

### D1.1 Payment Records — Customer Linkage

The existing `paymentRecords` table currently links payments to an opportunity and meeting. Customers need to be able to receive payments directly (e.g., payment plan installments after conversion), so we add a `customerId` field:

**Changes to `paymentRecords`:**

```typescript
// Existing fields stay
opportunityId: v.id("opportunities"),
meetingId: v.id("meetings"),

// New field
customerId: v.optional(v.id("customers")),  // Set on conversion or for post-conversion payments
```

**New index:** `by_customerId` — for querying all payments belonging to a customer.

**Payment context:**
- **Pre-conversion payments** (closer records payment on a meeting): `opportunityId` and `meetingId` are set. `customerId` is backfilled when the lead converts.
- **Post-conversion payments** (payment plan installments, upsells): `customerId` is set directly. `opportunityId` is optional (may not be tied to a specific opportunity). `meetingId` is optional (no meeting needed for a payment plan installment).

**Computed total paid:**

```typescript
// Query — not a stored field
export const getCustomerTotalPaid = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, { customerId }) => {
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_customerId", q => q.eq("customerId", customerId))
      .collect();
    return payments.reduce((sum, p) => sum + p.amount, 0);
  },
});
```

### D2. Conversion Flow

**Automatic conversion (on payment):**

When a closer records a payment and the opportunity transitions to `payment_received`:

1. The `logPayment` mutation (or a subsequent scheduled action) checks if a customer record already exists for this lead
2. If **no customer exists:**
   - Create customer record with data denormalized from lead
   - Update lead status to `converted`
   - Populate `winningOpportunityId`, `winningMeetingId`
   - Backfill `customerId` on all existing `paymentRecords` for this lead's opportunities
   - Log `[Pipeline] lead converted to customer` with `{ leadId, customerId, opportunityId }`
3. If **customer already exists** (returning customer / additional sale):
   - Set `customerId` on the new payment record
   - No other changes needed — total is always computed from records

**Manual conversion (admin):**

From the Lead Manager, an admin can manually convert a lead to a customer:
- Opens a conversion dialog with pre-filled data from the lead
- Selects which opportunity and meeting represent the "win"
- Enters payment amount if not already recorded
- Confirms conversion

**Post-conversion payments:**

Once a customer exists, payments can be recorded directly against the customer (not just through meeting outcomes):
- Use case: payment plan installments, upsells, renewals
- The payment form gets an optional `customerId` field
- If `customerId` is set, `opportunityId` and `meetingId` become optional
- This allows admins/closers to record payments for customers without needing a meeting context

### D3. Customer View (Placeholder)

**Route:** `/workspace/customers`
**v0.5 scope:** A minimal list view that proves the data model works. Full customer management is v0.6+.

**Placeholder features:**
- List of all customers with name, email, converted date, **computed total paid** (aggregated from payment records), program type
- Click to open a detail sheet showing:
  - Customer info
  - Linked lead (clickable → Lead Manager)
  - Winning opportunity and meeting
  - Payment history (all `paymentRecords` with `customerId` matching, sorted by date)
  - Ability to record a new payment directly against the customer
  - Status badge (active/churned/paused)
- Basic filtering by status and date range
- No edit capabilities beyond status change (active ↔ paused ↔ churned)

### D4. Salesforce-Inspired Relationship Model

The relationship graph should be navigable:

```
Customer Detail
├── Lead record (link) → Lead Manager detail
├── Opportunity (link) → Pipeline view
│   ├── Meeting 1 (link) → Meeting detail
│   ├── Meeting 2 (link) → Meeting detail (the winning meeting)
│   └── Payment Records
└── Total lifetime value
```

**Every entity links back to its related entities.** The user should never hit a dead end — every ID should be a clickable link.

---

## 7. Feature Area E — Lead Identity Resolution

### The problem

Leads frequently book meetings using:
- Different email addresses (personal vs. work)
- Different name spellings
- Same social handle but different email
- No social handle one time, social handle another time

The current system uses email as the sole dedup key. This means the same person can appear as 2-3 different leads.

### E1. Multi-Identifier Lead Model

**New table: `leadIdentifiers`**

```typescript
leadIdentifiers: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  type: v.union(
    v.literal("email"),
    v.literal("phone"),
    v.literal("instagram"),
    v.literal("tiktok"),
    v.literal("twitter"),
    v.literal("facebook"),
    v.literal("linkedin"),
    v.literal("other_social"),
  ),
  value: v.string(),           // Normalized (lowercased, trimmed, @ stripped for social)
  rawValue: v.string(),        // Original value as entered
  source: v.union(
    v.literal("calendly_booking"),
    v.literal("manual_entry"),
    v.literal("merge"),
  ),
  sourceMeetingId: v.optional(v.id("meetings")),  // Which meeting provided this
  confidence: v.union(
    v.literal("verified"),     // Direct input by lead (email, phone)
    v.literal("inferred"),     // Extracted from form field
    v.literal("suggested"),    // AI/heuristic suggestion, unconfirmed
  ),
  createdAt: v.number(),
})
.index("by_tenantId_and_type_and_value", ["tenantId", "type", "value"])
.index("by_leadId", ["leadId"])
.index("by_tenantId_and_value", ["tenantId", "value"])
```

### E2. Social Handle Extraction from Custom Form Data

**The problem:** Calendly form data comes as arbitrary question/answer pairs. The social handle field could be named anything:
- "What's your Instagram username?"
- "Instagram handle"
- "IG @"
- "@yourinstagram"

**Solution — Configurable field mapping per event type:**

Each `eventTypeConfig` gets a new `customFieldMappings` object:

```typescript
customFieldMappings: v.optional(v.object({
  socialHandleField: v.optional(v.string()),    // The question text that contains the social handle
  socialHandleType: v.optional(v.union(         // Which platform
    v.literal("instagram"),
    v.literal("tiktok"),
    v.literal("twitter"),
    v.literal("other_social"),
  )),
  phoneField: v.optional(v.string()),           // Override if phone is in custom fields
  programField: v.optional(v.string()),         // Field that identifies the program/product
}))
```

**Configuration UI:**

In Settings → Event Types → Edit Event Type:

```
┌─────────────────────────────────────────────────────────────┐
│  Event Type: "Discovery Call - Fitness Program"              │
│                                                              │
│  Custom Field Mappings                                       │
│                                                              │
│  Social Handle Field:                                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ What's your Instagram username? (Example @therealb... ▼│ │
│  └─────────────────────────────────────────────────────────┘ │
│  Platform: [Instagram ▼]                                     │
│                                                              │
│  Phone Field (override):                                     │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Phone  ▼                                                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  Program Identifier Field:                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ (none selected) ▼                                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ℹ️ These dropdowns are populated from actual form field     │
│  names seen in recent bookings for this event type.          │
└─────────────────────────────────────────────────────────────┘
```

**Minimum friction approach:**
- The dropdown is populated from **actual custom field keys** that the system has seen in past bookings for that event type. This means:
  1. First booking comes in → field keys are stored
  2. Admin goes to Settings → Event Types → sees the actual field names from Calendly
  3. Admin selects which field is the social handle, which is phone, etc.
  4. All future bookings for that event type automatically extract the mapped data
- No manual typing of field names — just select from what Calendly sends

**Pipeline integration:**

When `invitee.created` fires and the pipeline processor creates/updates a lead:

1. Load the `eventTypeConfig` for this booking's event type
2. Check `customFieldMappings.socialHandleField` — if set, extract the answer for that question
3. Normalize the social handle:
   - Strip leading `@`
   - Lowercase
   - Trim whitespace
   - Handle common patterns: "instagram.com/username" → "username"
4. Create a `leadIdentifier` record with `type: "instagram"`, `confidence: "inferred"`
5. Check if any other lead already has this identifier → flag as potential duplicate

### E3. Identity Resolution During Webhook Processing

When a new `invitee.created` event arrives, the pipeline should attempt identity resolution in this order:

```
1. Exact email match → same lead (current behavior, keep)
2. Exact social handle match → same lead (new, if configured)
3. Exact phone match → same lead (new)
4. Fuzzy name match + same social handle → strong suggestion
5. Same email domain + similar name → weak suggestion (display only)
```

**Resolution confidence levels:**

| Match type | Action | Confidence |
|-----------|--------|------------|
| Email match | Auto-merge into existing lead | Verified |
| Social handle match (configured field) | Auto-merge into existing lead | Verified |
| Phone match | Auto-merge into existing lead | Verified |
| Name + partial identifier match | Create new lead + flag as "Potential Duplicate" | Suggested |
| No match | Create new lead normally | N/A |

**"Potential Duplicate" flag:**
- Stored on the opportunity: `potentialDuplicateLeadId: v.optional(v.id("leads"))`
- Surfaces in the Lead Manager as a merge suggestion
- Surfaces on the meeting detail page as a banner: "This lead might be the same as [Lead Name]. [Review & Merge]"

### E4. Social Handle Normalization Rules

| Platform | Input | Normalized |
|----------|-------|------------|
| Instagram | `@campos.coachpro` | `campos.coachpro` |
| Instagram | `instagram.com/campos.coachpro` | `campos.coachpro` |
| Instagram | `https://www.instagram.com/campos.coachpro/` | `campos.coachpro` |
| TikTok | `@coach_pro` | `coach_pro` |
| TikTok | `tiktok.com/@coach_pro` | `coach_pro` |
| Twitter/X | `@coachpro` | `coachpro` |
| Phone | `+1 778-955-9253` | `+17789559253` (E.164) |
| Phone | `(778) 955-9253` | `+17789559253` (assume US/CA if no country code) |

---

## 8. Feature Area F — Event Type Data (Read-Only from Calendly)

### Current state

`eventTypeConfigs` stores the Calendly event type URI, display name, payment links, and a round-robin flag. Event types are used to look up payment links on the meeting detail page. The display name and round-robin status are synced from Calendly.

### Guiding principle

**Calendly owns event types.** Creating, editing, naming, configuring questions, setting round-robin rules, managing availability — all of that happens in Calendly. Our CRM does not duplicate that responsibility.

What the CRM *does* own is a thin **overlay layer** — CRM-specific metadata that Calendly doesn't know about. The only writable overlay in v0.5 scope is **custom field mappings** for identity resolution.

### What we read from Calendly (read-only, synced via webhooks + org member sync)

| Data | Source | Where it surfaces |
|------|--------|-------------------|
| Event type name | `scheduled_event.event_type` → Calendly API | Meeting detail page, pipeline table, closer dashboard |
| Round-robin status | Event type config from Calendly | Internal logic (follow-up link targeting) |
| Event type URI | Webhook payload | Linking meetings to configs |
| Custom form questions | `questions_and_answers` in webhook payload | Booking answers card, identity resolution |
| Host assignment | `event_memberships` in webhook payload | Closer assignment |

**No management UI for event types themselves.** Admins configure event types in Calendly. Our settings page only shows a read-only list of synced event types with their Calendly-provided names, for the purpose of attaching CRM overlays.

### F1. CRM Overlay: Custom Field Mappings

The **only editable configuration** per event type is the custom field mapping — telling the CRM which Calendly form question corresponds to which identity field. This is the same mapping described in [Feature Area E, Section E2](#e2-social-handle-extraction-from-custom-form-data).

**New fields on `eventTypeConfigs`:**

```typescript
// CRM-only overlays (not from Calendly)
customFieldMappings: v.optional(v.object({
  socialHandleField: v.optional(v.string()),    // Which question text contains the social handle
  socialHandleType: v.optional(v.union(         // Which platform
    v.literal("instagram"),
    v.literal("tiktok"),
    v.literal("twitter"),
    v.literal("other_social"),
  )),
  phoneField: v.optional(v.string()),           // Override if phone is in custom fields
})),

// Auto-discovered from incoming bookings (read-only, system-managed)
knownCustomFieldKeys: v.optional(v.array(v.string())),
```

### F2. Auto-Discovery of Custom Field Keys

When the pipeline processes an `invitee.created` event and finds `questions_and_answers`:

1. Extract all question strings from the payload
2. Load the `eventTypeConfig` for this event type
3. Compute the union of `knownCustomFieldKeys` and the new question keys
4. If new keys were discovered → update `knownCustomFieldKeys` on the config

This is fully automatic — no admin action required. It simply ensures the field mapping dropdowns in settings are populated with real field names from actual bookings.

### F3. Settings UI — "Field Mappings" Tab

In Settings, a **"Field Mappings"** tab shows:

```
┌─────────────────────────────────────────────────────────────┐
│  Settings > Field Mappings                                   │
│                                                              │
│  Configure how CRM identifies leads from booking form data.  │
│  Event types and their settings are managed in Calendly.     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Discovery Call - Fitness Program          [Configure]  │  │
│  │ Last booking: Apr 7 · 14 bookings · 6 form fields     │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Follow-Up Call                            [Configure]  │  │
│  │ Last booking: Apr 5 · 3 bookings · 4 form fields      │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Business Mentorship Intro                 [Configure]  │  │
│  │ Last booking: Apr 2 · 8 bookings · 6 form fields      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ℹ️ Event types appear here after their first booking.       │
│  Names and form questions are synced from Calendly.          │
└─────────────────────────────────────────────────────────────┘
```

Clicking "Configure" opens the field mapping dialog (same UI from E2) — dropdowns populated from `knownCustomFieldKeys`, letting the admin select which question is the social handle, phone override, etc.

### F4. Event Type in Meeting Context

The meeting detail page should prominently display:
- **Event type name** (already shown, read from Calendly via config)
- This gives the closer immediate context about what kind of meeting this is
- Any program/call-type labeling is Calendly's responsibility via event type naming

---

## 9. Feature Area G — UTM Tracking & Attribution

### Current state

No UTM tracking exists. The pipeline processor currently ignores the `tracking` object in webhook payloads.

### How Calendly UTMs work (confirmed)

Calendly stores UTM parameters at the **Invitee** level (not the Event level). There are two ways to access them:

1. **Real-time via webhooks (our primary method):** The `invitee.created` webhook payload includes a `tracking` object on the invitee resource. Since we already subscribe to this event, we just need to extract a field we're currently ignoring.

2. **On-demand via API:** `GET /scheduled_events/{event_uuid}/invitees` returns the same `tracking` object. Useful for backfilling or reconciliation.

**Critically:** Calendly only supports the **5 standard UTM fields** (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`). There are no custom tracking fields. This means our CRM-specific identifiers (opportunity ID, follow-up ID, etc.) must be packed into these 5 fields.

**For UTMs to be captured**, they must be present on the booking URL when the lead visits. Direct links work (`calendly.com/user/event?utm_source=twitter`). For embedded widgets, the Advanced Embed code is needed to pass parent URL params into the iframe — but our tenants use direct links, so this is not a concern for v0.5.

### Target state

Full UTM capture from every booking, plus CRM-generated UTMs on follow-up/reschedule links that allow deterministic meeting-to-opportunity linking.

### G1. UTM Extraction from Webhook Payload

**Where it lives in the payload:**

```json
{
  "resource": {
    "uri": "https://api.calendly.com/scheduled_events/GBHGN7SGV67SGV/invitees/ABC123",
    "email": "jane.doe@example.com",
    "tracking": {
      "utm_campaign": "spring_sale",
      "utm_source": "facebook",
      "utm_medium": "ad",
      "utm_content": "video_ads",
      "utm_term": "productivity_tools"
    }
  }
}
```

**Pipeline change in `inviteeCreated.ts`:**

1. Extract `tracking` from the invitee payload (same level as `email`, `questions_and_answers`)
2. Store on the **meeting** record as `utmParams`
3. Store on the **opportunity** record as `utmParams` (first booking's UTMs become the opportunity's attribution; subsequent bookings on the same opportunity don't overwrite)

**Schema:**

```typescript
utmParams: v.optional(v.object({
  utm_source: v.optional(v.string()),
  utm_medium: v.optional(v.string()),
  utm_campaign: v.optional(v.string()),
  utm_term: v.optional(v.string()),
  utm_content: v.optional(v.string()),
}))
```

Note: We store exactly what Calendly gives us — no CRM-specific fields mixed into this object. CRM-specific tracking (reschedule detection, follow-up linking) is handled by **interpreting** the UTM values, not by adding extra fields to the schema. See G2.

### G2. CRM-Generated UTMs on Follow-Up & Reschedule Links

When the system generates a scheduling link (Feature A2, B2), we append UTM parameters to the booking URL. Since Calendly only supports 5 standard UTM fields, we pack our identifiers strategically:

**For closer-initiated follow-ups:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `utm_source` | `ptdom` | Identifies our CRM as the source (short — URL length matters) |
| `utm_medium` | `follow_up` | Distinguishes from organic, ad, or no-show bookings |
| `utm_campaign` | `{opportunityId}` | Links directly back to the opportunity — this is the primary key for pipeline reconnection |
| `utm_content` | `{followUpId}` | Links to the specific follow-up record for audit |
| `utm_term` | `{closerId}` | Identifies which closer generated the link |

**For no-show reschedules:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `utm_source` | `ptdom` | CRM identifier |
| `utm_medium` | `noshow_resched` | Distinguishes from regular follow-ups |
| `utm_campaign` | `{opportunityId}` | Opportunity reconnection key |
| `utm_content` | `{originalMeetingId}` | The no-show meeting this reschedule originated from |
| `utm_term` | `{closerId}` | Closer attribution |

**Example generated URL:**
```
https://calendly.com/closer-jane/discovery-call
  ?utm_source=ptdom
  &utm_medium=follow_up
  &utm_campaign=k57abc123def456
  &utm_content=k57xyz789ghi012
  &utm_term=k57closer456abc
```

**Why this encoding works:**
- `utm_source=ptdom` is the unambiguous flag — when the pipeline sees this, it knows this booking originated from our CRM
- `utm_campaign` carrying the opportunity ID is the deterministic link — no heuristics needed
- Convex document IDs are URL-safe strings, so they work directly as UTM values
- We don't need a separate `ptdom_reschedule` param — `utm_source=ptdom` combined with `utm_medium` tells us everything

### G3. Pipeline UTM Intelligence

When `invitee.created` fires, the pipeline processor checks UTMs **before** creating entities:

```
1. Extract tracking.utm_source from payload
2. If utm_source === "ptdom":
   → This is a CRM-generated booking (follow-up or reschedule)
   a. Extract utm_campaign → this is the opportunityId
   b. Look up the opportunity by ID
   c. If found and belongs to this tenant:
      - Link the new meeting to this existing opportunity (don't create a new one)
      - Transition opportunity from follow_up_scheduled/no_show/canceled → scheduled
      - Set meeting.rescheduledFromMeetingId if utm_medium === "noshow_resched"
        (use utm_content as the original meeting ID)
      - Mark the follow-up record as "booked" if utm_medium === "follow_up"
        (use utm_content as the followUp ID)
   d. If not found (ID doesn't match, wrong tenant, etc.):
      - Log warning: "[Pipeline] CRM UTM references unknown opportunity"
      - Fall through to normal processing (create new opportunity)
3. If utm_source !== "ptdom" or no tracking data:
   → Normal processing (current behavior)
   → Store whatever UTMs Calendly provides for attribution display
```

**This is the deterministic path** — it takes priority over the heuristic reschedule detection in Feature B3. If a booking has `utm_source=ptdom`, we trust the UTMs. The heuristic path (B3: email match + recency) only activates for organic rebookings where the lead went back to the original Calendly link independently — typically a round-robin, so the closer may differ.

**Priority order for opportunity linking:**
1. **UTM-based** (deterministic): `utm_source=ptdom` → use `utm_campaign` as opportunity ID
2. **Heuristic** (Feature B3): Email/identity match + no-show/canceled opportunity within 14 days. If closer differs (round-robin reassignment), reassign the opportunity to the new host.
3. **Follow-up detection** (existing): Lead has a `follow_up_scheduled` opportunity
4. **New opportunity** (default): No match found

### G4. UTM Display in Meeting Detail

New **"Attribution"** card on the meeting detail page:

```
┌─────────────────────────────────────────────────────────────┐
│  📊 Attribution                                              │
│                                                              │
│  Source:     Facebook                                        │
│  Medium:     Ad                                              │
│  Campaign:   Spring Sale                                     │
│  Term:       productivity_tools                              │
│  Content:    video_ads                                       │
│                                                              │
│  Booking Origin: ● Organic                                   │
└─────────────────────────────────────────────────────────────┘
```

For CRM-generated bookings, the card displays differently:

```
┌─────────────────────────────────────────────────────────────┐
│  📊 Attribution                                              │
│                                                              │
│  Booking Origin: ● Follow-Up (CRM Generated)                │
│  Original Meeting: Mar 28 @ 2:00 PM [View →]               │
│  Follow-Up Created By: Jane (Closer)                        │
│                                                              │
│  ℹ️ This meeting was booked via a follow-up link             │
│  generated from the CRM.                                     │
└─────────────────────────────────────────────────────────────┘
```

**Display logic:**
- If `utm_source === "ptdom"` → show CRM origin card (resolve follow-up/meeting references from UTM values)
- If `tracking` has any non-ptdom UTMs → show standard attribution card with raw values
- If no tracking data → show "Direct booking (no attribution data)"
- Both cases: show a **Booking Origin** badge — `Organic`, `Follow-Up`, `No-Show Reschedule`, or `Unknown`

### G5. Backfill Consideration

For existing meetings that were created before UTM tracking was implemented:
- No backfill needed — old meetings simply won't have `utmParams` and the attribution card shows "No attribution data"
- If a tenant wants to retroactively fetch UTMs for recent bookings, a future admin action could call `GET /scheduled_events/{uuid}/invitees` for each meeting with a `calendlyEventUri` — but this is **not in v0.5 scope**

---

## 10. Feature Area H — Closer Unavailability & Workload Redistribution

### The problem

When a closer becomes unavailable (sick, emergency, etc.), their meetings for the day are orphaned. Currently there's no way to redistribute those meetings to other available closers.

### H1. Mark Closer Unavailable

**UI Location:** Admin/Owner views — Team page or a dedicated "Schedule" section

**Flow:**
1. Admin navigates to Team Management
2. Clicks on a closer → "Mark Unavailable"
3. Dialog appears:
   - **Date:** Pre-filled with today (can select future dates)
   - **Reason:** Dropdown (Sick, Emergency, Personal, Other) + optional note
   - **Duration:** Full day / specific time range
4. On confirm:
   - Closer is marked with an `unavailability` record
   - System identifies all of this closer's meetings for that date/range
   - Shows a summary: "John has 5 meetings today. What would you like to do?"

### H2. Workload Redistribution

**After marking a closer unavailable, the admin enters the redistribution flow:**

```
┌─────────────────────────────────────────────────────────────┐
│  Redistribute John's Meetings (April 8, 2026)               │
│                                                              │
│  John has 5 meetings scheduled today:                        │
│                                                              │
│  ☑ 10:00 AM — Sarah Connor (Discovery)                      │
│  ☑ 11:30 AM — Mike Johnson (Follow-up)                      │
│  ☑ 1:00 PM  — Lisa Park (Discovery)                         │
│  ☑ 2:30 PM  — Tom Brown (Closing)                           │
│  ☑ 4:00 PM  — Ana Garcia (Discovery)                        │
│                                                              │
│  Select available closers to redistribute to:                │
│                                                              │
│  ☑ Alice (5 meetings today, 2 gaps found)                   │
│  ☑ Bob (3 meetings today, 4 gaps found)                     │
│  ☐ Carol (7 meetings today, 0 gaps found)                   │
│                                                              │
│  [Auto-Distribute]  [Manual Assign]                          │
└─────────────────────────────────────────────────────────────┘
```

### H3. Intelligent Distribution Algorithm

When "Auto-Distribute" is clicked:

**Input:**
- List of meetings to redistribute (with scheduled times)
- List of available closers (selected by admin)
- Each closer's existing meeting schedule for the day

**Algorithm:**

```
For each meeting M (sorted by time):
  1. For each selected closer C:
     a. Check if C has a free slot at M's scheduled time
        (no overlap with C's existing meetings ± 15 min buffer)
     b. If free: add to candidate list with priority score
  2. Priority scoring:
     - Fewer total meetings today → higher priority (load balancing)
     - Same program type experience → slight bonus (if we track this)
     - Gap duration (longer gap = better fit) → slight bonus
  3. Assign M to the highest-scoring candidate
  4. If no candidate has availability:
     - Mark M as "unassigned" → goes to the admin's manual resolution queue
```

### H4. Manual Resolution for Unassigned Meetings

Meetings that couldn't be auto-distributed are presented to the admin one by one:

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠️ 2 meetings could not be auto-assigned                   │
│                                                              │
│  1:00 PM — Lisa Park (Discovery)                            │
│  No selected closers are available at this time.             │
│                                                              │
│  Options:                                                    │
│  [Assign to Alice (overlap warning)]                        │
│  [Assign to Bob (overlap warning)]                          │
│  [Reschedule] → generates reschedule link for lead          │
│  [Cancel Meeting] → cancels and notifies lead               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### H5. Reassignment Execution

When a meeting is reassigned to a different closer:

1. **Calendly side:** The system does NOT modify Calendly's calendar directly. Instead:
   - The original meeting's Zoom link stays active (it's hosted by the original closer's Calendly)
   - A note is added to the meeting record: "Reassigned from {original closer} to {new closer} due to unavailability"
   - The new closer sees the meeting on their dashboard with a "Reassigned" badge

2. **CRM side:**
   - `opportunity.assignedCloserId` is updated to the new closer
   - Meeting record gets a `reassignedFromCloserId` field
   - Notification sent to the new closer
   - Admin sees the redistribution summary in an audit log

3. **Limitations & future work:**
   - v0.5: Reassignment is CRM-only. The Calendly event still shows the original host. The new closer uses the existing Zoom link.
   - v0.6+: Integration with Calendly's "reassign" or "cancel + rebook" APIs for full calendar sync
   - v0.6+: Automatic Zoom link generation for the new closer

### H6. Schema — Unavailability

```typescript
closerUnavailability: defineTable({
  tenantId: v.id("tenants"),
  closerId: v.id("users"),
  date: v.number(),                         // Start of day timestamp
  startTime: v.optional(v.number()),        // Specific start (if partial day)
  endTime: v.optional(v.number()),          // Specific end (if partial day)
  isFullDay: v.boolean(),
  reason: v.union(
    v.literal("sick"),
    v.literal("emergency"),
    v.literal("personal"),
    v.literal("other"),
  ),
  note: v.optional(v.string()),
  createdByUserId: v.id("users"),           // Admin who marked unavailable
  createdAt: v.number(),
})
.index("by_tenantId_and_date", ["tenantId", "date"])
.index("by_closerId_and_date", ["closerId", "date"])
```

```typescript
meetingReassignments: defineTable({
  tenantId: v.id("tenants"),
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  fromCloserId: v.id("users"),
  toCloserId: v.id("users"),
  reason: v.string(),                        // "closer_unavailable", "manual_override"
  unavailabilityId: v.optional(v.id("closerUnavailability")),
  reassignedByUserId: v.id("users"),         // Admin who performed reassignment
  reassignedAt: v.number(),
})
.index("by_tenantId", ["tenantId"])
.index("by_meetingId", ["meetingId"])
.index("by_toCloserId", ["toCloserId"])
```

---

## 11. Feature Area I — Meeting Detail Enhancements

### Current state

The meeting detail page shows: lead info, meeting info, booking answers, notes, payment links, and the outcome action bar. Payments are recorded but their details are not prominently displayed.

### Target state

A richer, more informative meeting detail page.

### I1. Won Deal Display

When the opportunity is `payment_received` (Won), the meeting detail page should show a **"Deal Won"** card:

```
┌─────────────────────────────────────────────────────────────┐
│  🎉 Deal Won                                                │
│                                                              │
│  Amount Paid:    $2,500.00 USD                              │
│  Provider:       Stripe                                     │
│  Reference:      pi_3abc123xyz                              │
│  Recorded:       April 5, 2026 at 3:45 PM                  │
│  Recorded By:    John Doe                                   │
│  Status:         Verified ✓                                 │
│                                                              │
│  Proof of Payment:                                          │
│  ┌────────────────────┐                                     │
│  │  [payment_proof.pdf]│  ← clickable to view/download      │
│  │  Uploaded Apr 5     │                                     │
│  └────────────────────┘                                     │
│                                                              │
│  Customer Profile: [View →]  (links to customer view)       │
└─────────────────────────────────────────────────────────────┘
```

**Key requirements:**
- Show the **actual payment amount** prominently
- Display the **proof file** — if it's an image (JPEG, PNG, GIF), render it inline as a thumbnail with a lightbox on click; if it's a PDF, show a download link with a PDF icon
- Link to the customer profile (if converted)
- Show payment status badge (recorded → verified → disputed)

### I2. Proof File Display

**Current:** Proof files are uploaded but never displayed. `getPaymentProofUrl` query exists but is never called from the UI.

**Target:** The proof file should be visible:
- **Image files:** Thumbnail preview (max 200px wide) → click to open full-size in a lightbox or new tab
- **PDF files:** PDF icon + filename → click to open in a new tab (use Convex storage URL)
- **File info:** Show filename, upload date, file size

### I3. Meeting Reschedule Chain

If a meeting was rescheduled (from a no-show or follow-up), show the chain:

```
┌─────────────────────────────────────────────────────────────┐
│  📋 Meeting History                                          │
│                                                              │
│  This meeting is a reschedule of:                           │
│  • Mar 28 @ 2:00 PM — No Show [View →]                     │
│    └── Original: Mar 25 @ 10:00 AM — Canceled [View →]     │
└─────────────────────────────────────────────────────────────┘
```

### I4. UTM Attribution Card

New card showing how the lead arrived at this meeting:

```
┌─────────────────────────────────────────────────────────────┐
│  📊 Attribution                                              │
│                                                              │
│  Source:     Facebook                                        │
│  Medium:     Paid Ad                                         │
│  Campaign:   Spring Fitness Promo                            │
│  ─────────────────────────────────────                       │
│  Booking Type: ○ Organic  ● Follow-Up  ○ Reschedule        │
│  Original Meeting: Mar 28 @ 2:00 PM [View →]               │
└─────────────────────────────────────────────────────────────┘
```

### I5. Enhanced Meeting Info

Additional data to surface:
- **Calendly event type name** (already shown — name comes from Calendly, read-only)
- **Custom form data per meeting** (not just per lead — each meeting may have different answers)
- **Lead identifiers** discovered from this booking (social handle, phone — extracted via field mapping)
- **Reassignment notice** if this meeting was redistributed from another closer

### I6. Richer Notes

Upgrade from plain textarea to a structured notes section:
- **Auto-save** (keep current debounced behavior)
- **Timestamps** on each save (show "Last saved at 3:45 PM")
- **Meeting outcome summary** field (separate from freeform notes): a structured dropdown or tag system for common outcomes: "Interested", "Needs more info", "Price objection", "Not qualified", "Ready to buy"
- Keep the freeform notes below the structured outcome

---

## 12. Feature Area J — Form Handling Modernization

### Current state

All forms use manual `useState` per field with imperative validation (if/else checks). Error feedback is via toast only — no inline field-level validation.

### Target state

Migrate to **React Hook Form + Zod** for type-safe, declarative form handling with inline validation.

### J1. Library Setup

Following [shadcn/ui form documentation](https://ui.shadcn.com/docs/forms/react-hook-form):

**Dependencies:**
- `react-hook-form` — form state management
- `@hookform/resolvers` — Zod resolver
- `zod` — schema validation (already used by Convex validators, add for frontend)

**shadcn/ui Form component:** Provides `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormDescription`, `FormMessage` — integrates RHF with Radix UI components.

### J2. Migration Priority

| Form | Current | Priority | Complexity |
|------|---------|----------|------------|
| Payment Form Dialog | 5 fields + file upload | High | Medium |
| Invite User Dialog | 4 fields + conditional logic | High | Medium |
| Field Mapping Dialog | Dropdown selections per event type (CRM overlay) | Medium | Simple |
| Role Edit Dialog | 1 field | Low | Simple |
| Mark Lost Dialog | 1 field (reason textarea) | Low | Simple |
| Follow-Up Dialog (redesigned) | New — 2 paths with different fields | High | Medium |
| Lead Merge Dialog | New — search + preview | High | High |
| Lead Edit Dialog | New — multiple fields | Medium | Medium |
| Redistribution Dialog | New — complex multi-step | High | High |
| Customer Conversion Dialog | New — pre-filled fields | Medium | Medium |

### J3. Pattern Template

Every form in the app should follow this pattern:

```tsx
// 1. Define Zod schema
const paymentFormSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD", "JPY"]),
  provider: z.enum(["Stripe", "PayPal", "Square", "Cash", "Bank Transfer", "Other"]),
  referenceCode: z.string().optional(),
  proofFile: z.instanceof(File).optional(),
});

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

// 2. Use React Hook Form with Zod resolver
const form = useForm<PaymentFormValues>({
  resolver: zodResolver(paymentFormSchema),
  defaultValues: {
    amount: 0,
    currency: "USD",
    provider: "Stripe",
  },
});

// 3. Structured submission handler
async function onSubmit(values: PaymentFormValues) {
  // No manual validation needed — Zod handles it
  // Just call the mutation
}

// 4. JSX uses <Form> + <FormField> for automatic error display
<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)}>
    <FormField
      control={form.control}
      name="amount"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Amount</FormLabel>
          <FormControl>
            <Input type="number" {...field} />
          </FormControl>
          <FormMessage /> {/* Inline error display */}
        </FormItem>
      )}
    />
  </form>
</Form>
```

### J4. Benefits

- **Inline validation errors** — no more toast-only feedback for field issues
- **Type safety** — Zod schemas ensure compile-time correctness
- **Declarative** — validation logic is in the schema, not scattered through handlers
- **Consistent UX** — every form behaves the same way (focus first error, inline messages)
- **Reduced boilerplate** — no `const [field, setField] = useState()` per field
- **Dirty tracking** — RHF tracks which fields changed (useful for edit forms)

---

## 13. Schema Changes Summary

### New Tables

| Table | Purpose |
|-------|---------|
| `customers` | Converted leads with full relationship tracking |
| `leadIdentifiers` | Multi-channel identity resolution (email, phone, social) |
| `leadMergeHistory` | Audit trail for lead merges (all roles can merge directly) |
| `closerUnavailability` | Closer schedule exceptions |
| `meetingReassignments` | Audit trail for meeting redistributions |

### Modified Tables

| Table | Changes |
|-------|---------|
| **users** | Add `personalEventTypeUri` (the closer's personal Calendly event type used for follow-up/reschedule link generation) |
| **leads** | Add `status` (`active`/`converted`/`merged`), `mergedIntoLeadId`, `socialHandles` object |
| **opportunities** | Add `utmParams` object, `potentialDuplicateLeadId`, `programType` |
| **meetings** | Add `utmParams`, `customFormData` (per-meeting copy), `rescheduledFromMeetingId`, `reassignedFromCloserId`, `meetingOutcome` |
| **eventTypeConfigs** | Add `customFieldMappings` (CRM overlay for identity resolution), `knownCustomFieldKeys` (auto-discovered from bookings). No new Calendly-managed fields — event type names, round-robin, questions are read-only from Calendly. |
| **followUps** | Add `type` (`scheduling_link`/`manual_reminder`), `reminderMethod`, `reminderScheduledAt`, `reminderNote`, `completedAt` |
| **paymentRecords** | Add `customerId` (optional, for post-conversion payments and backfill on conversion), `closerFullName` (denormalized). New index: `by_customerId`. `opportunityId` and `meetingId` become optional for post-conversion payments. |

### New Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `leads` | `by_tenantId_and_status` | Filter leads by lifecycle status |
| `leads` | `by_tenantId_and_fullName` | Name-based search |
| `leadIdentifiers` | `by_tenantId_and_type_and_value` | Identity resolution lookups |
| `leadIdentifiers` | `by_leadId` | Get all identifiers for a lead |
| `leadIdentifiers` | `by_tenantId_and_value` | Cross-type value search |
| `customers` | `by_tenantId_and_leadId` | Lead → Customer lookup |
| `customers` | `by_tenantId_and_status` | Customer filtering |
| `customers` | `by_tenantId_and_convertedAt` | Temporal queries |
| `closerUnavailability` | `by_tenantId_and_date` | Date-based availability check |
| `closerUnavailability` | `by_closerId_and_date` | Per-closer availability |
| `meetingReassignments` | `by_meetingId` | Reassignment history per meeting |
| `meetingReassignments` | `by_toCloserId` | "My reassigned meetings" query |
| `followUps` | `by_tenantId_and_status` | Pending reminder queries |
| `followUps` | `by_tenantId_and_reminderScheduledAt` | Query pending reminders sorted by time for closer dashboard |
| `meetings` | `by_tenantId_and_status` | Filter meetings by status |
| `opportunities` | `by_tenantId_and_createdAt` | Temporal pipeline queries |

---

## 14. Permissions Matrix Update

### New Permissions

```
lead:view-all         → [tenant_master, tenant_admin, closer]
lead:edit             → [tenant_master, tenant_admin]
lead:create           → [tenant_master, tenant_admin]
lead:delete           → [tenant_master]
lead:merge            → [tenant_master, tenant_admin, closer]
lead:convert          → [tenant_master, tenant_admin]
lead:export           → [tenant_master, tenant_admin]
customer:view-all     → [tenant_master, tenant_admin]
customer:view-own     → [tenant_master, tenant_admin, closer]
customer:edit         → [tenant_master, tenant_admin]
closer:mark-unavail   → [tenant_master, tenant_admin]
meeting:reassign      → [tenant_master, tenant_admin]
meeting:view-all      → [tenant_master, tenant_admin]
```

### Full Permission Matrix (v0.5)

| Permission | tenant_master | tenant_admin | closer |
|-----------|:---:|:---:|:---:|
| **Team** | | | |
| team:invite | ✓ | ✓ | ✗ |
| team:remove | ✓ | ✓ | ✗ |
| team:update-role | ✓ | ✗ | ✗ |
| **Pipeline** | | | |
| pipeline:view-all | ✓ | ✓ | ✗ |
| pipeline:view-own | ✓ | ✓ | ✓ |
| **Settings** | | | |
| settings:manage | ✓ | ✓ | ✗ |
| **Meetings** | | | |
| meeting:view-all | ✓ | ✓ | ✗ |
| meeting:view-own | ✓ | ✓ | ✓ |
| meeting:manage-own | ✗ | ✗ | ✓ |
| meeting:reassign | ✓ | ✓ | ✗ |
| **Payments** | | | |
| payment:record | ✗ | ✗ | ✓ |
| payment:view-all | ✓ | ✓ | ✗ |
| payment:view-own | ✓ | ✓ | ✓ |
| **Leads** | | | |
| lead:view-all | ✓ | ✓ | ✓ |
| lead:edit | ✓ | ✓ | ✗ |
| lead:create | ✓ | ✓ | ✗ |
| lead:delete | ✓ | ✗ | ✗ |
| lead:merge | ✓ | ✓ | ✓ |
| lead:convert | ✓ | ✓ | ✗ |
| lead:export | ✓ | ✓ | ✗ |
| **Customers** | | | |
| customer:view-all | ✓ | ✓ | ✗ |
| customer:view-own | ✓ | ✓ | ✓ |
| customer:edit | ✓ | ✓ | ✗ |
| **Closer Management** | | | |
| closer:mark-unavail | ✓ | ✓ | ✗ |

---

---

## 15. Implementation Phases

Each phase is a **self-contained vertical slice** — schema, backend, and frontend for one testable feature. After completing a phase, you should be able to deploy, test the feature end-to-end in the browser, validate it works, and move on. No phase leaves half-built plumbing that requires a future phase to become testable.

### Dependency graph

```
Phase 1: Form Handling Modernization ─────────────────────────── (no deps, foundational)
Phase 2: UTM Tracking ────────────────────────────────────────── (no deps, pipeline-only)
Phase 3: Meeting Detail Enhancements ─────────────────────────── (after 2, uses UTM display)
Phase 4: Follow-Up & Rescheduling Overhaul ───────────────────── (after 2+3, UTMs on links)
Phase 5: No-Show Management ──────────────────────────────────── (after 4, shares follow-up/reschedule)
Phase 6: Event Type Field Mappings ───────────────────────────── (after 2, uses pipeline UTM infra)
Phase 7: Lead Identity Resolution ────────────────────────────── (after 6, uses field mappings)
Phase 8: Lead Manager ───────────────────────────────────────── (after 7, uses identifiers)
Phase 9: Lead-to-Customer Conversion ─────────────────────────── (after 8, uses lead manager)
Phase 10: Closer Unavailability & Workload Redistribution ────── (after 3, independent)
```

---

### Phase 1 — Form Handling Modernization
**Feature Area:** J
**Testable outcome:** Existing forms use React Hook Form + Zod with inline validation errors. No functional change — same features, better UX.

| What to build | Details |
|---------------|---------|
| **Dependencies** | `react-hook-form`, `@hookform/resolvers`, `zod` (add to project) |
| **shadcn Form component** | Add `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage` |
| **Migrate: Payment Form Dialog** | 5 fields + file upload → Zod schema + RHF. Inline validation for amount > 0, required currency/provider |
| **Migrate: Invite User Dialog** | 4 fields + conditional Calendly member select → Zod schema with conditional validation |
| **Migrate: Follow-Up Dialog** | Keep current state-machine UI, wrap the idle state's generate action in RHF if needed |
| **Migrate: Mark Lost Dialog** | Simple — reason textarea with RHF |
| **Migrate: Role Edit Dialog** | Simple — single select with RHF |

**How to test:**
- Open each dialog, submit with invalid data → see inline field errors (not just toasts)
- Submit with valid data → same behavior as before
- Check that disabled/loading states still work during submission
- Verify file upload still works in payment form

---

### Phase 2 — UTM Tracking & Attribution
**Feature Area:** G (G1, G2, G3, G5)
**Testable outcome:** Pipeline extracts and stores UTMs from Calendly webhooks. Meeting records have `utmParams`. Backfill note documented.

| What to build | Details |
|---------------|---------|
| **Schema** | Add `utmParams` field to `meetings` and `opportunities` tables |
| **Pipeline change** (`inviteeCreated.ts`) | Extract `tracking` object from invitee payload, store on meeting and opportunity |
| **Migration** | Widen-only — new optional fields, no backfill needed, existing records get `undefined` |
| **No frontend yet** | UTM display card is Phase 3. This phase is backend-only + verifiable via Convex dashboard |

**How to test:**
- Trigger a Calendly booking with UTM params on the URL (`?utm_source=test&utm_medium=manual`)
- Check the webhook fires, pipeline processes it
- Inspect the meeting and opportunity documents in Convex dashboard → `utmParams` should be populated
- Trigger a booking without UTMs → `utmParams` should be `undefined`
- Verify existing meetings are unaffected (no migration errors)

---

### Phase 3 — Meeting Detail Enhancements
**Feature Area:** I (I1, I2, I3, I4, I5, I6)
**Testable outcome:** Meeting detail page shows payment proof files, UTM attribution card, richer notes, and meeting outcome tags.

| What to build | Details |
|---------------|---------|
| **Deal Won card** (I1) | When opportunity is `payment_received`: show payment amount, currency, provider, reference, proof file, recorded date. Uses existing `getPaymentProofUrl` query |
| **Proof File Display** (I2) | Call `getPaymentProofUrl`, render image thumbnail or PDF download link. Lightbox for images |
| **UTM Attribution card** (I4) | New card component. If `utmParams` exists on meeting → show source/medium/campaign/term/content. If empty → "Direct booking" |
| **Meeting outcome tags** (I6) | Add `meetingOutcome` field to meetings schema. Structured dropdown on meeting detail (Interested / Needs more info / Price objection / Not qualified / Ready to buy). Separate from freeform notes |
| **Richer notes** (I6) | Add "Last saved at" timestamp display. Keep auto-save behavior |
| **Schema** | Add `meetingOutcome` to `meetings` table |
| **Backend** | New mutation: `updateMeetingOutcome`. Extend `getMeetingDetail` to return payment proof URL |

**How to test:**
- Record a payment with proof file upload on a meeting → navigate to that meeting → see the Deal Won card with amount and clickable proof file
- Upload an image proof → see thumbnail. Upload a PDF → see download link
- Book a meeting with UTMs (from Phase 2) → open meeting detail → see Attribution card
- Open any meeting → set a meeting outcome tag → refresh → tag persists
- Edit notes → see "Last saved at" timestamp update

---

### Phase 4 — Follow-Up & Rescheduling Overhaul
**Feature Area:** A (A1, A2, A3)
**Testable outcome:** Follow-up dialog has two paths (send scheduling link / set reminder). Scheduling links use the closer's personal Calendly event type with UTM params. Closer dashboard has a Reminders section.

| What to build | Details |
|---------------|---------|
| **Schema** | Add `type`, `reminderMethod`, `reminderScheduledAt`, `reminderNote`, `completedAt` to `followUps` table. Add `personalEventTypeUri` to `users` table |
| **Personal event type assignment** | Admin UI in Team settings to assign a Calendly event type as a closer's personal calendar link. Dropdown populated from tenant's `eventTypeConfigs`. Stored on `users.personalEventTypeUri` |
| **Follow-up dialog redesign** (A3) | Two-card selection UI: "Send Link" vs "Set Reminder" |
| **Manual Reminder path** (A1) | Form: reminder method (call/text), date/time picker, optional note. Creates followUp with `type: "manual_reminder"` |
| **Enhanced scheduling link path** (A2) | Reads closer's `personalEventTypeUri` → builds Calendly URL with UTM params (`utm_source=ptdom`, `utm_medium=follow_up`, `utm_campaign={oppId}`, etc.). If no personal event type → show error asking admin to assign one |
| **Reminders UI** | New "Reminders" section on closer dashboard. Lists pending reminders with: lead name, phone (prominent), method (call/text), scheduled time, note. Visual escalation (amber → red) when due. "Mark Complete" button logs that the closer performed the outreach |
| **Reminders query** | `getMyPendingReminders` query — closer's dashboard subscribes via `useQuery`. Client-side interval (reuses `useMeetingStartWindow` pattern) compares `reminderScheduledAt` vs `Date.now()` for visual escalation (normal → amber when due → red when overdue). No cron needed — Convex subscriptions keep it reactive. |
| **Pipeline enhancement** (G3) | In `inviteeCreated.ts`: check `utm_source === "ptdom"` before creating new opportunity. If match → extract `utm_campaign` as opportunityId → link to existing opportunity |
| **Link expiry cron** | `expire-follow-up-links` cron (1 hr). Pending scheduling_link follow-ups older than 7 days → expired |

**How to test:**
- As admin: go to Team → assign a personal event type to a closer
- As closer: open a meeting in `in_progress` → click "Schedule Follow-up" → see two options
- Choose "Send Link" → get a URL pointing to the closer's personal Calendly → inspect URL has UTM params → copy and open → book as lead → Calendly webhook fires → verify the new meeting lands on the **same** opportunity (not a new one)
- Choose "Set Reminder" for "Call" in 2 minutes → see it appear in the Reminders section on the dashboard → wait → card turns amber → click "Mark Complete" → follow-up transitions to `completed` with timestamp
- Test without personal event type assigned → "Send Link" shows error message
- From a `canceled` or `no_show` opportunity → follow-up dialog should also be available

---

### Phase 5 — No-Show Management
**Feature Area:** B (B1, B2, B3)
**Testable outcome:** No-show meetings show action bar with confirm/reschedule/follow-up options. Reschedule links use UTMs. Pipeline detects automatic reschedules.

| What to build | Details |
|---------------|---------|
| **No-Show Action Bar** (B1) | New UI on meeting detail when status is `no_show`: "Confirm No-Show", "Request Reschedule", "Schedule Follow-Up" |
| **Confirm No-Show** (B1) | Simple acknowledgment — no state change needed beyond what Calendly already set. Captures PostHog event |
| **Request Reschedule** (B2) | Generates same-closer scheduling link with no-show-specific UTMs (`utm_medium=noshow_resched`, `utm_content={originalMeetingId}`) |
| **Schema** | Add `rescheduledFromMeetingId` to `meetings` table |
| **Reschedule chain display** (I3) | On meeting detail: if `rescheduledFromMeetingId` exists, show "This is a reschedule of [meeting] → [View]" |
| **Automatic reschedule detection** (B3) | Pipeline heuristic: on `invitee.created`, if no UTM match, check if same-email lead has a `no_show`/`canceled` opportunity within 14 days → link to existing opportunity. If the new booking has a **different closer** (round-robin assigned a different host), reassign the opportunity to the new closer. |
| **Pipeline priority** | UTM-deterministic (Phase 4) → Heuristic (B3) → Existing follow-up detection → New opportunity |

**How to test:**
- Have Calendly fire a `invitee_no_show.created` webhook → open meeting detail → see No-Show Action Bar with 3 buttons
- Click "Confirm No-Show" → bar updates to confirmed state, PostHog event fires
- Click "Request Reschedule" → get URL with UTMs → book as lead → new meeting appears on same opportunity with `rescheduledFromMeetingId` set → meeting detail shows reschedule chain
- Test automatic detection (same closer): create a no-show, then book the same lead (same email) directly through Calendly → pipeline should link to existing opportunity and log `[Pipeline] auto-reschedule detected`
- Test automatic detection (different closer via round-robin): create a no-show with Closer A, then rebook the same email through the round-robin link → Calendly assigns Closer B → pipeline links to existing opportunity AND reassigns it from Closer A to Closer B → Closer B sees it on their dashboard, Closer A no longer owns it
- Test non-match: book a different lead → should create a new opportunity normally

---

### Phase 6 — Event Type Field Mappings
**Feature Area:** F (F1, F2, F3)
**Testable outcome:** Settings page has a "Field Mappings" tab. Admins can map Calendly form questions to identity fields. Known field keys auto-discover from bookings.

| What to build | Details |
|---------------|---------|
| **Schema** | Add `customFieldMappings` and `knownCustomFieldKeys` to `eventTypeConfigs` |
| **Auto-discovery** (F2) | In `inviteeCreated.ts`: after extracting `questions_and_answers`, collect question keys → union with `eventTypeConfig.knownCustomFieldKeys` → update if new keys found |
| **Settings UI** (F3) | New "Field Mappings" tab in `/workspace/settings`. Read-only list of event types (name from Calendly). "Configure" button per event type opens dialog |
| **Field Mapping Dialog** | Dropdowns populated from `knownCustomFieldKeys`. Select which field is social handle (+ platform type), phone override |
| **Backend** | Mutation: `updateCustomFieldMappings` (admin-only). Query: `getEventTypeConfigs` (already exists, extend to return new fields) |

**How to test:**
- Trigger a few bookings with different Calendly event types that have custom form questions
- Go to Settings → Field Mappings → see event types listed with booking counts and field counts
- Click "Configure" on an event type → dropdown shows the actual question texts from bookings
- Select a question as the social handle field, pick "Instagram" → save
- Trigger another booking for that event type → verify the mapping is stored (check Convex dashboard)
- The extraction itself is tested in Phase 7 — this phase just validates the config UI works

---

### Phase 7 — Lead Identity Resolution
**Feature Area:** E (E1, E2, E3, E4)
**Testable outcome:** Pipeline extracts social handles using field mappings. Leads get multi-identifier records. Potential duplicates are flagged.

| What to build | Details |
|---------------|---------|
| **Schema** | New `leadIdentifiers` table. Add `status` (`active`/`converted`/`merged`), `mergedIntoLeadId`, `socialHandles` to `leads` |
| **Identifier creation** | On lead create/update in pipeline: create `leadIdentifier` records for email (always), phone (if present), social handle (if field mapping configured for this event type) |
| **Social handle extraction** (E2) | In `inviteeCreated.ts`: load `eventTypeConfig.customFieldMappings` → find the mapped question in `questions_and_answers` → normalize the value (E4 rules) → create `leadIdentifier` |
| **Normalization** (E4) | Utility function: strip `@`, handle `instagram.com/username` URLs, E.164 phone formatting |
| **Identity resolution** (E3) | Before creating a new lead: check `leadIdentifiers` for email match (current), then social handle match, then phone match. If match found → merge into existing lead |
| **Duplicate flagging** | If partial match (name similarity + partial identifier) → set `potentialDuplicateLeadId` on the opportunity → surface as banner on meeting detail |
| **Schema** | Add `potentialDuplicateLeadId` to `opportunities` |
| **Meeting detail banner** | If opportunity has `potentialDuplicateLeadId` → show "This lead might be the same as [Name]. [Review]" |

**How to test:**
- Configure a social handle field mapping for an event type (Phase 6)
- Book a meeting where the lead enters `@johndoe` as their Instagram → check `leadIdentifiers` table has a record with `type: "instagram"`, `value: "johndoe"`
- Book another meeting with a different email but the same Instagram handle `@johndoe` → pipeline should resolve to the **same lead** (not create a duplicate)
- Book with `instagram.com/johndoe` → normalizes to `johndoe` → same lead
- Book with a different email, different social, but similar name → new lead created, but opportunity gets `potentialDuplicateLeadId` → meeting detail shows duplicate banner
- Verify existing leads (no identifiers) still work normally

---

### Phase 8 — Lead Manager
**Feature Area:** C (C1, C2, C3, C4, C5)
**Testable outcome:** `/workspace/leads` route with searchable lead list, `/workspace/leads/[leadId]` detail page (opens in new tab) with 5 tabs, and `/workspace/leads/[leadId]/merge` page for direct lead merge (all roles) with full audit trail.

| What to build | Details |
|---------------|---------|
| **Route & page** (C1) | `/workspace/leads` page + client component. New sidebar nav item |
| **Lead list** | Paginated table: name, email, social handles, status, meeting count. Filterable by status, sortable |
| **Lead search** (C3) | Debounced search across name, email, social handles, phone |
| **Lead detail page** (C2) | Full page at `/workspace/leads/[leadId]` (opens in new tab from list). Tabs: Overview, Meetings, Opportunities, Activity, Custom Fields |
| **Permissions** (C4) | New permissions: `lead:view-all`, `lead:edit`, `lead:create`, `lead:delete`, `lead:merge`, `lead:export`. Backend enforcement via `requireTenantUser` |
| **Lead merge** (C5) | All roles can merge directly. Merge dialog: search for target lead → side-by-side preview → confirm. Repoints opportunities, consolidates identifiers, soft-deletes source lead. Every merge recorded in `leadMergeHistory` for admin audit |
| **Schema** | New `leadMergeHistory` table for audit trail |
| **Backend** | Queries: `listLeads`, `searchLeads`, `getLeadDetail`, `getMergePreview`. Mutations: `updateLead`, `mergeLead`, `dismissDuplicateFlag` |

**How to test:**
- Navigate to `/workspace/leads` → see all leads for the tenant with search bar
- Search by name → results filter. Search by Instagram handle → results filter
- Click a lead → sheet opens with tabs. Meetings tab shows all meetings across opportunities
- As any role: click "Merge Lead" → search for another lead → see preview → confirm → source lead disappears from list, target lead gains all opportunities and identifiers
- As admin: open a lead → Activity tab shows merge history with who merged what and when
- Verify closers can merge but cannot edit lead info (read-only fields + merge only)

---

### Phase 9 — Lead-to-Customer Conversion
**Feature Area:** D (D1, D2, D3, D4)
**Testable outcome:** Payment recording auto-converts leads to customers. `/workspace/customers` shows customer list with relationship links.

| What to build | Details |
|---------------|---------|
| **Schema** | New `customers` table. Add `customerId` (optional) to `paymentRecords` + new `by_customerId` index. Make `opportunityId`/`meetingId` optional on `paymentRecords` for post-conversion payments. |
| **Auto-conversion** (D2) | Extend `logPayment` mutation: after transitioning opportunity to `payment_received`, check if customer exists for this lead → if not, create customer record with denormalized data, update lead status to `converted`, backfill `customerId` on all existing payment records for this lead |
| **Manual conversion** (D2) | Admin action from Lead Manager: conversion dialog with pre-filled data |
| **Customer list page** (D3) | `/workspace/customers` route. Minimal list: name, email, converted date, computed total paid (aggregated from payment records), program, status |
| **Customer detail sheet** (D3) | Click to open sheet: customer info, linked lead, winning opportunity, payment history (all records with this `customerId`), record new payment button |
| **Post-conversion payments** | Payment form accessible from customer detail — records payment with `customerId` set, no meeting/opportunity required |
| **Relationship navigation** (D4) | Every entity ID is a clickable link: Customer → Lead (Lead Manager), Customer → Opportunity (Pipeline), Customer → Meeting (Meeting detail) |
| **Permissions** | New: `customer:view-all`, `customer:view-own`, `customer:edit` |
| **Backend** | Queries: `listCustomers`, `getCustomerDetail`, `getCustomerTotalPaid` (computed from payment records). Mutations: `convertLeadToCustomer`, `updateCustomerStatus`, `recordCustomerPayment` |

**How to test:**
- Record a payment on a meeting → opportunity goes to `payment_received` → check that a customer record was created automatically
- Verify the payment record now has `customerId` set (backfilled)
- Navigate to `/workspace/customers` → see the new customer with computed total matching the payment amount
- Click the customer → sheet opens → payment history shows the payment → click lead link → goes to Lead Manager. Click opportunity → goes to pipeline. Click meeting → goes to meeting detail
- Verify lead's status changed to `converted` in the Lead Manager
- Record another payment for a returning customer (same lead, different opportunity) → customer's computed total increases (sum of all payment records)
- From the customer detail sheet → click "Record Payment" → enter a payment plan installment (no meeting/opportunity required) → payment appears in history, total updates
- As admin: open a lead in Lead Manager → manually convert to customer via dialog
- Verify closers can see their own customers (`customer:view-own`) but not all (`customer:view-all` is admin-only)

---

### Phase 10 — Closer Unavailability & Workload Redistribution
**Feature Area:** H (H1, H2, H3, H4, H5, H6)
**Testable outcome:** Admins can mark closers unavailable, select redistribution targets, auto-distribute meetings, and manually resolve conflicts.

| What to build | Details |
|---------------|---------|
| **Schema** | New `closerUnavailability` and `meetingReassignments` tables |
| **Mark Unavailable** (H1) | Team page: "Mark Unavailable" action on closer rows. Dialog: date, reason, duration. Creates `closerUnavailability` record |
| **Meeting identification** | On marking unavailable: query meetings for that closer on that date → show summary |
| **Closer selection** (H2) | Checkbox list of other closers with their meeting count and available gaps for that day |
| **Auto-Distribute** (H3) | Distribution algorithm: for each meeting (sorted by time), find available closer with lowest load → assign |
| **Manual Resolution** (H4) | Unassignable meetings presented one-by-one: assign with overlap warning / reschedule (generates link) / cancel |
| **Reassignment execution** (H5) | Update `opportunity.assignedCloserId`. Create `meetingReassignments` audit record. Notify new closer |
| **Permissions** | `closer:mark-unavail`, `meeting:reassign` (admin-only) |
| **Backend** | Queries: `getCloserMeetingsForDate`, `getCloserAvailability`. Mutations: `markCloserUnavailable`, `redistributeMeetings`, `reassignMeeting`. Action: `autoDistribute` |

**How to test:**
- As admin: go to Team → click a closer → "Mark Unavailable" → select today → see their meetings listed
- Select 2 other closers → click "Auto-Distribute" → meetings get assigned based on availability → see summary of assignments
- If any meeting couldn't be assigned → manual resolution dialog appears → assign with warning / reschedule / cancel
- Verify reassigned meetings appear on the new closer's dashboard with "Reassigned" badge
- Verify the original closer's dashboard no longer shows those meetings
- Check `meetingReassignments` table has audit records
- Verify closers cannot mark other closers unavailable (admin-only)

---

### Phase summary

| Phase | Feature | Key deliverable | Depends on |
|-------|---------|----------------|------------|
| 1 | Form Handling | RHF + Zod on all existing forms | — |
| 2 | UTM Tracking | Pipeline extracts & stores UTMs from webhooks | — |
| 3 | Meeting Detail | Deal Won card, proof files, attribution card, outcome tags | 2 |
| 4 | Follow-Up Overhaul | Two follow-up paths, UTM-tagged links, reminders UI, pipeline UTM intelligence | 2, 3 |
| 5 | No-Show Management | No-show action bar, reschedule links, auto-reschedule detection | 4 |
| 6 | Event Type Field Mappings | Settings UI for custom field → identity field mapping | 2 |
| 7 | Lead Identity Resolution | Multi-identifier leads, social handle extraction, duplicate flagging | 6 |
| 8 | Lead Manager | Lead list, search, detail, merge (all roles, direct) | 7 |
| 9 | Customer Conversion | Auto-convert on payment, customer list, relationship navigation | 8 |
| 10 | Workload Redistribution | Mark unavailable, auto-distribute, manual resolution | 3 |

**Parallelization opportunities:**
- Phases 1 and 2 can run in parallel (no dependency between them)
- Phase 6 can start as soon as Phase 2 is done, in parallel with Phases 3-5
- Phase 10 can start as soon as Phase 3 is done, in parallel with Phases 6-9

```
Time →
       ┌─────┐
    1  │Forms│
       └─────┘
       ┌─────┐   ┌───┐   ┌──────────┐   ┌────────┐
    2  │ UTM │──→│ 3 │──→│ 4 Follow  │──→│ 5 No   │
       └─────┘   │Det│   │ Up Ovrhul │   │ Show   │
          │      └───┘   └──────────┘   └────────┘
          │        │
          │        └──→┌─────┐
          │            │ 10  │
          │            │Redis│
          │            └─────┘
          │
          └──→┌─────┐   ┌─────┐   ┌──────┐   ┌─────┐
              │6 Fld│──→│7 ID │──→│8 Lead│──→│9 Cst│
              │ Map │   │ Res │   │ Mgr  │   │ Cnv │
              └─────┘   └─────┘   └──────┘   └─────┘
```

Each phase will have its own design document under `plans/v0.5/<feature>/design.md` with detailed sub-phases when implementation begins.

---

## Appendix A — State Machine Updates

### Opportunity Status (v0.5)

```
                    ┌──────────────┐
           ┌───────│  scheduled   │───────┐
           │       └──────┬───────┘       │
           │              │               │
           ▼              ▼               ▼
    ┌──────────┐  ┌──────────────┐  ┌──────────┐
    │ canceled │  │ in_progress  │  │ no_show  │
    └────┬─────┘  └──┬───┬───┬──┘  └────┬─────┘
         │           │   │   │           │
         │           ▼   │   ▼           │
         │    ┌──────┐   │ ┌──────┐     │
         │    │ lost │   │ │ won  │     │
         │    └──────┘   │ └──────┘     │
         │               │              │
         └───────┬───────┘──────┬───────┘
                 ▼              │
         ┌──────────────┐      │
         │ follow_up_   │──────┘
         │ scheduled    │→ back to "scheduled"
         └──────────────┘
```

### Meeting Status (v0.5 — no changes)

```
scheduled → in_progress → completed
                       → canceled
                       → no_show
```

### Lead Status (new)

```
active → converted (via payment + customer creation)
active → merged (via lead merge)
```

### Follow-Up Status (v0.5)

```
pending → booked (lead scheduled via link)
pending → completed (closer completed manual reminder)
pending → expired (time-based expiry)
```

---

## Appendix B — Route Changes

### New Routes

| Route | Purpose | Access |
|-------|---------|--------|
| `/workspace/leads` | Lead Manager list | All roles |
| `/workspace/leads/[leadId]` | Lead detail — full page (opens in new tab from list) | All roles |
| `/workspace/leads/[leadId]/merge` | Merge flow — full page (search → preview → confirm) | All roles |
| `/workspace/customers` | Customer list (placeholder) | Admin/Owner |
| `/workspace/team/schedule` | Closer availability management | Admin/Owner |

### Modified Routes

| Route | Change |
|-------|--------|
| `/workspace/closer/meetings/[id]` | Enhanced meeting detail, no-show actions, deal won card, attribution card |
| `/workspace/settings` | New tab: "Field Mappings" — CRM overlays on read-only Calendly event types (social handle mapping, phone override). No event type management. |
| `/workspace/team` | "Mark Unavailable" action on closer rows, redistribution flow |

---

## Appendix C — Cron Jobs (New)

| Job | Interval | Purpose |
|-----|----------|---------|
| `expire-follow-up-links` | 1 hour | Check `followUps` with `type: "scheduling_link"` where `status === "pending"` and `createdAt < now - 7 days` → transition to `expired` |
| ~~`detect-stale-merge-suggestions`~~ | ~~24 hours~~ | ~~Removed — no suggestion pipeline. All merges are direct.~~ |

> **Note:** Reminders do NOT use a cron. The closer's dashboard subscribes to pending reminders via `useQuery` and the client handles time-based visual escalation locally — same pattern as `useMeetingStartWindow`.

---

## Appendix D — Analytics Events (New)

| Event | Properties | Trigger |
|-------|-----------|---------|
| `follow_up_reminder_set` | `{ method, scheduledAt, opportunityId }` | Closer sets a manual reminder |
| `follow_up_reminder_completed` | `{ opportunityId, method }` | Closer marks reminder done |
| `no_show_confirmed` | `{ meetingId, opportunityId }` | Closer confirms no-show |
| `no_show_reschedule_requested` | `{ meetingId, opportunityId }` | Closer requests no-show reschedule |
| `lead_merged` | `{ sourceLeadId, targetLeadId, identifierCount }` | Lead merge executed |
| `lead_merge_suggested` | `{ sourceLeadId, targetLeadId }` | Closer suggests merge |
| `lead_converted_to_customer` | `{ leadId, customerId, amount }` | Lead becomes customer |
| `closer_marked_unavailable` | `{ closerId, date, reason }` | Admin marks closer unavailable |
| `meetings_redistributed` | `{ count, autoAssigned, manualResolution }` | Workload redistribution completed |
| `potential_duplicate_detected` | `{ leadId, matchType }` | Pipeline detects possible duplicate |
| `auto_reschedule_linked` | `{ meetingId, originalMeetingId }` | Pipeline auto-links reschedule |
