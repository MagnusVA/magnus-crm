# Magnus CRM

The language for how one person moves from first contact to a paying customer and back for another program. The terms describe the model in [ADR 0001](docs/adr/0001-lead-lifecycle-model.md), which the code follows; the ADR maps each term to the table that holds it.

## People

**Person**:
One human the business tries to sell to, recorded once for life, whichever channel found them first. Buying creates no second record.
_Avoid_: contact, customer record, lead (except as the table and screen name)

**Identifier**:
An email, phone number, or social handle that a person really uses, and that decides who a booking or capture belongs to. Placeholder values, such as a sample phone or `email@gmail.com`, are never identifiers.
_Avoid_: contact detail, key

**Booking review**:
A booking whose identifiers name more than one person, waiting for an admin to say whether they are one person. The Instagram handle decides who gets the call; when the handle names no one, the booking is held until the review is decided. A decision covers the people, not the one booking: a merge, from a review or the Leads page, closes every review it leaves with one person, and keeping people separate closes every review about the same people.
_Avoid_: duplicate, conflict

**Lifecycle stage**:
How far a person has ever got: Prospect, In conversation, Qualified, Booked, Showed, Customer. It moves forward on its own and only moves back when an admin moves it, with a reason.
_Avoid_: lead status

**Prospect**:
A person lead gen captured. A capture enters them at In conversation, so the Prospect stage is kept in the list but no longer used; it keeps the date of the first capture. A prospect is a person, not a separate record.
_Avoid_: lead gen lead

**In conversation**:
The lifecycle stage a person reaches when lead gen captures them or a lead generator resparks them. A DM portal note or profile edit is a touch but doesn't move the stage.

**Customer**:
A person at the Customer lifecycle stage, reached at their first payment. It is a stage, not a separate record.
_Avoid_: client, customer record

**Disposition**:
Whether the team should keep working a person, separate from their stage: open, nurture, not a fit, unresponsive, do not contact. The system, an admin, or a lead generator in a respark sets it. A respark, a qualification or a booking reopens a not a fit; a capture doesn't.

**Inactive**:
A person with no touch for the tenant's N days (90 by default), worked out from their last touch whenever it's shown. Nothing stores it, and changing N rewrites nothing.
_Avoid_: stale (a deal loss reason), dormant

**Respark**:
A lead generator messaging a stalled person again from the respark pool, then marking them resparked, not a fit, or skipped. The pool is five buckets in a fixed order: qualified and never booked, never qualified, inactive, had a call and the deal was lost, not a fit. A batch is held for its lead generator until the business day ends. Resparked counts as an entry for them and as lead gen credit if the person's next deal comes from it.
_Avoid_: reactivation, re-engagement

## Deals

**Deal**:
One attempt to sell one program to one person. A person can have many deals, and a second program is a new deal.
_Avoid_: opportunity (except as the table name), sale

**Stage**:
Say which one you mean. A person has a lifecycle stage. A deal has a deal stage.

**Deal stage**:
Where a deal is in the sale: Qualified, Booked, Call held, Follow-up, Closed. Deal stages describe the sale, not the calendar, so no-show and canceled are never deal stages.
_Avoid_: status, pipeline step

**Outcome**:
Whether a deal is still alive: open, won, or lost. A lost deal carries a reason. A no-show or a cancellation closes the deal as lost with that reason, while the attendance stays on the meeting. Outcome belongs to the deal; a meeting has attendance, not an outcome.
_Avoid_: deal status, closed won, meeting outcome

**Meeting**:
One scheduled sales call. It records attendance only: scheduled, held, no-show, or canceled, each recorded with its own time. A call still scheduled after it ends shows as "Not recorded"; that is a display rule, not a fifth state.
_Avoid_: appointment, completed (as a meeting state)

**Business day**:
The day a tenant's reports count by: from a start hour in the tenant's time zone, by default 1:00 am Honduras time, when the last qualifier's shift ends. Screens that use the viewer's browser clock say so.
_Avoid_: calendar day, UTC day

**Task**:
A dated next step on a deal, such as sending a reschedule link after a no-show, sending a scheduling link, or a reminder to call back.
_Avoid_: follow-up (as a deal status)

**Program**:
A coaching program a tenant sells. Each deal is for one program.

**Enrollment**:
One person in one program they bought, with its own status: active, paused, or churned. A person who buys two programs has two enrollments.
_Avoid_: customer program, subscription

**Side deal**:
A deal a closer or admin opens by hand, with no Calendly booking behind it.

## Credit and history

**Team member**:
One human on a tenant's team, whichever roles they work and whether or not they have a login.
_Avoid_: worker, rep, staff user

**Role**:
The job a team member did on a deal. Lead gen found the person, the setter qualified them in Slack, the DM closer worked the conversation and sent the booking link, and the closer ran the sales call.

**Attribution**:
A record that one team member played one role on one deal, with where that fact came from. Attribution is only ever added; reassigning a meeting adds a record instead of replacing one. It carries no commission share.
_Avoid_: credit column, owner

**Touch**:
One thing that happened to a person, recorded once: captured, messaged, qualified, booked, attended, no-show, follow-up, paid, resparked, or a note. A touch names the person and, where they apply, the deal, the team member, and the channel. A person's touches in order are their timeline.
_Avoid_: activity

**First touch**:
The touch that first brought a person in. Once set, nothing overwrites it. Each deal keeps a copy of the person's first and latest touch from the moment the deal was created.
_Avoid_: original source

**Last touch**:
The newest touch of any kind that someone did with the person: a channel touch, a meeting result, a deal move by a person, a payment, or a respark. System events, such as the Slack expiry, aren't one. Inactive and the respark pool read it; attribution reads the latest touch instead.

**Channel**:
Where a touch came from: lead gen (a capture or a respark), the DM portal, Slack, Calendly, or a side deal.

## Flagged ambiguities

- "Lead" means three things in today's code: the person (the `leads` table), the active lifecycle (`leads.status = active`), and, in reports, a new lead. Say person, lifecycle stage, or new person. In the leads report, a new lead is a person who first reached Qualified in the period, not a newly created row.
- "Prospect" also names the `leadGenProspects` table, which records captures and is not yet linked to a person.
- "Status" on an opportunity, in old deal events and old links, mixed deal stage, outcome, meeting attendance, and task state. The field is gone; name the one you mean.
