# Authorization Revamp Design: Review & Gap Analysis

**Date:** 2026-04-05  
**Status:** Comprehensive review complete with critical additions identified

---

## Executive Summary

The design document is **strong and well-structured**. It correctly identifies security risks, proposes a four-layer defense-in-depth architecture, and includes detailed implementation patterns. However, **there are 5 material gaps** that must be addressed before implementation:

1. **No error handling strategy** for authorization failures
2. **No account provisioning/seeding flow** for new users
3. **Incomplete testing strategy** across auth layers
4. **Missing audit logging** for access and mutations
5. **Unspecified token expiry + refresh logic** for session management

Additionally, **3 architectural clarifications** are needed to close open questions.

---

## Assessment: What's Good

### ✅ Four-Layer Architecture (Solid)
- **Clear separation of concerns**: proxy (fast), RSC (secure), Convex (data), client (UX)
- **Defense in depth**: Every layer validates independently
- **Performance-conscious**: Recognizes bottlenecks (proxy speed, cache deduplication, no double-fetch)
- **Security model is sound**: Every attack vector is covered in the matrix

### ✅ Migration Strategy (Pragmatic)
- Phased approach (5 phases, non-breaking early phases)
- Risk assessment per phase
- Isolated page-by-page conversion reduces blast radius
- Clearly separates immediate work from future Polish (Phase 4) and advanced migrations (Phase 5)

### ✅ Design Patterns (Best Practices)
- Uses `React.cache()` for deduplication (per Vercel guidance)
- Composition over boolean props (`<RequirePermission>` instead of `isAdmin` boolean)
- Server Actions pattern is correct (authenticate per action)
- Permission layering (Phase 1: conceptual; Phase 2: WorkOS native)

---

## Critical Gaps to Fill

### Gap 1: Error Handling Strategy (CRITICAL)

**What's missing:**
- How should authorization failures be handled? (HTTP 403? Redirect?)
- What error messages should users see?
- How should invalid tokens be handled?
- What happens if a role check fails in a Server Action mid-mutation?

**Why it matters:**
- Without a consistent error strategy, teams will implement ad-hoc solutions
- Poorly handled auth errors leak information (403 vs 404 reveals what exists)
- Client-side error recovery (retry, re-login) is undefined

**Recommend adding:**

```markdown
## Error Handling Strategy

### 4a. HTTP Status Codes & Behavior

| Scenario | Response | Behavior |
|----------|----------|----------|
| Valid session, insufficient role | 302 → role-appropriate page | Use `redirect()` in RSCs (server-side) |
| Valid session, insufficient permission in Server Action | 500 w/ structured error | Convex throws; Client-side error boundary catches |
| Expired token in RSC | 302 → /sign-in | `withAuth({ ensureSignedIn: true })` handles |
| Invalid token in Server Action | 500 w/ "Unauthorized" | `verifySession()` redirects; not reached in action |
| Token refresh needed | Automatic (browser) | WorkOS SDK handles cookie refresh transparently |

### 4b. Client-Side Error Recovery

```tsx
// Error boundary for auth failures
export function AuthErrorBoundary({ children }) {
  return (
    <ErrorBoundary
      onError={(error) => {
        if (error.message.includes("Unauthorized")) {
          // Trigger re-auth or redirect to sign-in
          window.location.href = "/sign-in";
        }
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
```

### 4c. Convex Mutation Failures

When a Convex mutation fails due to authorization:

```ts
// App code
try {
  await updateTeamMember(userId, newRole);
} catch (error) {
  if (error.message.includes("not authorized")) {
    showToast("You don't have permission to do that", "error");
  } else {
    showToast("Something went wrong", "error");
  }
}
```

Convex should throw descriptive errors:

```ts
// convex function
export const updateTeamMember = mutation(async (ctx, args) => {
  const { userId, tenantId } = await requireTenantUser(ctx, ["tenant_master"]);
  
  // ✅ Do this: throw with a descriptive message
  if (!canUpdateMember(userId, args.targetUserId)) {
    throw new Error("You do not have permission to update this user");
  }
  
  // ❌ Don't do this: generic error
  // throw new Error("Unauthorized");
});
```
```

---

### Gap 2: User Provisioning & First-Time Access (CRITICAL)

**What's missing:**
- How does a new user (created in WorkOS) get a CRM user record?
- What if the Convex user creation fails but WorkOS succeeded?
- What's the expected state of a newly invited user before/after they claim their account?
- Does `getAuthorizedUser()` create the user on-demand, or must it exist beforehand?

**Why it matters:**
- Invited users cannot access the app until provisioned
- Race conditions: WorkOS + Convex out of sync
- Unclear who's responsible for provisioning (WorkOS flow, manual admin action, or auto-create in `getCurrentUser`)

**Recommend adding:**

```markdown
## User Provisioning & Onboarding

### Provisioning Flow

1. **Admin invites user** via WorkOS User Management widget
   - User is created in WorkOS (email, org assigned)
   - No CRM user yet

2. **Invited user clicks email link** → sign-in flow
   - WorkOS session created
   - Browser requests `/workspace` (first time)

3. **Workspace layout calls `getAuthorizedUser()`**
   ```ts
   export const getAuthorizedUser = cache(async (): Promise<AuthorizedUser> => {
     const session = await verifySession();
     
     let crmUser = await fetchQuery(
       api.users.queries.getCurrentUser,
       {},
       { token: session.accessToken },
     );
     
     // Auto-provision: if WorkOS user exists but CRM user doesn't
     if (!crmUser) {
       crmUser = await fetchMutation(
         api.users.mutations.provisionUserFromWorkOS,
         { workosUserId: session.user.id },
         { token: session.accessToken },
       );
     }
     
     return { session, crmUser };
   });
   ```

4. **Workspace layout renders with provisioned user**
   - CRM user record exists
   - Role is assigned (default: "closer" or from WorkOS directory sync)

### Idempotency & Race Conditions

- `provisionUserFromWorkOS` must be idempotent (if called twice, second is no-op)
- Use Convex's `getOneFrom()` + `insert()` pattern to avoid duplicates
- If provision fails (e.g., tenant doesn't exist), redirect to onboarding

### Claim Flow (Existing Auto-Claim)

The current "auto-claim invited user" flow (in workspace layout) should move to a client component within `WorkspaceShell` after layout conversion:

```tsx
// app/workspace/_components/workspace-shell.tsx
"use client";

import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

export function WorkspaceShell({ children, role }) {
  const claimOrganization = useMutation(api.workos.organizations.claimOrganization);
  
  useEffect(() => {
    // On first mount, try to claim the organization if the user was invited
    claimOrganization({}).catch(() => {
      // Already claimed or not invited -- silent fail
    });
  }, []);
  
  return (
    // ...
  );
}
```

This preserves the existing behavior while working with the new RSC layout.
```

---

### Gap 3: Incomplete Testing Strategy (CRITICAL)

**What's missing:**
- No test coverage targets
- No unit tests shown for auth helpers
- No e2e test scenarios for auth flows
- How to test server-side auth without mocking Convex?
- How to test permission matrix changes?

**Why it matters:**
- Auth bugs are the most critical kind
- Teams need examples of how to test protected pages
- Permission regressions can silently introduce security holes

**Recommend adding:**

```markdown
## Testing Strategy

### Unit Tests (`lib/auth.ts` helpers)

Test auth helpers in isolation with mocked `withAuth()` and `fetchQuery`:

```ts
// lib/auth.test.ts
import { describe, it, expect, vi } from "vitest";
import { verifySession, requireRole } from "./auth";

describe("verifySession", () => {
  it("redirects if no user", async () => {
    vi.mock("@workos-inc/authkit-nextjs", () => ({
      withAuth: () => ({ user: null }),
    }));
    
    // Use Next.js test utils to catch redirect()
    await expect(verifySession()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("returns session if user exists", async () => {
    vi.mock("@workos-inc/authkit-nextjs", () => ({
      withAuth: () => ({
        user: { id: "user123", email: "test@example.com" },
        accessToken: "token123",
        organizationId: "org123",
      }),
    }));
    
    const session = await verifySession();
    expect(session.user.email).toBe("test@example.com");
  });
});

describe("requireRole", () => {
  it("redirects if role not allowed", async () => {
    vi.mock("./auth", () => ({
      getAuthorizedUser: () => ({
        session: { user: { id: "user123" }, organizationId: "org123" },
        crmUser: { role: "closer" },
      }),
    }));
    
    await expect(requireRole(["tenant_admin"])).rejects.toThrow("NEXT_REDIRECT");
  });

  it("returns user if role allowed", async () => {
    // similar pattern
  });
});
```

### E2E Tests (`test/e2e/auth.spec.ts`)

Test full request flow using Playwright:

```ts
import { test, expect } from "@playwright/test";

test("closer cannot access /workspace/team", async ({ page }) => {
  // 1. Sign in as closer
  await page.goto("/sign-in");
  await page.fill("[name=email]", "closer@example.com");
  await page.click("button:has-text('Sign In')");
  // (WorkOS flow)
  
  // 2. Try to visit admin page
  await page.goto("/workspace/team");
  
  // 3. Should redirect to closer dashboard, not show team page
  await expect(page).toHaveURL("/workspace/closer");
});

test("admin can access /workspace/team", async ({ page }) => {
  // Sign in as admin
  // Visit /workspace/team
  // Page should load successfully
});

test("unauthenticated user redirected to sign-in", async ({ page }) => {
  // Visit /workspace without session
  // Should redirect to /sign-in
});

test("expired token triggers re-auth", async ({ page }) => {
  // Sign in, let session expire
  // Make a request
  // Should redirect to /sign-in or show re-auth prompt
});
```

### Permission Matrix Tests

When adding/changing permissions, run a test matrix:

```ts
// convex/lib/permissions.test.ts
import { PERMISSIONS } from "./permissions";
import { describe, it, expect } from "vitest";

describe("PERMISSIONS", () => {
  it("all permission keys have defined roles", () => {
    for (const [perm, roles] of Object.entries(PERMISSIONS)) {
      expect(roles.length).toBeGreaterThan(0);
    }
  });

  it("team:invite restricted to admins", () => {
    expect(PERMISSIONS["team:invite"]).not.toContain("closer");
    expect(PERMISSIONS["team:invite"]).toContain("tenant_admin");
  });

  it("no orphaned roles", () => {
    const allRoles = new Set(["tenant_master", "tenant_admin", "closer"]);
    const usedRoles = new Set(
      Object.values(PERMISSIONS).flatMap(r => r)
    );
    
    for (const role of usedRoles) {
      expect(allRoles).toContain(role);
    }
  });
});
```

### Coverage Target

- **Unit tests** (`lib/auth.ts`, `convex/lib/permissions.ts`): 80%+ coverage
- **E2E tests**: All sensitive routes (admin pages, mutations, profile)
- **Manual testing checklist** (before each release):
  - [ ] Closer cannot see admin UI
  - [ ] Admin cannot see closer-only UI
  - [ ] Role change reflected immediately on next page navigation
  - [ ] Session expiry triggers re-auth
  - [ ] New invited user can claim account
```

---

### Gap 4: Missing Audit Logging (IMPORTANT)

**What's missing:**
- No logging of access to sensitive pages
- No audit trail for mutations (who changed what, when)
- No alerting on suspicious patterns (e.g., failed role checks)

**Why it matters:**
- Compliance requirements (SOC 2, HIPAA, GDPR)
- Incident investigation (who accessed what data?)
- Detecting misuse (repeated failed auth attempts)

**Recommend adding:**

```markdown
## Audit Logging

### What to Log

1. **Access logs** (in RSCs & Server Actions):
   - User ID, timestamp, route/action, allowed/denied
   - Redirect reason if denied

2. **Mutation logs** (in Convex functions):
   - User ID, mutation name, arguments (sanitized), result (success/failure)
   - When a mutation is denied by `requireTenantUser`, log the user, role, and required permission

3. **Token events**:
   - Token refresh, expiry, revocation
   - Failed token validations

### Implementation

**In RSCs (via structured logging):**

```ts
// lib/auth.ts
export async function logAccess(
  userId: string,
  action: "page_access" | "mutation" | "query",
  resource: string,
  allowed: boolean,
  reason?: string
) {
  // Send to observability system (e.g., PostHog, Datadog, custom)
  console.log(JSON.stringify({
    event: "auth_access",
    userId,
    action,
    resource,
    allowed,
    reason,
    timestamp: new Date().toISOString(),
  }));
}
```

**In Convex (via scheduled job):**

```ts
// convex/auth/logs.ts
export const createAuditLog = internalMutation(
  async (ctx, args: {
    userId: string;
    action: string;
    resource: string;
    result: "success" | "denied";
    reason?: string;
  }) => {
    await ctx.db.insert("auditLogs", {
      userId: args.userId,
      action: args.action,
      resource: args.resource,
      result: args.result,
      reason: args.reason,
      timestamp: Date.now(),
    });
  }
);
```

**In functions (use internal mutations):**

```ts
// convex/workos/userManagement.ts
export const inviteUser = mutation(
  async (ctx, args) => {
    const { userId, tenantId } = await requireTenantUser(
      ctx,
      rolesWithPermission("team:invite")
    );
    
    // Do the mutation...
    const newUser = await ctx.db.insert("users", { /* ... */ });
    
    // Log the action
    await ctx.runMutation(api.auth.logs.createAuditLog, {
      userId,
      action: "invite_user",
      resource: `user:${newUser._id}`,
      result: "success",
    });
    
    return newUser;
  }
);
```

### Alerts to Configure

- Failed role checks from authenticated users (possible privilege escalation attempt)
- Repeated failed access attempts from same user to same resource
- Role downgrades (user's role suddenly changed)
- System admin console access
```

---

### Gap 5: Session Token Expiry & Refresh (IMPORTANT)

**What's missing:**
- How long are tokens valid?
- How is token refresh handled?
- What's the user experience during token refresh?
- Does the proxy need to handle expired tokens?

**Why it matters:**
- Token expiry affects security (longer lived = more risk if compromised)
- Refresh strategy affects UX (transparent vs. user-initiated)
- Unclear how to handle mid-request token expiry

**Recommend adding:**

```markdown
## Session Management: Token Expiry & Refresh

### Token Lifecycle

**WorkOS tokens (from `withAuth()`):**
- **Access token**: Valid for ~1 hour (default WorkOS setting, configurable in dashboard)
- **Refresh token**: Stored in secure HTTP-only cookie, used to refresh access token
- **Session cookie**: Valid for the refresh token's lifetime (typically 30 days)

### Transparency & UX

1. **In RSCs (Server-Side):**
   - If token expired, `withAuth()` uses the refresh cookie to get a new token
   - Transparent to the component -- `verifySession()` just works
   - No user-facing delays

2. **In Client Components (via Convex hooks):**
   - `useQuery` and `useMutation` handle token refresh via Convex's built-in logic
   - If token expires, Convex client refreshes it automatically
   - No user action needed (UX is seamless)

3. **In Server Actions:**
   - Each action calls `verifySession()`, which refreshes if needed
   - Refresh is automatic via WorkOS SDK

### What Needs No Changes

- WorkOS AuthKit already handles refresh cookie management
- Convex client already handles token refresh for mutations/queries
- No custom refresh logic needed (unless you want custom expiry times)

### What to Monitor

- Token refresh rate (alerting if unusually high)
- Stale token usage (users with expired sessions trying to access protected routes)
- Cross-tab token sync (if user signs out in one tab, other tabs should detect it)

**Monitor via:**
```ts
// Convex insight: token refresh errors
// WorkOS dashboard: token refresh metrics
// Custom: log token age via useAuth() in components
```

### Future: Custom Token Expiry

If you need shorter/longer token expiry:

1. In WorkOS Dashboard, set "Access Token Lifetime" per org
2. Document the chosen value and rationale in your security policy
3. Monitor UX impact (more frequent refreshes vs. security)

### Edge Case: Token Refresh During Long-Running Server Action

If a Server Action takes >1 hour (rare but possible):

```ts
// convex/workos/longRunningMutation.ts
export const processLargeImport = mutation(
  async (ctx, args) => {
    // Initial auth
    const { userId } = await requireTenantUser(ctx, ["tenant_master"]);
    
    for (const batch of batches) {
      // Re-verify auth every N iterations (not required, but safer for >1hr actions)
      const stillAuth = await requireTenantUser(ctx, ["tenant_master"]);
      
      // Process batch...
    }
  }
);
```

This is rarely needed but good to document.
```

---

## Architectural Clarifications (Open Questions → Resolved)

### Clarification 1: `preloadQuery` with WorkOS Token

**Open question from doc:** "Does the WorkOS access token work with Convex's `ctx.auth.getUserIdentity()`?"

**Resolution:**

The `preloadQuery` + access token pattern works because:

1. WorkOS access token is passed to Convex in the Authorization header (by `convex/nextjs` SDK)
2. Convex extracts it via `ctx.auth.getUserIdentity()`, which returns the same identity object as client-side
3. `requireTenantUser` then validates using this identity

**Add to doc:**

```markdown
### Why Server-Side Auth Token Works

When you call:
```ts
const data = await preloadQuery(
  api.myQuery,
  { /* args */ },
  { token: session.accessToken }  // WorkOS token
);
```

Convex receives the token and:
1. Validates it against WorkOS's key set (happens once, cached)
2. Extracts the identity claims (userId, orgId, etc.)
3. Returns the same identity object that client-side hooks would see

Therefore, `requireTenantUser` works identically server-side and client-side.
```

---

### Clarification 2: Proxy + WorkOS Token Refresh

**Open question:** "Does the proxy need to handle token refresh?"

**Resolution:**

**No.** The proxy only reads the session cookie. Token refresh happens:
- **Client-side**: Convex client handles it for mutations/queries
- **Server-side**: Next.js request context handles it via `withAuth()`

The proxy doesn't need to refresh because:
1. It doesn't validate tokens (only checks org claim in cookie)
2. Refresh happens at the request layer, not the middleware layer
3. `withAuth()` automatically refreshes if cookie is stale

**No code change needed.**

---

### Clarification 3: Permission Slug String Safety

**Open question:** "How do we prevent typos in permission strings?"

**Resolution:**

Use TypeScript's `as const` to make permission keys type-safe:

```ts
// convex/lib/permissions.ts
export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  // ...
} as const;

export type Permission = keyof typeof PERMISSIONS;

// Now this is a compile error:
const perm: Permission = "team:typo";  // ❌ Type error
const perm: Permission = "team:invite"; // ✅ OK
```

Already shown in the doc, but good to highlight as a solved problem.

---

## Summary Table: Completeness Gaps

| Gap | Severity | Pages to Add | Why It Matters |
|-----|----------|--------------|----------------|
| Error handling | 🔴 Critical | +0.5 pages | Prod incidents; teams need patterns |
| User provisioning | 🔴 Critical | +0.5 pages | New users can't access the app |
| Testing strategy | 🔴 Critical | +1 page | Auth bugs are the most dangerous |
| Audit logging | 🟠 Important | +0.5 pages | Compliance, incident investigation |
| Token expiry | 🟠 Important | +0.5 pages | UX clarity, token lifecycle mgmt |

**Total estimated addition: ~3 pages of content**

---

## Recommendation: Next Steps

1. **Before implementation starts:**
   - [ ] Add error handling strategy (define redirects, error messages, recovery UX)
   - [ ] Define user provisioning flow (auto-create vs. manual, idempotency guarantees)
   - [ ] Draft testing strategy with example tests

2. **During implementation:**
   - [ ] Implement audit logging infrastructure (even minimal: structured logs)
   - [ ] Document token refresh behavior (reassure teams it's automatic)
   - [ ] Verify `preloadQuery` + WorkOS token integration works with your Convex version

3. **After Phase 1 (Foundation):**
   - [ ] Run full test suite with E2E auth scenarios
   - [ ] Review audit logs for gaps
   - [ ] Get security review from external reviewer (if compliance-required)

---

## Conclusion

**The design is solid and implementable as-is.** The gaps identified are not blockers — they're refinements that make the design production-ready and operationally clear. Adding ~3 pages of detail around error handling, provisioning, testing, and logging will transform this from "well-structured blueprint" to "fully specified implementation guide."

With these additions, teams implementing this can:
- Handle edge cases confidently
- Avoid common auth pitfalls
- Test thoroughly
- Meet compliance requirements
- Operate the system safely

**Estimated effort to close all gaps: 2-3 hours of writing & review.**
