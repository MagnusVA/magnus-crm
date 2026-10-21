# Magnus CRM

The language for how one person moves from first contact to a paying customer and back for another program. The terms describe the target model in [ADR 0001](docs/adr/0001-lead-lifecycle-model.md). The code still uses older names, and the ADR maps each term to the tables that hold it today.

## People

**Person**:
One human the business tries to sell to, recorded once for life, whichever channel found them first. Buying creates no second record.
_Avoid_: contact, customer record, lead (except as the table and screen name)

**Identifier**:
An email, phone number, or social handle that a person really uses, and that decides who a booking or capture belongs to. Placeholder values, such as a sample phone or `email@gmail.com`, are never identifiers.
_Avoid_: contact detail, key

**Booking review**:
A booking whose identifiers name more than one person, waiting for an admin to say whether they are one person. The Instagram handle decides who gets the call; when the handle names no one, the booking is held until the review is decided.
_Avoid_: duplicate, conflict

**Lifecycle stage**:
How far a person has ever got: Prospect, In conversation, Qualified, Booked, Showed, Customer. It moves forward on its own and only moves back when an admin moves it, with a reason.
_Avoid_: lead status

**Prospect**:
A person at the Prospect lifecycle stage. Lead gen captured their handle and nobody has talked to them yet. A prospect is a person, not a separate record.
_Avoid_: lead gen lead

**Customer**:
A person at the Customer lifecycle stage, reached at their first payment. It is a stage, not a separate record.
_Avoid_: client, customer record

**Disposition**:
Whether the team should keep working a person, separate from their stage: open, nurture, not a fit, unresponsive, do not contact.

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
Whether a deal is still alive: open, won, or lost. A lost deal carries a reason. Outcome belongs to the deal; a meeting has attendance, not an outcome.
_Avoid_: deal status, closed won, meeting outcome

**Meeting**:
One scheduled sales call. It records attendance only: scheduled, held, no-show, or canceled.
_Avoid_: appointment

**Task**:
A dated next step on a deal, such as rebooking after a no-show, sending a scheduling link, or a reminder to call back.
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
One thing that happened to a person, recorded once: captured, messaged, qualified, booked, attended, no-show, follow-up, paid, or a note. A touch names the person and, where they apply, the deal, the team member, and the channel. A person's touches in order are their timeline.
_Avoid_: activity

**First touch**:
The touch that first brought a person in. Once set, nothing overwrites it. Each deal keeps a copy of the person's first and latest touch from the moment the deal was created.
_Avoid_: original source

**Channel**:
Where a touch came from: lead gen, the DM portal, Slack, Calendly, or a side deal.

## Flagged ambiguities

- "Lead" means three things in today's code: the person (the `leads` table), the active lifecycle (`leads.status = active`), and, in reports, a new lead. Say person, lifecycle stage, or new person. In the leads report, a new lead is a person who first reached Qualified in the period, not a newly created row.
- "Prospect" also names the `leadGenProspects` table, which records captures and is not yet linked to a person.
- "Status" on an opportunity mixes deal stage, outcome, meeting attendance, and task state. Name the one you mean.
