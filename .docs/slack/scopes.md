# Slack Scopes Reference (index)

> Note: This file was reconstructed from a summarized fetch — the canonical `https://docs.slack.dev/reference/scopes` page did not return raw markdown via WebFetch (404 on the `.md` variant; HTML page was summarized). Refer to the live URL for the full table of scopes.

## Overview

This page is the index for Slack API scopes. Slack scopes define the permissions an app requests when installed via OAuth and are granted to bot tokens (`xoxb-`) or user tokens (`xoxp-`).

## Page Structure

The reference page lists scopes in a table with three columns:

- **Name** — the scope identifier (e.g. `chat:write`, `channels:read`)
- **Description** — what the scope authorizes
- **Token Types** — which token types (Bot / User / both) accept the scope

## Scope Categories

The reference covers (alphabetically) categories such as:

- **Admin** — `admin.*` scopes for org-level admin operations
- **App configuration & mentions** — `app_mentions:read`, `app_configurations:*`
- **Audit logs** — `auditlogs:read`
- **Authorizations** — `authorizations:read`
- **Bookmarks, calls, canvases** — `bookmarks:*`, `calls:*`, `canvases:*`
- **Chat & channels** — `chat:write`, `chat:write.public`, `chat:write.customize`, `channels:history`, `channels:read`, `channels:write`, `channels:join`, `channels:manage`
- **Commands** — `commands` (slash commands)
- **Connections** — `connections:write`
- **Files & email & metadata** — `files:read`, `files:write`, `users:read.email`, `metadata.message:read`
- **Groups (private channels)** — `groups:history`, `groups:read`, `groups:write`
- **IM (DMs)** — `im:history`, `im:read`, `im:write`
- **MPIM (group DMs)** — `mpim:history`, `mpim:read`, `mpim:write`
- **Reactions, reminders, search** — `reactions:read`, `reactions:write`, `reminders:*`, `search:read`
- **Team & users** — `team:read`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `usergroups:*`
- **Workflow & integrations** — `workflow.steps:execute`, `triggers:*`
- **Assistant / AI** — `assistant:write`
- **Links & unfurls** — `links:read`, `links:write`
- **Incoming webhooks** — `incoming-webhook`

## Common Scopes for Slash-Command + Modal Apps

For an app that uses slash commands, modals, and posts messages, typical bot scopes are:

- `commands` — register slash commands
- `chat:write` — post messages as the app
- `chat:write.public` — post in channels the app isn't a member of
- `users:read` — look up user profiles
- `users:read.email` — access email fields (requires explicit grant)
- `channels:read` / `groups:read` / `im:read` / `mpim:read` — list conversations the user can see
- `im:history` — read DM history (for assistant/help patterns)

## Optional scopes

Apps can mark scopes as **optional** in the manifest (`oauth_config.scopes.bot_optional` / `user_optional`). The user can choose at install time whether to grant them. Apps must handle `missing_scope` errors gracefully when a user declines an optional scope. See [Installing with OAuth — Optional scopes](/authentication/installing-with-oauth#optional-scopes).

## See also

- [Installing with OAuth](/authentication/installing-with-oauth)
- [App manifest reference — `oauth_config.scopes`](/reference/app-manifest#oauth)
- [Web API method docs](/reference/methods) — each method lists the exact scopes required.
