# conversations.list method

## Facts {#facts}

**Description**: Lists all channels in a Slack team.

**Method Access**:

```
GET https://slack.com/api/conversations.list
```

- bolt-js: `app.client.conversations.list`
- bolt-py: `app.client.conversations_list`
- bolt-java: `app.client().conversationsList`

**Scopes**:
- Bot token: [`channels:read`](/reference/scopes/channels.read), [`groups:read`](/reference/scopes/groups.read), [`im:read`](/reference/scopes/im.read), [`mpim:read`](/reference/scopes/mpim.read)
- User token: [`channels:read`](/reference/scopes/channels.read), [`groups:read`](/reference/scopes/groups.read), [`im:read`](/reference/scopes/im.read), [`mpim:read`](/reference/scopes/mpim.read)

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Tier 2: 20+ per minute](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes.

### Optional arguments

**`cursor`** `string` Optional — Paginate through collections of data by setting the `cursor` parameter to a `next_cursor` attribute returned by a previous request's `response_metadata`. _Example:_ `dXNlcjpVMDYxTkZUVDI=`

**`exclude_archived`** `boolean` Optional — Set to `true` to exclude archived channels from the list. _Default:_ `false`

**`limit`** `number` Optional — The maximum number of items to return. Must be an integer under 1000. _Default:_ `100`

**`team_id`** `string` Optional — encoded team id to list channels in, required if token belongs to org-wide app.

**`types`** `string` Optional — Mix and match channel types by providing a comma-separated list of any combination of `public_channel`, `private_channel`, `mpim`, `im`. _Default:_ `public_channel`. _Example:_ `public_channel,private_channel`

## Usage info {#usage-info}

This [Conversations API](/apis/web-api/using-the-conversations-api) method returns a list of all [channel-like conversations](/reference/objects/conversation-object) in a workspace. The "channels" returned depend on what the calling token has access to and the directives placed in the `types` parameter.

The `team_id` is only relevant when using an org-level token. This field will be ignored if the API call is sent using a workspace-level token. When paginating, any filters used in the request are applied _after_ retrieving a virtual page's `limit`. For example, using `exclude_archived=true` when `limit=20` on a virtual page that would contain 15 archived channels will return you the virtual page with only `5` results. Additional results are available from the next `cursor` value.

* * *

## Response {#response}

#### Typical success response with only public channels

```
{
  "ok": true,
  "channels": [
    {
      "id": "C012AB3CD",
      "name": "general",
      "is_channel": true,
      "is_group": false,
      "is_im": false,
      "created": 1449252889,
      "creator": "U012A3CDE",
      "is_archived": false,
      "is_general": true,
      "unlinked": 0,
      "name_normalized": "general",
      "is_shared": false,
      "is_ext_shared": false,
      "is_org_shared": false,
      "pending_shared": [],
      "is_pending_ext_shared": false,
      "is_member": true,
      "is_private": false,
      "is_mpim": false,
      "updated": 1678229664302,
      "topic": {"value": "Company-wide announcements and work-based matters","creator": "","last_set": 0},
      "purpose": {"value": "This channel is for team-wide communication and announcements. All team members are in this channel.","creator": "","last_set": 0},
      "previous_names": [],
      "num_members": 4
    }
  ],
  "response_metadata": {"next_cursor": "dGVhbTpDMDYxRkE1UEI="}
}
```

#### Example response when mixing different conversation types together, like im and mpim

```
{
  "ok": true,
  "channels": [
    {
      "id": "G0AKFJBEU",
      "name": "mpdm-mr.banks--slactions-jackson--beforebot-1",
      "is_channel": false,
      "is_group": true,
      "is_im": false,
      "created": 1493657761,
      "creator": "U061F7AUR",
      "is_archived": false,
      "is_general": false,
      "is_member": true,
      "is_private": true,
      "is_mpim": true,
      "is_open": true,
      "priority": 0
    },
    {
      "id": "D0C0F7S8Y",
      "created": 1498500348,
      "is_im": true,
      "is_org_shared": false,
      "user": "U0BS9U4SV",
      "is_user_deleted": false,
      "priority": 0
    }
  ],
  "response_metadata": {"next_cursor": "aW1faWQ6RDBCSDk1RExI"}
}
```

#### Typical error response

```
{"ok": false,"error": "invalid_auth"}
```

Returns a list of limited channel-like [conversation objects](/reference/objects/conversation-object). To get a full [conversation object](/reference/objects/conversation-object), call the [`conversations.info`](/reference/methods/conversations.info) method.

Use [`conversations.members`](/reference/methods/conversations.members) to retrieve and traverse membership.

Some fields in the response, like `unread_count` and `unread_count_display`, are included for DM conversations only.

### Pagination {#pagination}

This method uses cursor-based pagination to make it easier to incrementally collect information. To begin pagination, specify a `limit` value under `1000`. We recommend no more than `200` results at a time.

Responses will include a top-level `response_metadata` attribute containing a `next_cursor` value. By using this value as a `cursor` parameter in a subsequent request, along with `limit`, you may navigate through the collection page by virtual page.

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
`invalid_auth` | Some aspect of authentication cannot be validated.
`invalid_charset` | Invalid charset.
`invalid_cursor` | Value passed for `cursor` was not valid or is no longer valid.
`invalid_form_data` | Invalid form data.
`invalid_limit` | Value passed for `limit` is not understood.
`invalid_post_type` | Invalid post type.
`invalid_types` | Value passed for `type` could not be used based on the method's capabilities or the permission scopes granted to the used token.
`method_deprecated` | The method has been deprecated.
`method_not_supported_for_channel_type` | This type of conversation cannot be used with this method.
`missing_argument` | A required argument is missing.
`missing_post_type` | Missing post type.
`missing_scope` | The calling token is not granted the necessary scopes to complete this operation.
`no_permission` | No permission.
`not_allowed_token_type` | Token type not allowed.
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
