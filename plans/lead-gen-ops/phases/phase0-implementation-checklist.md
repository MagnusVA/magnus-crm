# Lead Gen Ops Implementation Checklist

This checklist is the Gate 0 contract for Lead Gen Ops. Phase 0 does not
change schema, auth, Slack, Calendly, or UI behavior; it defines what later
phases are allowed to change and what must be verified before workers are
invited.

## Forbidden Changes

- [ ] No Lead Gen capture mutation inserts into or patches `leads`.
- [ ] No Lead Gen capture mutation inserts into or patches `opportunities`.
- [ ] No Lead Gen capture code calls CRM opportunity lifecycle helpers.
- [ ] No Slack slash command, modal payload shape, modal callback, or ACK timing changes.
- [ ] No Calendly webhook HTTP route, signature verification, raw event storage, or broad processor reordering changes.
- [ ] No Calendly cold-booking lookup against `leadGenProspects`.
- [ ] No Lead Gen volume in CRM conversion metrics.
- [ ] No `lead_generator` fallback into closer/admin route sets.
- [ ] No client-supplied `userId`, worker ID, or role accepted for Lead Gen authorization.

## Allowed Integration Points

- [ ] `convex/slack/createQualifiedLead.ts` may schedule one internal Lead Gen audit-match mutation after successful Slack qualification has resolved a CRM lead/opportunity.
- [ ] `convex/pipeline/inviteeCreated.ts` may preserve an existing accepted audit match only inside the Slack-qualified opportunity scheduling branch.
- [ ] `app/workspace/page.tsx` may redirect `lead_generator` users to `/workspace/lead-gen/capture`.
- [ ] `lib/auth.ts` may add a permission-based server gate and a role-aware fallback helper.
- [ ] `convex/leadGen/*` may write only to `leadGen*` tables during capture, reporting, audit, and correction flows.

## WorkOS and RBAC Preflight

- [ ] WorkOS dev environment role exists with slug `lead-generator`.
- [ ] WorkOS production environment role exists with slug `lead-generator`.
- [ ] The role is environment-level unless there is an explicit reason to create org-scoped roles.
- [ ] If IdP group role mapping is configured, production setup documents that API/Dashboard role changes can be overwritten on next login.
- [ ] Operators know role updates require the organization membership ID, not the WorkOS user ID.
- [ ] After any active role change, the affected user re-authenticates or refreshes their session before relying on WorkOS session claims.
- [ ] `mapCrmRoleToWorkosSlug("lead_generator")` returns `lead-generator`.
- [ ] `mapWorkosSlugToCrmRole("lead-generator")` returns `lead_generator`.
- [ ] `ADMIN_ROLES` remains only `tenant_master` and `tenant_admin`.
- [ ] `lead_generator` has no CRM pipeline, meeting, payment, customer, lead, report, or team-management permissions.
- [ ] Invite action accepts `lead_generator` without a Calendly member.
- [ ] Role-change action creates/enables a worker profile when changing to `lead_generator`.
- [ ] Role-change action deactivates the worker profile when changing away from `lead_generator`.
- [ ] Remove-user action deactivates the worker profile and preserves historical submissions.
- [ ] Pending invitation role changes revoke/resend the WorkOS invitation with the new role slug.

## Current Role Surface Inventory

These are current code assumptions that Phase 1 must address before exposing
Lead Gen invites.

| Surface | Current State | Phase 1 Blocker |
|---|---|---|
| `convex/schema.ts` | `users.role` allows `tenant_master`, `tenant_admin`, `closer`. | Add `lead_generator` in the schema widen. |
| `convex/lib/roleMapping.ts` | CRM/WorkOS maps only include owner, tenant-admin, closer. Unknown WorkOS slugs map to `closer`. | Add explicit bidirectional `lead_generator`/`lead-generator` mapping; avoid silent closer fallback for this role. |
| `convex/lib/permissions.ts` | Permissions grant CRM access to admins/closers only. | Add Lead Gen permission literals without giving `lead_generator` CRM permissions. |
| `convex/requireTenantUser.ts` | Uses `CrmRole[]`, so generated type must widen first. | Use server-derived identity and allow `lead_generator` only on Lead Gen functions. |
| `lib/auth.ts` | `requireRole()` fallback is closer if role is `closer`, otherwise `/workspace`. | Add a role-aware fallback for `lead_generator` and a server `requirePermission()` helper. |
| `components/auth/role-context.tsx` | `isAdmin` is owner/admin; `hasPermission()` is UI-only. | Keep UI-only semantics; ensure `lead_generator` reads new permission literals. |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Form schema and select options allow `closer` and `tenant_admin`; closer requires Calendly. | Add Lead Generator option; Calendly member remains closer-only. |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Role edit schema and options allow `closer` and `tenant_admin`. | Add Lead Generator option and profile sync behavior. |
| `convex/workos/userManagement.ts` | Invite/update validators allow current three roles; membership update already uses membership ID. | Widen validators; preserve pending-invite revoke/resend flow. |
| `convex/workos/userMutations.ts` | User creation/update validators allow current three roles; tenant closer stats update only for closers. | Widen validators and add worker profile sync without counting Lead Gen workers as closers. |

## Route and Navigation Audit

- [ ] `/workspace` redirects `tenant_master` and `tenant_admin` to the admin dashboard.
- [ ] `/workspace` redirects `closer` to `/workspace/closer`.
- [ ] `/workspace` redirects `lead_generator` to `/workspace/lead-gen/capture`.
- [ ] `requireRole()` fallback handles `lead_generator` separately from closer.
- [ ] `requirePermission()` exists before Lead Gen pages use permission slugs.
- [ ] Direct admin URLs redirect or reject `lead_generator` through server route gates.
- [ ] Direct closer URLs redirect or reject `lead_generator` through server route gates.
- [ ] Sidebar has a dedicated Lead Gen nav set.
- [ ] Brand/home link sends `lead_generator` to capture, not closer dashboard.
- [ ] Command palette pages use role-specific lists.
- [ ] Command palette quick actions hide CRM create actions from `lead_generator`.
- [ ] Cmd+1-4 shortcuts use the active role nav list.
- [ ] Breadcrumb labels include `lead-gen`, `capture`, `my-activity`, and `prospects`.
- [ ] Profile and sign-out remain available to `lead_generator`.
- [ ] Calendly and Slack connection guards do not show admin banners to `lead_generator`.

## Route Wrapper Baseline

Lead Gen route wrappers should keep the existing workspace pattern:

```tsx
import { requirePermission } from "@/lib/auth";
import { LeadGenCapturePageClient } from "../_components/lead-gen-capture-page-client";

export const unstable_instant = false;

export default async function LeadGenCapturePage() {
  await requirePermission("lead-gen:capture");
  return <LeadGenCapturePageClient />;
}
```

Implementation rules:

- [ ] Page files remain Server Components unless the route has a documented exception.
- [ ] Interactive code lives in `*-page-client` components.
- [ ] Redirects from RSCs and auth helpers are not wrapped in `try/catch`.
- [ ] Client-side role checks only hide UI; Convex and RSC gates enforce access.

## UX and Accessibility Guardrails

- [ ] Mobile capture is the first worker experience; it must fit a narrow viewport without horizontal overflow.
- [ ] Admin reporting is dense, desktop-first, and optimized for scanning, not a marketing layout.
- [ ] Capture form controls have labels, `name`, `autocomplete`, and input types/input modes where applicable.
- [ ] Validation errors render inline near the field and move focus to the first failing field where practical.
- [ ] Async save states use explicit loading text and do not block paste.
- [ ] Icon-only buttons have `aria-label`; decorative icons are hidden from assistive tech.
- [ ] Filters, pagination, tabs, and report ranges are deep-linkable in URL state where practical.
- [ ] Tables with large result sets paginate or virtualize instead of mapping unbounded arrays.
- [ ] CSV export UI warns on row limits and uses formula-hardened serialization.
- [ ] Animations respect `prefers-reduced-motion` and avoid `transition: all`.

## PR Verification

Before merging any implementation PR in this feature, paste these command
results into the PR:

```bash
rg "ctx\\.db\\.(insert|patch|replace)\\(\\\"(leads|opportunities)\\\"" convex/leadGen
rg "leadGen" convex/slack convex/pipeline
rg "lead_generator|lead-generator|lead-gen" app components convex lib
```

Expected results:

- The first command returns no Lead Gen capture writes to `leads` or `opportunities`.
- Slack results are limited to `convex/slack/createQualifiedLead.ts` plus internal audit scheduling references.
- Calendly results are limited to `convex/pipeline/inviteeCreated.ts` preserving existing audit matches and must not include `leadGenProspects`.

## Required Gates

| Gate | Trigger | Required Checks |
|---|---|---|
| Gate 0 | Before Phase 1 | WorkOS role exists in dev/prod; migration notes accepted; forbidden-change checklist complete; QA matrix accepted. |
| Gate 1 | After Phase 1 | `npx convex dev --once`; `pnpm tsc --noEmit`; route-gate QA; invite/role UI smoke test; command palette worker safety. |
| Gate 2 | After Phases 2 and 3 | Capture/dedupe/report aggregate reconciliation passes; Lead Gen capture writes only Lead Gen tables. |
| Gate 3 | After Phase 4 | Slack duplicate/already-booked/created-opportunity regressions pass; Calendly Slack-join/cold-booking regressions pass. |
| Gate 4 | After Phase 5 | Full release checklist, export hardening, mobile capture QA, desktop admin QA, and backout notes pass. |

## Shared-File Ownership Checks

- [ ] `convex/schema.ts` is edited only in Phase 1 unless a new migration plan is accepted.
- [ ] `convex/lib/roleMapping.ts` and `convex/lib/permissions.ts` are edited only in Phase 1.
- [ ] `convex/workos/userManagement.ts` and `convex/workos/userMutations.ts` are edited only in Phase 1.
- [ ] `app/workspace/_components/workspace-shell-client.tsx`, `components/command-palette.tsx`, and `components/workspace-breadcrumbs.tsx` are edited only in Phase 1 for role/nav safety.
- [ ] `convex/slack/createQualifiedLead.ts` is edited only in Phase 4 for the audit scheduling hook.
- [ ] `convex/pipeline/inviteeCreated.ts` is edited only in Phase 4 for audit match preservation.
- [ ] Any exception updates `parallelization-strategy.md` before code changes land.
