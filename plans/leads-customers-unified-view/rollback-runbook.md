# Leads & Customers Unified View - Rollback Runbook

## Fast Rollback

1. Restore sidebar entries for Leads, Customers, and Opportunities in `app/workspace/_components/workspace-shell-client.tsx`.
2. Restore command palette entries and create opportunity action to the legacy routes.
3. Restore high-traffic internal links to legacy opportunity routes where needed.
4. Leave `/workspace/leads-customers` deployed but stop linking to it.
5. Leave `leadCustomerSearchRows` in the schema; it is derived data and not source of truth.
6. Leave redirect shims only if verified safe; otherwise restore old route page components from git.

## Do Not Do

- Do not delete lead, customer, opportunity, meeting, payment, comment, or identifier source data.
- Do not drop `leadCustomerSearchRows` during fast rollback.
- Do not run destructive migrations.
- Do not remove Phase 1 write hooks unless a projection write-hook bug is the confirmed incident cause and a patch is ready.

## Rollback Verification

- [ ] Admin can reach legacy Leads, Customers, and Opportunities entries again.
- [ ] Closer can reach the legacy workspace entries again.
- [ ] Existing direct `/workspace/leads-customers` URLs do not expose unauthorized data.
- [ ] Convex logs show no recurring projection or redirect errors after rollback.
