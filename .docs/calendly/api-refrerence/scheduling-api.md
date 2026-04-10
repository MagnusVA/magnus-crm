# Create Event Invitee (Scheduling API)

**Endpoint:** `POST https://api.calendly.com/invitees`

Creates a new booking for an event invitee. Use this endpoint to book an invitee directly from your app without redirects, iframes, or Calendly-hosted UI.

Standard notifications, calendar invites, reschedules, and workflows run as if booked via the Calendly UI.

**NOTE:**

- Access to this endpoint is limited to Calendly users on paid plans (Standard and above). Users on the Free plan receive **403 Forbidden**.

**Required OAuth scope:** `scheduled_events:write`

## Authentication

Send a valid access token:

```http
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

OAuth endpoints (Authorization Code flow):

- Authorize: `https://auth.calendly.com/oauth/authorize`
- Token / refresh: `https://auth.calendly.com/oauth/token`

## Request body

Content type: `application/json`

### Top-level fields

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `event_type` | string (URI) | Yes | Canonical reference for the event type being scheduled |
| `start_time` | string (date-time) | Yes | Start time in **UTC** (e.g. `2019-08-07T06:05:04.321123Z`) |
| `invitee` | object | Yes | Invitee details (see below) |
| `location` | object | No | Location override; shape depends on event / location kind (e.g. in-person) |
| `questions_and_answers` | array | No | Booking form Q&A |
| `tracking` | object | No | UTM and Salesforce tracking (if included, fields inside are required per schema) |
| `event_guests` | string[] (email) | No | Guest emails; **max 10** |

### `invitee` object

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `email` | string | Yes | Invitee email |
| `timezone` | string | Yes | IANA timezone (e.g. `America/New_York`) |
| `name` | string | Conditional | Full name — **required if** `first_name` **is not** provided |
| `first_name` | string | Conditional | **Required if** `name` **is not** provided |
| `last_name` | string | No | Last name |
| `text_reminder_number` | string | No | SMS reminder number (valid phone, e.g. `+14155551234`) |

### `questions_and_answers` items

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `question` | string | Yes | Must **exactly** match the question text (case sensitive) |
| `answer` | string | Yes | Invitee’s answer |
| `position` | integer | Yes | Order of the question |

### `location` (example: in-person)

For an in-person meeting, Calendly documents a shape such as:

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `kind` | string | Yes | e.g. `physical` for in-person |
| `location` | string | Yes | Physical address or place description |

Other location kinds in the API correspond to phone calls, Zoom, Google Meet, Teams, Webex, custom locations, etc. (see Calendly’s OpenAPI/schema for the full discriminated union).

### `tracking` object (when present)

Each of these keys is required in the schema when you send `tracking` (values may be string or `null` where documented):

- `utm_campaign`, `utm_source`, `utm_medium`, `utm_content`, `utm_term`, `salesforce_uuid`

## Example request

```json
{
  "event_type": "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA",
  "start_time": "2019-08-07T06:05:04.321123Z",
  "invitee": {
    "name": "John Smith",
    "first_name": "John",
    "last_name": "Smith",
    "email": "test@example.com",
    "timezone": "America/New_York",
    "text_reminder_number": "+1 888-888-8888"
  },
  "location": {
    "kind": "physical",
    "location": "123 Main St"
  },
  "questions_and_answers": [
    {
      "question": "What is your company name?",
      "answer": "Acme Inc",
      "position": 0
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
  "event_guests": ["janedoe@calendly.com"]
}
```

### cURL

```bash
curl --request POST \
  --url https://api.calendly.com/invitees \
  --header "Authorization: Bearer <TOKEN>" \
  --header "Content-Type: application/json" \
  --data @body.json
```

## Responses

| Status | Meaning |
| ------ | ------- |
| 201 | Created — body contains `resource` (Invitee) |
| 400 | Bad request |
| 401 | Unauthorized |
| 403 | Forbidden (e.g. Free plan, or insufficient scope) |
| 404 | Not found |
| 500 | Server error |

### 201 response shape

The success payload wraps an **Invitee** in `resource`. Notable fields include:

- `uri` — invitee canonical URI
- `email`, `first_name`, `last_name`, `name`
- `status` — `active` or `canceled`
- `questions_and_answers`, `timezone`, `event` (scheduled event URI)
- `created_at`, `updated_at`
- `tracking`, `text_reminder_number`
- `rescheduled`, `old_invitee`, `new_invitee`
- `cancel_url`, `reschedule_url`
- `routing_form_submission`, `cancellation`, `payment`, `no_show`, `reconfirmation`
- `scheduling_method` — e.g. `instant_book` or `null`
- `invitee_scheduled_by`

**Example (illustrative):**

```json
{
  "resource": {
    "uri": "https://calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "email": "test@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "name": "John Doe",
    "status": "active",
    "questions_and_answers": [],
    "timezone": "America/New_York",
    "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "created_at": "2019-01-02T03:04:05.678123Z",
    "updated_at": "2019-08-07T06:05:04.321123Z",
    "tracking": {
      "utm_campaign": null,
      "utm_source": null,
      "utm_medium": null,
      "utm_content": null,
      "utm_term": null,
      "salesforce_uuid": null
    },
    "text_reminder_number": null,
    "rescheduled": false,
    "old_invitee": null,
    "new_invitee": null,
    "cancel_url": "https://calendly.com/…",
    "reschedule_url": "https://calendly.com/…",
    "routing_form_submission": null,
    "cancellation": null,
    "payment": null,
    "no_show": null,
    "reconfirmation": null,
    "scheduling_method": "instant_book",
    "invitee_scheduled_by": null
  }
}
```

## Source

Derived from Calendly’s public API documentation for **Create Event Invitee** (Scheduling API). For authoritative schema details and additional location variants, use the official Calendly API reference.
