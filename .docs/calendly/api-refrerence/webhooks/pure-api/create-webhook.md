# Create Webhook Subscription

**`POST`** `https://api.calendly.com/webhook_subscriptions`

Create a Webhook Subscription for an Organization or User.

- The `organization` subscription scope triggers the webhook for all subscribed events within the organization.
- The `user` subscription scope only triggers the webhook for subscribed events that belong to the specific user.
- The `group` subscription scope only triggers the webhook for subscribed events that belong to the specific group.

| Event | Allowed Subscription Scopes | Required Auth Scope |
| --- | --- | --- |
| `invitee.created` | `organization` `user` `group` | `scheduled_events:read` |
| `invitee.canceled` | `organization` `user` `group` | `scheduled_events:read` |
| `invitee_no_show.created` | `organization` `user` `group` | `scheduled_events:read` |
| `invitee_no_show.deleted` | `organization` `user` `group` | `scheduled_events:read` |
| `event_type.created` | `organization` `user` `group` | `event_types:read` |
| `event_type.deleted` | `organization` `user` `group` | `event_types:read` |
| `event_type.updated` | `organization` `user` `group` | `event_types:read` |
| `routing_form_submission.created` | `organization`<br><small>Create separate Webhook Subscriptions for events with different subscription scopes.</small> | `routing_forms:read` |

> **Required scopes:** `webhooks:write`

## Request

### Security: OAuth 2.0

Put the access token in the `Authorization: Bearer <TOKEN>` header.

**Authorization Code OAuth Flow**

- Authorize URL: [https://auth.calendly.com/oauth/authorize](https://auth.calendly.com/oauth/authorize)
- Token URL: [https://auth.calendly.com/oauth/token](https://auth.calendly.com/oauth/token)
- Refresh URL: [https://auth.calendly.com/oauth/token](https://auth.calendly.com/oauth/token)

### Security: Bearer Auth

Put the access token in the `Authorization: Bearer <TOKEN>` header.

Provide your bearer token in the Authorization header when making requests to protected resources.

Example: `Authorization: Bearer 123`

### Body

Content-Type: **`application/json`**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string (URI) | Yes | The URL where you want to receive POST requests for events you are subscribed to. |
| `events` | array[string] | Yes | List of user events to subscribe to. Allowed values: `invitee.canceled`, `invitee.created`, `invitee_no_show.created`, `invitee_no_show.deleted`, `routing_form_submission.created`. |
| `organization` | string (URI) | Yes | The unique reference to the organization that the webhook will be tied to. |
| `user` | string (URI) | No | The unique reference to the user that the webhook will be tied to. |
| `group` | string (URI) | No | The unique reference to the group that the webhook will be tied to. |
| `scope` | string | Yes | Indicates if the webhook subscription scope will be `organization`, `user`, or `group`. Allowed: `organization`, `user`, `group`. |
| `signing_key` | string | No | Optional secret key shared between your application and Calendly. See [Webhook signatures](https://developer.calendly.com/api-docs/ZG9jOjM2MzE2MDM4-webhook-signatures) (or [Webhook Signatures](../webhook-signature.md) in this repo) for additional information. |

## Responses

Possible HTTP status codes: **201**, **400**, **401**, **403**, **404**, **409**.

### `201` Created

**Headers**

| Header | Type | Description |
| --- | --- | --- |
| `Location` | string (URI) | Canonical reference (unique identifier) for the webhook. Example: `https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA` |

**Body** (`application/json`)

Root **`resource`** (required): Webhook Subscription object.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string (URI) | Yes | Canonical reference (unique identifier) for the webhook. |
| `callback_url` | string (URI) | Yes | The callback URL to use when the event is triggered. |
| `created_at` | string (date-time) | Yes | When the webhook subscription was created (e.g. `2020-01-02T03:04:05.678123Z`). |
| `updated_at` | string (date-time) | Yes | When the webhook subscription was last updated. |
| `retry_started_at` | string (date-time) \| null | Yes | The date and time the webhook subscription is retried. |
| `state` | string | Yes | `active` or `disabled`. |
| `events` | array[string] | Yes | Events to which the webhook is subscribed. |
| `scope` | string | Yes | `user`, `organization`, or `group`. |
| `organization` | string (URI) | Yes | The URI of the organization associated with the subscription. |
| `user` | string (URI) \| null | Yes | The URI of the user associated with the subscription. |
| `group` | string (URI) \| null | Yes | Example: `https://api.calendly.com/groups/AAAAAAAAAAAAAAAA` |
| `creator` | string (URI) \| null | Yes | The URI of the user who created the webhook subscription. |

### `400` Request is not valid

**Body** (`application/json`) — Error Object

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Allowed: `Invalid Argument` |
| `message` | string | Allowed: `The supplied parameters are invalid.` |
| `details` | array | Items: `parameter` (string), `message` (string, required), `code` (string). |

### `401` Cannot authenticate caller

**Body** (`application/json`) — Error Object

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Allowed: `Unauthenticated` |
| `message` | string | e.g. `The access token is invalid`, `The access token expired`, `The access token was revoked` |
| `details` | array | Same shape as 400. |

### `403` Permission denied or insufficient scope

**Body** (`application/json`) — `PostWebhookSubscriptionsError` (one of)

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Allowed: `Permission Denied` |
| `message` | string | e.g. `Please upgrade your Calendly account to Standard`, `You do not have permission to access this resource.`, `You do not have permission` |

### `404` Requested resource not found

**Body** (`application/json`) — Error Object

| Field | Type | Required |
| --- | --- | --- |
| `title` | string (`Resource Not Found`) | Yes |
| `message` | string (`The server could not find the requested resource.`) | Yes |
| `details` | array[ErrorResponseDetailsItem] | — |

`details` items: `parameter` (string), `message` (string, required), `code` (string).

### `409` Attempt to create a resource that already exists

**Body** (`application/json`) — Error Object

| Field | Type | Required |
| --- | --- | --- |
| `title` | string (`Already Exists`) | Yes |
| `message` | string (`Hook with this url already exists`) | Yes |
| `details` | array[ErrorResponseDetailsItem] | — |

---

## Examples

### Request body

```json
{
  "url": "https://blah.foo/bar",
  "events": [
    "invitee.created",
    "invitee.canceled",
    "invitee_no_show.created",
    "invitee_no_show.deleted"
  ],
  "organization": "https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA",
  "user": "https://api.calendly.com/users/BBBBBBBBBBBBBBBB",
  "scope": "user",
  "signing_key": "5mEzn9C-I28UtwOjZJtFoob0sAAFZ95GbZkqj4y3i0I"
}
```

### cURL

```bash
curl --request POST \
  --url https://api.calendly.com/webhook_subscriptions \
  --header 'Authorization: Bearer <TOKEN>' \
  --header 'Content-Type: application/json' \
  --data '{
  "url": "https://blah.foo/bar",
  "events": [
    "invitee.created",
    "invitee.canceled",
    "invitee_no_show.created",
    "invitee_no_show.deleted"
  ],
  "organization": "https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA",
  "user": "https://api.calendly.com/users/BBBBBBBBBBBBBBBB",
  "scope": "user",
  "signing_key": "5mEzn9C-I28UtwOjZJtFoob0sAAFZ95GbZkqj4y3i0I"
}'
```

### Response example (`201`)

```json
{
  "resource": {
    "uri": "https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA",
    "callback_url": "https://blah.foo/bar",
    "created_at": "2019-08-24T14:15:22.123456Z",
    "updated_at": "2019-08-24T14:15:22.123456Z",
    "retry_started_at": "2019-08-24T14:15:22.123456Z",
    "state": "active",
    "events": [
      "invitee.created"
    ],
    "scope": "user",
    "organization": "https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA",
    "user": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA",
    "group": "https://api.calendly.com/groups/AAAAAAAAAAAAAAAA",
    "creator": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA"
  }
}
```

### Error example (`404`)

```json
{
  "title": "Resource Not Found",
  "message": "The server could not find the requested resource.",
  "details": [
    {
      "parameter": "string",
      "message": "string"
    }
  ]
}
```
