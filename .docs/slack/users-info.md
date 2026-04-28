# users.info method

> Note: This file was reconstructed from a summarized fetch of https://docs.slack.dev/reference/methods/users.info.md — WebFetch did not return raw markdown. Refer to the live page for the full schema.

## Facts {#facts}

**Description**: Gets information about a user.

**Method Access**:

```
GET https://slack.com/api/users.info
```

- bolt-js: `app.client.users.info`
- bolt-py: `app.client.users_info`
- bolt-java: `app.client().usersInfo`

**Scopes**:
- Bot token: [`users:read`](/reference/scopes/users.read)
- User token: [`users:read`](/reference/scopes/users.read)
- Email access (both fields): also requires [`users:read.email`](/reference/scopes/users.read.email)

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Tier 4: 100+ per minute](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes.

**`user`** `string` Required — User ID to get info on. _Example:_ `W1234567890`

### Optional arguments

**`include_locale`** `boolean` Optional — Set this to `true` to receive the locale for this user. _Default:_ `false`

## Usage info {#usage-info}

This method returns information about a member of a workspace. It returns a user object containing identification, account status, profile information, timezone data, and status indicators.

Apps require both `users:read` and `users:read.email` scopes to access email fields in returned user objects.

The profile hash contains as much information as the user has supplied in default fields.

## Response {#response}

#### Typical success response

```
{
  "ok": true,
  "user": {
    "id": "W012A3CDE",
    "team_id": "T012AB3C4",
    "name": "spengler",
    "deleted": false,
    "color": "9f69e7",
    "real_name": "Egon Spengler",
    "tz": "America/Los_Angeles",
    "tz_label": "Pacific Daylight Time",
    "tz_offset": -25200,
    "profile": {
      "avatar_hash": "ge3b51ca72de",
      "status_text": "Print is dead",
      "status_emoji": ":books:",
      "real_name": "Egon Spengler",
      "display_name": "spengler",
      "real_name_normalized": "Egon Spengler",
      "display_name_normalized": "spengler",
      "email": "spengler@ghostbusters.example.com",
      "image_24": "https://.../avatar_24.jpg",
      "image_32": "https://.../avatar_32.jpg",
      "image_48": "https://.../avatar_48.jpg",
      "image_72": "https://.../avatar_72.jpg",
      "image_192": "https://.../avatar_192.jpg",
      "image_512": "https://.../avatar_512.jpg",
      "team": "T012AB3C4"
    },
    "is_admin": true,
    "is_owner": false,
    "is_primary_owner": false,
    "is_restricted": false,
    "is_ultra_restricted": false,
    "is_bot": false,
    "updated": 1502138686,
    "is_app_user": false,
    "has_2fa": false
  }
}
```

## Common Errors

Error | Description
--- | ---
`user_not_found` | Invalid user ID provided
`missing_scope` | Token lacks required permissions
`invalid_auth` | Authentication token is invalid or request origin is disallowed
`not_authed` | No authentication token provided
`account_inactive` | Authentication token is for a deleted user or workspace
`token_expired` | Authentication token has expired
`token_revoked` | Authentication token is for a deleted user or workspace
`ratelimited` | The request has been ratelimited
`service_unavailable` | The service is temporarily unavailable
