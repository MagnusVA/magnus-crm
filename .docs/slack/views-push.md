# views.push method

## Facts {#facts}

**Description**: Push a view onto the stack of a root view.

**Method Access**:

```
POST https://slack.com/api/views.push
```

- bolt-js: `app.client.views.push`
- bolt-py: `app.client.views_push`
- bolt-java: `app.client().viewsPush`

**Scopes**: _No scopes required_

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Tier 4: 100+ per minute](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes.

**`view`** Required — A [view payload](/reference/views). This must be a JSON-encoded string.

### Optional arguments

**`trigger_id`** Optional — Exchange a trigger to post to the user. _Example:_ `12345.98765.abcd2358fdea`

**`interactivity_pointer`** Optional — Exchange an interactivity pointer to post to the user.

## Usage info {#usage-info}

Push a new view onto the existing view stack by passing a view object and a valid `trigger_id` generated from an interaction within the existing modal. The pushed view is added to the top of the stack, so the user will go back to the previous view after they complete or cancel the pushed view.

After a modal is opened, the app is limited to pushing 2 additional views.

Read the [modals](/block-kit#adding_blocks) documentation to learn more about the lifecycle and intricacies of views.

* * *

## Response {#response}

#### Typical success response includes the pushed view payload.

```
{
  "ok": true,
  "view": {
    "id": "VNM522E2U",
    "team_id": "T9M4RL1JM",
    "type": "modal",
    "title": {"type": "plain_text","text": "Pushed Modal","emoji": true},
    "close": {"type": "plain_text","text": "Back","emoji": true},
    "submit": {"type": "plain_text","text": "Save","emoji": true},
    "blocks": [
      {
        "type": "input",
        "block_id": "edit_details",
        "element": {"type": "plain_text_input","action_id": "detail_input"},
        "label": {"type": "plain_text","text": "Edit details"}
      }
    ],
    "private_metadata": "",
    "callback_id": "view_4",
    "external_id": "",
    "state": {"values": {}},
    "hash": "1569362015.55b5e41b",
    "clear_on_close": true,
    "notify_on_close": false,
    "root_view_id": "VNN729E3U",
    "previous_view_id": null,
    "app_id": "AAD3351BQ",
    "bot_id": "BADF7A34H"
  }
}
```

#### Typical error response

```
{
  "ok": false,
  "error": "invalid_arguments",
  "response_metadata": {"messages": ["missing required field: title"]}
}
```

If you pass a valid view object along with a valid `trigger_id`, you'll receive a success response with the view object that was pushed to the stack.

## Errors {#errors}

Error | Description
--- | ---
`access_denied` | Access to a resource specified in the request is denied.
`accesslimited` | Access to this method is limited on the current network
`account_inactive` | Authentication token is for a deleted user or workspace.
`deprecated_endpoint` | The endpoint has been deprecated.
`duplicate_external_id` | Error returned when the given `external_id` has already be used.
`ekm_access_denied` | Administrators have suspended the ability to post a message.
`enterprise_is_restricted` | The method cannot be called from an Enterprise.
`exchanged_trigger_id` | The trigger_id was already exchanged in a previous call.
`expired_trigger_id` | The trigger_id is expired.
`fatal_error` | Catastrophic error.
`internal_error` | Internal error.
`invalid_arg_name` | Invalid argument name.
`invalid_arguments` | The method was called with invalid arguments.
`invalid_array_arg` | Invalid array argument.
`invalid_auth` | Some aspect of authentication cannot be validated.
`invalid_charset` | Invalid charset.
`invalid_form_data` | Invalid form data.
`invalid_post_type` | Invalid post type.
`invalid_trigger_id` | The trigger_id is invalid. Expected format: "132456.7890123.abcdef".
`method_deprecated` | The method has been deprecated.
`missing_post_type` | Missing post type.
`missing_scope` | The token used is not granted the specific scope permissions required.
`no_permission` | No permission.
`not_allowed_token_type` | Token type not allowed.
`not_authed` | No authentication token provided.
`not_found` | Error returned when the requested view can't be found.
`org_login_required` | Workspace migration in progress.
`push_limit_reached` | Error returned when the max push limit has been reached for views. Currently the limit is 3.
`ratelimited` | The request has been ratelimited.
`request_timeout` | Request timeout.
`service_unavailable` | The service is temporarily unavailable
`team_access_not_granted` | Team access not granted.
`team_added_to_org` | Workspace migration in progress.
`token_expired` | Authentication token has expired
`token_revoked` | Authentication token is for a deleted user or workspace.
`two_factor_setup_required` | Two factor setup is required.
`view_too_large` | Error returned if the provided view is greater than 250kb.
