# auth.test method

## Facts {#facts}

**Description**: Checks authentication & identity.

**Method Access**:

```
POST https://slack.com/api/auth.test
```

- bolt-js: `app.client.auth.test`
- bolt-py: `app.client.auth_test`
- bolt-java: `app.client().authTest`

**Scopes**: _No scopes required_

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Special rate limits apply.](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes. Tokens should be passed as an HTTP Authorization header or alternatively, as a POST parameter. _Example:_ `xxxx-xxxxxxxxx-xxxx`

## Usage info {#usage-info}

This method checks authentication and tells "you" who you are, even if you might be a bot.

You can also use this method to test whether Slack API authentication is functional.

* * *

## Response {#response}

#### Standard success response when used with a user token

```
{
  "ok": true,
  "url": "https://subarachnoid.slack.com/",
  "team": "Subarachnoid Workspace",
  "user": "grace",
  "team_id": "T12345678",
  "user_id": "W12345678"
}
```

#### Standard failure response when used with an invalid token

```
{"ok": false,"error": "invalid_auth"}
```

#### Success response when using a bot user token

```
{
  "ok": true,
  "url": "https://subarachnoid.slack.com/",
  "team": "Subarachnoid Workspace",
  "user": "bot",
  "team_id": "T0G9PQBBK",
  "user_id": "W23456789",
  "bot_id": "BZYBOTHED"
}
```

#### Error response when omitting a token

```
{"ok": false,"error": "not_authed"}
```

When working against a team within an [Enterprise organization](/enterprise), you'll also find their `enterprise_id` here.

## Rate limiting {#rate-limiting}

This method allows hundreds of requests per minute. Use it as often as is reasonably required. Please consult [rate limits](/apis/web-api/rate-limits) for more information.

## Errors {#errors}

Error | Description
--- | ---
`access_denied` | Access to a resource specified in the request is denied.
`accesslimited` | Access to this method is limited on the current network
`account_inactive` | Authentication token is for a deleted user or workspace.
`deprecated_endpoint` | The endpoint has been deprecated.
`ekm_access_denied` | Administrators have suspended the ability to post a message.
`enterprise_is_restricted` | The method cannot be called from an Enterprise.
`fatal_error` | Catastrophic error.
`internal_error` | Internal error.
`invalid_arg_name` | Invalid argument name.
`invalid_arguments` | The method was called with invalid arguments.
`invalid_array_arg` | Invalid array argument.
`invalid_auth` | Method was called with invalid credentials. Some aspect of authentication cannot be validated.
`invalid_charset` | Invalid charset.
`invalid_form_data` | Invalid form data.
`invalid_post_type` | Invalid post type.
`method_deprecated` | The method has been deprecated.
`missing_post_type` | Missing post type.
`missing_scope` | The token used is not granted the specific scope permissions required.
`no_permission` | The workspace token does not have necessary permissions.
`not_allowed_token_type` | The token type used in this request is not allowed.
`not_authed` | No authentication token provided.
`org_login_required` | Workspace migration in progress.
`ratelimited` | The request has been ratelimited.
`request_timeout` | Request timeout.
`service_unavailable` | The service is temporarily unavailable
`team_access_not_granted` | Team access not granted.
`team_added_to_org` | Workspace migration in progress.
`token_expired` | Authentication token has expired
`token_revoked` | Authentication token is for a deleted user or workspace.
`two_factor_setup_required` | Two factor setup is required.
