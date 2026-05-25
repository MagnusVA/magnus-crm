# Lead Gen Ops Migration Notes

These notes classify the MVP rollout and define when the work must switch from
simple widening to a true Convex data migration.

## MVP Classification

The MVP is widen-only if implementation only:

1. Adds `lead_generator` to the existing `users.role` validator.
2. Adds `lead_generator` to the shared `CrmRole` type.
3. Adds `lead-generator` to the WorkOS role mapping helpers.
4. Adds new Lead Gen permission literals.
5. Adds new `leadGen*` tables and indexes.

No `@convex-dev/migrations` job is required for those changes because existing
`users` documents remain valid and the new tables start empty.

## Required Deployment Order

1. Create the WorkOS role slug `lead-generator` in the dev WorkOS environment.
2. Create the WorkOS role slug `lead-generator` in the production WorkOS environment.
3. Deploy schema/code widening:
   - `users.role` validator includes `lead_generator`.
   - `CrmRole` includes `lead_generator`.
   - WorkOS mapping includes `lead_generator` <-> `lead-generator`.
   - Lead Gen permission literals exist.
   - New `leadGen*` tables and indexes exist.
4. Deploy route, sidebar, command palette, shortcut, and breadcrumb handling for `lead_generator`.
5. Deploy WorkOS invite/role/remove lifecycle changes that sync `leadGenWorkers`.
6. Deploy admin invite and role-edit UI that exposes Lead Generator.
7. Invite real lead-gen workers only after route guards and navigation safety have passed in dev.

## External WorkOS Configuration

WorkOS role creation is external configuration, not an application env var.
Gate 0 is blocked until dev and production have an environment-level role with:

| Field | Required Value |
|---|---|
| Role name | Lead Generator |
| Role slug | `lead-generator` |
| Scope | Environment-level role unless an org-scoped role is explicitly approved |

Important WorkOS notes for rollout:

- Role assignment updates require the organization membership ID, not the user ID.
- If IdP group role mapping is enabled, WorkOS API or Dashboard role changes can be overwritten on next login.
- Creating org-scoped roles can stop that org from inheriting environment-level role changes; avoid org-scoped roles for the MVP.
- Session claims can be stale after role updates. Until the planned WorkOS-permission migration, CRM role data remains the app's authoritative authorization source.

## Escalation Triggers

Use the `convex-migration-helper` widen-migrate-narrow workflow before
production if implementation later:

- Converts existing `closer` users to `lead_generator` automatically.
- Adds required fields to existing tables.
- Changes the type or requiredness of existing `users`, `leads`, `opportunities`, `meetings`, or reporting fields.
- Renames or deletes existing fields.
- Splits existing team, schedule, or attribution data into Lead Gen Ops tables.
- Backfills historical Slack, Calendly, lead, opportunity, or meeting data into Lead Gen Ops.
- Changes existing opportunity lifecycle semantics.
- Makes Lead Gen capture write to existing CRM funnel tables.

## Widen-Migrate-Narrow Reminder

If any escalation trigger appears:

1. Widen the schema so old and new data are both valid.
2. Deploy code that can read old and new shapes and writes the new shape.
3. Backfill in batches with `@convex-dev/migrations` or a documented bounded internal mutation.
4. Verify every affected document is migrated.
5. Narrow the schema in a later deploy.

Do not add a migration component job "just in case." Add it only when a
breaking data shape change or backfill is actually part of the implementation.

## Rollback and Backout Notes

- If the WorkOS role is missing, do not expose Lead Generator in invite or role-edit UI.
- If Phase 1 schema deploy fails, revert the schema/code widen before any worker invites are sent.
- If route safety fails after deploy, hide Lead Generator invite options and disable active worker invitations until the fallback paths are fixed.
- New empty `leadGen*` tables can remain in schema during rollback if no code writes to them.
- Never auto-convert existing users as a rollback tactic.
