# tokens_revoked event

### API tokens for your app were revoked

## Facts

**Required Scopes**: No scopes required!

**Compatible APIs**: [`Events`](/apis/events-api)

## Usage info {#usage-info}

This example includes both the [event wrapper](/apis/events-api/#callback-field) and the [event structure](/apis/events-api/#event-type-structure) for the `tokens_revoked` event.

```
{
    "token": "XXYYZZ",
    "team_id": "TXXXXXXXX",
    "api_app_id": "AXXXXXXXXX",
    "event": {
        "type": "tokens_revoked",
        "tokens": {
            "oauth": ["UXXXXXXXX"],
            "bot": ["UXXXXXXXX"]
        }
    },
    "type": "event_callback",
    "event_id": "EvXXXXXXXX",
    "event_time": 1234567890
}
```

When your app's API tokens are revoked, the `tokens_revoked` event is sent via the Events API to your app if it is subscribed.

The example above details the complete Events API payload, including the event wrapper. Use the `team_id` to identify the associated workspace.

The inner event's `tokens` field is a hash keyed with the types of revoked tokens. `oauth` tokens are user-based tokens negotiated with [OAuth](/authentication) or app installation, typically beginning with `xoxp-`. `bot` tokens are also negotiated in that process, but belong specifically to any bot users contained in your app and begin with `xoxb-`. Each key contains an array of user IDs, _not_ the actual `token` strings representing your revoked tokens. To use this event most effectively, store your tokens along side user IDs and team IDs.
