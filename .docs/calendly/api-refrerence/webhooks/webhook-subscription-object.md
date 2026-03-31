# Webhook Subscription

Webhook Subscription Object.

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string (`uri`) | Yes | Canonical reference (unique identifier) for the webhook. Example: `https://api.calendly.com/webhook_subscriptions/AAAAAAAAAAAAAAAA` |
| `callback_url` | string (`uri`) | Yes | The callback URL to use when the event is triggered. Example: `https://blah.foo/bar` |
| `created_at` | string (`date-time`) | Yes | The moment when the webhook subscription was created (e.g. `2020-01-02T03:04:05.678123Z`). |
| `updated_at` | string (`date-time`) | Yes | The moment when the webhook subscription was last updated (e.g. `2020-01-02T03:04:05.678123Z`). |
| `retry_started_at` | string (`date-time`) \| null | Yes | The date and time the webhook subscription is retried. |
| `state` | string | Yes | Indicates if the webhook subscription is `active` or `disabled`. Allowed values: `active`, `disabled`. |
| `events` | array[string] | Yes | A list of events to which the webhook is subscribed. Allowed values: `invitee.created`, `invitee.canceled`, `invitee_no_show.created`, `invitee_no_show.deleted`, `routing_form_submission.created`. |
| `scope` | string | Yes | The scope of the webhook subscription. Allowed values: `user`, `organization`, `group`. Example: `user`. |
| `organization` | string (`uri`) | Yes | The URI of the organization that's associated with the webhook subscription. Example: `https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA` |
| `user` | string (`uri`) \| null | Yes | The URI of the user that's associated with the webhook subscription. Example: `https://api.calendly.com/users/AAAAAAAAAAAAAAAA` |
| `group` | string (`uri`) \| null | Yes | Example: `https://api.calendly.com/groups/AAAAAAAAAAAAAAAA` |
| `creator` | string (`uri`) \| null | Yes | The URI of the user who created the webhook subscription. Example: `https://api.calendly.com/users/AAAAAAAAAAAAAAAA` |

## Example

```json
{
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
  "creator": "https://api.calendly.com/users/AAAAAAAAAAAAAAAA"
}
```

In API responses this object often appears under a `resource` key (see [Create Webhook Subscription](./pure-api/create-webhook.md)).
