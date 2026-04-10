# Get Event Type

**Endpoint:** `GET https://api.calendly.com/event_types/{uuid}`

Returns a single **event type** (the template for bookable meetings: duration, scheduling URL, custom questions, locations, etc.). Use this to resolve `event_type` URIs from webhooks or scheduling flows, or to introspect form fields (`custom_questions`) for API bookings.

**Required OAuth scope:** `event_types:read`

## Authentication

```http
Authorization: Bearer <TOKEN>
```

OAuth endpoints (Authorization Code flow):

- Authorize: `https://auth.calendly.com/oauth/authorize`
- Token / refresh: `https://auth.calendly.com/oauth/token`

## Path parameters

| Parameter | Type   | Description                                                               |
| --------- | ------ | ------------------------------------------------------------------------- |
| `uuid`    | string | Event type UUID (the segment after `/event_types/` in the event type URI) |

## Responses

| Status | Meaning                                         |
| ------ | ----------------------------------------------- |
| 200    | Success — body contains `resource` (Event Type) |
| 401    | Unauthorized                                    |
| 403    | Forbidden (insufficient scope)                  |
| 404    | Event type not found                            |
| 500    | Server error                                    |

### 200 — `resource` (Event Type)

Notable fields on `resource` (see Calendly’s OpenAPI for the full schema):

| Field                                   | Type               | Description                                                    |
| --------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `uri`                                   | string             | Canonical API URI for this event type                          |
| `name`                                  | string             | Display name                                                   |
| `active`                                | boolean            | Whether the event type accepts new bookings                    |
| `booking_method`                        | string             | e.g. `instant`                                                 |
| `slug`                                  | string             | URL slug                                                       |
| `scheduling_url`                        | string             | Calendly-hosted booking URL for invitees                       |
| `duration`                              | integer            | Length in minutes                                              |
| `duration_options`                      | integer[]          | Allowed durations when multiple are configured                 |
| `kind`                                  | string             | e.g. `solo`                                                    |
| `pooling_type`                          | string             | e.g. `round_robin` for team types                              |
| `type`                                  | string             | e.g. `StandardEventType`                                       |
| `color`                                 | string             | UI color                                                       |
| `created_at`, `updated_at`              | string (date-time) | ISO8601 timestamps                                             |
| `internal_note`                         | string \| null     | Host-only note                                                 |
| `is_paid`                               | boolean            | Paid event flag                                                |
| `description_plain`, `description_html` | string             | Invitee-facing description                                     |
| `profile`                               | object             | Owning profile summary (e.g. `type`, `name`, `owner` user URI) |
| `secret`                                | boolean            | “Secret” event type                                            |
| `deleted_at`                            | string \| null     | Soft-delete timestamp                                          |
| `admin_managed`                         | boolean            | Org-admin managed                                              |
| `locations`                             | array              | Location objects (`kind`, phone, etc.)                         |
| `position`                              | integer            | Ordering                                                       |
| `custom_questions`                      | array              | Booking form fields (see below)                                |
| `locale`                                | string             | e.g. `en`                                                      |

### `custom_questions` items

| Field            | Type     | Description                                                            |
| ---------------- | -------- | ---------------------------------------------------------------------- |
| `name`           | string   | Question text (must match for Scheduling API `questions_and_answers`)  |
| `type`           | string   | e.g. `string`, `text`, `single_select`, `multi_select`, `phone_number` |
| `position`       | integer  | Order                                                                  |
| `enabled`        | boolean  | Shown on the form                                                      |
| `required`       | boolean  | Required for invitees                                                  |
| `answer_choices` | string[] | For select types                                                       |
| `include_other`  | boolean  | “Other” option for selects                                             |

## Example request

### cURL

```bash
curl --request GET \
  --url "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA" \
  --header "Authorization: Bearer <TOKEN>" \
  --header "Content-Type: application/json"
```

## Example response (illustrative)

```json
{
	"resource": {
		"uri": "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA",
		"name": "15 Minute Meeting",
		"active": true,
		"booking_method": "instant",
		"slug": "acmesales",
		"scheduling_url": "https://calendly.com/acmesales",
		"duration": 15,
		"duration_options": [15, 30, 60],
		"kind": "solo",
		"pooling_type": "round_robin",
		"type": "StandardEventType",
		"color": "#fff200",
		"created_at": "2019-01-02T03:04:05.678123Z",
		"updated_at": "2019-08-07T06:05:04.321123Z",
		"internal_note": "Internal note",
		"is_paid": false,
		"description_plain": "15 Minute Meeting",
		"description_html": "<p>15 Minute Meeting</p>",
		"profile": {
			"type": "User",
			"name": "Tamara Jones",
			"owner": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA"
		},
		"secret": true,
		"deleted_at": null,
		"admin_managed": false,
		"locations": [
			{
				"kind": "inbound_call",
				"phone_number": "+380934567654",
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
				"answer_choices": [],
				"include_other": false
			},
			{
				"name": "Phone Number",
				"type": "phone_number",
				"position": 1,
				"enabled": true,
				"required": true,
				"answer_choices": [],
				"include_other": false
			}
		],
		"locale": "en"
	}
}
```

## Related

- **Create booking (Scheduling API):** `scheduling-api.md` — use `event_type` URI and `questions_and_answers` aligned with `custom_questions[].name` and `position`.
- **Scheduled event instance (different resource):** `GET /scheduled_events/{uuid}` — a concrete booked occurrence, not the event type template.

## Source

Derived from Calendly’s public API documentation for **Get Event Type**. For authoritative schema and edge cases, use the official Calendly API reference.
