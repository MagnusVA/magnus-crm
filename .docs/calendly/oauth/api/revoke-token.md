# Revoke Access/Refresh Token

`POST` `https://auth.calendly.com/oauth/revoke`

Use this endpoint to revoke an access/refresh token.

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

Documented status codes include **200**, **400**, and **403**. The **200** response is described below.

### 200 OK

**Body** (`application/json`): OK

```json
{}
```

### Example request (cURL)

```bash
curl --request POST \
  --url https://auth.calendly.com/oauth/revoke \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'client_id=CLIENT_ID' \
  --data-urlencode 'client_secret=CLIENT_SECRET' \
  --data-urlencode 'token=ACCESS_OR_REFRESH_TOKEN'
```
