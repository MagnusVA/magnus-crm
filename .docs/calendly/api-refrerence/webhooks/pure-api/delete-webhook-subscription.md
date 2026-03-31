# Delete Webhook Subscription

**`DELETE`** `https://api.calendly.com/webhook_subscriptions/{webhook_uuid}`

Delete a webhook subscription.

> **Required scopes:** `webhooks:write`

See also: [Get Webhook Subscription](./get-webhook-subscription.md), [Create Webhook Subscription](./create-webhook.md).

The `{webhook_uuid}` path segment is the subscription identifier (the final segment of the subscription `uri`, e.g. `https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA` → `AAAAAAAAAAAAAAAA`).

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

No request body.

## Responses

Possible HTTP status codes: **204**, **401**, **403**, **404**, **500**.

### `204` No Content

Success. The subscription was deleted. There is no response body.

### Example request (cURL)

```bash
curl --request DELETE \
  --url 'https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA' \
  --header 'Authorization: Bearer {access_token}' \
  --header 'Content-Type: application/json'
```

### `401` / `403` / `404`

Authentication failure, insufficient permissions, or subscription not found. Error bodies follow the usual Calendly API error object pattern where applicable.

### `500`

Server error. Retry with backoff; if persistent, treat as a Calendly-side issue.
