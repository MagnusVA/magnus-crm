# API Conventions

The Calendly API allows our users to create their own custom features by providing them programmatic access to their Calendly data and functionality. In order to give our users a best-in-class experience when using our API, we have developed this API with standard and consistent conventions in mind. We've created well-defined conventions to make integrations against our API an intuitive and simple experience for our users.

---

## Resource Reference by Uniform Resource Identifier (URI)

Instead of referencing unique resources by an ID, which can be common in some RESTful APIs, we've decided that a more uniform approach to identifying a resource is to use a Uniform Resource Identifier (URI).

### Requests

For requests, this means that when a parameter is a resource reference, it has to be a URI. For example, when calling `GET /organization_memberships`, we pass the URI of a `user` to filter my results by that user:

```json
// GET /organization_memberships?user=https://api.calendly.com/users/ABC123XYZ789

{
  "collection": [...],
  "pagination": {...}
}
```

### Responses

When calling one of our API endpoints, you may notice that within the response data, any attribute referring to another resource has a URI value. For example, when calling `GET /event_types`, you may notice that `owner` has a URI value:

```json
// GET /event_types

{
  "collection": [
    {
      "profile": {
        "name": "John Doe",
        "owner": "https://api.calendly.com/users/ABC123XYZ789",
        "type": "User"
      },
      ...
    }
  ],
  ...
}
```

Since `owner` is a separate resource, we reference it through a URI. If the user wishes to access more data for the `owner`, a request to the provided URI can be made:

```json
// GET /users/ABC123XYZ789

{
  "resource": {
    "avatar_url": null,
    "created_at": "2020-04-20T20:44:29.052644Z",
    "email": "john.doe@fakeaddress.com",
    "name": "John Doe",
    "scheduling_url": "https://www.calendly.com/john-doe",
    "slug": "john-doe",
    "timezone": "America/New_York",
    "updated_at": "2020-09-08T19:11:15.831274Z",
    "uri": "https://api.calendly.com/users/ABC123XYZ789"
  }
}
```

---

## Keyset-based Pagination

Also referred to as "cursor-based pagination", this approach is how we handle pagination for all of our endpoints that can return a collection of multiple resources. Unlike offset-limit pagination, this approach allows us to provide accurate data to our users, despite resources possibly being added/removed to the collection on subsequent page retrievals.

When calling an endpoint that returns a collection of multiple resources, you will notice a `pagination` object in your response body. Inside of the `pagination` object is a `next_page` attribute. If there are more resources than what has been returned, the `next_page` attribute will contain the URL to the next page of resources; otherwise, `next_page` will be `null`:

```json
// GET /scheduled_events (has another page of resources)
{
  "collection": [...],
  "pagination": {
    "count": 20,
    "next_page": "https://api.calendly.com/scheduled_events?count=5&page_token=nODUpzeh8eNPGLrNaBoMK1HijZiO6H1t&user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FAFEHBEDFE6WUE2R7"
  }
}

// GET /scheduled_events (has no more pages of resources)
{
  "collection": [...],
  "pagination": {
    "count": 10,
    "next_page": null
  }
}
```

This makes it convenient for our users to retrieve the next page of data for a large collection of resources.

---

## Deterministic Irrespective of Requester

Our API will always return data based on the request being made and never based on the requester making the data. For example, if the user requesting the data has an "admin" role, the data will be exactly the same as if the requesting user had a "user" role. This approach helps ensure that our users never become confused around the data being requested and the requester of the data. The response will be based solely on the request.

As a result of this approach, our API users will always need to be very explicit about what data they are requesting. Our API users will never get responses based on the requester of the data.

For example, despite whether my role is "admin" or "user", when making a request to `/event_types`, the response will also be based on the actual request made:

**Current user role is `admin`** — example:

```json
// GET /event_types?user=<user_a>
{
  "collection": [
    { "uri": "https://api.calendly.com/event_types/A", ... },
    { "uri": "https://api.calendly.com/event_types/B", ... },
    { "uri": "https://api.calendly.com/event_types/C", ... }
  ],
  ...
}
```

**Current user role is `user`** — for the same request (`GET /event_types?user=<user_a>`), the response is the same: it depends on the request parameters, not the caller’s role.

### Permission

This does not mean, however, that all users will have the same level of access to the data. For example, if the requester has the role of "admin", they may be able to request the organization's webhooks successfully:

```json
// Current User Role: "admin"
// GET /webhook_subscriptions?scope=organization&organization=<org_a>

Status: 200 OK
```

...while a requester with the role of "user" may not have access when making the same request:

```json
// Current User Role: "user"
// GET /webhook_subscriptions?scope=organization&organization=<org_a>

Status: 403 Permission Denied
```
