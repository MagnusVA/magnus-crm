# Rate limits

Slack platform features and APIs rely on rate limits to help provide a predictably pleasant experience for users.

The details of how and when rate limiting works _differs_ between features. This article gives an overview of the rate limits you're likely to encounter for Slack platform features, and then notes how the limits apply to each feature.

## App types and rate limits

Slack is changing the way rate limits are applied to non-Marketplace apps. Apps already approved for the Slack Marketplace and internal customer-built applications should not see rate limit changes.

Effective **May 29, 2025**, all newly-created Slack apps that are commercially distributed and have not been approved for the Slack Marketplace will be subject to new rate limits for the [`conversations.history`](/reference/methods/conversations.history) and [`conversations.replies`](/reference/methods/conversations.replies) API methods. Existing installations of apps that are not Marketplace-approved are not subject to the new posted limits.

## Overview {#overview}

Broadly, you'll encounter limits like these, applied on a "_per API method per workspace/team per app_" basis.

| Feature/API | Limit | Notes |
|---|---|---|
| Web API Tier 1 | 1+ per minute | Access tier 1 methods infrequently. A small amount of burst behavior is tolerated. |
| Web API Tier 2 | 20+ per minute | Most methods allow at least 20 requests per minute, while allowing for occasional bursts of more requests. |
| Web API Tier 3 | 50+ per minute | Tier 3 methods allow a larger number of requests and are typically attached to methods with paginating collections of conversations or users. Sporadic bursts are welcome. |
| Web API Tier 4 | 100+ per minute | Enjoy a large request quota for Tier 4 methods, including generous burst behavior. |
| Web API Special Tier | _Varies_ | Rate limiting conditions are unique for methods with this tier. For example, [`chat.postMessage`](/reference/methods/chat.postMessage) generally allows posting one message per second per channel, while also maintaining a workspace-wide limit. |
| Posting messages | 1 per second | Short bursts >1 allowed. |
| Incoming webhooks | 1 per second | Short bursts >1 allowed. |
| Events API events | 30,000 deliveries per workspace/team per app per 60 minutes | Larger bursts are sometimes allowed. |
| Workflow triggers: event triggers | 10,000 per hour | |
| Workflow triggers: webhook triggers | 10 per minute | |
| Workflow steps: AI summary | At the team level: 150 requests per minute, burst of 300; per workflow: 1 request per hour, burst of 10 | |
| AI Generate step | 500/day per workflow; 10/hr per workflow w/ message or webhook trigger; 100/day per workflow w/ message or webhook trigger; 50/day for prompt test runs | |

## Burst limiting {#burst-limiting}

Burst limits are similar to rate limits. While a rate limit defines the maximum requests allowed in a specific timeframe (typically per minute), a burst limit defines the maximum rate of requests allowed concurrently.

Slack does not share precise burst limits externally. We recommend you design your apps with a limit of 1 request per second for any given API call, knowing that we'll allow it to go over this limit as long as this is only a temporary burst.

---

## Web API rate limiting {#web}

Your app's requests to the [Web API](/apis/web-api/) are evaluated per method, per workspace. Rate limit windows are per minute.

Each [Web API method](/reference/methods) is assigned one of four _rate limit tiers_, listed [above](#overview). Tier 1 accepts the fewest requests and Tier 4 the most. There's also a `special` tier for rate-limiting behavior that's unique to a method.

All Slack plans receive the same rate limit tier for each method.

### Pagination limitation {#pagination}

For methods supporting [cursored pagination](/apis/web-api/pagination), the rate limit given applies when you're _using_ pagination. If you're not, you'll receive stricter rate limits.

## Responding to rate limiting conditions {#headers}

If you exceed a rate limit when using any of our HTTP-based APIs (including incoming webhooks), Slack will return a `HTTP 429 Too Many Requests` error, and a `Retry-After` HTTP header containing the number of seconds until you can retry.

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

This response instructs your app to wait 30 seconds before attempting to call the method with any [token](/authentication/tokens) awarded to your app from this workspace.

Calls to other methods on behalf of this workspace are not restricted. Calls to the same method for other workspaces for this app are also not restricted.

## Limits when posting messages {#posting-messages}

In general, apps may post no more than one message per second per channel, whether a message is posted via [`chat.postMessage`](/reference/methods/chat.postMessage), an incoming webhook, or one of the many other ways to send messages in to Slack. We allow bursts over that limit for short periods. However, if your app continues to exceed its allowance over longer periods of time, we will begin rate limiting.

If you go over these limits while using the [Real Time Messaging API](/legacy/legacy-rtm-api) you will receive an error message as a reply. If you continue to send messages, your app will be disconnected.

## Profile update rate limits {#profile_updates}

Update a user's profile, including custom status, sparingly. Special rate limit rules apply when updating profile data with [`users.profile.set`](/reference/methods/users.profile.set). A token may update a single user's profile no more than **10** times per minute. And a single token may only set **30** user profiles per minute.

## Events API {#events}

Event deliveries to your server via the Events API currently max out at 30,000 per workspace/team per app per 60 minutes.

When a workspace generates more than 30,000 events, you'll receive an informative event called [`app_rate_limited`](/reference/events/app_rate_limited):

```
{
    "token": "Jhj5dZrVaK7ZwHHjRyZWjbDl",
    "type": "app_rate_limited",
    "team_id": "T123456",
    "minute_rate_limited": 1518467820,
    "api_app_id": "A123456"
}
```

## RTM APIs (legacy) {#rtm}

### Message delivery {#rtm-message-delivery}

Message delivery to your app is not rate limited over RTM. You'll receive every event the connecting token is allowed to see.

### Posting messages {#rtm-posting-messages}

Rate limits _do_ apply to posting messages or other write events to the Real Time Messaging websocket. Please limit writes to 1 per second.

The message server will disconnect any client that sends a message longer than 16 kilobytes.

### Obtaining websocket URLs {#rtm-websocket-urls}

Limit requests to [`rtm.start`](/reference/methods/rtm.start) and [`rtm.connect`](/reference/methods/rtm.connect) to no more than 1 per minute, with some bursting behavior allowed.

## Other functionality {#other}

We reserve the right to rate limit other functionality to prevent abuse, spam, denial-of-service attacks, or other security issues.
