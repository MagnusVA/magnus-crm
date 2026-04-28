# views.update method

## Facts {#facts}

**Description**: Update an existing view.

**Method Access**:

```
POST https://slack.com/api/views.update
```

- bolt-js: `app.client.views.update`
- bolt-py: `app.client.views_update`
- bolt-java: `app.client().viewsUpdate`

**Scopes**: _No scopes required_

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Tier 4: 100+ per minute](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes.

**`view`** Required — A [view object](/reference/views). This must be a JSON-encoded string.

### Optional arguments

**`view_id`** `string` Optional — A unique identifier of the view to be updated. Either `view_id` or `external_id` is required. _Example:_ `VMM512F2U`

**`external_id`** `string` Optional — A unique identifier of the view set by the developer. Must be unique for all views on a team. Max length of 255 characters. Either `view_id` or `external_id` is required.

**`hash`** `string` Optional — A string that represents view state to protect against possible race conditions. _Example:_ `156772938.1827394`

## Usage info {#usage-info}

Update a view by passing a new view definition object along with the `view_id` returned in [`views.open`](/reference/methods/views.open) or the `external_id`. See the [modals](/surfaces/modals#updating_apis) documentation to learn more about updating views and avoiding race conditions with the `hash` argument.

Preserving `input` entry: Data entered or selected in `input` blocks can be preserved while updating views. The new `view` object that you use with `views.update` should contain the same input blocks and elements with identical `block_id` and `action_id` values.

* * *

## Response {#response}

#### Typical success response includes the updated view payload.

```
{
  "ok": true,
  "view": {
    "id": "VNM522E2U",
    "team_id": "T9M4RL1JM",
    "type": "modal",
    "title": {"type": "plain_text","text": "Updated Modal","emoji": true},
    "close": {"type": "plain_text","text": "Close","emoji": true},
    "submit": null,
    "blocks": [
      {
        "type": "section",
        "block_id": "s_block",
        "text": {"type": "plain_text","text": "I am but an updated modal","emoji": true},
        "accessory": {
          "type": "button",
          "action_id": "button_4",
          "text": {"type": "plain_text","text": "Click me"}
        }
      }
    ],
    "private_metadata": "",
    "callback_id": "view_2",
    "external_id": "",
    "state": {"values": {}},
    "hash": "1569262015.55b5e41b",
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
{"ok": false,"error": "not_found"}
```

If you pass a valid `view` object along with a `view_id` or `external_id`, you'll receive a success response with the updated payload.

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
`fatal_error` | Catastrophic error.
`hash_conflict` | Error returned when the provided `hash` doesn't match the current stored value.
`internal_error` | Internal error.
`invalid_arg_name` | Invalid argument name.
`invalid_arguments` | The method was called with invalid arguments.
`invalid_array_arg` | Invalid array argument.
`invalid_auth` | Some aspect of authentication cannot be validated.
`invalid_charset` | Invalid charset.
`invalid_form_data` | Invalid form data.
`invalid_post_type` | Invalid post type.
`method_deprecated` | The method has been deprecated.
`missing_post_type` | Missing post type.
`missing_scope` | The token used is not granted the specific scope permissions required.
`no_permission` | No permission.
`not_allowed_token_type` | Token type not allowed.
`not_authed` | No authentication token provided.
`not_found` | Error returned when the given `view_id` or `external_id` doesn't exist.
`org_login_required` | Workspace migration in progress.
`ratelimited` | The request has been ratelimited.
`request_timeout` | Request timeout.
`service_unavailable` | The service is temporarily unavailable
`team_access_not_granted` | Team access not granted.
`team_added_to_org` | Workspace migration in progress.
`token_expired` | Authentication token has expired
`token_revoked` | Authentication token is for a deleted user or workspace.
`two_factor_setup_required` | Two factor setup is required.
`view_too_large` | Error returned if the provided view is greater than 250kb.
