# Get sample webhook data

**`GET`** `https://api.calendly.com/sample_webhook_data`

Return a **sample** webhook body for a given event type and scope so you can test your handler (parsing, validation, routing) without waiting for a real Calendly event.

> **Required scopes:** `webhooks:read`

The JSON shape matches the **Webhook Payload** object Calendly sends to your subscription URL: top-level `event`, `created_at`, `created_by`, and `payload` (variant depends on `event`). Field-level reference: [Webhook payload](../webhook-events-samples/webhook-payload.md).

See also: [Create Webhook Subscription](./create-webhook.md), [Webhook signature verification](../webhook-signature.md) (sample responses are not signed like real deliveries).

## Request

### Security: OAuth 2.0

Put the access token in the `Authorization: Bearer <TOKEN>` header.

**Authorization Code OAuth Flow**

- Authorize URL: [https://auth.calendly.com/oauth/authorize](https://auth.calendly.com/oauth/authorize)
- Token URL: [https://auth.calendly.com/oauth/token](https://auth.calendly.com/oauth/token)
- Refresh URL: [https://auth.calendly.com/oauth/token](https://auth.calendly.com/oauth/token)

### Security: Bearer Auth

Put the access token in the `Authorization: Bearer <TOKEN>` header.

Example: `Authorization: Bearer <access_token>`

### Query parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | string | Yes | Sample event to generate. **Allowed:** `invitee.created`, `invitee.canceled`, `invitee_no_show.created`, `invitee_no_show.deleted`, `routing_form_submission.created`, `event_type.created`, `event_type.deleted`, `event_type.updated`. |
| `organization` | string (URI) | Yes | Organization context for the sample. **Example:** `https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA` |
| `scope` | string | Yes | **`organization`**, **`user`**, or **`group`** — aligns with webhook subscription scope. |
| `user` | string (URI) | If `scope=user` | User URI for user-scoped sample. **Example:** `https://api.calendly.com/users/AAAAAAAAAAAAAAAA` |
| `group` | string (URI) | If `scope=group` | Group URI for group-scoped sample. **Example:** `https://api.calendly.com/groups/AAAAAAAAAAAAAAAA` |

Include `user` when `scope` is `user`, and `group` when `scope` is `group`.

## Responses

Possible HTTP status codes: **200**, **400**, **401**, **403**, **404**, **500**.

### `200` OK

**Body** (`application/json`): **Webhook Payload** object.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event` | string | Yes | Echoes the requested event type. |
| `created_at` | string (date-time) | Yes | Sample timestamp for the webhook envelope. |
| `created_by` | string (URI) | Yes | Sample user URI (creator of the webhook subscription). |
| `payload` | object | Yes | Event-specific payload: **Invitee Payload**, **Routing Form Submission**, or **Event Type Webhook Payload** depending on `event`. See [webhook-payload.md](../webhook-events-samples/webhook-payload.md). |

### Example request (cURL)

Minimal query (add `user` or `group` when `scope` requires it):

```bash
curl --request GET \
  --url 'https://api.calendly.com/sample_webhook_data?event=invitee.created&organization=https%3A%2F%2Fapi.calendly.com%2Forganizations%2FAAAAAAAAAAAAAAAA&scope=user' \
  --header 'Authorization: Bearer {access_token}' \
  --header 'Content-Type: application/json'
```

### Example response (`200`)

Illustrative **`invitee.created`** sample from the interactive docs (`scope=user`). Other `event` values return different `payload` shapes per the schema.

```json
{
  "event": "invitee.created",
  "created_at": "2019-08-24T14:15:22Z",
  "created_by": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
  "payload": {
    "uri": "https://calendly.com/scheduled_events/AAAAAAAAAAAAAAAA/invitees/AAAAAAAAAAAAAAAA",
    "email": "test@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "name": "John Doe",
    "status": "active",
    "questions_and_answers": [
      {
        "question": "string",
        "answer": "string",
        "position": 0
      }
    ],
    "timezone": "string",
    "event": "https://api.calendly.com/scheduled_events/AAAAAAAAAAAAAAAA",
    "created_at": "2019-01-02T03:04:05.678123Z",
    "updated_at": "2019-08-07T06:05:04.321123Z",
    "tracking": {
      "utm_campaign": "string",
      "utm_source": "string",
      "utm_medium": "string",
      "utm_content": "string",
      "utm_term": "string",
      "salesforce_uuid": "string"
    },
    "text_reminder_number": "+1 404-555-1234",
    "rescheduled": true,
    "old_invitee": "http://example.com",
    "new_invitee": "http://example.com",
    "cancel_url": "http://example.com",
    "reschedule_url": "http://example.com",
    "routing_form_submission": "https://api.calendly.com/routing_form_submissions/AAAAAAAAAAAAAAAA",
    "cancellation": {
      "canceled_by": "string",
      "reason": "string",
      "canceler_type": "host",
      "created_at": "2019-01-02T03:04:05.678123Z"
    },
    "payment": {
      "external_id": "string",
      "provider": "stripe",
      "amount": 0,
      "currency": "AUD",
      "terms": "sample terms of payment (up to 1,024 characters)",
      "successful": true
    },
    "no_show": {
      "uri": "string",
      "created_at": "2019-01-02T03:04:05.678123Z"
    },
    "reconfirmation": {
      "created_at": "2020-11-23T17:51:18.341657Z",
      "confirmed_at": "2020-11-23T17:51:18.341657Z"
    },
    "scheduling_method": "instant_book",
    "invitee_scheduled_by": "http://example.com",
    "scheduled_event": {
      "uri": "https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2",
      "name": "15 Minute Meeting",
      "meeting_notes_plain": "15 Minute Meeting",
      "meeting_notes_html": "<p>15 Minute Meeting</p>",
      "status": "active",
      "start_time": "2019-08-24T14:15:22Z",
      "end_time": "2019-08-24T14:15:22Z",
      "event_type": "https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2",
      "location": {
        "type": "physical",
        "location": "Calendly Office",
        "additional_info": "Please check in at the main lobby."
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
          "created_at": "2019-08-24T14:15:22Z",
          "updated_at": "2019-08-24T14:15:22Z"
        }
      ],
      "cancellation": {
        "canceled_by": "string",
        "reason": "string",
        "canceler_type": "host",
        "created_at": "2019-01-02T03:04:05.678123Z"
      }
    }
  }
}
```

### `400` / `401` / `403` / `404` / `500`

Invalid query parameters, auth failure, permission issues, not found, or server error. Use the standard Calendly API error patterns where applicable.
