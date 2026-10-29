# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Magnus CRM is multi-tenant. Each tenant is a team that sells high-ticket programs through booked sales calls. Inside a tenant there are four roles (`docs/agents/auth.md`):

- **Closers** take the booked calls. They sit at a desk with Magnus open on a laptop or a second monitor beside the Zoom or Meet call, and use it before, during and between calls. Their jobs are to see what's on today, prepare for the next call, record the outcome (showed, no-show, won with payment, follow-up, lost), and work their follow-ups. Phone use is occasional.
- **Owners and admins** (`tenant_master`, `tenant_admin`) run the sales floor: they watch operations dashboards (lead gen, qualifications, booked calls, sales calls, no-shows, booking reviews) and reports, and they manage people and deals, billing, the team, and settings.
- **Lead generators** capture people found through outreach, respark stalled people from their team's pool, and review their own activity.

Two groups work with the CRM without being CRM users:

- **DM closers** add notes through a password-protected link portal.
- **Slack qualifiers** log qualified leads through the Slack bot.

A system admin area serves the Magnus operators who run the tenants.

## Product Purpose

Magnus tracks each person from first contact (a lead gen capture, a DM conversation, a Slack qualification) through a booked Calendly call to a payment, and back again for another program. Closers need to know what to do next and record what happened on every call. Owners need numbers they can trust about throughput, show-up rate, cash collected and close rate.

Success means every call ends with a recorded outcome, every deal is credited to the people who earned it, and an owner can tell from one screen whether the floor is on track.

## Positioning

Magnus is built for high-ticket program sales teams in which setters and lead generators book the calls and closers close them. On each deal it credits every hand involved: lead gen, the DM team and DM closer, and the closer. That credit comes from Calendly bookings, the DM portal, Slack qualifications and lead gen captures. A generic CRM records the deal; Magnus records who caused it.

## Operating Context

- Calls are booked through Calendly. Each tenant connects Calendly, and Magnus receives the bookings through webhooks. Slack connects the qualification bot.
- Closers work beside a live video call, so the CRM is a second screen during the call.
- Time follows the tenant's business day (for example, "days run 1:00 am to 1:00 am, America/Tegucigalpa time"), not the browser's. Weeks start on Monday.
- Tenants record payments in several currencies.
- Report pages run on ClickHouse, and the Today views on Convex. Analytics can show freshness, rebuilding and export-job states.

## Capabilities and Constraints

- The domain language is defined in `CONTEXT.md`, and the model follows `docs/adr/0001-lead-lifecycle-model.md`. A person is recorded once for life; a deal is one attempt to sell one program; a meeting has an attendance status separate from the deal's stage. The UI uses these terms: "deal", not "opportunity"; "person", not "contact".
- Pages and Convex functions each enforce access. Hiding a control with `useRole()` is presentation only.
- Writes to meetings, deals, payments, leads and enrollments carry side effects maintained by hand (`docs/agents/convex.md`).
- Stack: Next.js 16 App Router, React 19, Convex, WorkOS AuthKit, shadcn/ui (`radix-nova`) on Tailwind CSS 4, Recharts, lucide icons, PostHog.
- Production holds one live test tenant, so data changes need a migration plan.
- The UI is in English only, and no i18n work is planned.
- The notification centre is a placeholder with no backend yet.

## Brand Commitments

- **Name and mark:** Magnus (Magnus VA). The mark is an angular M built from cut geometric planes with rounded inner corners. Assets are in the repo at `public/magnus-icon.svg`, `public/magnus-white.svg` and the favicons, and outside it at `~/Documents/MARKETING Y LOGOS/`: horizontal and vertical lockups in colour, white and greys, plus mockups.
- **Brand colours:** deep navy (about `#1A2030`) and lime green (about `#84B135`), with a slate-teal second ground in the marketing pieces.
- **Brand typeface:** Aceh (`public/Aceh-Light.ttf`, exposed as `--font-brand`).
- **Committed signature (user decision, 2026-10-28):** the brand lives loudly in the CRM. The navy shell and lime recur as a strong signature through the chrome and the key actions, as in the marketing pieces. They don't stay in small accents.
- **Translate, don't copy:** the marketing mockups are inspiration. The CRM writes its own design language from this material and doesn't reproduce the marketing layouts.

## Evidence on Hand

- Brand assets: listed above.
- Audit of the current app, 2026-10-28:
  - `.impeccable/audit/routes.md`: 54 routes, 43 live screens grouped by archetype, navigation per role.
  - `.impeccable/audit/drift.md`: styling drift in the source.
  - `.impeccable/audit/backlog.md`: the redesign backlog.
  - Critique snapshots in `.impeccable/critique/`.
  - 285 screenshots in `.impeccable/review/inventory/` (not committed).
- The dev deployment has test users for owner, closer and lead generator, and test data that is thin on most dashboards.
- There are no customer testimonials, benchmarks or published metrics. Don't invent any.

## Product Principles

1. **Next action first.** Every screen answers "what do I do now?" before "what is this record?". That means today's calls and outcomes still to record for closers, and the attention items before history for admins.
2. **Every call gets an outcome.** Recording what happened is the closer's most important act, so it's the clearest, safest and most visible action on a call, and its consequences are stated before they happen.
3. **The deal is the unit.** Meetings, payments and tasks belong to a deal, and a person's page tells the story deal by deal.
4. **Numbers you can trust.** Metric definitions stay honest and visible, and freshness, partial results and business-day boundaries are always explicit.
5. **One word, one meaning.** The UI speaks the language of `CONTEXT.md`: one name per concept and one visual form per status.

## Accessibility & Inclusion

Target WCAG 2.2 AA. The audit measured contrast failures (muted text at 4.1–4.4:1), controls 14–20px tall, list rows that only respond to clicks, and help icons that overwrite table header names. The redesign must fix all of these at the system level: AA contrast in both themes, a 24px minimum target size, full keyboard access, and accessible names that survive tooltips.
