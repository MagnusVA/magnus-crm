# Webhook Payload

Webhook Payload Object.

## Root fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | Yes | The event that caused the webhook to fire. See allowed values below. |
| `created_at` | string (date-time) | Yes | The moment when the event was created (e.g. `2020-01-02T03:04:05.678123Z`). |
| `created_by` | string (URI) | Yes | The user who created the webhook. **Example:** `https://api.calendly.com/users/AAAAAAAAAAAAAAAA` |
| `payload` | object | Yes | Event-specific payload. **One of:** Invitee Payload, Routing Form Submission, Event Type Webhook Payload (see below). |

### `event` allowed values

- `invitee.created`
- `invitee.canceled`
- `invitee_no_show.created`
- `invitee_no_show.deleted`
- `routing_form_submission.created`
- `event_type.created`
- `event_type.deleted`
- `event_type.updated`

## `payload` variants

The schema viewer labels `payload` as **one of**:

1. **Invitee Payload** — The payload sent when an invitee creates or schedules a meeting, and when an invitee cancels.
2. **Routing Form Submission**
3. **Event Type Webhook Payload**

### Invitee Payload

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `uri` | string (URI) | Yes | Canonical reference (unique identifier) for the invitee. **Example:** `https://calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA` |
| `email` | string (email) | Yes | The invitee’s email address. **Example:** `test@example.com` |
| `first_name` | string \| null | Yes | First name when the event type uses separate first/last name fields; `null` when a single name field is used. **Example:** `John` |
| `last_name` | string \| null | Yes | Last name when the event type uses separate first/last name fields; `null` when a single name field is used. **Example:** `Doe` |
| `name` | string | Yes | The invitee’s name (human-readable). **Example:** `John Doe` |
| `status` | string | Yes | `active` or `canceled`. |
| `questions_and_answers` | array | Yes | Invitee responses to booking form questions (items: **Invitee Question and Answer**). `>= 0` items. |
| `timezone` | string \| null | Yes | Time zone used when displaying time to the invitee. |
| `event` | string (URI) | Yes | Reference to the scheduled event. **Example:** `https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA` |
| `created_at` | string (date-time) | Yes | When the invitee record was created. **Example:** `2019-01-02T03:04:05.678123Z` |
| `updated_at` | string (date-time) | Yes | When the invitee record was last updated. **Example:** `2019-08-07T06:05:04.321123Z` |
| `tracking` | object | Yes | UTM and Salesforce tracking parameters (**Invitee Tracking**). |
| `text_reminder_number` | string \| null | Yes | Phone number for SMS reminders. **Example:** `+1 404-555-1234` |
| `rescheduled` | boolean | Yes | If `true`, see `new_invitee`; references the new Invitee instance. |
| `old_invitee` | string (URI) \| null | Yes | Reference to the previous Invitee when rescheduled. |
| `new_invitee` | string (URI) \| null | Yes | Link to the new invitee after reschedule. |
| `cancel_url` | string (URI) | Yes | Link for the invitee to cancel the event. |
| `reschedule_url` | string (URI) | Yes | Link for the invitee to reschedule the event. |
| `routing_form_submission` | string (URI) \| null | Yes | Routing form submission that redirected the invitee. **Example:** `https://api.calendly.com/routing_form_submissions/AAAAAAAAAAAAAAAA` |
| `cancellation` | object | No | Data for cancellation of the event or invitee. |
| `payment` | object \| null | Yes | Invitee payment. |
| `no_show` | object \| null | Yes | Data for the invitee no-show. |
| `reconfirmation` | object \| null | Yes | When reconfirmation is enabled: includes `created_at` when notification was sent; `confirmed_at` becomes non-null after the invitee reconfirms. |
| `scheduling_method` | string \| null | Yes | How the event was scheduled. **Allowed values:** `instant_book`, `null`. |
| `invitee_scheduled_by` | string (URI) \| null | Yes | User URI of who scheduled the event. |
| `scheduled_event` | object | Yes | Information about the invitee’s scheduled meeting. |

### Routing Form Submission (`payload` for `routing_form_submission.created`)

The interactive docs list this variant; field-level schema was not expanded in the captured page. Shape is illustrated in [Example: Routing Form Submission Created](#example-routing-form-submission-created) below.

### Event Type Webhook Payload

Listed in the schema UI for `event_type.created`, `event_type.deleted`, and `event_type.updated`. No example was included in the provided material.

## Examples

### Example: Invitee Created

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

### Example: Invitee Canceled

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

### Example: Invitee No Show Created

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

### Example: Routing Form Submission Created

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

Related: [Create Webhook Subscription](../pure-api/create-webhook.md), [Webhook signatures](../webhook-signature.md).
