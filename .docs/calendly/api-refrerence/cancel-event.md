# Cancel Event

**Endpoint:** `POST https://api.calendly.com/scheduled_events/{uuid}/cancellation`

Cancels the specified scheduled event.

**Required OAuth scope:** `scheduled_events:write`

## Authentication

```http
Authorization: Bearer <TOKEN>
```

OAuth endpoints (Authorization Code flow):

- Authorize: `https://auth.calendly.com/oauth/authorize`
- Token / refresh: `https://auth.calendly.com/oauth/token`

## Path parameters

| Parameter | Type   | Description |
| --------- | ------ | ------------------------------- |
| `uuid`    | string | Scheduled event UUID (required) |

## Request body

Content-Type: `application/json`

Optional cancellation payload:

| Field    | Type   | Constraints           | Description             |
| -------- | ------ | --------------------- | ----------------------- |
| `reason` | string | Max 10,000 characters | Reason for cancellation |

## Responses

| Status | Meaning                         |
| ------ | ------------------------------- |
| 201    | Created — cancellation recorded |
| 400    | Bad request                     |
| 401    | Unauthorized                    |
| 403    | Forbidden                       |
| 404    | Not found                       |
| 500    | Server error                    |

### 201 — `resource`

Provides data for the cancellation of the event or invitee.

| Field           | Type               | Description                             |
| --------------- | ------------------ | --------------------------------------- |
| `canceled_by`   | string             | Name of the person who canceled         |
| `reason`        | string \| null     | Reason the cancellation occurred        |
| `canceler_type` | string             | `host` or `invitee`                     |
| `created_at`    | string (date-time) | When the cancellation was created       |

## Example request

```json
{
  "reason": "Schedule conflict"
}
```

## Example: cURL

```bash
curl --request POST \
  --url "https://api.calendly.com/scheduled_events/{uuid}/cancellation" \
  --header "Authorization: Bearer <TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{
  "reason": "Schedule conflict"
}'
```

## Example response (201)

```json
{
  "resource": {
    "canceled_by": "string",
    "reason": "string",
    "canceler_type": "host",
    "created_at": "2019-01-02T03:04:05.678123Z"
  }
}
```
