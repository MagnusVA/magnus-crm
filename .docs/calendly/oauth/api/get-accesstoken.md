# Get Access Token

`POST` `https://auth.calendly.com/oauth/token`

Use Access Tokens to access Calendly resources on behalf of an authenticated user.

The Basic HTTP Authentication security scheme is for web clients only.

To make a call to this endpoint:

- **Web clients:** pass `client_id` and `client_secret` via Basic HTTP Authorization header
- **Native clients:** include `client_id` as a body param within the API call

Note:

- Access Tokens expire after 2 hours.
- Refresh Tokens don't expire until they are used.
- Only 8 OAuth tokens per user can be requested within a span of 1 minute

## Request

### Security: Basic Auth

Web clients pass `client_id` and `client_secret` via the Basic HTTP Authorization header (see bullets under **To make a call to this endpoint** above).

### Headers

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `Content-Type` | string | Yes | Indicates the media type of the resource. **Allowed / default:** `application/x-www-form-urlencoded` |

### Body

**Content type:** `application/x-www-form-urlencoded`

**Schema variant:** Web Token Request with Authorization Code

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `grant_type` | string | Yes | The method used to retrieve an access token. **Allowed value:** `authorization_code` |
| `code` | string | Yes | The authorization code from an OAuth response |
| `redirect_uri` | string (URI) | Yes | The redirect URI. This must be the same as the **redirect_uri** passed in the authorization request. **Example:** `https://my.site.com/auth/calendly` |

## Responses

Documented status codes include **200**, **400**, **401**, and **429**. The payload below describes the **200** success body.

### 200 OK

**Body** (`application/json`): OAuth token response

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token_type` | string | Yes | The token type (currently this is always `"Bearer"`). **Allowed value:** `Bearer` |
| `access_token` | string | Yes | The access token provided in the response |
| `refresh_token` | string | Yes | The refresh token provided in the response |
| `scope` | string | No | The scope of the access request |
| `created_at` | number | Yes | The UNIX timestamp in seconds when the event was created |
| `expires_in` | number | Yes | The number of seconds until the access token expires |
| `owner` | string (URI) | Yes | A link to the resource that owns the token (currently, this is always a user). **Example:** `https://api.calendly.com/users/EBHAAFHDCAEQTSEZ` |
| `organization` | string (URI) | Yes | A link to the owner's current organization. **Example:** `https://api.calendly.com/organizations/EBHAAFHDCAEQTSEZ` |

### Example request (cURL)

Web client: Basic credentials are Base64-encoded `client_id:client_secret`.

```bash
curl --request POST \
  --url https://auth.calendly.com/oauth/token \
  --header 'Authorization: Basic <BASE64_CLIENT_ID_AND_SECRET>' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'code=<AUTHORIZATION_CODE>' \
  --data-urlencode 'redirect_uri=https://my.site.com/auth/calendly'
```

Replace `<BASE64_CLIENT_ID_AND_SECRET>` with the Base64 encoding of `client_id:client_secret`. For native clients, include `client_id` as a body parameter (see introduction).

### Response example

```json
{
  "token_type": "Bearer",
  "expires_in": 7200,
  "created_at": 1548689183,
  "refresh_token": "b77a76ffce83d3bc20531ddfa76704e584f0ee963f6041b8bfc70c91373267d5",
  "access_token": "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2F1dGguY2FsZW5kbHkuY29tIiwiaWF0IjoxNjMxNzI3Nzk5LCJqdGkiOiI5ZmViM2I0Zi04Njk1LTQzZjgtYWJhMS1kNDRiM2I5ZDdjYzEiLCJ1c2VyX3V1aWQiOiJCR0hIREdGREdIQURCSEoyIiwiYXBwX3VpZCI6IkppNzY5UjZ6eTZzSVN4X3I0OWRmZ0VsN0NPazVmeFVadVA0eHBadFlPbUkiLCJleHAiOjE2MzE3MzQ5OTl9.CrVBOFsqLjyfPK2E834E3sJv3fKU-PPlaNXQQB80Deo",
  "scope": "default",
  "owner": "https://api.calendly.com/users/EBHAAFHDCAEQTSEZ",
  "organization": "https://api.calendly.com/organizations/EBHAAFHDCAEQTSEZ"
}
```
