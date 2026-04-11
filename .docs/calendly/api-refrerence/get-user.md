# Get user

**Endpoint:** `GET https://api.calendly.com/users/{uuid}`

Returns information about a specified **user** (the authenticated Calendly account or another user your token can access).

**Required OAuth scope:** `users:read`

## Authentication

```http
Authorization: Bearer <TOKEN>
```

OAuth endpoints (Authorization Code flow):

- Authorize: `https://auth.calendly.com/oauth/authorize`
- Token / refresh: `https://auth.calendly.com/oauth/token`

## Path parameters

| Parameter | Type   | Description |
| --------- | ------ | --------------------------------------------------------------------------- |
| `uuid`    | string | User UUID, **or** the literal `me` to reference the token’s authenticated user |

## Responses

| Status | Meaning                          |
| ------ | -------------------------------- |
| 200    | Success — body contains `resource` (User) |
| 401    | Unauthorized                     |
| 403    | Forbidden (e.g. insufficient scope) |
| 404    | User not found                   |
| 500    | Server error                     |

### 200 — `resource` (User)

| Field                  | Type               | Description |
| ---------------------- | ------------------ | ----------- |
| `uri`                  | string (URI)       | Canonical API URI for the user |
| `name`                 | string             | Display name (human-readable) |
| `slug`                 | string             | Scheduling-page slug (e.g. `calendly.com/{slug}`) |
| `email`                | string (email)     | Email address |
| `scheduling_url`       | string (URI)       | Landing page listing the user’s event types |
| `timezone`             | string             | Time zone used when presenting times to the user |
| `time_notation`        | string             | `12h` or `24h` (default `12h`) |
| `avatar_url`           | string (URI) \| null | Avatar image URL |
| `created_at`           | string (date-time) | ISO8601 — record created |
| `updated_at`           | string (date-time) | ISO8601 — record last updated |
| `current_organization` | string (URI)       | URI of the user’s current organization |
| `resource_type`        | string             | Polymorphic type discriminator (e.g. `User`) |
| `locale`               | string             | Language preference; allowed: `en`, `fr`, `es`, `de`, `pt`, `ps` |

## Example request

### cURL

```bash
curl --request GET \
  --url "https://api.calendly.com/users/me" \
  --header "Authorization: Bearer <TOKEN>" \
  --header "Content-Type: application/json"
```

## Example response (illustrative)

```json
{
	"resource": {
		"uri": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
		"name": "John Doe",
		"slug": "acmesales",
		"email": "test@example.com",
		"scheduling_url": "https://calendly.com/acmesales",
		"timezone": "America/New_York",
		"time_notation": "12h",
		"avatar_url": "https://01234567890.cloudfront.net/uploads/user/avatar/0123456/a1b2c3d4.png",
		"created_at": "2019-01-02T03:04:05.678123Z",
		"updated_at": "2019-08-07T06:05:04.321123Z",
		"current_organization": "https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA",
		"resource_type": "User",
		"locale": "en"
	}
}
```

**Content-Type (success):** `application/json`

## Source

Derived from Calendly’s public API documentation for **Get user**. For authoritative schema and edge cases, use the [official Calendly API reference](https://developer.calendly.com/api-docs) or [Stoplight docs](https://calendly.stoplight.io/docs/api-docs).
