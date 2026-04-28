# chat.update method

## Facts {#facts}

**Description**: Updates a message.

**Method Access**:

```
POST https://slack.com/api/chat.update
```

- bolt-js: `app.client.chat.update`
- bolt-py: `app.client.chat_update`
- bolt-java: `app.client().chatUpdate`

**Scopes**:
- Bot token: [`chat:write`](/reference/scopes/chat.write)
- User token: [`chat:write`](/reference/scopes/chat.write)

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Tier 3: 50+ per minute](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes.

**`channel`** `string` Required — Channel containing the message to be updated. For direct messages, ensure that this value is a DM ID (starts with `D`) instead of a User ID (starts with either `U` or `W`).

**`ts`** `string` Required — Timestamp of the message to be updated. _Example:_ `"1405894322.002768"`

### Optional arguments

**`as_user`** Optional — Pass true to update the message as the authed user. Bot users in this context are considered authed users.

**`attachments`** Optional — A JSON-based array of structured attachments, presented as a URL-encoded string.

**`unfurled_attachments`** Optional — A JSON-based array of structured attachments, presented as a URL-encoded string.

**`blocks`** Optional — A JSON-based array of structured blocks, presented as a URL-encoded string.

**`markdown_text`** `string` Optional — Accepts message text formatted in markdown. Limit 12,000 chars.

**`metadata`** Optional — JSON object with event_type and event_payload fields. If you don't include this field, the message's previous `metadata` will be retained. To remove previous `metadata`, include an empty object for this field.

**`link_names`** Optional — Find and link channel names and usernames. Defaults to `none`.

**`parse`** Optional — Change how messages are treated. Defaults to `client`. Accepts either `none` or `full`.

**`text`** Optional — Message text.

**`reply_broadcast`** `boolean` Optional — Broadcast an existing thread reply to make it visible to everyone. _Default:_ `false`

**`file_ids`** `array` Optional — Array of new file ids that will be sent with this message.

## Usage info {#usage-info}

This method updates a message in a channel. Though related to [`chat.postMessage`](/reference/methods/chat.postMessage), some parameters of `chat.update` are handled differently.

Ephemeral messages created by [`chat.postEphemeral`](/reference/methods/chat.postEphemeral) or otherwise cannot be updated with this method.

New Slack apps may use this method with the [`chat:write`](/reference/scopes/chat.write) scope and either a bot or user token.

### text, blocks or attachments {#text-blocks-attachments}

This method will behave differently depending on whether `blocks` or `text` is supplied. Slack will always try to render the message using `blocks`, and use `text` only for notifications. If you don't include `blocks`, the message's previous `blocks` will only be retained if the `text` argument is not provided. If the `text` argument is provided and `blocks` are not provided, the `blocks` will be removed, and the provided `text` will be used for message rendering. To remove previous `blocks`, include an empty array for the `blocks` field. If `blocks` are used and a message is being updated, the `edited` flag will not be displayed on the message (the flag will be displayed on the message if using `text`).

Similarly, the `attachments` field is required when not presenting `text`. If you don't include `attachments`, the message's previous `attachments` will be retained.

## Valid message types {#valid-message-types}

Only messages posted by the authenticated user are able to be updated using this method. This includes regular chat messages, as well as messages containing the `me_message` subtype. Bot users may also update the messages they post.

Attempting to update other message types will return a `cant_update_message` error.

To use `chat.update` with a bot users token, you'll need to _think of your bot user as a user_, and pass `as_user` set to `true` while editing a message created by that same bot user.

* * *

## Response {#response}

#### Typical success response

```
{
  "ok": true,
  "channel": "C123ABC456",
  "ts": "1401383885.000061",
  "text": "Updated text you carefully authored",
  "message": {
    "text": "Updated text you carefully authored",
    "user": "U34567890"
  }
}
```

#### Typical error response

```
{"ok": false,"error": "cant_update_message"}
```

The response includes the `text`, `channel` and `timestamp` properties of the updated message so clients can keep their local copies of the message in sync.

### Updating interactive messages {#updating-interactive-messages}

If you're posting an [interactive message](/messaging/creating-interactive-messages), you may use `chat.update` to continue updating ongoing state changes around a message. Provide the `ts` field the message you're updating and follow the bot user instructions above to update message text, and remove or add blocks.

## Errors {#errors}

Error | Description
--- | ---
`access_denied` | Access to a resource specified in the request is denied.
`accesslimited` | Access to this method is limited on the current network
`account_inactive` | Authentication token is for a deleted user or workspace.
`as_user_not_supported` | The `as_user` parameter does not function with workspace apps.
`block_mismatch` | Rich-text blocks cannot be replaced with non-rich-text blocks
`blocked_file_type` | Admin has disabled uploading this type of file.
`cant_broadcast_message` | Unable to broadcast this message.
`cant_update_message` | Authenticated user does not have permission to update this message.
`channel_not_found` | Value passed for `channel` was invalid.
`deprecated_endpoint` | The endpoint has been deprecated.
`edit_window_closed` | The message cannot be edited due to the team message edit settings
`ekm_access_denied` | Administrators have suspended the ability to post a message.
`enterprise_is_restricted` | The method cannot be called from an Enterprise.
`external_channel_migrating` | The channel is in the process of migrating.
`fatal_error` | The server could not complete your operation(s).
`file_deleted` | File to share deleted.
`file_is_deleted` | The file is deleted.
`file_not_found` | One or more of the provided file IDs could not be found.
`file_share_limit_reached` | The file has reached the share limit.
`internal_error` | Internal error.
`invalid_arg_name` | The method was passed an argument whose name falls outside the bounds of accepted or expected values.
`invalid_arguments` | The method was called with invalid arguments.
`invalid_array_arg` | Invalid array argument.
`invalid_attachments` | The attachments were invalid.
`invalid_auth` | Some aspect of authentication cannot be validated.
`invalid_blocks` | The blocks were invalid for the requesting user.
`invalid_blocks_format` | The `blocks` array is not a valid JSON object or doesn't match the Block Kit syntax.
`invalid_charset` | Invalid charset.
`invalid_form_data` | Invalid form data.
`invalid_metadata_format` | Invalid metadata format provided
`invalid_metadata_schema` | Invalid metadata schema provided
`invalid_post_type` | Invalid post type.
`is_inactive` | The message cannot be edited within a frozen, archived or deleted channel.
`markdown_text_conflict` | Markdown text cannot be used in conjunction with `blocks` or `text` argument.
`max_file_sharing_exceeded` | Exceeded max allowed files shared.
`message_limit_exceeded` | Members on this team are sending too many messages.
`message_not_found` | No message exists with the requested timestamp.
`metadata_must_be_sent_from_app` | Message metadata can only be posted or updated using an app-level token
`metadata_too_large` | Metadata exceeds size limit
`method_deprecated` | The method has been deprecated.
`missing_post_type` | Missing post type.
`missing_scope` | The token used is not granted the specific scope permissions required.
`msg_too_long` | Message text is too long. The `text` field cannot exceed 4,000 characters.
`no_dual_broadcast_content_update` | Can't broadcast an old reply and update the content at the same time.
`no_permission` | The workspace token used in this request does not have the permissions necessary.
`no_text` | No message text provided
`not_allowed_token_type` | The token type used in this request is not allowed.
`not_authed` | No authentication token provided.
`org_login_required` | The workspace is undergoing an enterprise migration.
`posting_to_channel_denied` | The user does not have permission to share files in this channel.
`ratelimited` | The request has been ratelimited.
`request_timeout` | Request timeout.
`service_unavailable` | The service is temporarily unavailable
`slack_connect_blocked_file_type` | Files with certain extensions are blocked from being uploaded in Slack Connect.
`slack_connect_canvas_sharing_blocked` | Admin has disabled sharing of canvas links in Slack Connect.
`slack_connect_clip_sharing_blocked` | Admin has disabled Clip uploads in Slack Connect.
`slack_connect_file_link_sharing_blocked` | Admin has disabled Slack file sharing in Slack Connect.
`slack_connect_file_upload_sharing_blocked` | Admin has disabled file uploads in Slack Connect.
`streaming_state_conflict` | The message is currently streaming text and cannot be edited.
`team_access_not_granted` | The token used is not granted the specific workspace access required.
`team_added_to_org` | Workspace migration in progress.
`team_not_found` | Team associated with the message and channel could not be found.
`token_expired` | Authentication token has expired
`token_revoked` | Authentication token is for a deleted user or workspace.
`too_many_attachments` | Too many attachments were provided with this message.
`two_factor_setup_required` | Two factor setup is required.
`unable_to_share_files` | Sharing the files failed.
`update_failed` | Internal update failure.
