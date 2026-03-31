# List Webhook Subscriptions

**`GET`** `https://api.calendly.com/webhook_subscriptions`

Get a list of webhook subscriptions for a specified organization or user (filtered by `scope`).

> **Required scopes:** `webhooks:read`

See also: [Create Webhook Subscription](./create-webhook.md), [Webhook Subscription object](../webhook-subscription-object.md).

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

| Name           | Type         | Required         | Description                                                                                                                     |
| -------------- | ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `organization` | string (URI) | Yes              | Organization that owns the subscriptions being returned. **Example:** `https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA` |
| `scope`        | string       | Yes              | Filter the list by `organization`, `user`, or `group`.                                                                          |
| `user`         | string (URI) | If `scope=user`  | Filter to subscriptions for this user. **Example:** `https://api.calendly.com/users/AAAAAAAAAAAAAAAA`                           |
| `group`        | string (URI) | If `scope=group` | Filter to subscriptions for this group. **Example:** `https://api.calendly.com/groups/AAAAAAAAAAAAAAAA`                         |
| `count`        | number       | No               | Page size. **Min:** 1, **max:** 100, **default:** 20.                                                                           |
| `page_token`   | string       | No               | Token for the next or previous page of the collection.                                                                          |
| `sort`         | string       | No               | Comma-separated `{field}:{direction}` values. **Supported field:** `created_at`. **Direction:** `asc`, `desc`.                  |

When `scope` is `user`, include `user`. When `scope` is `group`, include `group`.

## Responses

Possible HTTP status codes: **200**, **400**, **401**, **403**, **404**.

### `200` OK

**Body** (`application/json`)

| Field        | Type                        | Required | Description                                                                                                                                                                                                                                                              |
| ------------ | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collection` | array[Webhook Subscription] | Yes      | Subscriptions matching the query. Each item matches the [Webhook Subscription](../webhook-subscription-object.md) shape (`uri`, `callback_url`, `created_at`, `updated_at`, `retry_started_at`, `state`, `events`, `scope`, `organization`, `user`, `group`, `creator`). |
| `pagination` | object                      | Yes      | Pagination metadata (see below).                                                                                                                                                                                                                                         |

**`pagination` object**

| Field                 | Type                 | Required | Description                                                          |
| --------------------- | -------------------- | -------- | -------------------------------------------------------------------- |
| `count`               | integer              | Yes      | Number of rows in this response. **Min:** 0, **max:** 100.           |
| `next_page`           | string (URI) \| null | Yes      | Full URL for the next page; `null` if there is no next page.         |
| `previous_page`       | string (URI) \| null | Yes      | Full URL for the previous page; `null` if there is no previous page. |
| `next_page_token`     | string \| null       | Yes      | Token for the next page; `null` if none.                             |
| `previous_page_token` | string \| null       | Yes      | Token for the previous page; `null` if none.                         |

Use `next_page` or `next_page_token` with subsequent requests per [API conventions](../../api-conventions.md) (keyset/cursor pagination).

### Example request (cURL)

```bash
curl --request GET \
  --url 'https://api.calendly.com/webhook_subscriptions?organization=https%3A%2F%2Fapi.calendly.com%2Forganizations%2FAAAAAAAAAAAAAAAA&scope=organization' \
  --header 'Authorization: Bearer {access_token}' \
  --header 'Content-Type: application/json'
```

### Example response (`200`)

```json
{
	"collection": [
		{
			"uri": "https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA",
			"callback_url": "https://blah.foo/bar",
			"created_at": "2019-08-24T14:15:22.123456Z",
			"updated_at": "2019-08-24T14:15:22.123456Z",
			"retry_started_at": "2019-08-24T14:15:22.123456Z",
			"state": "active",
			"events": ["invitee.created"],
			"scope": "user",
			"organization": "https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA",
			"user": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
			"group": "https://api.calendly.com/groups/AAAAAAAAAAAAAAAA",
			"creator": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA"
		}
	],
	"pagination": {
		"count": 20,
		"next_page": "https://api.calendly.com/webhook_subscriptions?count=1&page_token=sNjq4TvMDfUHEl7zHRR0k0E1PCEJWvdi",
		"previous_page": "https://api.calendly.com/webhook_subscriptions?count=1&page_token=VJs2rfDYeY8ahZpq0QI1O114LJkNjd7H",
		"next_page_token": "sNjq4TvMDfUHEl7zHRR0k0E1PCEJWvdi",
		"previous_page_token": "VJs2rfDYeY8ahZpq0QI1O114LJkNjd7H"
	}
}
```

**Note:** Allowed `events` values on each subscription item align with the API; the schema viewer for list may show a subset (e.g. invitee and routing form events). For the full matrix when **creating** subscriptions, see [Create Webhook Subscription](./create-webhook.md).

### `400` / `401` / `403` / `404`

Treat as standard Calendly API errors: invalid arguments, authentication failure, insufficient permissions, or resource not found. Error bodies follow the usual API error object pattern where applicable.
