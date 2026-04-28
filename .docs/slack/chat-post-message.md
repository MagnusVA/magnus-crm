# chat.postMessage method

## Facts {#facts}

**Description**: Sends a message to a channel.

**Method Access**:

```
POST https://slack.com/api/chat.postMessage
```

- bolt-js: `app.client.chat.postMessage`
- bolt-py: `app.client.chat_postMessage`
- bolt-java: `app.client().chatPostMessage`

**Scopes**:
- Bot token: [`chat:write`](/reference/scopes/chat.write)
- User token: [`chat:write`](/reference/scopes/chat.write)

**Content types**: `application/x-www-form-urlencoded`, `application/json`

**Rate Limits**: [Special rate limits apply.](/apis/web-api/rate-limits)

## Arguments {#arguments}

### Required arguments

**`token`** `string` Required — Authentication token bearing required scopes. Tokens should be passed as an HTTP Authorization header or alternatively, as a POST parameter. _Example:_ `xxxx-xxxxxxxxx-xxxx`

**`channel`** `string` Required — An encoded ID or channel name that represents a channel, private group, or IM channel to send the message to. See [below](#channels) for more details.

### Optional arguments

**`as_user`** `boolean` Optional — (Legacy) Pass true to post the message as the authed user instead of as a bot. Defaults to false. Can only be used by classic apps.

**`attachments`** Optional — A JSON-based array of structured attachments, presented as a URL-encoded string. _Example:_ `[{"pretext": "pre-hello", "text": "text-world"}]`

**`blocks`** Optional — A JSON-based array of structured blocks, presented as a URL-encoded string. _Example:_ `[{"type": "section", "text": {"type": "plain_text", "text": "Hello world"}}]`

**`current_draft_last_updated_ts`** `string` Optional — Timestamp of the draft's last update at the time this API is called.

**`icon_emoji`** Optional — Emoji to use as the icon for this message. Overrides `icon_url`. _Example:_ `:chart_with_upwards_trend:`

**`icon_url`** Optional — URL to an image to use as the icon for this message.

**`link_names`** `boolean` Optional — Find and link user groups. No longer supports linking individual users; use syntax shown in [Mentioning Users](/messaging/formatting-message-text#mentioning-users) instead.

**`markdown_text`** `string` Optional — Accepts message text formatted in markdown. This argument should not be used in conjunction with `blocks` or `text`. Limit this field to 12,000 characters.

**`metadata`** Optional — JSON object with event_type and event_payload fields, presented as a URL-encoded string.

**`mrkdwn`** `boolean` Optional — Disable Slack markup parsing by setting to `false`. Enabled by default. _Default:_ `true`

**`parse`** Optional — Change how messages are treated. _Example:_ `full`

**`reply_broadcast`** `boolean` Optional — Used in conjunction with `thread_ts` and indicates whether reply should be made visible to everyone in the channel or conversation. Defaults to `false`.

**`text`** Optional — How this field works and whether it is required depends on other fields you use in your API call. _Example:_ `Hello world`

**`thread_ts`** Optional — Provide another message's `ts` value to make this message a reply. Avoid using a reply's `ts` value; use its parent instead.

**`unfurl_links`** `boolean` Optional — Pass true to enable unfurling of primarily text-based content.

**`unfurl_media`** `boolean` Optional — Pass false to disable unfurling of media content.

**`username`** Optional — Set your bot's user name.

## Usage info {#usage-info}

This method posts [a message](/messaging) to a public channel, private channel, or direct message (DM, or IM) conversation.

### The text, blocks and attachments fields {#text-blocks-attachments}

The usage of the `text` field changes depending on whether you're using `blocks`. If you're using `blocks`, this is used as a fallback string to display in notifications. If you aren't, this is the main body text of the message. It can be formatted as plain text, or with `mrkdwn`.

The `text` field is not enforced as required when using `blocks` or `attachments`. However, we highly recommended that you include `text` to provide a fallback when using `blocks`.

#### Accessibility considerations {#accessibility}

It is expected behavior that screen readers will default to the top-level `text` field of your post, and will not read the content of any interior `blocks` in the underlying structure of the message. Therefore, to make an accessible app, you must either:

*   include all necessary content for screen reader users in the top-level `text` field of your message, or
*   do not include a top-level `text` field if the message has `blocks`, and allow Slack attempt to build it for you by appending content from supported `blocks` to be read by the screen reader.

#### JSON POST support {#JSON_POST}

When POSTing with `application/x-www-form-urlencoded` data, the optional `attachments` argument should contain a JSON-encoded array of [attachments](/messaging/formatting-message-text).

As of October 2017, it's possible to send a well-formatted `application/json` POST body to `chat.postMessage` and other Web API write methods.

### Formatting messages {#formatting}

Messages are formatted as described in the [formatting spec](/messaging/formatting-message-text). The formatting behavior will change depending on the value of `parse`.

By default, URLs will be hyperlinked. Set `parse` to `none` to remove the hyperlinks.

The behavior of `parse` is different for text formatted with `mrkdwn`. By default, or when `parse` is set to `none`, `mrkdwn` formatting is implemented. To ignore `mrkdwn` formatting, set `parse` to `full`.

#### Unfurling content {#unfurling}

By default, we unfurl all links in any messages posted by users and Slack apps. We also unfurl links to media-based content within [Block kit blocks](/reference/block-kit/blocks).

If you want to suppress link unfurls in messages containing [Block Kit blocks](/reference/block-kit/blocks), set `unfurl_links` and `unfurl_media` to false.

#### Truncating content {#truncating}

For best results, limit the number of characters in the `text` field to 4,000 characters. Slack will truncate messages containing more than 40,000 characters.

If using `blocks`, the limit and truncation of characters will be determined by the specific type of [block](/reference/block-kit/blocks).

### Threads and replies {#threads}

Provide a `thread_ts` value for the posted message to act as a reply to a parent message. Sparingly, set `reply_broadcast` to `true` if your reply is important enough for everyone in the channel to receive.

### Channels {#channels}

You **must** specify a public channel, private channel, or an IM channel with the `channel` argument.

#### Post to a public channel {#public}

Pass the channel name or the channel's ID (`C123456`) to the `channel` parameter and the message will be posted to that channel.

#### Post to a private channel {#private}

As long as the authenticated user is a member of the private channel, pass the channel's ID (`C123456`) to the `channel` parameter.

#### Post to a multi-person direct message channel {#mpdm}

As long as the authenticated user is a member of the multi-person direct message (a "private group" or MPIM), you can pass the group's ID (`G123456`).

#### Post to a direct message channel {#dm}

If you want your app's bot user to start a 1:1 conversation with another user in a workspace, provide the user's ID as the `channel` value and a direct message conversation will be opened if it isn't open already.

Bot users **cannot** post to a direct message conversation between two users using `chat.postMessage`. Apps can post to direct message conversations between users when a [shortcut](/interactivity/implementing-shortcuts) or [slash command](/interactivity/implementing-slash-commands) belonging to that app is used in the conversation.

You will receive a `channel_not_found` error if your app doesn't have permission to enter into a DM with the intended user.

#### Getting a user's ID {#get-userID}

A list of user IDs can be retrieved via the [`users.list`](/reference/methods/users.list) API method.

### Begin a conversation in a user's App Home {#app_home}

With the `chat:write` scope enabled, call `chat.postMessage` and pass a user's ID (`U123456`) as the value of `channel` to post to that user's App Home channel.

### Rate limiting {#rate_limiting}

`chat.postMessage` has special [rate limiting](/apis/web-api/rate-limits) conditions. It will generally allow an app to post 1 message per second to a specific channel. There are limits governing your app's relationship with the entire workspace above that, limiting posting to several hundred messages per minute. Generous burst behavior is also granted.

### Channel membership {#channel_membership}

New Slack apps do _not_ begin life with the ability to post in all public channels.

For your new Slack app to gain the ability to post in all public channels, request the [`chat:write.public`](/reference/scopes/chat.write.public) scope.

* * *

### Sending messages as other entities {#authorship}

Apps can publish messages that appear to have been created by a user in the conversation. The message will be attributed to the user and show their profile photo beside it. This ability is only available when an app has requested and been granted an additional scope — [`chat:write.customize`](/reference/scopes/chat.write.customize).

To modify the appearance of the app, make calls to [`chat.postMessage`](/reference/methods/chat.postMessage) while providing any of the following parameters:

*   `username` to specify the username for the published message.
*   `icon_url` to specify a URL to an image to use as the profile photo alongside the message.
*   `icon_emoji` to specify an emoji.

If the `channel` parameter is set to a User ID (beginning with `U`), the message will appear in that user's direct message channel with Slackbot.

* * *

## Response {#response}

#### Typical success response

```
{
  "ok": true,
  "channel": "C123ABC456",
  "ts": "1503435956.000247",
  "message": {
    "text": "Here's a message for you",
    "username": "ecto1",
    "bot_id": "B123ABC456",
    "attachments": [{"text": "This is an attachment","id": 1,"fallback": "This is an attachment's fallback"}],
    "type": "message",
    "subtype": "bot_message",
    "ts": "1503435956.000247"
  }
}
```

#### Typical error response

```
{"ok": false,"error": "too_many_attachments"}
```

## Errors {#errors}

Error | Description
--- | ---
`access_denied` | Access to a resource specified in the request is denied.
`accesslimited` | Access to this method is limited on the current network
`account_inactive` | Authentication token is for a deleted user or workspace when using a `bot` token.
`as_user_not_supported` | The `as_user` parameter does not function with workspace apps.
`attachment_payload_limit_exceeded` | Attachment payload size is too long.
`cannot_reply_to_message` | This message type cannot have thread replies.
`channel_not_found` | Value passed for `channel` was invalid.
`deprecated_endpoint` | The endpoint has been deprecated.
`ekm_access_denied` | Your message couldn't be sent because your admins have disabled sending messages to this channel.
`enterprise_is_restricted` | The method cannot be called from an Enterprise.
`fatal_error` | The server could not complete your operation(s) without encountering a catastrophic error.
`internal_error` | The server could not complete your operation(s) without encountering an error.
`invalid_arg_name` | The method was passed an argument whose name falls outside the bounds of accepted or expected values.
`invalid_arguments` | The method was called with invalid arguments.
`invalid_array_arg` | The method was passed an array as an argument.
`invalid_auth` | Some aspect of authentication cannot be validated.
`invalid_blocks` | Blocks submitted with this message are not valid.
`invalid_blocks_format` | The `blocks` is not a valid JSON object or doesn't match the Block Kit syntax.
`invalid_charset` | Invalid charset.
`invalid_form_data` | The method was called via a `POST` request with `Content-Type` `application/x-www-form-urlencoded` or `multipart/form-data`, but the form data was either missing or syntactically invalid.
`invalid_metadata_format` | Invalid metadata format provided.
`invalid_metadata_schema` | Invalid metadata schema provided.
`invalid_post_type` | Invalid post type.
`is_archived` | Channel has been archived.
`markdown_text_conflict` | Markdown text cannot be used in conjunction with `blocks` or `text` argument.
`message_limit_exceeded` | Members on this team are sending too many messages.
`messages_tab_disabled` | Messages tab for the app is disabled.
`metadata_must_be_sent_from_app` | Message metadata can only be posted or updated using an app-level token.
`metadata_too_large` | Metadata exceeds size limit.
`method_deprecated` | The method has been deprecated.
`missing_file_data` | Attempted to share a file but some required data was missing.
`missing_post_type` | Missing post type.
`missing_scope` | The token used is not granted the specific scope permissions required to complete this request.
`msg_blocks_too_long` | Blocks submitted with this message are too long.
`no_permission` | The workspace token used in this request does not have the permissions necessary.
`no_text` | No message text provided.
`not_allowed_token_type` | The token type used in this request is not allowed.
`not_authed` | No authentication token provided.
`not_in_channel` | Cannot post user messages to a channel they are not in.
`org_login_required` | The workspace is undergoing an enterprise migration.
`rate_limited` | Application has posted too many messages.
`ratelimited` | The request has been ratelimited.
`request_timeout` | Request timeout.
`restricted_action` | A workspace preference prevents the authenticated user from posting.
`restricted_action_non_threadable_channel` | Cannot post thread replies into a non_threadable channel.
`restricted_action_read_only_channel` | Cannot post any message into a read-only channel.
`restricted_action_thread_locked` | Cannot post replies to a thread that has been locked by admins.
`restricted_action_thread_only_channel` | Cannot post top-level messages into a thread-only channel.
`service_unavailable` | The service is temporarily unavailable
`team_access_not_granted` | The token used is not granted the specific workspace access required.
`team_added_to_org` | Workspace migration in progress.
`team_not_found` | This error occurs if, when using an org-wide token, the `channel_name` is passed instead of the `channel_id`.
`token_expired` | Authentication token has expired.
`token_revoked` | Authentication token is for a deleted user or workspace or the app has been removed when using a `user` token.
`too_many_attachments` | Too many attachments were provided with this message. A maximum of 100 attachments are allowed on a message.
`too_many_contact_cards` | Too many contact_cards were provided with this message.
`two_factor_setup_required` | Two factor setup is required.

* * *

## Legacy concerns {#legacy}

This feature works differently for classic apps. Classic apps using the umbrella `bot` scope can't request additional scopes to adjust message authorship.

#### Legacy as_user parameter {#legacy_as_user}

For classic apps, the best way to control the authorship of a message was to be explicit with the legacy `as_user` parameter. If you didn't use the `as_user` parameter, `chat.postMessage` would guess the most appropriate `as_user` interpretation based on the kind of token you were using.
