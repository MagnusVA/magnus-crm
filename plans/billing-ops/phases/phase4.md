# Phase 4 — Copy and Export Workflow

**Goal:** Provide the external billing handoff workflow: copy a normalized single-payment payload from the focused page, export bounded CSV rows from the queue filters, audit CSV exports, and reveal Billing navigation only after tenant enablement.

**Prerequisite:** Phase 1 read-only row/detail contracts exist. Phase 2 review events and Phase 3 correction events should be visible in focused history before CSV export is released to operators.

**Runs in PARALLEL with:** Phase 3 UI can run in parallel after the shared detail row type is stable. Navigation gating can run in parallel with export backend because it touches workspace shell files, not `convex/billing`.

**Skills to invoke:**
- `frontend-design` — copy/export controls should be clear operational commands, not a marketing-style panel.
- `shadcn` — use DropdownMenu, Button, Tooltip, Alert, Badge, and Table primitives.
- `next-best-practices` — route/client boundaries remain thin; export generation stays client-side from authorized Convex data.
- `convex-performance-audit` — use if export query fan-out or aggregate counts are expensive for capped exports.

**Acceptance Criteria:**
1. The focused page exposes a copy-ready normalized payment payload with customer, payment, attribution, source ids, review, and contributor summary fields.
2. Single-payment copy does not write an audit row in MVP.
3. CSV export uses the same server-side filters as the queue and caps rows at 1,000.
4. Export filtering happens before `take(limit)` through the same indexed query branch as the queue.
5. CSV export includes proof-present boolean only and never includes signed proof URLs.
6. CSV cells are serialized through `lib/csv.ts` formula-safe helpers.
7. Every CSV export writes a `billingExportEvents` row with server-derived tenant and actor, normalized filters, exact count, exported count, truncation state, and timestamp.
8. Billing sidebar and command palette entries render only for users with `billing:view` and `tenant.billingOpsEnabled === true`.
9. System-admin enablement remains manual; passing readiness checks does not auto-enable Billing Ops.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (copy payload formatter) ─────────────┐
                                        ├── 4D (export menu UI)
4B (export query + CSV DTO) ─────────────┤
4C (record export audit mutation) ───────┘

4E (nav + command gating) ───────────────┐
                                         ├── 4F (release/export QA)
4A + 4B + 4C + 4D complete ──────────────┘
```

**Optimal execution:**
1. Run 4A, 4B, 4C, and 4E in parallel. They touch mostly separate files.
2. Build 4D after 4A-4C contracts exist.
3. Finish with 4F to validate export audit, CSV content, nav gating, and tenant enablement.

**Estimated time:** 3-4 days

---

## Subphases

### 4A — Single-Payment Copy Payload

**Type:** Frontend
**Parallelizable:** Yes — depends only on Phase 1 focused detail shape.

**What:** Add a client-side formatter and copy button for the focused payment page.

**Why:** The copy payload is derived from already-authorized detail data. It does not need a mutation and should not require another Convex round trip.

**Where:**
- `app/workspace/billing/_components/copy-billing-payload-button.tsx` (new)
- `app/workspace/billing/_components/billing-review-page-client.tsx` (modify)
- `app/workspace/billing/_components/billing-copy-format.ts` (new)

**How:**

**Step 1: Create a copy formatter.**

```typescript
// Path: app/workspace/billing/_components/billing-copy-format.ts
type BillingCopyDetail = {
  payment: {
    id: string;
    amountMinor: number;
    currency: string;
    recordedAt: number;
    paymentType: string;
    programName: string;
    referenceCode: string | null;
    note: string | null;
  };
  customer: { fullName: string | null; email: string | null; phone: string | null };
  enteredBy: { name: string };
  phoneCloser: { name: string | null };
  dmAttribution: { teamName: string | null; dmCloserName: string | null };
  slackContributorSummary: { firstLabel: string | null; count: number };
  opportunity: { id: string | null };
  meeting: { id: string | null };
  review: { reviewedAt: number | null; reviewerName: string | null };
};

function line(label: string, value: unknown) {
  return `${label}: ${value == null || value === "" ? "None" : String(value)}`;
}

export function formatBillingCopyPayload(detail: BillingCopyDetail) {
  return [
    line("Payment ID", detail.payment.id),
    line("Paid at", new Date(detail.payment.recordedAt).toISOString()),
    line("Reviewed at", detail.review.reviewedAt ? new Date(detail.review.reviewedAt).toISOString() : null),
    line("Reviewer", detail.review.reviewerName),
    line("Customer name", detail.customer.fullName),
    line("Customer email", detail.customer.email),
    line("Customer phone", detail.customer.phone),
    line("Amount", (detail.payment.amountMinor / 100).toFixed(2)),
    line("Currency", detail.payment.currency),
    line("Payment program", detail.payment.programName),
    line("Payment type", detail.payment.paymentType),
    line("Reference code", detail.payment.referenceCode),
    line("Internal note", detail.payment.note),
    line("Entered by", detail.enteredBy.name),
    line("Phone closer", detail.phoneCloser.name),
    line("DM team", detail.dmAttribution.teamName),
    line("DM closer", detail.dmAttribution.dmCloserName),
    line("Slack contributor", detail.slackContributorSummary.firstLabel),
    line("Slack contributor count", detail.slackContributorSummary.count),
    line("Opportunity ID", detail.opportunity.id),
    line("Meeting ID", detail.meeting.id),
  ].join("\n");
}
```

**Step 2: Add the copy button.**

```tsx
// Path: app/workspace/billing/_components/copy-billing-payload-button.tsx
"use client";

import { ClipboardIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatBillingCopyPayload } from "./billing-copy-format";

export function CopyBillingPayloadButton({ detail }: { detail: BillingCopyDetail }) {
  const copy = async () => {
    await navigator.clipboard.writeText(formatBillingCopyPayload(detail));
    toast.success("Billing payload copied.");
  };

  return (
    <Button variant="outline" onClick={copy}>
      <ClipboardIcon data-icon="inline-start" />
      Copy payload
    </Button>
  );
}
```

**Key implementation notes:**
- Do not log single-payment copy in MVP.
- Use ISO timestamps in the payload so external operators get unambiguous dates.
- If clipboard API fails, show a toast and keep the payload visible in the UI for manual selection.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/_components/billing-copy-format.ts` | Create | Copy payload formatter |
| `app/workspace/billing/_components/copy-billing-payload-button.tsx` | Create | Focused copy action |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | Mount copy button |

---

### 4B — Bounded Export Query and CSV DTO

**Type:** Backend
**Parallelizable:** Yes — independent of audit mutation and nav gating.

**What:** Add `api.billing.queries.exportPayments` that reuses queue filters, applies indexed filtering before `.take(limit)`, enriches rows, and returns export DTOs without proof URLs.

**Why:** Exports contain customer/payment data and must be bounded. A future full-history export should be a job, not a single query.

**Where:**
- `convex/billing/queries.ts` (modify)
- `convex/billing/export.ts` (new)
- `convex/billing/validators.ts` (modify)

**How:**

**Step 1: Add export args.**

```typescript
// Path: convex/billing/validators.ts
import { v } from "convex/values";

export const exportPaymentsArgsValidator = {
  status: billingStatusValidator,
  programId: v.optional(v.id("tenantPrograms")),
  paymentType: v.optional(paymentTypeValidator),
  startAt: v.optional(v.number()),
  endAt: v.optional(v.number()),
  limit: v.optional(v.number()),
};
```

**Step 2: Convert enriched rows to export DTOs.**

```typescript
// Path: convex/billing/export.ts
import type { BillingPaymentRow } from "./types";

export function toBillingExportRow(row: BillingPaymentRow) {
  return {
    paymentId: row.payment.id,
    paidAt: row.payment.recordedAt,
    reviewedAt: row.review.reviewedAt,
    reviewer: row.review.reviewerName,
    customerName: row.customer.fullName,
    customerEmail: row.customer.email,
    customerPhone: row.customer.phone,
    amount: row.payment.amountMinor / 100,
    currency: row.payment.currency,
    program: row.payment.programName,
    paymentType: row.payment.paymentType,
    referenceCode: row.payment.referenceCode,
    note: row.payment.note,
    enteredBy: row.enteredBy.name,
    phoneCloser: row.phoneCloser.name,
    dmTeam: row.dmAttribution.teamName,
    dmCloser: row.dmAttribution.dmCloserName,
    slackContributor: row.slackContributorSummary.firstLabel,
    slackContributorCount: row.slackContributorSummary.count,
    opportunityId: row.opportunity.id,
    meetingId: row.meeting.id,
    hasProofFile: row.payment.hasProofFile,
  };
}
```

**Step 3: Add the bounded export query.**

```typescript
// Path: convex/billing/queries.ts
import { exportPaymentsArgsValidator } from "./validators";
import { toBillingExportRow } from "./export";

const MAX_BILLING_EXPORT_ROWS = 1000;

export const exportPayments = query({
  args: exportPaymentsArgsValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:export");
    await requireBillingOpsEnabled(ctx, tenantId);

    const limit = Math.min(args.limit ?? 500, MAX_BILLING_EXPORT_ROWS);
    const exactCount = await countBillingPayments(ctx, tenantId, args);
    const payments = await selectBillingPaymentQuery(ctx, tenantId, args)
      .order("desc")
      .take(limit);
    const rows = await enrichBillingPaymentRows(ctx, tenantId, payments);

    return {
      rows: rows.map(toBillingExportRow),
      exactCount,
      exportedCount: rows.length,
      truncated: exactCount > limit,
      limit,
    };
  },
});
```

**Key implementation notes:**
- Do not include `proof.url` or storage ids in CSV output.
- The query is capped even if the exact count is larger.
- Keep export row shape stable and separate from UI row shape.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/validators.ts` | Modify | Export args |
| `convex/billing/export.ts` | Create | Export DTO mapper |
| `convex/billing/queries.ts` | Modify | Bounded export query |

---

### 4C — Export Audit Mutation

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 0 `billingExportEvents` table and guards.

**What:** Add `recordExportAudit` that derives tenant/actor from auth, recomputes exact count server-side, records normalized filters and truncation metadata, and returns the audit row id.

**Why:** CSV export moves sensitive payment/customer data outside CRM. The handoff needs an audit trail independent of domain entity events.

**Where:**
- `convex/billing/mutations.ts` (modify)
- `convex/billing/export.ts` (modify)

**How:**

**Step 1: Normalize filters in one helper.**

```typescript
// Path: convex/billing/export.ts
import type { Id } from "../_generated/dataModel";
import type { PaymentType } from "../lib/paymentTypes";
import type { BillingPaymentStatus } from "./types";

export type BillingExportFilters = {
  status: BillingPaymentStatus;
  programId?: Id<"tenantPrograms">;
  programName?: string;
  paymentType?: PaymentType;
  startAt?: number;
  endAt?: number;
  limit: number;
};

export function normalizeExportFilters(filters: BillingExportFilters) {
  return JSON.stringify({
    status: filters.status,
    programId: filters.programId ?? null,
    programName: filters.programName ?? null,
    paymentType: filters.paymentType ?? null,
    startAt: filters.startAt ?? null,
    endAt: filters.endAt ?? null,
    limit: filters.limit,
  });
}
```

**Step 2: Record audit with server-derived ids.**

```typescript
// Path: convex/billing/mutations.ts
import { exportPaymentsArgsValidator } from "./validators";
import { countBillingPayments } from "./aggregates";
import { normalizeExportFilters } from "./export";

export const recordExportAudit = mutation({
  args: {
    ...exportPaymentsArgsValidator,
    exportedCount: v.number(),
    truncated: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireBillingPermission(
      ctx,
      "billing:export",
    );
    await requireBillingOpsEnabled(ctx, tenantId);

    const limit = Math.min(args.limit ?? 500, 1000);
    const exactCount = await countBillingPayments(ctx, tenantId, args);
    const program = args.programId ? await ctx.db.get(args.programId) : null;
    if (program && program.tenantId !== tenantId) {
      throw new Error("Program not found.");
    }

    return await ctx.db.insert("billingExportEvents", {
      tenantId,
      actorUserId: userId,
      filtersJson: normalizeExportFilters({
        status: args.status,
        programId: args.programId,
        programName: program?.name,
        paymentType: args.paymentType,
        startAt: args.startAt,
        endAt: args.endAt,
        limit,
      }),
      exactCount,
      exportedCount: Math.min(args.exportedCount, limit),
      truncated: exactCount > limit || args.truncated,
      createdAt: Date.now(),
    });
  },
});
```

**Key implementation notes:**
- Server recalculates `exactCount`; the client-supplied value from the query is not trusted for the audit row.
- Ensure `countBillingPayments` accepts `QueryCtx | MutationCtx`; the audit mutation needs the same aggregate count helper as queries.
- The mutation may accept `exportedCount` because it records the browser's generated file size, but it clamps to the export cap.
- Do not write full row payloads into `billingExportEvents`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/mutations.ts` | Modify | Export audit mutation |
| `convex/billing/export.ts` | Modify | Filter normalization |

---

### 4D — Export Menu and CSV Serialization

**Type:** Frontend
**Parallelizable:** No — depends on 4B query and 4C audit mutation.

**What:** Add an export menu to the queue page that previews exact count/cap, calls audit mutation, serializes rows with `serializeCsv`, and downloads a CSV file.

**Why:** Operators need a simple handoff to the external billing platform, but the system must avoid unbounded reads and spreadsheet formula injection.

**Where:**
- `app/workspace/billing/_components/export-menu.tsx` (new)
- `app/workspace/billing/_components/billing-page-client.tsx` (modify)
- `lib/csv.ts` (reuse)

**How:**

**Step 1: Convert export rows to CSV through `serializeCsv`.**

```tsx
// Path: app/workspace/billing/_components/export-menu.tsx
"use client";

import { useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { serializeCsv } from "@/lib/csv";

const HEADERS = [
  "Payment ID",
  "Paid At",
  "Reviewed At",
  "Reviewer",
  "Customer Name",
  "Customer Email",
  "Customer Phone",
  "Amount",
  "Currency",
  "Program",
  "Payment Type",
  "Reference Code",
  "Internal Note",
  "Entered By",
  "Phone Closer",
  "DM Team",
  "DM Closer",
  "Slack Contributor",
  "Slack Contributor Count",
  "Opportunity ID",
  "Meeting ID",
  "Has Proof File",
] as const;
```

**Step 2: Audit immediately before download.**

```tsx
// Path: app/workspace/billing/_components/export-menu.tsx
export function ExportMenu({ filters }: { filters: BillingExportFilters }) {
  const [armed, setArmed] = useState(false);
  const exportData = useQuery(
    api.billing.queries.exportPayments,
    armed ? { ...filters, limit: 1000 } : "skip",
  );
  const recordExportAudit = useMutation(api.billing.mutations.recordExportAudit);

  const csv = useMemo(() => {
    if (!exportData) return null;
    return serializeCsv([
      [...HEADERS],
      ...exportData.rows.map((row) => [
        row.paymentId,
        row.paidAt ? new Date(row.paidAt).toISOString() : "",
        row.reviewedAt ? new Date(row.reviewedAt).toISOString() : "",
        row.reviewer,
        row.customerName,
        row.customerEmail,
        row.customerPhone,
        row.amount,
        row.currency,
        row.program,
        row.paymentType,
        row.referenceCode,
        row.note,
        row.enteredBy,
        row.phoneCloser,
        row.dmTeam,
        row.dmCloser,
        row.slackContributor,
        row.slackContributorCount,
        row.opportunityId,
        row.meetingId,
        row.hasProofFile ? "yes" : "no",
      ]),
    ]);
  }, [exportData]);

  const download = async () => {
    if (!exportData || !csv) {
      setArmed(true);
      return;
    }

    await recordExportAudit({
      ...filters,
      limit: exportData.limit,
      exportedCount: exportData.exportedCount,
      truncated: exportData.truncated,
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `billing-export-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button variant="outline" onClick={download}>
      <DownloadIcon data-icon="inline-start" />
      Export CSV
    </Button>
  );
}
```

**Key implementation notes:**
- Use `"skip"` until the operator opens/arms export to avoid continuously loading large exports.
- Show `exactCount`, `exportedCount`, and truncation warning in the menu before download.
- Disable the download button while audit mutation is in flight.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/_components/export-menu.tsx` | Create | Export flow |
| `app/workspace/billing/_components/billing-page-client.tsx` | Modify | Pass current filters |
| `lib/csv.ts` | Reuse | Formula-safe CSV serialization |

---

### 4E — Navigation and Command Palette Gating

**Type:** Frontend / Auth
**Parallelizable:** Yes — independent of export backend.

**What:** Add Billing navigation only when the ready workspace tenant has `billingOpsEnabled === true` and the user has `billing:view`.

**Why:** Billing Ops must remain hidden until system admin manually enables the tenant after verification.

**Where:**
- `convex/tenants.ts` (modify)
- `lib/auth.ts` (modify)
- `app/workspace/_components/workspace-auth.tsx` (modify)
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `components/command-palette.tsx` (modify)
- `app/workspace/_components/workspace-shell.tsx` (inspect, modify only if still imported)

**How:**

**Step 1: Include the tenant flag in current tenant response.**

```typescript
// Path: convex/tenants.ts
const result = {
  tenantId: tenant._id,
  companyName: tenant.companyName,
  workosOrgId: tenant.workosOrgId,
  status: tenant.status,
  calendlyWebhookUri: connection?.webhookUri,
  onboardingCompletedAt: tenant.onboardingCompletedAt,
  billingOpsEnabled: tenant.billingOpsEnabled === true,
};
```

**Step 2: Carry the flag through server auth.**

```typescript
// Path: lib/auth.ts
type CurrentTenant = {
  tenantId: string;
  companyName: string;
  workosOrgId: string;
  status: "active" | "pending_signup" | "pending_calendly" | "provisioning_webhooks" | "calendly_disconnected" | "suspended" | "invite_expired";
  calendlyWebhookUri?: string;
  onboardingCompletedAt?: number;
  billingOpsEnabled?: boolean;
};
```

**Step 3: Pass the flag into the workspace shell.**

```tsx
// Path: app/workspace/_components/workspace-auth.tsx
<WorkspaceShellClient
  initialRole={access.crmUser.role}
  initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
  initialEmail={access.crmUser.email}
  workosUserId={access.crmUser.workosUserId}
  workosOrgId={access.tenant.workosOrgId}
  tenantName={access.tenant.companyName}
  billingOpsEnabled={access.tenant.billingOpsEnabled === true}
>
  {children}
</WorkspaceShellClient>
```

**Step 4: Insert Billing into admin nav only when enabled.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
const billingNavItem: NavItem = {
  href: "/workspace/billing",
  label: "Billing",
  icon: DollarSignIcon,
};

function navForRole(role: CrmRole, isAdmin: boolean, billingOpsEnabled: boolean) {
  if (isAdmin) {
    return billingOpsEnabled
      ? [
          ...adminNavItems.slice(0, 3),
          billingNavItem,
          ...adminNavItems.slice(3),
        ]
      : adminNavItems;
  }
  if (role === "lead_generator") return leadGeneratorNavItems;
  return closerNavItems;
}
```

**Step 5: Gate command palette pages with the same prop.**

```tsx
// Path: components/command-palette.tsx
const billingPage = {
  label: "Billing",
  href: "/workspace/billing",
  icon: DollarSignIcon,
};

export function CommandPalette({
  billingOpsEnabled = false,
}: {
  billingOpsEnabled?: boolean;
}) {
  const pages = isAdmin
    ? billingOpsEnabled
      ? [...adminPages.slice(0, 3), billingPage, ...adminPages.slice(3)]
      : adminPages
    : role === "lead_generator"
      ? leadGenPages
      : closerPages;
}
```

**Key implementation notes:**
- UI visibility is not security. Routes and Convex functions still enforce permissions and enablement.
- The deprecated `workspace-shell.tsx` should be inspected; update it only if any imports remain.
- Command palette should not show Billing while disabled, even if direct route would show `BillingUnavailable`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenants.ts` | Modify | Return `billingOpsEnabled` in current tenant |
| `lib/auth.ts` | Modify | Add field to `CurrentTenant` |
| `app/workspace/_components/workspace-auth.tsx` | Modify | Pass flag to shell |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Billing nav gating |
| `components/command-palette.tsx` | Modify | Billing command gating |
| `app/workspace/_components/workspace-shell.tsx` | Inspect / Modify | Deprecated shell parity if still used |

---

### 4F — Export and Release QA

**Type:** Manual / QA
**Parallelizable:** No — final MVP release gate after Phase 0-4 are complete.

**What:** Verify export content, audit rows, nav gating, disabled/enabled behavior, and final tenant enablement sequence.

**Why:** Billing Ops is not independently shippable by phase. This is the gate that proves the whole MVP can be safely enabled for the test tenant.

**Where:**
- `plans/billing-ops/phases/phase4-export-release-qa.md` (new)
- `plans/billing-ops/phases/phase0-rollout-runbook.md` (modify)

**How:**

**Step 1: Create release QA checklist.**

```typescript
// Path: plans/billing-ops/phases/phase4-export-release-qa.md
export const releaseQaChecks = [
  "Billing nav hidden while tenant billingOpsEnabled is false.",
  "Direct route while disabled renders BillingUnavailable.",
  "System admin enablement fails without latest passing readiness check.",
  "After enablement, owner/admin nav and command palette show Billing.",
  "Closer and lead generator cannot access Billing route or functions.",
  "CSV export writes exactly one billingExportEvents row.",
  "CSV export contains no proof URL or storage id columns.",
  "CSV cells beginning with formula characters are hardened by serializeCsv.",
  "Export over cap reports truncated true and downloads only capped rows.",
] as const;
```

**Step 2: Confirm final enablement order.**

| Gate | Required Evidence |
|---|---|
| Widen deployed | Convex schema/components deploy cleanly. |
| Hooks active | New payment insert changes Billing counts without re-backfill. |
| Backfill complete | Backfill batch returns `hasMore: false`. |
| Readiness passed | Latest `billingOpsReadinessChecks.status` is `passed`. |
| MVP complete | Phases 1-4 acceptance criteria pass. |
| Manual enable | System admin explicitly sets `billingOpsEnabled = true`. |

**Key implementation notes:**
- Export QA must include a customer name/email/reference value that starts with `=`, `+`, `-`, `@`, tab, or carriage return to prove formula hardening.
- Revoke enablement by setting `billingOpsEnabled = false`; do not roll back schema for ordinary release reversal.
- Verify PostHog or analytics do not receive full export row payloads.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/billing-ops/phases/phase4-export-release-qa.md` | Create | Export and release QA |
| `plans/billing-ops/phases/phase0-rollout-runbook.md` | Modify | Final enablement order |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/billing/_components/billing-copy-format.ts` | Create | 4A |
| `app/workspace/billing/_components/copy-billing-payload-button.tsx` | Create | 4A |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Modify | 4A |
| `convex/billing/validators.ts` | Modify | 4B |
| `convex/billing/export.ts` | Create | 4B, 4C |
| `convex/billing/queries.ts` | Modify | 4B |
| `convex/billing/mutations.ts` | Modify | 4C |
| `app/workspace/billing/_components/export-menu.tsx` | Create | 4D |
| `app/workspace/billing/_components/billing-page-client.tsx` | Modify | 4D |
| `convex/tenants.ts` | Modify | 4E |
| `lib/auth.ts` | Modify | 4E |
| `app/workspace/_components/workspace-auth.tsx` | Modify | 4E |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 4E |
| `components/command-palette.tsx` | Modify | 4E |
| `app/workspace/_components/workspace-shell.tsx` | Inspect / Modify | 4E |
| `plans/billing-ops/phases/phase4-export-release-qa.md` | Create | 4F |
| `plans/billing-ops/phases/phase0-rollout-runbook.md` | Modify | 4F |
