# How to find the organization or user URI

## Make a GET request to /users/me

To get the user URI, call [`GET /users/me`](https://developer.calendly.com/api-docs/b3A6MTEzMDIyOQ-get-current-user) to get the organization and user URI. Replace the `{access_token}` value with your [OAuth](https://developer.calendly.com/how-to-authenticate-with-oauth) or [personal access token](https://developer.calendly.com/how-to-authenticate-with-personal-access-tokens).

**Example request:**

```bash
curl --request GET \
  --url https://api.calendly.com/users/me \
  --header 'authorization: Bearer {access_token}'
```

## Review the response payload (for personal access tokens)

If you authenticated with your personal access token, the payload will contain information about you and your Calendly account. Note the values of the resources in the payload:

- the **user** URI is given as the value of `uri`
- the **organization** URI is given as the value of `current_organization`

![org and user uri scheme](https://images.ctfassets.net/9m49emnnmv2w/5V7Y8zf4aoCMssTXvEWrzZ/f633a7e4bb0a5cf3a5ee39a6a6e865f4/org_and_user_uri_scheme_24SEP21.png)

## Review the response payload (for OAuth)

If you authenticated with OAuth, the organization and user URI are referenced differently in the [access token's payload](https://developer.calendly.com/api-docs/b3A6NTkxNDA4-get-access-token):

- the **user** URI is given as the value of the `owner` key
- the **organization** URI is given as the value of the `organization` key

![owner and org URI schema](https://images.ctfassets.net/9m49emnnmv2w/xMblnymuA80L1uvFaVxLp/01a922beb16d5b7fff02a2823af0a224/owner_and_org_URI_schema_24SEP21.png)

## Find the organization or user URI for all Calendly members in your organization

If you already have a specific user or organization URI, use it to make a GET request to `/organization_memberships` [endpoint](https://developer.calendly.com/api-docs/b3A6NTkxNDI0-list-organization-memberships) which will return information about a user's membership to an organization, or a collection of all Calendly members in the organization, respectively.

## Review the response payload (for personal access tokens)

Depending on which URI you've used, the payload will contain information about your membership status to an organization, or information about all Calendly members in the organization. Note the values of the resources in the payload:

- the **user** URI is given as the value of `uri`
- the **organization** URI is given as the value of `organization`

In the user object of each collection, Calendly returns the user's `organization` URI and user URI as `uri`.

![organization membership schema](https://images.ctfassets.net/9m49emnnmv2w/7Bm5QF6cPgMrBAUONDYgCc/7232959e9d613065760b24e81a86cc36/organization_membership_schema_24SEP21.png)

## What's next

- [How to get scheduling page links for any team member across the organization (admins only)](https://developer.calendly.com/how-to-get-scheduling-page-links-for-team-members-across-the-organization)
- [Track and report on all scheduled events across the organization (admins only)](https://developer.calendly.com/track-and-report-on-all-scheduled-events-across-your-organization)
