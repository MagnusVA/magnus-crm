# Get Webhook Subscription

**`GET`** `https://api.calendly.com/webhook_subscriptions/{webhook_uuid}`

Get one webhook subscription by identifier.

> **Required scopes:** `webhooks:read`

See also: [List Webhook Subscriptions](./list-webhook-subscriptions.md), [Create Webhook Subscription](./create-webhook.md), [Webhook Subscription object](../webhook-subscription-object.md).

The `{webhook_uuid}` path segment is the identifier for the subscription (the final segment of the subscription `uri`, e.g. `https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA` → `AAAAAAAAAAAAAAAA`).

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

### Path parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `webhook_uuid` | string | Yes | Webhook subscription id (path segment, not the full URI). |

## Responses

Possible HTTP status codes: **200**, **401**, **403**, **404**.

### `200` OK

**Body** (`application/json`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `resource` | Webhook Subscription | Yes | The subscription. Field definitions match [Webhook Subscription](../webhook-subscription-object.md): `uri`, `callback_url`, `created_at`, `updated_at`, `retry_started_at`, `state`, `events`, `scope`, `organization`, `user`, `group`, `creator`. |

### Example request (cURL)

```bash
curl --request GET \
  --url 'https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA' \
  --header 'Authorization: Bearer {access_token}' \
  --header 'Content-Type: application/json'
```

### Example response (`200`)

```json
{
  "resource": {
    "uri": "https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA",
    "callback_url": "https://blah.foo/bar",
    "created_at": "2019-08-24T14:15:22.123456Z",
    "updated_at": "2019-08-24T14:15:22.123456Z",
    "retry_started_at": "2019-08-24T14:15:22.123456Z",
    "state": "active",
    "events": [
      "invitee.created"
    ],
    "scope": "user",
    "organization": "https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA",
    "user": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
    "group": "https://api.calendly.com/groups/AAAAAAAAAAAAAAAA",
    "creator": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA"
  }
}
```

**Note:** Allowed `events` values in the schema may list invitee and routing-form events; event types for create/list are documented in [Create Webhook Subscription](./create-webhook.md).

### `401` / `403` / `404`

Authentication failure, insufficient permissions, or subscription not found. Error bodies follow the usual Calendly API error object pattern where applicable.
