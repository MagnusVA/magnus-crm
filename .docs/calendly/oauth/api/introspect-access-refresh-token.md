# Introspect Access/Refresh Token

`POST` `https://auth.calendly.com/oauth/introspect`

Use this endpoint to introspect an access/refresh token.

## Request

### Headers

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `Content-Type` | string | Yes | Indicates the media type of the resource. **Allowed / default:** `application/x-www-form-urlencoded` |

### Body

**Content type:** `application/x-www-form-urlencoded`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_id` | string | Yes | The ID provided by Calendly for the web application |
| `client_secret` | string | Yes | The secret provided by Calendly |
| `token` | string | Yes | The access/refresh token provided by Calendly |

## Responses

Documented status codes include **200**, **400**, and **401**. The **200** response is described below.

### 200 OK

**Body** (`application/json`): OK

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `active` | boolean | Yes | Boolean indicator of whether or not the presented token is currently active |
| `scope` | string | No | The scope of the access token |
| `client_id` | string | No | The ID provided by Calendly for the web application |
| `token_type` | string | No | The token type (currently this is always `"Bearer"`) |
| `exp` | number | No | The UNIX timestamp in seconds when the access-token will expire |
| `iat` | number | No | The UNIX timestamp in seconds when the access-token was originally issued |
| `owner` | string (URI) | No | A link to the resource that owns the token (currently, this is always a user) |
| `organization` | string (URI) | No | A link to the owner's current organization. **Example:** `https://api.calendly.com/organizations/EBHAAFHDCAEQTSEZ` |

### Response example (Example - Active token)

```json
{
  "active": true,
  "scope": "default",
  "client_id": "123",
  "token_type": "Bearer",
  "exp": 1601325434,
  "iat": 1601318234,
  "owner": "https://api.calendly.com/users/EBHAAFHDCAEQTSEZ",
  "organization": "https://api.calendly.com/organizations/EBHAAFHDCAEQTSEZ"
}
```

### Example request (cURL)

```bash
curl --request POST \
  --url https://auth.calendly.com/oauth/introspect \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'client_id=CLIENT_ID' \
  --data-urlencode 'client_secret=CLIENT_SECRET' \
  --data-urlencode 'token=ACCESS_OR_REFRESH_TOKEN'
```
