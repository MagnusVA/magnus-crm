# List User's Event Types

**`GET`** `https://api.calendly.com/event_types`

Returns all Event Types associated with a specified User. Use:

- `organization` to look up all Event Types that belong to the organization
- `user` to look up a user's Event Types in an organization

Either `organization` or `user` are required query params when using this endpoint.

> **Required scopes:** `event_types:read`

See also: [API conventions](../../api-conventions.md), [organization or user URI](../../../organization/organization-or-user-uri.md).

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

Example: `Authorization: Bearer <access_token>`

### Query parameters

| Name                         | Type         | Required | Description                                                                                                                                                                                                 |
| ---------------------------- | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization`               | string (URI) | One of   | View available personal, team, and organization event types associated with the organization's URI. **Either `organization` or `user` is required.**                                                        |
| `user`                       | string (URI) | One of   | View available personal, team, and organization event types associated with the user's URI. **Either `organization` or `user` is required.**                                                                |
| `user_availability_schedule` | string (URI) | No       | Used in conjunction with `user`; returns a filtered list of Event Types that use the given primary availability schedule.                                                                                   |
| `admin_managed`              | boolean      | No       | Return only admin-managed event types if `true`, exclude admin-managed event types if `false`, or include all event types if omitted.                                                                         |
| `active`                     | boolean      | No       | Return only active event types if `true`, only inactive if `false`, or all event types if omitted.                                                                                                          |
| `count`                      | integer      | No       | The number of rows to return. **Min:** 1, **max:** 100, **default:** 20.                                                                                                                                    |
| `page_token`                 | string       | No       | The token to pass to get the next or previous portion of the collection.                                                                                                                                    |
| `sort`                       | string       | No       | Order results by the specified field and direction. Comma-separated list of `{field}:{direction}`. **Supported fields:** `name`, `position`, `created_at`, `updated_at`. **Direction:** `asc`, `desc`. **Default:** `name:asc`. **Example:** `name` |

## Responses

Possible HTTP status codes: **200**, **400**, **401**, **403**, **404**, **500**.

### `200` OK

**Body** (`application/json`)

| Field        | Type                 | Required | Description                                      |
| ------------ | -------------------- | -------- | ------------------------------------------------ |
| `collection` | array[Event Type]    | Yes      | Event types matching the query (see items below). |
| `pagination` | object (Pagination)  | Yes      | Pagination metadata (see below).                 |

**Event Type** (each item in `collection`)

| Field                | Type                                   | Required | Description |
| -------------------- | -------------------------------------- | -------- | ----------- |
| `active`             | boolean                                | Yes      | Indicates if the event is active or not. |
| `admin_managed`      | boolean                                | Yes      | Indicates if this event type is managed by an organization admin. |
| `booking_method`     | string                                 | Yes      | Indicates if the event type is for a poll or an instant booking. **Allowed:** `instant`, `poll`. **Example:** `poll` |
| `color`              | string                                 | Yes      | Hexadecimal color of the event type's scheduling page. **Pattern:** `^#[a-f\d]{6}$`. **Example:** `#fff200` |
| `created_at`         | string (date-time)                     | Yes      | When the event type was created. **Example:** `2019-01-02T03:04:05.678123Z` |
| `custom_questions`   | array[EventTypeCustomQuestion]         | Yes      | Custom questions configured on the event type. |
| `deleted_at`         | string (date-time) \| null             | Yes      | When the event type was deleted; useful when fetching deleted types for scheduled events that still reference them. **Example:** `2019-01-02T03:04:05.678123Z` |
| `description_html`   | string \| null                         | Yes      | Description formatted with HTML. **Example:** `<p>15 Minute Meeting</p>` |
| `description_plain`  | string \| null                         | Yes      | Description in plain text. **Example:** `15 Minute Meeting` |
| `duration`           | number                                 | Yes      | Length of sessions booked with this event type (minutes). **Example:** `15` |
| `duration_options`   | array[integer] \| null                 | Yes      | Duration options; always `null` for ad hoc event types. **Example:** `[1,13,15,720]` |
| `internal_note`      | string \| null                         | Yes      | Note associated with the event type. **Example:** `Internal note` |
| `is_paid`            | boolean                                | Yes      | Whether the event type requires payment. |
| `kind`               | string                                 | Yes      | **Allowed:** `solo` (individual user), `group` |
| `locale`             | string                                 | Yes      | Locale for the scheduling page. **Allowed:** `en`, `fr`, `es`, `de`, `nl`, `pt`, `it`, `uk`. **Example:** `de` |
| `locations`          | array[LocationConfiguration] \| null   | Yes      | Configuration for each possible location for this event type. |
| `name`               | string \| null                         | Yes      | Human-readable event type name. **Example:** `15 Minute Meeting` |
| `pooling_type`       | string \| null                         | Yes      | Group scheduling mode. **Allowed:** `round_robin`, `collective`, `multi_pool`, `null` (no group availability). |
| `position`           | integer                                | Yes      | Display order, starting at 0. |
| `profile`            | Profile \| null                        | Yes      | Publicly visible profile of the User or Team associated with the event type (some event types have no profile). |
| `scheduling_url`     | string (URI)                           | Yes      | URL where invitees book this event type. **Example:** `https://calendly.com/acmesales` |
| `secret`             | boolean                                | Yes      | Whether the event type is hidden on the owner's main scheduling page. |
| `slug`               | string \| null                         | Yes      | URL segment identifying this event type. **Example:** `acmesales` |
| `type`               | string                                 | Yes      | **Allowed:** `StandardEventType`, `AdhocEventType` |
| `updated_at`         | string (date-time)                     | Yes      | When the event type was last updated. **Example:** `2019-08-07T06:05:04.321123Z` |
| `uri`                | string (URI)                           | Yes      | Canonical reference (unique identifier). **Example:** `https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA` |

**`pagination` object**

| Field                 | Type                 | Required | Description                                                                 |
| --------------------- | -------------------- | -------- | --------------------------------------------------------------------------- |
| `count`               | integer              | Yes      | Number of rows in this response. **Min:** 0, **max:** 100. **Example:** `20` |
| `next_page`           | string (URI) \| null | Yes      | Full URL for the next page; `null` if there is no next page.                |
| `previous_page`       | string (URI) \| null | Yes      | Full URL for the previous page; `null` if there is no previous page.        |
| `next_page_token`     | string \| null       | Yes      | Token for the next page; `null` if none.                                    |
| `previous_page_token` | string \| null       | Yes      | Token for the previous page; `null` if none.                                |

Use `next_page` or `next_page_token` with subsequent requests per [API conventions](../../api-conventions.md) (keyset/cursor pagination).

### Example request (cURL)

```bash
curl --request GET \
  --url 'https://api.calendly.com/event_types?organization=https%3A%2F%2Fapi.calendly.com%2Forganizations%2FAAAAAAAAAAAAAAAA' \
  --header 'Authorization: Bearer {access_token}' \
  --header 'Content-Type: application/json'
```

### Example response (`200`)

```json
{
  "collection": [
    {
      "uri": "https://api.calendly.com/event_types/AAAAAAAAAAAAAAAA",
      "name": "15 Minute Meeting",
      "active": true,
      "slug": "acmesales",
      "scheduling_url": "https://calendly.com/acmesales",
      "duration": 15,
      "kind": "solo",
      "type": "StandardEventType",
      "color": "#fff200",
      "created_at": "2019-01-02T03:04:05.678123Z",
      "updated_at": "2019-08-07T06:05:04.321123Z",
      "internal_note": null,
      "description_plain": "15 Minute Meeting",
      "description_html": "<p>15 Minute Meeting</p>",
      "profile": null,
      "secret": false,
      "booking_method": "instant",
      "custom_questions": [],
      "deleted_at": null,
      "admin_managed": false,
      "locations": null,
      "position": 0,
      "locale": "en",
      "duration_options": null,
      "is_paid": false,
      "pooling_type": null
    }
  ],
  "pagination": {
    "count": 20,
    "next_page": "https://api.calendly.com/event_types?count=1&page_token=sNjq4TvMDfUHEl7zHRR0k0E1PCEJWvdi",
    "previous_page": "https://api.calendly.com/event_types?count=1&page_token=VJs2rfDYeY8ahZpq0QI1O114LJkNjd7H",
    "next_page_token": "sNjq4TvMDfUHEl7zHRR0k0E1PCEJWvdi",
    "previous_page_token": "VJs2rfDYeY8ahZpq0QI1O114LJkNjd7H"
  }
}
```

The example above illustrates shape; field sets on real responses match the schema table.

### `400` Request is not valid

**Body** (`application/json`) — Error Object

| Field     | Type                              | Required | Description |
| --------- | --------------------------------- | -------- | ----------- |
| `title`   | string                            | Yes      | **Allowed value:** `Invalid Argument` |
| `message` | string                            | Yes      | **Allowed value:** `The supplied parameters are invalid.` |
| `details` | array[ErrorResponseDetailsItem] | No       | Per-parameter errors (see below). |

**`details[]` item**

| Field       | Type   | Required | Description |
| ----------- | ------ | -------- | ----------- |
| `parameter` | string | No       | Query or body parameter name. |
| `message`   | string | Yes      | Human-readable error for this parameter. |
| `code`      | string | No       | Machine-readable error code. |

### `401` Cannot authenticate caller

**Body** (`application/json`) — Error Object

| Field     | Type                              | Required | Description |
| --------- | --------------------------------- | -------- | ----------- |
| `title`   | string                            | Yes      | **Allowed value:** `Unauthenticated` |
| `message` | string                            | Yes      | **Allowed values:** `The access token is invalid`, `The access token expired`, `The access token was revoked` |
| `details` | array[ErrorResponseDetailsItem] | No       | Same shape as `400` details. |

### `403` Permission Denied or insufficient scope

**Body** (`application/json`) — `EventTypesError` (one of)

| Field     | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `title`   | string | Yes      | **Allowed value:** `Permission Denied` |
| `message` | string | Yes      | **Allowed values:** `This user is not in your organization`, `You do not have permission`, `You do not have permission to access this resource.` |

### `404` Requested resource not found

**Body** (`application/json`) — Error Object

| Field     | Type                              | Required | Description |
| --------- | --------------------------------- | -------- | ----------- |
| `title`   | string                            | Yes      | **Allowed value:** `Resource Not Found` |
| `message` | string                            | Yes      | **Allowed value:** `The server could not find the requested resource.` |
| `details` | array[ErrorResponseDetailsItem] | No       | Same shape as `400` details. |

### Example error response (`404`)

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

### `500` Server error

Treat as a standard Calendly server error. Retry with backoff per [API limits](../../api-limits.md).
