"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { Copy, LogOut, Plus, ShieldAlert } from "lucide-react";
import { useCallback, useState } from "react";

import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";

import {
  CreateTenantDialog,
  type CreateTenantPayload,
} from "./_components/create-tenant-dialog";
import {
  InviteBanner,
  type InviteResult,
} from "./_components/invite-banner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOT_GRID = [
  "radial-gradient(circle, oklch(1 0 0 / 0.03) 1px, transparent 1px)",
].join(", ");

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { organizationId, signOut } = useAuth();
  const isSystemAdmin = organizationId === SYSTEM_ADMIN_ORG_ID;
  const canQuery = isAuthenticated && isSystemAdmin;

  const tenants = useQuery(
    api.admin.tenantsQueries.listTenants,
    canQuery ? {} : "skip",
  );

  const createTenantInvite = useAction(api.admin.tenants.createTenantInvite);
  const regenerateInvite = useAction(api.admin.tenants.regenerateInvite);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);

  // ---- Handlers (stable refs) ----

  const handleCreate = useCallback(
    async (payload: CreateTenantPayload) => {
      const result = await createTenantInvite(payload);
      setInviteResult(result);
    },
    [createTenantInvite],
  );

  const handleRegenerate = useCallback(
    async (tenant: Doc<"tenants">) => {
      const result = await regenerateInvite({ tenantId: tenant._id });
      setInviteResult({
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        inviteUrl: result.inviteUrl,
        expiresAt: result.expiresAt,
      });
    },
    [regenerateInvite],
  );

  // ---- Gate states ----

  if (isLoading) {
    return <GateScreen label="Loading admin workspace" />;
  }

  if (!isAuthenticated) {
    return (
      <GateScreen
        title="Authentication Required"
        description="Sign in with a system admin account to manage tenants."
        variant="error"
      />
    );
  }

  if (!isSystemAdmin) {
    return (
      <GateScreen
        title="Admin Access Only"
        description="Your current session is not attached to the system admin organization."
        variant="error"
      />
    );
  }

  // ---- Stats ----

  const stats = computeStats(tenants);

  // ---- Render ----

  return (
    <div
      className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8"
      style={{ backgroundImage: DOT_GRID, backgroundSize: "24px 24px" }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {/* Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              System Admin
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl text-balance">
              Tenant Control Console
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Provision WorkOS organizations, issue onboarding invites, and
              monitor tenant setup progress.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              aria-label="Sign out"
              className="gap-2"
              onClick={() => signOut()}
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign Out
            </Button>
            <Button className="gap-2" onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Create Tenant Invite
            </Button>
          </div>
        </header>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(({ label, value, accentClass }) => (
            <div
              key={label}
              className="rounded-lg border border-border bg-card p-4"
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                {label}
              </p>
              <p
                className={`mt-2 text-2xl font-semibold tabular-nums ${accentClass}`}
              >
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* Invite banner */}
        {inviteResult ? (
          <InviteBanner
            result={inviteResult}
            onDismiss={() => setInviteResult(null)}
          />
        ) : null}

        {/* Tenant table */}
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-sm font-semibold text-card-foreground">
              Tenants
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Live tenant state from Convex. Pending invites can be regenerated
              from the actions column.
            </p>
          </div>

          {tenants === undefined ? (
            <div
              className="flex items-center gap-3 px-6 py-10 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner className="size-4" />
              Loading tenant list&hellip;
            </div>
          ) : tenants.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              No tenants yet. Create the first invite above.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Invite Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((tenant) => (
                    <TenantRow
                      key={tenant._id}
                      tenant={tenant}
                      onRegenerate={handleRegenerate}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      {/* Dialog */}
      <CreateTenantDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tenant Row
// ---------------------------------------------------------------------------

function TenantRow({
  tenant,
  onRegenerate,
}: {
  tenant: Doc<"tenants">;
  onRegenerate: (tenant: Doc<"tenants">) => Promise<void>;
}) {
  const [regenerating, setRegenerating] = useState(false);

  return (
    <TableRow>
      <TableCell className="font-medium">{tenant.companyName}</TableCell>
      <TableCell className="text-muted-foreground">
        {tenant.contactEmail}
      </TableCell>
      <TableCell>
        <StatusBadge status={tenant.status} />
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">
        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
          tenant._creationTime,
        )}
      </TableCell>
      <TableCell className="tabular-nums">
        <InviteExpiry expiresAt={tenant.inviteExpiresAt} status={tenant.status} />
      </TableCell>
      <TableCell className="text-right">
        {tenant.status === "pending_signup" ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={regenerating}
            aria-label={`Regenerate invite for ${tenant.companyName}`}
            onClick={async () => {
              setRegenerating(true);
              try {
                await onRegenerate(tenant);
              } finally {
                setRegenerating(false);
              }
            }}
          >
            {regenerating ? (
              <Spinner className="size-3.5" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            Regenerate
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">&mdash;</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Status Badge
// ---------------------------------------------------------------------------

type TenantStatus = Doc<"tenants">["status"];

const STATUS_CONFIG: Record<
  TenantStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "ghost" }
> = {
  pending_signup: { label: "Pending Signup", variant: "outline" },
  pending_calendly: { label: "Pending Calendly", variant: "secondary" },
  provisioning_webhooks: { label: "Provisioning", variant: "secondary" },
  active: { label: "Active", variant: "default" },
  calendly_disconnected: { label: "Disconnected", variant: "destructive" },
  suspended: { label: "Suspended", variant: "ghost" },
};

function StatusBadge({ status }: { status: TenantStatus }) {
  const config = STATUS_CONFIG[status];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

// ---------------------------------------------------------------------------
// Invite Expiry
// ---------------------------------------------------------------------------

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function InviteExpiry({
  expiresAt,
  status,
}: {
  expiresAt: number;
  status: TenantStatus;
}) {
  // Once redeemed or active, the invite expiry is no longer relevant
  if (status !== "pending_signup") {
    return <span className="text-xs text-muted-foreground">&mdash;</span>;
  }

  const isExpired = expiresAt < Date.now();

  return (
    <time
      dateTime={new Date(expiresAt).toISOString()}
      className={isExpired ? "text-destructive" : "text-muted-foreground"}
      title={dateTimeFormatter.format(expiresAt)}
    >
      <span className="text-sm">
        {dateTimeFormatter.format(expiresAt)}
      </span>
      {isExpired ? (
        <span className="ml-1.5 text-[11px] font-medium uppercase tracking-wider text-destructive">
          Expired
        </span>
      ) : null}
    </time>
  );
}

// ---------------------------------------------------------------------------
// Stats helper
// ---------------------------------------------------------------------------

function computeStats(tenants: Doc<"tenants">[] | undefined) {
  const counts = {
    pending_signup: 0,
    pending_calendly: 0,
    active: 0,
    total: 0,
  };

  if (tenants) {
    counts.total = tenants.length;
    for (const t of tenants) {
      if (t.status === "pending_signup") counts.pending_signup++;
      else if (t.status === "pending_calendly") counts.pending_calendly++;
      else if (t.status === "active") counts.active++;
    }
  }

  return [
    {
      label: "Total Tenants",
      value: String(counts.total),
      accentClass: "text-foreground",
    },
    {
      label: "Pending Signup",
      value: String(counts.pending_signup),
      accentClass: "text-chart-1",
    },
    {
      label: "Pending Calendly",
      value: String(counts.pending_calendly),
      accentClass: "text-chart-2",
    },
    {
      label: "Active",
      value: String(counts.active),
      accentClass: "text-primary",
    },
  ];
}

// ---------------------------------------------------------------------------
// Gate Screen (loading / auth error)
// ---------------------------------------------------------------------------

function GateScreen({
  label,
  title,
  description,
  variant = "loading",
}: {
  label?: string;
  title?: string;
  description?: string;
  variant?: "loading" | "error";
}) {
  if (variant === "loading") {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-background"
        role="status"
      >
        <div className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {label ?? "Loading"}&hellip;
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="h-0.5 bg-destructive" />
        <div className="space-y-4 p-8">
          <div className="flex items-start gap-3">
            <ShieldAlert
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-card-foreground">
                {title}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
