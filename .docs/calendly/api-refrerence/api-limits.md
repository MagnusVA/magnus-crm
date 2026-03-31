# API Rate Limits

Calendly's API uses **user-based rate limiting** to ensure service quality, system stability, and fair usage across customers.

## Current Rate Limits

| Billing Tier | Rate Limit |
| --- | --- |
| Paid Plans | 500 requests per user per minute |
| Free Plan | 50 requests per user per minute |

- These limits apply to both direct API calls and calls made through third-party integrations.
- Rate limits are enforced per user.
- Only 8 OAuth tokens per user can be requested within a span of 1 minute.

## Endpoint Specific Rate Limits

| Endpoint | Rate Limit |
| --- | --- |
| Create Event Invitee | 10 requests per user per minute |
| | 50 requests per user per hour |
| | 125 requests per user per day |

## Behavior When Rate Limits Are Exceeded

If you exceed your allowed rate limit, the Calendly API will respond with:

```http
HTTP/2 429 Too Many Requests
Date: Wed, 10 Jan 2024 12:00:00 GMT
Content-Type: application/json
X-RateLimit-Limit: {your limit}
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 60
```

All responses include the following headers:

| Header | Description |
| --- | --- |
| `X-RateLimit-Limit` | Your rate limit ceiling |
| `X-RateLimit-Remaining` | Number of requests left in the current window |
| `X-RateLimit-Reset` | Number of seconds until the limit resets (typically 60 seconds) |

## Best Practices

- Use the `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers to monitor and manage your API usage.
- If you receive a `429` response, wait until the `X-RateLimit-Reset` time has elapsed before retrying.
- Implement **exponential backoff** or **retry-after** logic to gracefully handle retries.
