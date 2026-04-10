# List Event Type Available Times

**Endpoint:** `GET https://api.calendly.com/event_type_available_times`

Returns a list of available times for an event type within a specified date range.

The date range **cannot exceed one week (7 days)**.

**NOTE:**

- This endpoint does **not** support traditional keyset pagination.

**Required OAuth scope:** `availability:read`

## Authentication

```http
Authorization: Bearer <TOKEN>
```

OAuth endpoints (Authorization Code flow):

- Authorize: `https://auth.calendly.com/oauth/authorize`
- Token / refresh: `https://auth.calendly.com/oauth/token`

## Query parameters

All query parameters are **required**.

| Parameter    | Type           | Description |
| ------------ | -------------- | ----------- |
| `event_type` | string (URI)   | URI of the event type (e.g. `https://api.calendly.com/event_types/…`) |
| `start_time` | string         | Start of the availability window. **Must not** be in the past. |
| `end_time`   | string         | End of the availability window. **Must** be after `start_time`. |

Example values from Calendly’s docs:

- `start_time`: `2020-01-02T20:00:00.000000Z`
- `end_time`: `2020-01-07T24:00:00.000000Z` (as shown in their reference; prefer valid ISO8601 end-of-range times in your client if your stack rejects `T24`)

## Responses

| Status | Meaning |
| ------ | ------- |
| 200 | OK — body contains `collection` of available slots |
| 400 | Bad request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not found |
| 500 | Server error |

### 200 — body

Top-level field:

| Field        | Type  | Description |
| ------------ | ----- | ----------- |
| `collection` | array | Available times matching the request (see items below) |

Each item in `collection` (**Event Type Available Time**):

| Field | Type           | Description |
| -------------------- | -------------- | ----------- |
| `status`             | string         | e.g. `available` for an open slot |
| `invitees_remaining` | number         | Remaining invitee capacity for this slot. For **group** event types, more than one invitee can book the same time; for other types, typically **1**. |
| `start_time`         | string (date-time) | Scheduled start in **UTC** |
| `scheduling_url`     | string (URI)   | Calendly scheduling URL where an invitee can book this event type for that slot |

## Example request

### cURL

```bash
curl --request GET \
  --url 'https://api.calendly.com/event_type_available_times?event_type=https%3A%2F%2Fapi.calendly.com%2Fevent_types%2FAAAAAAAAAAAAAAAA&start_time=2020-01-02T20%3A00%3A00.000000Z&end_time=2020-01-07T24%3A00%3A00.000000Z' \
  --header 'Authorization: Bearer <TOKEN>' \
  --header 'Content-Type: application/json'
```

(Decode query keys: `event_type`, `start_time`, `end_time`.)

### Example response

```json
{
  "collection": [
    {
      "status": "available",
      "invitees_remaining": 2,
      "start_time": "2020-01-02T20:00:00.000000Z",
      "scheduling_url": "https://calendly.com/acmesales/discovery-call/2020-01-02T20:00:00Z?month=2020-01&date=2020-01-02"
    },
    {
      "status": "available",
      "invitees_remaining": 1,
      "start_time": "2020-01-03T15:00:00.000000Z",
      "scheduling_url": "https://calendly.com/acmesales/discovery-call/2020-01-03T15:00:00Z?month=2020-01&date=2020-01-03"
    },
    {
      "status": "available",
      "invitees_remaining": 3,
      "start_time": "2020-01-07T23:00:00.000000Z",
      "scheduling_url": "https://calendly.com/acmesales/discovery-call/2020-01-07T23:00:00Z?month=2020-01&date=2020-01-07"
    }
  ]
}
```

## Source

Derived from Calendly’s public API documentation for **List Event Type Available Times**. For the authoritative schema and error bodies, use the official Calendly API reference.
