# app_uninstalled event type

### Your Slack app was uninstalled

## Facts

**Required Scopes**: No scopes required!

**Compatible APIs**: [`Events`](/apis/events-api)

## Usage info {#usage-info}

This example includes both the [event wrapper](/apis/events-api/#callback-field) and the [event structure](/apis/events-api/#event-type-structure) for the `app_uninstalled` event.

```
{
    "token": "XXYYZZ",
    "team_id": "T123ABC456",
    "api_app_id": "A123ABC456",
    "event": {"type": "app_uninstalled"},
    "type": "event_callback",
    "authorizations": [
        {
            "team_id": "T123ABC456",
            "user_id": "U123ABC456",
            "is_bot": false,
            "is_enterprise_install": false
        }
    ],
    "event_id": "Ev123ABC456",
    "event_time": 123456789
}
```

This Events API-only event is sent via subscription whenever a Slack app is **completely** uninstalled.

You should also receive [`tokens_revoked`](/reference/events/tokens_revoked) events for revoked tokens however the order of the `app_uninstalled` and `tokens_revoked` events are not guaranteed to be sequential (you could receive a `tokens_revoked` event after `app_uninstalled`). An app is not uninstalled until its final user and bot tokens are revoked.

The example above details the complete Events API payload, including the event wrapper. The `team_id` indicates which workspace uninstalled the Slack app identified by `api_app_id`.
