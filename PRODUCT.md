# Multi-Tenant Calendly-Driven Sales CRM — Product Specification

**Version:** 0.1 (MVP)
**Status:** Draft
**Audience:** Engineering, Product, and Stakeholders

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Technology Stack](#3-technology-stack)
4. [Multi-Tenancy Model](#4-multi-tenancy-model)
5. [Authentication & User Roles](#5-authentication--user-roles)
6. [Calendly Integration Strategy](#6-calendly-integration-strategy)
7. [Event-Driven Data Pipeline](#7-event-driven-data-pipeline)
8. [Core Domain Entities](#8-core-domain-entities)
9. [Sales Pipeline Workflow](#9-sales-pipeline-workflow)
10. [Closer Experience — UI & UX Flows](#10-closer-experience--ui--ux-flows)
11. [Admin Panel](#11-admin-panel)
12. [Tenant Onboarding Flow](#12-tenant-onboarding-flow)
13. [Webhook Event Handling](#13-webhook-event-handling)
14. [Round Robin Assignment](#14-round-robin-assignment)
15. [MVP Scope & Phasing](#15-mvp-scope--phasing)
16. [Open Questions & Future Considerations](#16-open-questions--future-considerations)

---

## 1. Executive Summary

This document describes the architecture, data flows, and product requirements for a **multi-tenant, event-driven Sales CRM** built on top of Calendly as its primary data ingestion source.

The system is designed to serve organizations (tenants) that rely on Calendly-scheduled meetings as their primary sales motion. Each tenant operates in full data isolation. The CRM captures inbound meeting data via webhooks, creates and tracks leads and opportunities through a structured sales pipeline, and provides operational dashboards for the people running those sales calls — referred to throughout as **Closers**.

The platform is **self-serve at the tenant level**: system administrators generate a unique registration link per tenant. Once registered, tenants connect their Calendly workspace, and the system provisions all necessary webhook subscriptions automatically via the Calendly API.

The MVP focuses on the **Closer's operational workflow**: calendar visibility, meeting execution, payment capture, and outcome logging.

---

## 2. System Architecture Overview

```mermaid
graph TD
    A[Calendly Platform] -->|Webhook Events| B[Webhook Ingestion Layer\nNext.js API Route / Convex HTTP Action]
    B -->|Tenant Resolution & Validation| C[Event Router\nConvex]
    C -->|Persists raw event| D[(Convex Database)]
    C -->|Triggers pipeline| E[Pipeline Processor\nConvex Mutation/Action]
    E -->|Upsert Lead Profile| D
    E -->|Create/Update Opportunity| D
    E -->|Assign Closer via Round Robin| D
    D -->|Real-time sync| F[Next.js Frontend]
    F -->|Auth| G[WorkOS]
    G -->|SSO / Directory Sync| F
    F -->|API Calls| H[Calendly REST API]
    H -->|Meeting creation, event fetch| A
    I[System Admin Panel] -->|Generates tenant invite links| J[Tenant Onboarding Flow]
    J -->|Registers tenant, stores config| D
    J -->|Provisions webhooks| H
```

---

## 3. Technology Stack

| Layer | Technology | Role |
|---|---|---|
| **Frontend** | Next.js (App Router) | UI, SSR, API routes for lightweight server logic |
| **Backend / Database** | Convex | Real-time reactive database, business logic (mutations, actions, queries) |
| **Authentication** | WorkOS | SSO, multi-tenancy auth, organization management, directory sync |
| **Webhook Source** | Calendly | Primary data source for all meeting/event data |
| **External Calendaring** | Calendly REST API | Webhook provisioning, event fetching, meeting scheduling |
| **Payments** | External providers (Stripe, PayPal, etc.) | Payment links managed per calendar/event-type configuration |
| **Video Conferencing** | Zoom (via Calendly) | Meeting execution |

---

## 4. Multi-Tenancy Model

Each **Tenant** represents a single business or organization subscribing to the CRM. Tenants are fully isolated at the data layer.

```mermaid
graph TD
    SA[System Admin] -->|Generates invite link| TenantReg[Tenant Registration Portal]
    TenantReg -->|Tenant submits info + Calendly OAuth| TenantRecord[(Tenant Record in Convex)]
    TenantRecord --> WH[Webhook Provisioning via Calendly API]
    WH -->|Webhook registered with tenantId in signing secret / metadata| CalendlyWebhook[Calendly Webhook Subscription]
    CalendlyWebhook -->|Inbound events tagged with tenantId| Ingestion[Webhook Ingestion Layer]
    Ingestion -->|Isolated data writes| TenantDB[(Tenant-scoped data in Convex)]
```

### Tenant Isolation Strategy

- Every Convex document that belongs to a tenant carries a `tenantId` field.
- All queries, mutations, and actions enforce `tenantId` scoping — no cross-tenant data access is possible at the application layer.
- WorkOS Organizations map 1:1 to Tenants; users are always resolved within their organization context.
- Calendly webhook subscriptions are provisioned per-tenant using the tenant's OAuth token, and the `tenantId` is embedded into the webhook subscription's signing metadata (or a dedicated endpoint path `/webhooks/calendly/{tenantId}`) to allow correct routing on receipt.

---

## 5. Authentication & User Roles

Authentication is handled exclusively through **WorkOS**, leveraging its AuthKit UI and organization-based access control.

### User Roles

| Role | Description | Key Permissions |
|---|---|---|
| **Tenant Master** | Primary point of contact or business owner for a tenant | Full access to all tenant data, pipeline, reporting, settings, and billing |
| **Tenant Admin** | Operational administrator within a tenant | Reporting, pipeline monitoring, user management, calendar configuration |
| **Closer** | Frontline sales operator | Own pipeline view, calendar, meeting execution, outcome logging |

### Role Resolution Flow

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant WOS as WorkOS AuthKit
    participant NX as Next.js Server
    participant CVX as Convex
    U->>WOS: Initiates login
    WOS-->>U: SSO / Magic Link flow
    WOS-->>NX: Session token + org membership + role claims
    NX->>CVX: Resolve user record by WorkOS user ID + org ID
    CVX-->>NX: User profile, tenantId, role
    NX-->>U: Redirect to role-appropriate dashboard
```

---

## 6. Calendly Integration Strategy

Calendly serves as the **sole inbound data source**. The CRM does not own scheduling — it consumes and enriches Calendly's data.

### 6.1 OAuth & Webhook Provisioning

When a tenant onboards:

1. The tenant completes a Calendly OAuth flow, granting the CRM access to their Calendly organization.
2. The CRM backend uses the obtained access token to call the Calendly API and register one or more webhook subscriptions for that tenant.
3. Webhook subscriptions are scoped to the tenant's Calendly organization and configured to fire on relevant event types.

### 6.2 Calendly App (OAuth App) Multi-Tenancy

The CRM is registered as a **single Calendly OAuth App**. Each tenant authorizes this app independently, producing a unique access token per tenant. This is the standard Calendly multi-tenant integration model. Token refresh and storage are handled securely in Convex, encrypted at rest.

### 6.3 Webhook Event Types Subscribed

| Event | Trigger | CRM Action |
|---|---|---|
| `invitee.created` | Lead books a meeting | Create/update Lead, create Opportunity, assign Closer |
| `invitee.canceled` | Meeting is canceled by lead or host | Update Opportunity status to Canceled, trigger follow-up prompt |
| `invitee_no_show` | Host marks invitee as no-show | Update Opportunity status, flag for follow-up |
| `routing_form_submission` | Routing form submitted | Enrich lead profile with pre-meeting qualification data |

### 6.4 Calendly API Supplemental Calls

When a webhook payload lacks necessary detail (e.g., invitee answers, event type metadata, assigned host), the CRM will issue supplemental GET requests to the Calendly API to fetch:

- Full invitee details (`/invitees/{uuid}`)
- Event details (`/scheduled_events/{uuid}`)
- Event type configuration (`/event_types/{uuid}`)
- Organization memberships (for round robin resolution)

---

## 7. Event-Driven Data Pipeline

```mermaid
flowchart TD
    A[Calendly Webhook fires] --> B{Validate\nHMAC Signature}
    B -->|Invalid| Z1[Return 401 / Discard]
    B -->|Valid| C{Resolve Tenant\nfrom endpoint path\nor signing key}
    C -->|Unknown tenant| Z2[Return 400 / Log]
    C -->|Tenant found| D[Persist raw webhook payload\nto RawEvents collection]
    D --> E[Trigger Pipeline Processor\nConvex Action]
    E --> F{Event Type?}
    F -->|invitee.created| G[Lead Upsert Flow]
    F -->|invitee.canceled| H[Cancellation Flow]
    F -->|invitee_no_show| I[No-Show Flow]
    F -->|Other| J[Log & ignore or extend]
    G --> G1[Upsert Lead Profile\nby email]
    G1 --> G2[Create Opportunity\nlinked to Lead + Event]
    G2 --> G3[Resolve Closer via\nRound Robin Assignment]
    G3 --> G4[Create Meeting record\nlinked to Opportunity]
    G4 --> G5[Notify Closer\nvia real-time Convex subscription]
    H --> H1[Update Opportunity status → Canceled]
    H1 --> H2[Flag for follow-up\nif applicable]
    I --> I1[Update Opportunity status → No Show]
    I1 --> I2[Flag for follow-up]
```

---

## 8. Core Domain Entities

```mermaid
erDiagram
    TENANT {
        string id PK
        string name
        string workos_org_id
        string calendly_org_uri
        string calendly_access_token
        string calendly_refresh_token
        timestamp token_expires_at
        string status
        timestamp created_at
    }

    USER {
        string id PK
        string tenant_id FK
        string workos_user_id
        string email
        string full_name
        enum role
        string calendly_user_uri
        timestamp created_at
    }

    LEAD {
        string id PK
        string tenant_id FK
        string email
        string full_name
        string phone
        json custom_fields
        timestamp first_seen_at
        timestamp updated_at
    }

    OPPORTUNITY {
        string id PK
        string tenant_id FK
        string lead_id FK
        string assigned_closer_id FK
        string event_type_id FK
        enum status
        timestamp created_at
        timestamp updated_at
    }

    MEETING {
        string id PK
        string tenant_id FK
        string opportunity_id FK
        string calendly_event_uri
        string calendly_invitee_uri
        string zoom_join_url
        datetime scheduled_at
        int duration_minutes
        enum status
        string notes
        timestamp created_at
    }

    EVENT_TYPE_CONFIG {
        string id PK
        string tenant_id FK
        string calendly_event_type_uri
        string display_name
        json payment_links
        bool round_robin_enabled
        timestamp created_at
    }

    PAYMENT_RECORD {
        string id PK
        string tenant_id FK
        string opportunity_id FK
        string meeting_id FK
        string closer_id FK
        decimal amount
        string currency
        string provider
        string reference_code
        string proof_file_url
        enum status
        timestamp recorded_at
    }

    FOLLOW_UP {
        string id PK
        string tenant_id FK
        string opportunity_id FK
        string lead_id FK
        string closer_id FK
        string calendly_event_uri
        enum reason
        timestamp scheduled_at
        timestamp created_at
    }

    RAW_WEBHOOK_EVENT {
        string id PK
        string tenant_id FK
        string event_type
        json payload
        bool processed
        timestamp received_at
    }

    TENANT ||--o{ USER : has
    TENANT ||--o{ LEAD : owns
    TENANT ||--o{ OPPORTUNITY : owns
    TENANT ||--o{ EVENT_TYPE_CONFIG : configures
    LEAD ||--o{ OPPORTUNITY : generates
    USER ||--o{ OPPORTUNITY : assigned_to
    OPPORTUNITY ||--o{ MEETING : has
    OPPORTUNITY ||--o{ PAYMENT_RECORD : has
    OPPORTUNITY ||--o{ FOLLOW_UP : triggers
    EVENT_TYPE_CONFIG ||--o{ OPPORTUNITY : typed_by
    MEETING ||--o| PAYMENT_RECORD : results_in
    MEETING ||--o| FOLLOW_UP : leads_to
```

### Opportunity Status State Machine

```mermaid
stateDiagram-v2
    [*] --> Scheduled : invitee.created webhook
    Scheduled --> InProgress : Closer starts meeting
    InProgress --> PaymentReceived : Closer logs payment
    InProgress --> FollowUpScheduled : Closer schedules follow-up
    InProgress --> Lost : Closer marks as lost
    Scheduled --> Canceled : invitee.canceled webhook
    Scheduled --> NoShow : invitee_no_show webhook
    Canceled --> FollowUpScheduled : Closer initiates follow-up
    NoShow --> FollowUpScheduled : Closer initiates follow-up
    FollowUpScheduled --> Scheduled : New meeting booked via webhook
    PaymentReceived --> [*] : Pipeline complete
    Lost --> [*] : Archived / Backburner
```

---

## 9. Sales Pipeline Workflow

```mermaid
flowchart TD
    L1[Lead visits Calendly booking page] --> L2[Lead selects time slot\nand submits booking]
    L2 --> L3[Calendly fires invitee.created webhook]
    L3 --> L4[CRM ingests event\nresolves tenant]
    L4 --> L5[Lead Profile upserted\nnew or existing]
    L5 --> L6[Opportunity created\nstatus: Scheduled]
    L6 --> L7[Closer assigned\nvia Round Robin]
    L7 --> L8[Meeting record created\nwith Zoom link and time]
    L8 --> L9[Closer sees event\non their dashboard]

    L9 --> M1[Meeting time arrives\nCloser opens meeting details]
    M1 --> M2[Closer joins Zoom\nvia link in CRM]
    M2 --> M3[Closer writes meeting notes\nin real time]
    M3 --> M4{Meeting Outcome?}

    M4 -->|Sale closed| P1[Closer shares payment link\nfrom Event Type Config]
    P1 --> P2[Lead completes payment\nexternal provider]
    P2 --> P3[Closer uploads payment proof\nreference code + amount]
    P3 --> P4[Opportunity status → PaymentReceived]
    P4 --> P5[Pipeline Complete ✓]

    M4 -->|Follow-up needed| F1[Closer proposes new time to lead]
    F1 --> F2[Lead confirms new time]
    F2 --> F3[Closer creates new meeting\nvia CRM UI → Calendly API]
    F3 --> F4[Calendly fires invitee.created\nfor follow-up event]
    F4 --> F5[Follow-up Meeting linked\nto existing Opportunity]
    F5 --> L9

    M4 -->|Sale lost| LO1[Closer marks Opportunity as Lost]
    LO1 --> LO2[Opportunity archived\nto Backburner]
    LO2 --> LO3[Available for future\nmanual follow-up]
```

---

## 10. Closer Experience — UI & UX Flows

### 10.1 Dashboard Layout

Upon login, the Closer lands on their personal pipeline dashboard. The layout is structured as follows:

```mermaid
graph TD
    subgraph Dashboard
        A[Featured Event Card\nNext upcoming meeting\nLead name · Time · Zoom link]
        B[Calendar View\nToday default · Week · Month filters]
        C[Pipeline Summary\nOpen · Follow-up · Closed · Lost counts]
    end
    A --> E[Click → Meeting Detail Page]
    B --> E
    C --> F[Click → Filtered Opportunity List]
```

### 10.2 Meeting Detail Page

```mermaid
flowchart TD
    A[Meeting Detail Page] --> B[Lead Info Panel\nName · Email · Phone · History]
    A --> C[Meeting Info\nDate · Duration · Zoom Link · Event Type]
    A --> D[Meeting Notes\nReal-time editable text area]
    A --> E[Payment Links Panel\nFrom Event Type Config]
    A --> G[Outcome Actions]
    G --> G1[Log Payment]
    G --> G2[Schedule Follow-up]
    G --> G3[Mark as Lost]
    G1 --> H[Payment Form\nAmount · Provider · Reference · Proof Upload]
    G2 --> I[Follow-up Scheduler\nCRM UI → Calendly API call]
    G3 --> J[Confirm Lost Dialog\nOptional notes · Archive]
```

### 10.3 Follow-Up Meeting Scheduling Flow

```mermaid
sequenceDiagram
    participant C as Closer (CRM UI)
    participant CVX as Convex Backend
    participant CAL as Calendly API
    participant WH as Webhook Ingestion
    C->>CVX: Submit follow-up request\n(lead email, event type, proposed time)
    CVX->>CAL: POST /scheduled_events\n(single-use scheduling link or direct booking)
    CAL-->>CVX: Booking confirmation + event URI
    CVX->>CVX: Create Follow-up record\nlink to existing Opportunity
    CAL-->>WH: invitee.created webhook fires
    WH->>CVX: Process webhook,\ndetect existing Opportunity via lead email
    CVX->>CVX: Create new Meeting record\nlinked to existing Opportunity
    CVX-->>C: Real-time update via\nConvex subscription
```

---

## 11. Admin Panel

The Admin Panel is accessible to **System Admins** (internal team) and provides cross-tenant visibility.

### 11.1 System Admin Capabilities

- **Tenant Management**: View all tenants, their status (active, onboarding, suspended), and key metrics.
- **Invite Link Generation**: Generate unique, time-limited registration URLs for new tenants.
- **Webhook Health Monitoring**: View per-tenant webhook subscription status and recent event logs.
- **Impersonation / Support Mode**: Ability to view a tenant's dashboard in read-only mode for support purposes.

### 11.2 Tenant Admin Capabilities

- **Pipeline Reporting**: Aggregate pipeline metrics — opportunities by status, conversion rates, revenue logged.
- **Closer Performance**: Per-closer breakdown of meetings, closes, and follow-ups.
- **Event Type Configuration**: Associate Calendly event types with payment link sets and round robin settings.
- **User Management**: Invite/remove Closers and Tenant Admins within their organization.

---

## 12. Tenant Onboarding Flow

```mermaid
sequenceDiagram
    participant SA as System Admin
    participant SYS as CRM System
    participant TM as Tenant Master
    participant WOS as WorkOS
    participant CAL as Calendly OAuth

    SA->>SYS: Request invite link for new tenant
    SYS-->>SA: Generates signed, time-limited invite URL
    SA->>TM: Sends invite URL (email / manual)
    TM->>SYS: Opens invite URL
    SYS-->>TM: Registration form\n(org name, contact info)
    TM->>WOS: Complete WorkOS signup / SSO
    WOS-->>SYS: Organization created, Tenant Master user provisioned
    TM->>CAL: Authorize CRM Calendly OAuth App
    CAL-->>SYS: Access token + org URI stored securely
    SYS->>CAL: Register webhook subscriptions\nfor this tenant's org
    CAL-->>SYS: Webhook subscription IDs confirmed
    SYS-->>TM: Onboarding complete → Dashboard
```

---

## 13. Webhook Event Handling

### 13.1 Signature Validation

All inbound webhook requests from Calendly are validated using HMAC-SHA256 signature verification before any processing occurs. Invalid requests are rejected with a `401` and logged for audit purposes.

### 13.2 Idempotency

Each webhook event carries a unique Calendly event URI. The ingestion layer checks for duplicate `RawWebhookEvent` records before processing to ensure exactly-once pipeline execution, even if Calendly retries delivery.

### 13.3 Cancellation Handling

```mermaid
flowchart TD
    A[invitee.canceled webhook received] --> B[Resolve tenant + Meeting record]
    B --> C{Cancellation initiator?}
    C -->|Lead canceled| D[Opportunity → Canceled\nFlag for closer review]
    C -->|Host canceled| E[Opportunity → Canceled\nInternal note added]
    D --> F{Closer action required?}
    E --> F
    F -->|Yes, within business rules| G[Prompt Closer to\nreach out and reschedule]
    F -->|No| H[Archive with cancellation reason]
    G --> I[Closer initiates Follow-up\nvia CRM UI]
```

---

## 14. Round Robin Assignment

Calendly natively supports round robin event types (distributing meetings across a team). The CRM must map these assignments back to its own User records.

### 14.1 Assignment Strategy

When a `invitee.created` event arrives, the payload includes the assigned Calendly host's URI (`event.event_memberships[].user`). The CRM resolves this URI against the `calendly_user_uri` field stored on each `USER` record to identify the correct Closer.

```mermaid
flowchart TD
    A[invitee.created payload received] --> B[Extract assigned host\nCalendly user URI from payload]
    B --> C{Match USER record\nby calendly_user_uri}
    C -->|Match found| D[Assign Opportunity to that Closer]
    C -->|No match| E[Fallback: assign to Tenant Admin\nAlert for manual resolution]
    D --> F[Notify Closer]
    E --> G[Alert: unmatched Calendly user\nRequires configuration]
```

### 14.2 Calendly User Sync

During and after onboarding, the CRM syncs Calendly organization members via the Calendly API (`/organization_memberships`) and attempts to match them to existing CRM users by email. Tenant Admins can manually complete the mapping via the admin UI when automatic matching fails.

---

## 15. MVP Scope & Phasing

### Phase 1 — MVP (Current Focus)

| Area | Included |
|---|---|
| Multi-tenant infrastructure | ✅ Tenant isolation, WorkOS auth, Convex backend |
| Calendly webhook ingestion | ✅ `invitee.created`, `invitee.canceled`, `invitee_no_show` |
| Lead & Opportunity creation | ✅ Automatic upsert from webhook data |
| Closer dashboard | ✅ Calendar view (Today/Week/Month), featured event |
| Meeting detail page | ✅ Notes, Zoom link, outcome actions |
| Payment logging | ✅ Manual entry + proof upload |
| Follow-up scheduling | ✅ Via Calendly API from CRM UI |
| Lost / Backburner flow | ✅ Status transitions, archival |
| Round robin resolution | ✅ Via Calendly host URI matching |
| System Admin panel | ✅ Tenant management, invite link generation |
| Tenant Admin reporting | 🔜 Phase 2 |
| Advanced analytics | 🔜 Phase 2 |
| Automated lead communication | 🔜 Phase 2 |
| Mobile-first Closer app | 🔜 Phase 3 |

---

## 16. Open Questions & Future Considerations

| # | Question | Notes |
|---|---|---|
| 1 | What is the canonical strategy for embedding `tenantId` in webhook URLs vs. signing key metadata? | Dedicated path `/webhooks/calendly/{tenantId}` is simpler and more debuggable; signing key per tenant adds security but complexity. |
| 2 | How should token refresh be handled for Calendly OAuth tokens in Convex? | Convex scheduled actions on a cron to proactively refresh before expiry. |
| 3 | How exactly does the CRM create a follow-up meeting via Calendly API? | Calendly supports single-use scheduling links; direct booking via API is limited. Investigate one-off links scoped to a specific invitee. |
| 4 | What happens when a Calendly event type is deleted or modified? | CRM must handle orphaned `EVENT_TYPE_CONFIG` records gracefully. |
| 5 | What is the payment proof storage strategy? | Convex file storage or an S3-compatible bucket; access must be tenant-scoped. |
| 6 | Should the CRM send any outbound notifications (email/SMS) to leads? | Out of scope for MVP; Phase 2 candidate via a provider like Resend or Twilio. |
| 7 | How is "Backburner" surfaced to Tenant Admins for future follow-up campaigns? | To be designed in Phase 2 reporting module. |
| 8 | Should routing form submission data from Calendly be captured as lead qualification fields? | Yes — recommended for Phase 1 if routing forms are in use by tenants. |

---

*This document is a living specification. As implementation decisions are finalized, sections will be updated to reflect confirmed architectural choices, API contracts, and UX designs.*
