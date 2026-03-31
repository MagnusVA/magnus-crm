# Authorization Scopes

## Overview

Authorization scopes define the permissions that an application requests when accessing Calendly APIs on behalf of a user. Scopes control which Calendly resources your integration can read or modify. When a user installs your app, the scopes you request determine what actions your app is permitted to perform.

Scopes follow these rules:

**Read vs Write**

- Read scopes allow safe retrieval of data.
- Write scopes allow creation, modification, or deletion of data.

**Hierarchy**

- A **`:write`** scope implicitly includes the corresponding **`:read`** scope within the same domain.

**Webhooks**

- Webhook subscriptions must be scoped by the event family you want to receive. Your app must be granted the related read scopes to receive webhook event payloads.

## Scope Catalog

| Category | Scope | Description | Provides access to |
| --- | --- | --- | --- |
| **Scheduling** | `availability:read` | Retrieve user and event-type availability. | `GET /user_busy_times`<br>`GET /user_availability_schedules`<br>`GET /user_availability_schedules/{uuid}`<br>`GET /event_type_availability_schedules` |
| | `availability:write` | Update event type availability. | `PATCH /event_type_availability_schedules/{uuid}` |
| | `event_types:read` | Retrieve event type details and available times. | `GET /event_types`, `GET /event_types/{uuid}`<br>`GET /event_type_available_times`<br>`GET /event_type_memberships` |
| | `event_types:write` | Create or update event types. | `POST /event_types`<br>`PATCH /event_types/{uuid}`<br>`POST /one_off_event_types` |
| | `locations:read` | Retrieve configured meeting locations. | `GET /locations` |
| | `routing_forms:read` | Retrieve routing forms and submissions. | `GET /routing_forms`<br>`GET /routing_forms/{uuid}`<br>`GET /routing_form_submissions`<br>`GET /routing_form_submissions/{uuid}` |
| | `shares:write` | Create and customize a single-use scheduling link from an existing event type. | `POST /shares` |
| | `scheduled_events:read` | Retrieve scheduled events and event invitee information. | `GET /scheduled_events`<br>`GET /scheduled_events/{uuid}`<br>`GET /scheduled_events/{uuid}/invitees`<br>`GET /scheduled_events/{uuid}/invitees/{invitee_uuid}`<br>`GET /invitee_no_shows/{uuid}` |
| | `scheduled_events:write` | Create event invitees, cancel events or mark invitees as no-show. | `POST /invitees`<br>`POST /scheduled_events/{uuid}/cancellation`<br>`POST /invitees/{uuid}/no_show`<br>`DELETE /invitees/{uuid}/no_show` |
| | `scheduling_links:write` | Create a single-use scheduling link from an existing event type without any customization. | `POST /scheduling_links` |
| **User management** | `groups:read` | Retrieve group details and relationships. | `GET /groups`<br>`GET /groups/{uuid}`<br>`GET /group_relationships`<br>`GET /group_relationships/{uuid}` |
| | `organizations:read` | Retrieve organization data, memberships, and invitations. | `GET /organizations/{uuid}`<br>`GET /organization_memberships`<br>`GET /organization_memberships/{uuid}`<br>`GET /organization_invitations`<br>`GET /organization_invitations/{uuid}` |
| | `organizations:write` | Invite or remove users from an organization. | `POST /organization_invitations`<br>`DELETE /organization_invitations/{uuid}`<br>`DELETE /organization_memberships/{uuid}` |
| | `users:read` | Retrieve user information. | `GET /users/{uuid}`<br>`GET /users/me` |
| **Webhooks** | `webhooks:read` | Retrieve webhook subscriptions and sample payloads. | `GET /webhook_subscriptions`<br>`GET /webhook_subscriptions/{uuid}`<br>`GET /webhook_subscriptions/sample_data` |
| | `webhooks:write` | Create or delete webhook subscriptions. | `POST /webhook_subscriptions`<br>`DELETE /webhook_subscriptions/{uuid}` |
| **Security & Compliance** | `activity_log:read` | View organization activity. | `GET /activity_log_entries` |
| | `data_compliance:write` | Delete invitee or event data. | `POST /data_compliance/deletion_event`<br>`POST /data_compliance/invitee_deletion` |
| | `outgoing_communications:read` | Retrieve a list of outgoing SMS and email communications. | `GET /outgoing_communications` |

## Required Scopes Per Endpoint

Each API endpoint in the reference includes a "Required scopes" section that tells you which Auth scopes must be granted for the request to succeed. Example callout:

![Required scopes](https://images.ctfassets.net/9m49emnnmv2w/7FcjyfA3h6ClTIIXFnERLq/f19ec5780d3da9b34aee32d7268e2f04/RequiredScopesCallout.png)

When a request is missing required scopes, the API returns an error indicating insufficient permissions.

## Choosing Scopes

When your app initiates an OAuth flow, it should request the minimum set of scopes needed for your use cases. Overly broad scopes can lead to unnecessary user friction at install time. Review your integration's features and map them to the scopes in the catalog above.

**Example**: Syncing basic scheduling data into a third party system

- `scheduled_events:read`  
  Required to read scheduled meetings and their status.
- `invitees:read`  
  Required to associate meetings with people and contact details.
- `webhooks:write` (optional)  
  Recommended for near real time updates. Not required if the integration relies on polling.

## Troubleshooting

**Missing scope error**

If you receive a 403 error indicating missing scopes:

1. Verify that the scopes requested during installation include all required by the endpoint you are calling.
2. Confirm that the user granted all requested scopes (users can decline scopes during install).
3. For existing installs, you may need to reauthorize the app to request additional scopes.

**Webhooks not delivering events**

- Check that `webhooks:write` is granted.
- Confirm that your subscription includes the event family you want to receive.
- Ensure that the related domain read scopes are also granted.

## Backward Compatibility

Legacy OAuth apps and Personal Access Tokens issued before the introduction of scoped permissions retain full access to available endpoints by default.

For newly created OAuth apps and new Personal Access Tokens, no API access is granted until scopes are explicitly requested and approved.

When a legacy token is refreshed, it is automatically migrated to the scoped token format. This migration happens transparently and does not require the user to reauthorize the application.

## Sample Authorization URL

Replace `CLIENT_ID` and `REDIRECT_URI` with your values:

```http
https://auth.calendly.com/oauth/authorize
?client_id=CLIENT_ID
&redirect_uri=REDIRECT_URI
&response_type=code
&scope=scheduled_events:read webhooks:write
```

List scopes separated by spaces. Only include the scopes your app needs.
