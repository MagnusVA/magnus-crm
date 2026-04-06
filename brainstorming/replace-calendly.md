# Replacing Calendly: What Would It Really Take?

> **Date:** 2026-04-05
> **Status:** Aspirational / Research
> **Context:** Magnus CRM depends on Calendly for scheduling, round-robin closer assignment, calendar sync, video links, and email notifications. This doc explores replacing it entirely.

---

## Table of Contents

1. [What Calendly Does For Us Today](#1-what-calendly-does-for-us-today)
2. [What We Already Have](#2-what-we-already-have)
3. [The Seven Pillars of a Replacement](#3-the-seven-pillars-of-a-replacement)
4. [Pillar Deep-Dives](#4-pillar-deep-dives)
5. [Build vs. Buy Matrix](#5-build-vs-buy-matrix)
6. [Effort Estimates](#6-effort-estimates)
7. [Risk Assessment](#7-risk-assessment)
8. [Recommended Approach](#8-recommended-approach)
9. [Open Questions](#9-open-questions)

---

## 1. What Calendly Does For Us Today

| Function | How It Works |
|---|---|
| **Booking pages** | Calendly hosts public scheduling pages; leads pick a time slot |
| **Availability engine** | Reads each closer's connected calendars, computes open slots |
| **Round-robin assignment** | Distributes bookings across closers; we just read who got assigned from `event_memberships[0].user` in the webhook |
| **Calendar sync (read)** | Checks Google/Outlook/Apple calendars for conflicts |
| **Calendar sync (write)** | Creates calendar events on the closer's calendar when booked |
| **Video conferencing** | Auto-generates Zoom/Google Meet/Teams links attached to events |
| **Email notifications** | Sends confirmation, reminder (24h, 1h), cancellation, and reschedule emails to leads and closers |
| **Webhook events** | Pushes `invitee.created`, `invitee.canceled`, `invitee_no_show.created` to our pipeline in real-time |
| **Timezone handling** | Auto-detects lead timezone, displays slots accordingly |
| **Routing forms** | Embeddable qualification forms before booking |

**Key insight:** Calendly is not just a scheduler. It's a calendar aggregator, email sender, video link generator, availability engine, and booking UI all in one. That's a lot of surface area.

---

## 2. What We Already Have

Our Convex + Next.js 16 stack already provides a solid foundation:

| Capability | Status | Notes |
|---|---|---|
| Multi-tenant data model | **Done** | `tenants`, `users`, `leads`, `opportunities`, `meetings` with tenant isolation |
| Meeting lifecycle tracking | **Done** | `scheduled` -> `in_progress` -> `completed`/`canceled`/`no_show` |
| Webhook processing pipeline | **Done** | Event dispatcher with idempotency, raw event audit trail in `rawWebhookEvents` |
| OAuth token management | **Done** | PKCE flow, single-use refresh rotation, distributed locking, rate-limit backoff. **Reusable** for Google/Microsoft OAuth |
| User/team management | **Done** | WorkOS AuthKit with `tenant_master`, `tenant_admin`, `closer` roles |
| Closer dashboard & calendar views | **Done** | Day/week/month views, pipeline page, featured meeting card |
| Real-time subscriptions | **Done** | Convex gives us this for free |
| Event type configuration | **Done** | Config table with payment links, `roundRobinEnabled` flag (stored but unused) |
| Date/time libraries | **Done** | `date-fns`, `react-day-picker` already in deps |
| Cron infrastructure | **Done** | Convex crons for token refresh, org member sync |
| Scheduled functions | **Done** | `ctx.scheduler.runAt()` for future task execution |

**We have ~40% of the infrastructure already.** The hardest parts to build are the availability engine, calendar provider integrations, and the public booking UI.

---

## 3. The Seven Pillars of a Replacement

```
                          Lead visits booking page
                                    |
                                    v
                    +----------------------------+
                    |   1. BOOKING UI            |  Public scheduling pages
                    |      (Next.js routes)      |  /book/[tenant]/[eventType]
                    +----------------------------+
                                    |
                                    v
                    +----------------------------+
                    |   2. AVAILABILITY ENGINE   |  Compute open slots from
                    |      (Convex functions)    |  calendar data + business rules
                    +----------------------------+
                            |               |
                            v               v
            +--------------------+   +--------------------+
            | 3. CALENDAR SYNC   |   | 4. ROUND-ROBIN     |
            |    (Read + Write)  |   |    DISTRIBUTION    |
            +--------------------+   +--------------------+
            | Google Calendar    |   | Fair distribution   |
            | Outlook / O365     |   | Weight/capacity     |
            | Apple Calendar     |   | Availability-aware  |
            +--------------------+   +--------------------+
                                    |
                                    v
                    +----------------------------+
                    |   5. VIDEO CONFERENCING    |  Auto-generate meeting links
                    |      (Zoom / Daily / Meet) |  on booking
                    +----------------------------+
                                    |
                                    v
                    +----------------------------+
                    |   6. EMAIL NOTIFICATIONS   |  Confirmations, reminders,
                    |      (Resend)              |  cancellations, reschedules
                    +----------------------------+
                                    |
                                    v
                    +----------------------------+
                    |   7. INTERNAL EVENTS       |  Replace Calendly webhooks
                    |      (Already built)       |  with direct Convex mutations
                    +----------------------------+
```

---

## 4. Pillar Deep-Dives

### Pillar 1: Booking UI

**What Calendly provides:** Hosted, polished, mobile-responsive scheduling pages with timezone auto-detection, date grid -> slot selection flow, custom intake forms, embed modes (inline, popup, widget), and branded theming.

**What we'd build:**

Public Next.js routes (no auth required), one per tenant + event type:
- `/book/[tenantSlug]/[eventTypeSlug]`

Multi-step booking flow:
1. Calendar date picker (we already have `react-day-picker`)
2. Available time slot grid for selected date
3. Lead info form (name, email, phone, custom fields from `eventTypeConfigs`)
4. Confirmation screen with calendar download (.ics) and Zoom link

Additional considerations:
- Timezone detection via `Intl.DateTimeFormat().resolvedOptions().timeZone` + manual override
- Mobile-responsive (Tailwind + shadcn handles this)
- Optional embed via `<iframe>` or lightweight JS snippet
- Tenant branding (logo, colors) from tenant config

**Complexity:** Medium. The UI is well-understood; computing which slots to show is the hard part.

**Reference:** Cal.com's open-source booking UI (MIT-licensed) for inspiration.

---

### Pillar 2: Availability Engine

**This is the hardest part.** This is where Calendly earns most of its money.

#### Business rules to support:
- Working hours per closer (e.g. Mon-Fri 9am-5pm in their timezone)
- Buffer time between meetings (e.g. 15 min before/after)
- Minimum scheduling notice (e.g. can't book less than 2 hours from now)
- Maximum days in advance (e.g. only show next 30 days)
- Meeting duration (30 min, 60 min, etc.)
- Daily/weekly meeting caps per closer
- Date-specific overrides (vacation days, special hours)

#### Conflict detection:
- Check ALL connected calendars for existing events
- Handle all-day events, tentative events, recurring events
- Multi-calendar merge (personal + work calendar)

#### Slot computation algorithm (simplified):

```
for each day in booking window:
  for each closer in round-robin pool:
    get working hours for this day (check overrides first, then weekly schedule)
    get all calendar events for this day (from synced calendarEvents table)
    subtract events (+ buffer) from working hours
    generate available slots at meeting-duration intervals
    apply minimum notice rule
    apply daily/weekly cap rules

merge slots based on round-robin mode:
  - "any available" → union of all closers' slots (at least one closer free)
  - "all must be free" → intersection (for group meetings)

return slots grouped by date, sorted by time
```

#### New schema:

```typescript
// availabilityRules - per closer, optionally per event type
{
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  eventTypeConfigId?: Id<"eventTypeConfigs">,  // optional per-event override
  timezone: string,                             // "America/New_York"
  weeklySchedule: {
    monday: { start: "09:00", end: "17:00" } | null,  // null = unavailable
    tuesday: { start: "09:00", end: "17:00" } | null,
    // ...
  },
  dateOverrides: [
    { date: "2026-04-10", start: "10:00", end: "14:00" },
    { date: "2026-04-11", available: false },  // day off
  ],
  bufferBefore: number,    // minutes
  bufferAfter: number,     // minutes
  minimumNotice: number,   // minutes
  maxDaysInAdvance: number,
  dailyCap: number | null,
  weeklyCap: number | null,
}

// calendarEvents - synced from external providers
{
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  calendarConnectionId: Id<"calendarConnections">,
  externalEventId: string,
  title: string,
  startTime: number,        // epoch ms, UTC
  endTime: number,
  isAllDay: boolean,
  status: "confirmed" | "tentative" | "cancelled",
  recurrenceRule?: string,  // iCal RRULE
  lastSyncedAt: number,
}
```

**Complexity:** HIGH. Calendar math with timezone edge cases, DST transitions, recurring event expansion. A single bug means double-bookings or phantom availability.

---

### Pillar 3: Calendar Integration (Read + Write)

Three providers, three completely different APIs.

#### Google Calendar
- **Auth:** OAuth 2.0 (our PKCE pattern from Calendly OAuth is directly reusable)
- **API:** Google Calendar API v3
- **Read:** `events.list` with `timeMin`/`timeMax` for conflict checking
- **Write:** `events.insert` to create meeting events with attendees
- **Watch:** `events.watch` for push notifications when calendar changes
- **Scopes:** `calendar.readonly` (minimum) or `calendar.events` (read+write)
- **SDK:** `googleapis` npm package
- **Gotchas:** Watch channels expire after ~7 days, need renewal cron. Recurring event expansion via `singleEvents=true` parameter. Rate limit: generous (1M queries/day).

#### Microsoft Outlook / Office 365
- **Auth:** OAuth 2.0 via Microsoft Identity Platform (MSAL)
- **API:** Microsoft Graph API v1.0
- **Read:** `GET /me/calendarView` with date range (auto-expands recurring events)
- **Write:** `POST /me/events` to create events
- **Watch:** `subscriptions` API for change notifications (max 3-day lifetime!)
- **Scopes:** `Calendars.ReadWrite`
- **SDK:** `@microsoft/microsoft-graph-client`
- **Gotchas:** Subscription renewal every 3 days is mandatory. Token refresh flow differs from Google. Free/busy model is different from Google's event-based model.

#### Apple Calendar (iCloud)
- **Auth:** App-specific passwords or CalDAV with limited OAuth
- **API:** CalDAV protocol (XML-based, not REST)
- **Read:** `REPORT` method with `calendar-query` in XML
- **Write:** `PUT` with iCalendar (.ics) format
- **Watch:** **No push notifications** — must poll
- **SDK:** No official SDK. Would use `tsdav` or `ical.js`
- **Gotchas:** Apple CalDAV is notoriously unreliable, poorly documented, and rate-limited. Most scheduling tools either skip it or tell users to connect their Apple Calendar to Google and sync that way.

#### New schema:

```typescript
// calendarConnections - per user, per provider
{
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  provider: "google" | "microsoft" | "apple",
  accessToken: string,          // encrypted
  refreshToken: string,         // encrypted
  tokenExpiresAt: number,
  email: string,
  calendarId: string,           // which calendar to read/write
  syncToken?: string,           // incremental sync cursor (Google)
  subscriptionId?: string,      // webhook subscription ID
  subscriptionExpiresAt?: number,
  lastSyncedAt: number,
  status: "active" | "needs_reauth" | "disconnected",
}
```

#### Sync strategy:
1. **Initial sync:** Fetch all events in +-60 day window on connection
2. **Incremental sync:** Sync tokens (Google) or delta queries (Microsoft) for changes only
3. **Push notifications:** Register webhooks for real-time change detection
4. **Fallback polling:** Cron every 15 minutes as safety net
5. **Write-back:** After booking, create event on closer's calendar with Zoom link, lead info, CRM deep-link

**Complexity:** HIGH per provider. Google is the most straightforward, Microsoft is moderate, Apple is painful.

**Strong recommendation:** Ship with Google only first. Add Microsoft second. Consider skipping Apple entirely (tell users to sync Apple Calendar to Google instead).

---

### Pillar 4: Round-Robin Distribution

We currently just read who Calendly assigned from the webhook. To own this:

#### Enhanced schema:

```typescript
// Extended eventTypeConfigs
{
  // ...existing fields
  roundRobinMode: "round_robin" | "availability_weighted" | "manual",
  roundRobinPool: Id<"users">[],
  roundRobinWeights: Record<string, number>,  // userId → weight multiplier
  equalDistribution: boolean,
}

// roundRobinState - tracks assignment pointer
{
  tenantId: Id<"tenants">,
  eventTypeConfigId: Id<"eventTypeConfigs">,
  lastAssignedIndex: number,
  assignmentCounts: Record<string, number>,
  windowStartedAt: number,
}
```

#### Algorithm:
1. Compute available slots — determine which closers in the pool are free at each time
2. For "any available" mode: show the union (at least one closer free at that time)
3. When lead books: assign to next available closer in rotation
   - Simple RR: increment pointer, skip if unavailable at that time
   - Weighted: bias toward closers with higher weight
   - Equal distribution: prefer the closer with fewest meetings this window
4. Atomic state update via Convex mutation (no race conditions)

**Complexity:** Medium. The logic itself is simple. Integration with the availability engine is the tricky part.

**Good news:** We already have `roundRobinEnabled` on `eventTypeConfigs` and the event type config table is extensible.

---

### Pillar 5: Video Conferencing

#### Option A: Zoom API (recommended start)
- **Auth:** OAuth 2.0 (server-to-server or per-user)
- **Create meeting:** `POST /users/{userId}/meetings` → returns `join_url` + `start_url`
- **SDK:** Direct REST or `@zoom/rivet`
- **Pricing:** Free with a Zoom account
- **Effort:** 1-2 weeks
- **Gotchas:** Requires Zoom Marketplace app approval for distribution

#### Option B: Daily.co
- **Auth:** API key (simpler than Zoom)
- **Create room:** `POST /rooms` → returns meeting URL (works in browser, no app needed)
- **SDK:** `@daily-co/daily-js` for embedded video
- **Pricing:** Free up to 200 participant-minutes/day, then $0.004/min
- **Effort:** 1 week
- **Pro:** Simpler than Zoom, browser-native, no app install for leads

#### Option C: Google Meet (free with Google Calendar)
- **How:** When creating a Google Calendar event, set `conferenceDataVersion=1` to auto-generate a Meet link
- **Pricing:** Free with Google Workspace
- **Effort:** Minimal (comes with Google Calendar write integration)
- **Con:** Only works for closers with Google Calendar connected

#### Option D: Twilio Video (full custom)
- **Auth:** API key + secret
- **Create room:** Programmatic room creation + access token generation
- **SDK:** `twilio` + `twilio-video` client SDK
- **Pricing:** $0.004/participant/minute
- **Effort:** 2-3 weeks (you own the entire video UI)
- **Pro:** Full control over the experience
- **Con:** Much more work — build recording, screen share, layout, etc.

**Recommendation:** Start with **Zoom** (closers already expect it, leads are familiar). Get **Google Meet for free** when Google Calendar is connected. Consider **Daily.co** as the Zoom-less fallback. Skip Twilio unless there's a specific need for a fully custom video experience.

#### New schema:

```typescript
// videoConferenceConnections
{
  tenantId: Id<"tenants">,
  userId: Id<"users">,
  provider: "zoom" | "google_meet" | "teams",
  accessToken: string,
  refreshToken: string,
  tokenExpiresAt: number,
  externalUserId?: string,
  status: "active" | "needs_reauth" | "disconnected",
}
```

---

### Pillar 6: Email Notifications

#### What Calendly sends:
1. **Booking confirmation** → lead + closer (immediate)
2. **Reminder** → lead + closer (24h before, 1h before)
3. **Cancellation** → lead + closer (immediate)
4. **Reschedule** → lead + closer (immediate)
5. **Follow-up** → configurable post-meeting (optional)

#### Provider recommendation: Resend

Already called out in PRODUCT.md as a Phase 2 candidate. Fits our stack perfectly:
- Modern API, great TypeScript DX
- **React Email** for templating (JSX email templates — same mental model as our UI)
- Free up to 3k emails/month, then $20/mo for 50k
- Great deliverability out of the box

#### Implementation:

```
/emails/
  booking-confirmation.tsx    ← React Email template
  meeting-reminder.tsx
  cancellation-notice.tsx
  reschedule-notice.tsx
  follow-up.tsx
```

Reminders via Convex scheduled functions:
```typescript
// At booking time, schedule reminders:
ctx.scheduler.runAt(meetingTime - 24 * 60 * 60 * 1000, internal.emails.sendReminder, {
  meetingId, type: "24h"
})
ctx.scheduler.runAt(meetingTime - 60 * 60 * 1000, internal.emails.sendReminder, {
  meetingId, type: "1h"
})

// On cancellation, cancel the scheduled reminders
```

#### New schema:

```typescript
// emailLog
{
  tenantId: Id<"tenants">,
  recipientEmail: string,
  recipientType: "lead" | "closer",
  emailType: "booking_confirmation" | "reminder_24h" | "reminder_1h" | "cancellation" | "reschedule",
  meetingId: Id<"meetings">,
  sentAt: number,
  externalMessageId: string,
  status: "sent" | "delivered" | "bounced" | "failed",
}
```

#### Additional considerations:
- SPF/DKIM/DMARC setup for deliverability (domain configuration)
- Domain warming period — new sending domains may hit spam filters initially
- `.ics` calendar attachment generation for confirmation emails

**Complexity:** Low-Medium. Email sending is well-solved. Main work is template design and scheduling/cancellation of reminder emails.

---

### Pillar 7: Internal Events (Already Built)

**Current flow:**
```
Lead books on Calendly → Calendly webhook → signature verification → raw event storage → pipeline processor → DB writes
```

**Post-replacement flow:**
```
Lead books on our page → Convex mutation → DB writes (pipeline logic inline)
```

We **simplify** by removing:
- Webhook HTTP endpoint (`/webhooks/calendly`)
- HMAC-SHA256 signature verification
- Raw webhook event storage (no external events to audit)
- The entire `convex/calendly/` directory (OAuth, tokens, org member sync)
- Calendly-specific cron jobs (token refresh, subscription renewal)

The pipeline handlers (`inviteeCreated`, `inviteeCanceled`, `inviteeNoShow`) become direct function calls within booking/cancellation mutations.

**Complexity:** Low. Mostly deleting code.

---

## 5. Build vs. Buy Matrix

| Component | Build | Buy / Use OSS | Recommendation |
|---|---|---|---|
| Booking UI | Custom Next.js pages | Cal.com (AGPL), Calendso | **Build** — need CRM-specific UX, tight Convex integration |
| Availability engine | Custom Convex functions | Nylas Scheduler ($), Cal.com | **Build** — core logic, must be Convex-native for real-time |
| Google Calendar sync | `googleapis` SDK | Nylas ($0.50/user/mo), Cronofy ($) | **Build** — OAuth pattern already exists, straightforward |
| Microsoft Calendar sync | MS Graph SDK | Nylas, Cronofy | **Build** — but defer to Phase 2 |
| Apple Calendar sync | `tsdav` / CalDAV | Nylas | **Skip or buy** — CalDAV is painful, low ROI |
| Round-robin | Custom Convex mutations | — | **Build** — simple logic, must be atomic with booking |
| Zoom integration | Zoom REST API | — | **Build** — straightforward OAuth + create meeting |
| Email notifications | Resend + React Email | — | **Build** — already planned for Phase 2 |
| Timezone handling | `date-fns-tz` | — | **Build** — leverage existing `date-fns` |

#### Alternative: Nylas as Calendar Abstraction Layer

Nylas provides a unified API across Google, Microsoft, and (partially) Apple calendars:
- $0.50/connected account/month at scale
- Would eliminate ~60% of calendar sync work
- Single auth flow, single event API, single webhook format
- **Trade-off:** new dependency replacing Calendly (but lower-level, more controllable)
- **Worth evaluating** if calendar sync becomes the bottleneck

---

## 6. Effort Estimates

| Pillar | Weeks (1 dev) | Complexity | Dependencies |
|---|---|---|---|
| **1. Booking UI** | 2-3 | Medium | Requires Pillar 2 |
| **2. Availability engine** | 3-4 | **HIGH** | Requires Pillar 3 |
| **3a. Google Calendar sync** | 2-3 | Medium-High | Independent |
| **3b. Microsoft Calendar sync** | 2-3 | Medium-High | Independent |
| **3c. Apple Calendar sync** | 3-4 | **HIGH** | Independent |
| **4. Round-robin** | 1 | Low-Medium | Requires Pillar 2 |
| **5. Video conferencing (Zoom)** | 1-2 | Low-Medium | Independent |
| **6. Email notifications** | 1-2 | Low-Medium | Independent |
| **7. Internal event rewiring** | 0.5 | Low | After all above |
| **Testing, edge cases, polish** | 2-3 | Medium | After all above |
| **Migration & parallel cutover** | 1-2 | Medium | After all above |

### Totals

| Scope | Duration | Coverage |
|---|---|---|
| **MVP (Google + Zoom + Emails)** | **10-14 weeks** | ~80% of use cases |
| **Full parity (+ Microsoft)** | **14-18 weeks** | ~95% of use cases |
| **Everything (+ Apple)** | **18-22 weeks** | ~100% |
| **With Nylas for calendar abstraction** | **8-12 weeks** | ~95%, but adds a dependency |

---

## 7. Risk Assessment

### High Risk

**Availability engine correctness**
Calendar math with timezones, DST transitions, and recurring event expansion is notoriously hard. A single bug means double-bookings or phantom availability. Calendly has spent years hardening this. We'd be starting from scratch.

**Calendar sync reliability**
Google Watch channels expire after ~7 days. Microsoft subscriptions expire after 3 days. Missing a sync event means stale availability → double-bookings. Need robust renewal crons AND fallback polling.

**Email deliverability**
Self-sent emails from a new domain may land in spam initially. Requires proper SPF/DKIM/DMARC setup and a domain warming period (2-4 weeks of gradually increasing volume).

### Medium Risk

**Maintenance burden**
Google and Microsoft regularly change APIs, deprecate endpoints, and update OAuth requirements. Calendly absorbs this for us today. We'd inherit it.

**Concurrent booking race conditions**
Two leads booking the last available slot simultaneously. Convex mutations are serializable, which helps, but the availability check → booking confirmation path needs careful atomic design.

**Scope creep**
"Just one more feature" — rescheduling flow, group meetings, collective availability, buffer customization, meeting caps. Each adds weeks.

### Low Risk

**Booking UI** — Well-understood, we have the component library.
**Round-robin** — Simple state machine, Convex handles atomicity.
**Internal event rewiring** — Net simplification.

### The Hidden Risk: Opportunity Cost

At 10-14 weeks for MVP, this is a **full quarter of development time**. That's time NOT spent on:
- Phase 4 frontend (admin UI — 25 missing pages)
- Phase 6 meeting details & outcome actions
- Payment processing integration
- Analytics & reporting
- Features that directly differentiate the CRM

---

## 8. Recommended Approach

### The honest assessment

**The pragmatic recommendation is to NOT replace Calendly right now.** Here's why:

1. **Cost math doesn't work yet.** Calendly costs ~$12-16/user/month. For 10 closers: $120-160/month. The 10-14 weeks of engineering to replace it costs far more than years of Calendly subscription.

2. **Calendly is battle-tested.** Timezone edge cases, DST, Google/Microsoft API churn, email deliverability, Zoom integration — they maintain all of this for us. That's an ongoing ops burden we don't carry today.

3. **Our round-robin already works.** Calendly manages distribution; we consume the result. It's working.

4. **Higher-priority gaps exist.** Phase 4 frontend, Phase 6, payment processing, and analytics all have more direct user impact.

### When it WOULD make sense

- **Custom routing logic** — If we need qualification-based assignment that Calendly can't do (e.g. "route enterprise leads to senior closers based on company size")
- **Scale economics** — At 100+ closers, Calendly costs $1,200-1,600/month. The math starts working.
- **Deep CRM integration** — Showing different availability based on lead score, opportunity stage, or closer capacity
- **White-label requirement** — If customers need fully branded scheduling with no Calendly mention
- **Reliability issues** — If Calendly becomes unreliable or changes API terms unfavorably

### If we DO build it, the phased plan:

#### Phase A: Foundation (Weeks 1-4)
- Google Calendar OAuth + event sync (read)
- `availabilityRules` schema + closer configuration UI
- Availability engine v1 (single-closer slot computation)
- **Gate:** Can compute correct available slots for one closer from their Google Calendar

#### Phase B: Booking Flow (Weeks 5-8)
- Public booking pages (`/book/[tenant]/[eventType]`)
- Round-robin pool distribution (multi-closer)
- Availability engine v2 (round-robin-aware)
- Google Calendar write-back (create event on booking)
- Zoom meeting auto-creation via API
- **Gate:** Lead can book, closer sees it on Google Calendar with Zoom link

#### Phase C: Notifications (Weeks 9-10)
- Resend + React Email templates
- Booking confirmation emails (lead + closer)
- Reminder scheduling (24h, 1h via `ctx.scheduler.runAt`)
- Cancellation + reschedule emails
- **Gate:** Full email lifecycle working end-to-end

#### Phase D: Polish & Migration (Weeks 11-14)
- Edge case hardening (DST, concurrent bookings, timezone boundaries)
- Calendar sync reliability (webhook renewal crons, fallback polling)
- Migration tooling (preserve event types, booking URLs)
- Parallel run: both systems active for 2 weeks
- Cutover
- **Gate:** Calendly fully replaced for Google Calendar users

#### Phase E: Expansion (Post-MVP)
- Microsoft Outlook / O365 integration
- Google Meet auto-creation (free with Google Calendar write)
- Daily.co as Zoom alternative
- Embeddable booking widget for external sites
- Apple Calendar (only if demanded)

### The middle ground: Hybrid approach

If the real pain point is specific (e.g. round-robin control, or branding), consider targeted replacements:

| Pain Point | Targeted Fix | Effort |
|---|---|---|
| Round-robin control | Build custom assignment on top of Calendly webhooks | 1 week |
| Branding | Custom booking page that calls Calendly API for availability | 3-4 weeks |
| Email control | Suppress Calendly emails, send our own via Resend | 2 weeks |
| Video control | Build Zoom integration, inject links into Calendly events | 2 weeks |

This lets us chip away at the dependency without the full rewrite.

---

## 9. Open Questions

1. **What specifically is painful about the Calendly dependency?** Cost? Feature gaps? Branding? Reliability? The answer shapes everything.
2. **How many closers are we supporting today and projecting?** This determines when the cost math tips.
3. **Do all closers use Google Calendar, or is Outlook/Apple critical?** Google-only MVP is dramatically simpler.
4. **Would Nylas as a calendar abstraction layer be acceptable?** It eliminates the hardest integration work but adds a new (lower-level) dependency.
5. **Is Cal.com (open-source, self-hosted) worth evaluating?** Covers ~70% of Calendly features, AGPL-licensed. Trade-off: hosting burden, doesn't integrate natively with Convex.
6. **What video platform do closers actually use?** Zoom seems standard but worth confirming before building the integration.
7. **Is there a specific feature Calendly lacks that would justify the investment?** (e.g. lead-score-based routing, custom qualification flows, deeper CRM integration)
