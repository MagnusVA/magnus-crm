# Webhook Payload

**Tags:** Webhooks

Webhook Payload Object — the body Calendly POSTs to your `callback_url` when a subscribed event fires.

The `payload` object shape depends on `event`. It is **one of:** Invitee Payload, Routing Form Submission, or Event Type Webhook Payload.

## Root object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | string | Yes | The event that caused the webhook to fire. See [Event values](#event-values). |
| `created_at` | string (date-time) | Yes | When the webhook event was created (e.g. `2020-01-02T03:04:05.678123Z`). |
| `created_by` | string (URI) | Yes | The user who created the webhook subscription. **Example:** `https://api.calendly.com/users/AAAAAAAAAAAAAAAA` |
| `payload` | object | Yes | Event-specific data. See [Payload variants](#payload-variants). |

### Event values

| Value | Payload variant |
| --- | --- |
| `invitee.created` | Invitee Payload |
| `invitee.canceled` | Invitee Payload |
| `invitee_no_show.created` | Invitee Payload |
| `invitee_no_show.deleted` | Invitee Payload |
| `routing_form_submission.created` | Routing Form Submission |
| `event_type.created` | Event Type Webhook Payload |
| `event_type.deleted` | Event Type Webhook Payload |
| `event_type.updated` | Event Type Webhook Payload |

---

## Payload variants

### Invitee Payload

The payload sent when an invitee creates or schedules a meeting, when an invitee cancels, and for invitee no-show events.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string (URI) | Yes | Canonical reference for the invitee. **Example:** `https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA` |
| `email` | string (email) | Yes | Invitee email. **Example:** `test@example.com` |
| `first_name` | string \| null | Yes | First name when the event type uses separate first/last fields; `null` when a single name field is used. **Example:** `John` |
| `last_name` | string \| null | Yes | Last name when the event type uses separate first/last fields; `null` when a single name field is used. **Example:** `Doe` |
| `name` | string | Yes | Invitee name (human-readable). **Example:** `John Doe` |
| `status` | string | Yes | `active` or `canceled`. |
| `questions_and_answers` | array[Invitee Question and Answer] | Yes | Responses to booking form questions. Min 0 items. |
| `timezone` | string \| null | Yes | Time zone for displaying time to the invitee. |
| `event` | string (URI) | Yes | Reference to the scheduled event. **Example:** `https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA` |
| `created_at` | string (date-time) | Yes | When the invitee was created. **Example:** `2019-01-02T03:04:05.678123Z` |
| `updated_at` | string (date-time) | Yes | When the invitee was last updated. **Example:** `2019-08-07T06:05:04.321123Z` |
| `tracking` | Invitee Tracking | Yes | UTM and Salesforce tracking parameters. |
| `text_reminder_number` | string \| null | Yes | Phone number for SMS reminders. **Example:** `+1 404-555-1234` |
| `rescheduled` | boolean | Yes | If `true`, see `new_invitee` for the new Invitee instance. |
| `old_invitee` | string (URI) \| null | Yes | Previous Invitee when rescheduled. |
| `new_invitee` | string (URI) \| null | Yes | New invitee after reschedule. |
| `cancel_url` | string (URI) | Yes | Link to cancel the event for this invitee. |
| `reschedule_url` | string (URI) | Yes | Link to reschedule the event for this invitee. |
| `routing_form_submission` | string (URI) \| null | Yes | Routing form submission that redirected to booking. **Example:** `https://api.calendly.com/routing_form_submissions/AAAAAAAAAAAAAAAA` |
| `cancellation` | Cancellation | No | Present when the invitee/event was canceled. |
| `payment` | Payment \| null | Yes | Invitee payment details. |
| `no_show` | No Show \| null | Yes | Associated no-show record. |
| `reconfirmation` | Reconfirmation \| null | Yes | Reconfirmation request/response when enabled on the event type. |
| `scheduling_method` | string \| null | Yes | How the event was scheduled. **Allowed:** `instant_book`, `null`. |
| `invitee_scheduled_by` | string (URI) \| null | Yes | User URI who scheduled the event on behalf of the invitee. |
| `scheduled_event` | Scheduled Event (embedded) | Yes | Information about the invitee's scheduled meeting. |

#### Payment

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `external_id` | string | Yes | Unique payment identifier. |
| `provider` | string | Yes | `stripe` or `paypal`. **Example:** `stripe` |
| `amount` | number (float) | Yes | Payment amount. |
| `currency` | string | Yes | `AUD`, `CAD`, `EUR`, `GBP`, or `USD`. |
| `terms` | string \| null | Yes | Payment terms (up to 1,024 characters). |
| `successful` | boolean | Yes | Whether payment was processed successfully. |

#### No Show

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string | Yes | Canonical reference for the no show. |
| `created_at` | string (date-time) | Yes | When the no show was created. **Example:** `2019-01-02T03:04:05.678123Z` |

#### Reconfirmation

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `created_at` | string (date-time) | Yes | When reconfirmation was requested. **Example:** `2020-11-23T17:51:18.341657Z` |
| `confirmed_at` | string (date-time) \| null | Yes | When the invitee confirmed attendance; `null` until confirmed. |

#### Scheduled Event (embedded in Invitee Payload)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string (URI) | Yes | Canonical reference for the scheduled event. **Example:** `https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2` |
| `name` | string \| null | Yes | Event name. **Example:** `15 Minute Meeting` |
| `meeting_notes_plain` | string \| null | Yes | Meeting notes (plain text). |
| `meeting_notes_html` | string | Yes | Meeting notes (HTML). **Example:** `<p>15 Minute Meeting</p>` |
| `status` | string | Yes | `active` or `canceled`. |
| `start_time` | string (date-time) | Yes | Scheduled start (UTC). |
| `end_time` | string (date-time) | Yes | Scheduled end (UTC). |
| `event_type` | string (URI) | Yes | Associated event type. **Example:** `https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2` |
| `location` | Location | Yes | Where/how the meeting takes place (see [Location](#location-scheduled-event)). |
| `invitees_counter` | object | Yes | Invitee counts (see below). |
| `created_at` | string (date-time) | Yes | When the event was created. |
| `updated_at` | string (date-time) | Yes | When the event was last updated. |
| `event_memberships` | array[Event Membership] | Yes | Host(s) assigned to the event. |
| `event_guests` | array[Guest] | Yes | Additional guests added by the invitee. |
| `cancellation` | Cancellation | No | Present when the scheduled event was canceled. |

**`invitees_counter`**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `total` | number | Yes | Total invitees including canceled. |
| `active` | number | Yes | Invitees who have not canceled. |
| `limit` | number | Yes | Maximum active invitees allowed. |

**Event Membership** (items in `event_memberships`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `user` | string (URI) | Yes | User URI. **Example:** `https://api.calendly.com/users/GBGBDCAADAEDCRZ2` |
| `user_email` | string (email) | No | Host email. **Example:** `user@example.com` |
| `user_name` | string | No | Host name. **Example:** `John Smith` |

---

### Routing Form Submission

Information about a routing form submission (`routing_form_submission.created`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string (URI) | Yes | Canonical reference. **Example:** `https://api.calendly.com/routing_form_submissions/AAAAAAAAAAAAAAAA` |
| `routing_form` | string (URI) | Yes | Associated routing form. **Example:** `https://api.calendly.com/routing_forms/AAAAAAAAAAAAAAAA` |
| `questions_and_answers` | array[Submission Question and Answer] | Yes | All questions with answers. |
| `tracking` | Submission Tracking | Yes | UTM and Salesforce tracking. |
| `result` | Submission Result | No* | Where the submission routed the respondent. *Present in documented examples. |
| `submitter` | string (URI) \| null | Yes | Invitee resource when submission results in a scheduled meeting. |
| `submitter_type` | string \| null | Yes | `Invitee` when submitter is an invitee. |
| `created_at` | string (date-time) | Yes | When the form was submitted. |
| `updated_at` | string (date-time) | Yes | When the submission was last updated. |

#### Submission Question and Answer

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `question_uuid` | string (UUID) | Yes | Question identifier. **Example:** `123e4567-e89b-12d3-a456-426614174000` |
| `question` | string | Yes | Question text. **Example:** `What is your industry?` |
| `answer` | string | Yes | Respondent answer. **Example:** `IT & Software` |

#### Submission Tracking

Same shape as [Invitee Tracking](#invitee-tracking): `utm_campaign`, `utm_source`, `utm_medium`, `utm_content`, `utm_term`, `salesforce_uuid` (each string \| null).

#### Submission Result

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | Yes | Result type (e.g. `event_type`). |
| `value` | string (URI) | Yes | Result target (e.g. event type URI). **Example:** `https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2` |

---

### Event Type Webhook Payload

A configuration for an Event Type (`event_type.created`, `event_type.deleted`, `event_type.updated`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string (URI) | Yes | Canonical reference. **Example:** `https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA` |
| `name` | string \| null | Yes | Event type name. **Example:** `15 Minute Meeting` |
| `active` | boolean | Yes | Whether the event type is active. |
| `slug` | string \| null | Yes | URL segment for this event type. **Example:** `acmesales` |
| `scheduling_url` | string (URI) | Yes | Booking page URL. **Example:** `https://calendly.com/acmesales` |
| `duration` | number | Yes | Session length in minutes. **Example:** `15` |
| `duration_options` | array[integer] \| null | Yes | Duration options; always `null` for ad hoc event types. **Example:** `[1, 13, 15, 720]` |
| `kind` | string | Yes | `solo` (individual) or `group`. |
| `is_paid` | boolean | Yes | Whether payment is required. |
| `pooling_type` | string \| null | Yes | `round_robin`, `collective`, `multi_pool`, or `null`. |
| `type` | string | Yes | `StandardEventType` or `AdhocEventType`. |
| `color` | string | Yes | Hex color for scheduling page. **Pattern:** `^#[a-f\d]{6}$`. **Example:** `#fff200` |
| `created_at` | string (date-time) | Yes | When created. |
| `updated_at` | string (date-time) | Yes | When last updated. |
| `internal_note` | string \| null | Yes | Internal note on the event type. |
| `description_plain` | string \| null | Yes | Description (plain text). |
| `description_html` | string \| null | Yes | Description (HTML). |
| `profile` | Profile \| null | Yes | Public profile of associated User or Team. |
| `secret` | boolean | Yes | Hidden from owner's main scheduling page. |
| `booking_method` | string | Yes | `instant` or `poll`. |
| `custom_questions` | array[Event Type Custom Question] | Yes | Custom booking questions. |
| `deleted_at` | string (date-time) \| null | Yes | When deleted (type may still be needed for past scheduled events). |
| `admin_managed` | boolean | Yes | Managed by an organization admin. |
| `locations` | array[Location Configuration] \| null | Yes | Possible location configurations. |
| `position` | integer | Yes | Display order (0-based). |
| `locale` | string | Yes | Scheduling page locale: `en`, `fr`, `es`, `de`, `nl`, `pt`, `it`, `uk`. **Example:** `de` |

#### Event Type Custom Question

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Question label. |
| `type` | string | Yes | `string`, `text`, `phone_number`, `single_select`, `multi_select`, etc. |
| `position` | integer | Yes | Display order. |
| `enabled` | boolean | Yes | Whether the question is enabled. |
| `required` | boolean | Yes | Whether an answer is required. |
| `answer_choices` | array[string] \| null | Yes | Choices for select types; `null` otherwise. |
| `include_other` | boolean | Yes | Whether "other" is allowed for select types. |

---

## Shared nested types

### Cancellation

Data for cancellation of an Event or Invitee.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `canceled_by` | string | Yes | Name of person who canceled. |
| `reason` | string \| null | Yes | Cancellation reason. |
| `canceler_type` | string | Yes | `host` or `invitee`. |
| `created_at` | string (date-time) | Yes | When the cancellation was created. **Example:** `2019-01-02T03:04:05.678123Z` |

### Guest

An individual invited by the invitee as an additional attendee.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string (email) | Yes | Guest email. |
| `created_at` | string (date-time) | Yes | When the guest was added. |
| `updated_at` | string (date-time) | Yes | When the guest was last updated. |

### Profile

Public profile of a User or Team associated with an Event Type. Nullable when no profile applies.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | Yes | `User` or `Team`. |
| `name` | string | Yes | Profile display name. **Example:** `Tamara Jones` |
| `owner` | string (URI) | Yes | User or team owner URI. **Example:** `https://api.calendly.com/users/AAAAAAAAAAAAAAAA` |

### Location Configuration

Configuration for a possible Event Type location (not the same object as scheduled-event `location`).

| Field | Type | Description |
| --- | --- | --- |
| `kind` | string | `ask_invitee`, `custom`, `google_conference`, `gotomeeting_conference`, `inbound_call`, `microsoft_teams_conference`, `outbound_call`, `physical`, `webex_conference`, `zoom_conference` |
| `location` | string | Location detail (when applicable). |
| `additional_info` | string | Extra location info. |
| `phone_number` | string | Phone number (e.g. inbound call). |

Nullable at the array level (`locations` may be `null`).

### Location (scheduled event)

Location on a **scheduled event** inside Invitee Payload webhooks. Webhook samples use `type` (not `kind`):

| Field | Type | Description |
| --- | --- | --- |
| `type` | string | e.g. `physical` |
| `location` | string | Address or place description. |
| `additional_info` | string | Additional location details. |

Other location types (Zoom, Google Meet, phone, etc.) use additional fields per Calendly's full Location schema.

### Invitee Tracking

| Field | Type | Description |
| --- | --- | --- |
| `utm_campaign` | string \| null | UTM campaign. |
| `utm_source` | string \| null | UTM source. |
| `utm_medium` | string \| null | UTM medium. |
| `utm_content` | string \| null | UTM content. |
| `utm_term` | string \| null | UTM term. |
| `salesforce_uuid` | string \| null | Salesforce UUID. |

### Invitee Question and Answer

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | string | Yes | Question text from the booking form. |
| `answer` | string | Yes | Invitee's answer. |
| `position` | integer | Yes | Question order on the form. |

---

## Examples

### Invitee Created

```json
{
  "created_at": "2020-11-23T17:51:19.000000Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "event": "invitee.created",
  "payload": {
    "cancel_url": "https://calendly.com/cancellations/AAAAAAAAAAAAAAAA",
    "created_at": "2020-11-23T17:51:18.327602Z",
    "email": "test@example.com",
    "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "name": "John Doe",
    "new_invitee": null,
    "old_invitee": null,
    "questions_and_answers": [],
    "reschedule_url": "https://calendly.com/reschedulings/AAAAAAAAAAAAAAAA",
    "rescheduled": false,
    "status": "active",
    "text_reminder_number": null,
    "timezone": "America/New_York",
    "tracking": {
      "utm_campaign": null,
      "utm_source": null,
      "utm_medium": null,
      "utm_content": null,
      "utm_term": null,
      "salesforce_uuid": null
    },
    "updated_at": "2020-11-23T17:51:18.341657Z",
    "uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "scheduled_event": {
      "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
      "name": "15 Minute Meeting",
      "meeting_notes_plain": "Internal meeting notes",
      "meeting_notes_html": "<p>Internal meeting notes</p>",
      "status": "active",
      "start_time": "2019-08-24T14:15:22.123456Z",
      "end_time": "2019-08-24T14:15:22.123456Z",
      "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
      "location": {
        "type": "physical",
        "location": "string",
        "additional_info": "string"
      },
      "invitees_counter": {
        "total": 0,
        "active": 0,
        "limit": 0
      },
      "created_at": "2019-01-02T03:04:05.678123Z",
      "updated_at": "2019-01-02T03:04:05.678123Z",
      "event_memberships": [
        {
          "user": "https://api.calendly.com/users/GBGBDCAADAEDCRZ2",
          "user_email": "user@example.com",
          "user_name": "John Smith"
        }
      ],
      "event_guests": [
        {
          "email": "user@example.com",
          "created_at": "2019-08-24T14:15:22.123456Z",
          "updated_at": "2019-08-24T14:15:22.123456Z"
        }
      ]
    }
  }
}
```

### Invitee Canceled

```json
{
  "created_at": "2020-11-23T17:54:22.000000Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "event": "invitee.canceled",
  "payload": {
    "cancel_url": "https://calendly.com/cancellations/AAAAAAAAAAAAAAAA",
    "created_at": "2020-11-23T17:51:18.327602Z",
    "email": "test@example.com",
    "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "name": "John Doe",
    "new_invitee": null,
    "old_invitee": null,
    "questions_and_answers": [],
    "reschedule_url": "https://calendly.com/reschedulings/AAAAAAAAAAAAAAAA",
    "rescheduled": false,
    "status": "canceled",
    "text_reminder_number": null,
    "timezone": "America/New_York",
    "tracking": {
      "utm_campaign": null,
      "utm_source": null,
      "utm_medium": null,
      "utm_content": null,
      "utm_term": null,
      "salesforce_uuid": null
    },
    "updated_at": "2020-11-23T17:54:22.356897Z",
    "uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "cancellation": {
      "canceled_by": "John Doe",
      "reason": "Meeting Conflict",
      "canceler_type": "invitee",
      "created_at": "2020-11-23T17:54:22.356897Z"
    },
    "scheduled_event": {
      "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
      "name": "15 Minute Meeting",
      "meeting_notes_plain": "Internal meeting notes",
      "meeting_notes_html": "<p>Internal meeting notes</p>",
      "status": "active",
      "start_time": "2019-08-24T14:15:22.123456Z",
      "end_time": "2019-08-24T14:15:22.123456Z",
      "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
      "location": {
        "type": "physical",
        "location": "string",
        "additional_info": "string"
      },
      "invitees_counter": {
        "total": 0,
        "active": 0,
        "limit": 0
      },
      "created_at": "2019-01-02T03:04:05.678123Z",
      "updated_at": "2019-01-02T03:04:05.678123Z",
      "event_memberships": [
        {
          "user": "https://api.calendly.com/users/GBGBDCAADAEDCRZ2",
          "user_email": "user@example.com",
          "user_name": "John Smith"
        }
      ],
      "event_guests": [
        {
          "email": "user@example.com",
          "created_at": "2019-08-24T14:15:22.123456Z"
        }
      ]
    }
  }
}
```

### Invitee No Show Created

```json
{
  "created_at": "2020-11-23T17:51:19.000000Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "event": "invitee_no_show.created",
  "payload": {
    "cancel_url": "https://calendly.com/cancellations/AAAAAAAAAAAAAAAA",
    "created_at": "2020-11-23T17:51:18.327602Z",
    "email": "test@example.com",
    "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "name": "John Doe",
    "new_invitee": null,
    "old_invitee": null,
    "no_show": {
      "uri": "https://api.calendly.com/invitee_no_shows/AAAAAAAAAAAAAAAA",
      "created_at": "2020-11-23T17:51:18.341657Z"
    },
    "questions_and_answers": [],
    "reschedule_url": "https://calendly.com/reschedulings/AAAAAAAAAAAAAAAA",
    "rescheduled": false,
    "status": "active",
    "text_reminder_number": null,
    "timezone": "America/New_York",
    "tracking": {
      "utm_campaign": null,
      "utm_source": null,
      "utm_medium": null,
      "utm_content": null,
      "utm_term": null,
      "salesforce_uuid": null
    },
    "updated_at": "2020-11-23T17:51:18.341657Z",
    "uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "scheduled_event": {
      "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
      "name": "15 Minute Meeting",
      "meeting_notes_plain": "Internal meeting notes",
      "meeting_notes_html": "<p>Internal meeting notes</p>",
      "status": "active",
      "start_time": "2019-08-24T14:15:22.123456Z",
      "end_time": "2019-08-24T14:15:22.123456Z",
      "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
      "location": {
        "type": "physical",
        "location": "string",
        "additional_info": "string"
      },
      "invitees_counter": {
        "total": 0,
        "active": 0,
        "limit": 0
      },
      "created_at": "2019-01-02T03:04:05.678123Z",
      "updated_at": "2019-01-02T03:04:05.678123Z",
      "event_memberships": [
        {
          "user": "https://api.calendly.com/users/GBGBDCAADAEDCRZ2",
          "user_email": "user@example.com",
          "user_name": "John Smith"
        }
      ],
      "event_guests": [
        {
          "email": "user@example.com",
          "created_at": "2019-08-24T14:15:22.123456Z",
          "updated_at": "2019-08-24T14:15:22.123456Z"
        }
      ]
    }
  }
}
```

### Invitee No Show Deleted

```json
{
  "created_at": "2020-11-23T17:51:19.000000Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "event": "invitee_no_show.deleted",
  "payload": {
    "cancel_url": "https://calendly.com/cancellations/AAAAAAAAAAAAAAAA",
    "created_at": "2020-11-23T17:51:18.327602Z",
    "email": "test@example.com",
    "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "name": "John Doe",
    "new_invitee": null,
    "old_invitee": null,
    "questions_and_answers": [],
    "reschedule_url": "https://calendly.com/reschedulings/AAAAAAAAAAAAAAAA",
    "rescheduled": false,
    "status": "active",
    "text_reminder_number": null,
    "timezone": "America/New_York",
    "tracking": {
      "utm_campaign": null,
      "utm_source": null,
      "utm_medium": null,
      "utm_content": null,
      "utm_term": null,
      "salesforce_uuid": null
    },
    "updated_at": "2020-11-23T17:51:18.341657Z",
    "uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "scheduled_event": {
      "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
      "name": "15 Minute Meeting",
      "meeting_notes_plain": "Internal meeting notes",
      "meeting_notes_html": "<p>Internal meeting notes</p>",
      "status": "active",
      "start_time": "2019-08-24T14:15:22.123456Z",
      "end_time": "2019-08-24T14:15:22.123456Z",
      "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
      "location": {
        "type": "physical",
        "location": "string",
        "additional_info": "string"
      },
      "invitees_counter": {
        "total": 0,
        "active": 0,
        "limit": 0
      },
      "created_at": "2019-01-02T03:04:05.678123Z",
      "updated_at": "2019-01-02T03:04:05.678123Z",
      "event_memberships": [
        {
          "user": "https://api.calendly.com/users/GBGBDCAADAEDCRZ2",
          "user_email": "user@example.com",
          "user_name": "John Smith"
        }
      ],
      "event_guests": [
        {
          "email": "user@example.com",
          "created_at": "2019-08-24T14:15:22.123456Z",
          "updated_at": "2019-08-24T14:15:22.123456Z"
        }
      ]
    }
  }
}
```

### Routing Form Submission Created

```json
{
  "event": "routing_form_submission.created",
  "created_at": "2022-05-15T14:59:59.000000Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "payload": {
    "uri": "https://api.calendly.com/routing_form_submissions/AAAAAAAAAAAAAAAA",
    "routing_form": "https://api.calendly.com/routing_forms/AAAAAAAAAAAAAAAA",
    "questions_and_answers": [
      {
        "question_uuid": "123e4567-e89b-12d3-a456-426614174000",
        "question": "What is your industry?",
        "answer": "IT & Software"
      }
    ],
    "tracking": {
      "utm_campaign": null,
      "utm_source": null,
      "utm_medium": null,
      "utm_content": null,
      "utm_term": null,
      "salesforce_uuid": null
    },
    "result": {
      "type": "event_type",
      "value": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2"
    },
    "submitter": "https://calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "submitter_type": "Invitee",
    "created_at": "2022-05-15T03:04:05.678Z",
    "updated_at": "2022-05-15T06:05:04.321Z"
  }
}
```

### Invitee Payload (full schema example — active)

From OpenAPI `InviteePayload` x-examples (`Invitee`). Includes optional nested objects often omitted in minimal webhook samples.

```json
{
  "cancel_url": "https://calendly.com/cancellations/AAAAAAAAAAAAAAAA",
  "created_at": "2020-11-23T17:51:18.327602Z",
  "email": "test@example.com",
  "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
  "first_name": "John",
  "last_name": "Doe",
  "name": "John Doe",
  "new_invitee": null,
  "old_invitee": null,
  "questions_and_answers": [],
  "reschedule_url": "https://calendly.com/reschedulings/AAAAAAAAAAAAAAAA",
  "rescheduled": false,
  "status": "active",
  "text_reminder_number": null,
  "timezone": "America/New_York",
  "tracking": {
    "utm_campaign": null,
    "utm_source": null,
    "utm_medium": null,
    "utm_content": null,
    "utm_term": null,
    "salesforce_uuid": null
  },
  "updated_at": "2020-11-23T17:51:18.341657Z",
  "uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
  "routing_form_submission": "https://api.calendly.com/routing_form_submissions/AAAAAAAAAAAAAAAA",
  "payment": {
    "external_id": "ch_AAAAAAAAAAAAAAAAAAAAAAAA",
    "provider": "stripe",
    "amount": 1234.56,
    "currency": "USD",
    "terms": "sample terms of payment (up to 1,024 characters)",
    "successful": true
  },
  "no_show": {
    "uri": "https://api.calendly.com/invitee_no_shows/6ee96ed4-83a3-4966-a278-cd19b3c02e09",
    "created_at": "2020-11-23T17:51:18.341657Z"
  },
  "reconfirmation": {
    "created_at": "2020-11-23T17:51:18.341657Z",
    "confirmed_at": "2020-11-23T20:01:18.341657Z"
  },
  "scheduling_method": null,
  "invitee_scheduled_by": null,
  "scheduled_event": {
    "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
    "name": "15 Minute Meeting",
    "meeting_notes_plain": "Internal meeting notes",
    "meeting_notes_html": "<p>Internal meeting notes</p>",
    "status": "active",
    "start_time": "2019-08-24T14:15:22.123456Z",
    "end_time": "2019-08-24T14:15:22.123456Z",
    "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
    "location": {
      "type": "physical",
      "location": "string",
      "additional_info": "string"
    },
    "invitees_counter": {
      "total": 0,
      "active": 0,
      "limit": 0
    },
    "created_at": "2019-01-02T03:04:05.678123Z",
    "updated_at": "2019-01-02T03:04:05.678123Z",
    "event_memberships": [
      {
        "user": "https://api.calendly.com/users/GBGBDCAADAEDCRZ2",
        "user_email": "user@example.com",
        "user_name": "John Smith"
      }
    ],
    "event_guests": [
      {
        "email": "user@example.com",
        "created_at": "2019-08-24T14:15:22.123456Z",
        "updated_at": "2019-08-24T14:15:22.123456Z"
      }
    ]
  }
}
```

### Invitee Payload (full schema example — canceled)

From OpenAPI `InviteePayload` x-examples (`Canceled Invitee`).

```json
{
  "cancel_url": "https://calendly.com/cancellations/AAAAAAAAAAAAAAAA",
  "created_at": "2020-11-23T17:51:18.327602Z",
  "email": "test@example.com",
  "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
  "first_name": "John",
  "last_name": "Doe",
  "name": "John Doe",
  "new_invitee": null,
  "old_invitee": null,
  "questions_and_answers": [],
  "reschedule_url": "https://calendly.com/reschedulings/AAAAAAAAAAAAAAAA",
  "rescheduled": false,
  "status": "canceled",
  "text_reminder_number": null,
  "timezone": "America/New_York",
  "tracking": {
    "utm_campaign": null,
    "utm_source": null,
    "utm_medium": null,
    "utm_content": null,
    "utm_term": null,
    "salesforce_uuid": null
  },
  "updated_at": "2020-11-23T17:54:22.356897Z",
  "uri": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
  "cancellation": {
    "canceled_by": "John Doe",
    "reason": "Meeting Conflict",
    "canceler_type": "invitee",
    "created_at": "2020-11-23T17:54:22.356897Z"
  },
  "routing_form_submission": null,
  "payment": {
    "external_id": "ch_AAAAAAAAAAAAAAAAAAAAAAAA",
    "provider": "stripe",
    "amount": 1234.56,
    "currency": "USD",
    "terms": "sample terms of payment (up to 1,024 characters)",
    "successful": true
  },
  "reconfirmation": null,
  "scheduling_method": null,
  "invitee_scheduled_by": null,
  "scheduled_event": {
    "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
    "name": "15 Minute Meeting",
    "meeting_notes_plain": "Internal meeting notes",
    "meeting_notes_html": "<p>Internal meeting notes</p>",
    "status": "active",
    "start_time": "2019-08-24T14:15:22.123456Z",
    "end_time": "2019-08-24T14:15:22.123456Z",
    "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
    "location": {
      "type": "physical",
      "location": "string",
      "additional_info": "string"
    },
    "invitees_counter": {
      "total": 0,
      "active": 0,
      "limit": 0
    },
    "created_at": "2019-01-02T03:04:05.678123Z",
    "updated_at": "2019-01-02T03:04:05.678123Z",
    "event_memberships": [
      {
        "user": "https://api.calendly.com/users/GBGBDCAADAEDCRZ2",
        "user_email": "user@example.com",
        "user_name": "John Smith"
      }
    ],
    "event_guests": [
      {
        "email": "user@example.com",
        "created_at": "2019-08-24T14:15:22.123456Z",
        "updated_at": "2019-08-24T14:15:22.123456Z"
      }
    ]
  }
}
```

### Event Type Webhook Payload — Standard Event Type

```json
{
  "event": "event_type.created",
  "created_at": "2019-01-02T03:04:05.678123Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "payload": {
    "uri": "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA",
    "name": "15 Minute Meeting",
    "active": true,
    "booking_method": "instant",
    "slug": "acmesales",
    "scheduling_url": "https://calendly.com/acmesales",
    "duration": 15,
    "duration_options": [1, 13, 15, 720],
    "kind": "solo",
    "is_paid": false,
    "pooling_type": "round_robin",
    "type": "StandardEventType",
    "color": "#fff200",
    "created_at": "2019-01-02T03:04:05.678123Z",
    "updated_at": "2019-08-07T06:05:04.321123Z",
    "internal_note": "Event type note",
    "description_plain": "Event type description",
    "description_html": "<p>Event type description</p>",
    "profile": {
      "type": "User",
      "name": "Tamara Jones",
      "owner": "https://api.calendly.com/users/ABC123"
    },
    "secret": true,
    "deleted_at": null,
    "admin_managed": false,
    "locations": [
      {
        "kind": "inbound_call",
        "phone_number": "380934567654",
        "additional_info": "Additional information about location"
      }
    ],
    "position": 0,
    "custom_questions": [
      {
        "name": "Company Name",
        "type": "string",
        "position": 0,
        "enabled": true,
        "required": true,
        "answer_choices": null,
        "include_other": false
      },
      {
        "name": "What would you like to discuss?",
        "type": "text",
        "position": 0,
        "enabled": true,
        "required": true,
        "answer_choices": null,
        "include_other": false
      },
      {
        "name": "Number of employees",
        "answer_choices": ["1", "2-10", "11-20", "20+"],
        "enabled": true,
        "include_other": true,
        "position": 2,
        "required": false,
        "type": "single_select"
      },
      {
        "name": "Multi-Select Question",
        "answer_choices": ["Answer 1", "Answer 2", "Answer 3", "Answer 4"],
        "enabled": true,
        "include_other": true,
        "position": 2,
        "required": false,
        "type": "multi_select"
      },
      {
        "name": "Phone Number",
        "type": "phone_number",
        "position": 0,
        "enabled": true,
        "required": true,
        "answer_choices": null,
        "include_other": false
      }
    ],
    "locale": "en"
  }
}
```

### Event Type Webhook Payload — Adhoc Event Type

```json
{
  "event": "event_type.created",
  "created_at": "2019-01-02T03:04:05.678123Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "payload": {
    "uri": "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA",
    "name": "15 Minute Meeting",
    "active": true,
    "booking_method": "instant",
    "slug": "acmesales",
    "scheduling_url": "https://calendly.com/acmesales",
    "duration": 15,
    "duration_options": null,
    "kind": "solo",
    "pooling_type": null,
    "type": "AdhocEventType",
    "color": "#fff200",
    "created_at": "2019-01-02T03:04:05.678123Z",
    "updated_at": "2019-08-07T06:05:04.321123Z",
    "internal_note": "Event type note",
    "description_plain": "Event type description",
    "description_html": "<p>Event type description</p>",
    "profile": {
      "type": "User",
      "name": "Tamara Jones",
      "owner": "https://api.calendly.com/users/ABC123"
    },
    "secret": true,
    "deleted_at": null,
    "admin_managed": false,
    "locations": [
      {
        "kind": "inbound_call",
        "phone_number": "380934567654",
        "additional_info": "Additional information about location"
      }
    ],
    "position": 0,
    "custom_questions": [],
    "locale": "en",
    "is_paid": false
  }
}
```

---

Related: [Create Webhook Subscription](../pure-api/create-webhook.md), [Webhook Subscription object](../webhook-subscription-object.md), [Webhook signatures](../webhook-signature.md).
