---
name: convex-dev-workos-authkit
description: Integrate with AuthKit events and actions, and keep auth data synced in your Convex database. Use this skill whenever working with WorkOS AuthKit or related Convex component functionality.
---

# WorkOS AuthKit

## Instructions

The WorkOS AuthKit component provides official integration between WorkOS AuthKit authentication and Convex databases. It automatically syncs user data from WorkOS to Convex via webhooks, handles WorkOS events like user creation and deletion with custom Convex functions, and supports WorkOS actions to control user registration and authentication flows. The component manages the complete lifecycle of auth data synchronization and event handling in a reliable, durable way.

### Installation

```bash
npm install @convex-dev/workos-authkit
```

## Use cases

- **Sync user profiles automatically** when you need WorkOS user data (email, firstName, lastName) to stay in sync with your Convex database without manual API calls
- **Handle user lifecycle events** to create related data like todo lists, user preferences, or team memberships when users are created, updated, or deleted in WorkOS
- **Control user registration flows** by implementing WorkOS actions that validate email domains, check invitation codes, or enforce custom business rules before allowing signup
- **Extend auth data with app-specific fields** by maintaining your own users table that references the synced WorkOS data and adds custom properties
- **Process additional WorkOS events** like session creation or team updates by configuring webhook handlers for any WorkOS event type

## How it works

The component installs as a standard Convex component using `app.use()` in your convex.config.ts file. You create an AuthKit client instance that connects to the component and register its HTTP routes to handle incoming webhooks from WorkOS.

Webhook events from WorkOS automatically trigger the component's internal functions to sync user data. You can extend this by defining event handlers using the `authKit.events()` method, which lets you respond to user.created, user.updated, user.deleted, and any additional WorkOS event types. Each handler receives a mutation context and typed event data.

For WorkOS actions, you use the `authKit.actions()` method to define handlers that can allow or deny authentication and registration attempts. The component provides response objects with `allow()` and `deny()` methods to control the outcome. All webhook signatures and action secrets are verified automatically using environment variables.

## When NOT to use

- When a simpler built-in solution exists for your specific use case
- If you are not using Convex as your backend
- When the functionality provided by WorkOS AuthKit is not needed

## Resources

- [npm package](https://www.npmjs.com/package/%40convex-dev%2Fworkos-authkit)
- [GitHub repository](https://github.com/get-convex/workos-authkit)
- [Live demo](https://github.com/get-convex/workos-authkit/tree/main/example)
- [Convex Components Directory](https://www.convex.dev/components/workos-authkit)
- [Convex documentation](https://docs.convex.dev)
