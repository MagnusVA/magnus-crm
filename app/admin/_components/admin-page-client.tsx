"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useAction, usePaginatedQuery } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  CopyIcon,
  LogOutIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  tenantStatusConfig,
  type TenantStatus as SharedTenantStatus,
} from "@/lib/status-config";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import dynamic from "next/dynamic";
import type { CreateTenantPayload } from "./create-tenant-dialog";
import type { ResetTenantResult } from "./reset-tenant-dialog";
import {
  InviteBanner,
  type InviteResult,
} from "./invite-banner";

const CreateTenantDialog = dynamic(() =>
  import("./create-tenant-dialog").then((m) => ({ default: m.CreateTenantDialog })),
);
const ResetTenantDialog = dynamic(() =>
  import("./reset-tenant-dialog").then((m) => ({ default: m.ResetTenantDialog })),
);

type TenantStatus = Doc<"tenants">["status"];

const DOT_GRID = [
  "radial-gradient(circle, oklch(1 0 0 / 0.03) 1px, transparent 1px)",
].join(", ");

const PAGE_SIZE = 25;

export function AdminPageClient() {
  usePageTitle("Admin Console");
  const { signOut } = useAuth();

  const [statusFilter, setStatusFilter] = useState<TenantStatus | undefined>(
    undefined,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [tenantToReset, setTenantToReset] = useState<Doc<"tenants"> | null>(
    null,
  );

  const {
    results: tenants,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(api.admin.tenantsQueries.listTenants, { statusFilter }, { initialNumItems: PAGE_SIZE });

  const createTenantInvite = useAction(api.admin.tenants.createTenantInvite);
  const regenerateInvite = useAction(api.admin.tenants.regenerateInvite);
  const deleteTenant = useAction(api.admin.tenants.resetTenantForReonboarding);

  const handleCreate = async (payload: CreateTenantPayload) => {
    const result = await createTenantInvite(payload);
    setInviteResult(result);
  };

  const handleRegenerate = async (tenant: Doc<"tenants">) => {
    const result = await regenerateInvite({ tenantId: tenant._id });
    setInviteResult({
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      inviteUrl: result.inviteUrl,
      expiresAt: result.expiresAt,
    });
  };

  const handleReset = async (tenant: Doc<"tenants">) => {
    try {
      const result = await deleteTenant({ tenantId: tenant._id });

      toast.success(getResetToastTitle(result), {
        description: getResetToastDescription(result),
      });
    } catch (error) {
      toast.error("Tenant deletion failed.", {
        description:
          error instanceof Error
            ? error.message
            : "The tenant could not be deleted.",
      });
      throw error;
    }
  };

  const stats = computeStats(tenants);

  return (
    <div
      className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8"
      style={{ backgroundImage: DOT_GRID, backgroundSize: "24px 24px" }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-1.5">
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
              onClick={() => signOut()}
            >
              <LogOutIcon data-icon="inline-start" aria-hidden="true" />
              Sign Out
            </Button>
            <Button onClick={() => setDialogOpen(true)}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Create Tenant Invite
            </Button>
          </div>
        </header>

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
                className={cn("mt-2 text-2xl font-semibold tabular-nums", accentClass)}
              >
                {value}
              </p>
            </div>
          ))}
        </div>

        {inviteResult ? (
          <InviteBanner
            result={inviteResult}
            onDismiss={() => setInviteResult(null)}
          />
        ) : null}

        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-card-foreground">
                Tenants
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Live tenant state from Convex. Pending invites can be regenerated
                and tenants can be fully deleted from the actions column.
              </p>
            </div>
            <Select
              value={statusFilter ?? "all"}
              onValueChange={(value) =>
                setStatusFilter(
                  value === "all" ? undefined : (value as TenantStatus),
                )
              }
            >
              <SelectTrigger
                className="w-[180px] shrink-0"
                size="sm"
                aria-label="Filter tenants by status"
              >
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="pending_signup">Pending Signup</SelectItem>
                <SelectItem value="pending_calendly">Pending Calendly</SelectItem>
                <SelectItem value="provisioning_webhooks">Provisioning</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="calendly_disconnected">Disconnected</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="invite_expired">Invite Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {paginationStatus === "LoadingFirstPage" ? (
            <div
              className="flex items-center gap-3 px-6 py-10 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner className="size-4" />
              Loading tenant list&hellip;
            </div>
          ) : tenants.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
              {statusFilter
                ? "No tenants match this filter."
                : "No tenants yet. Create the first invite above."}
            </div>
          ) : (
            <>
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
                        onResetRequest={setTenantToReset}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="border-t border-border bg-muted/30 px-6 py-3.5">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-xs text-muted-foreground">
                    Showing {tenants.length} tenant{tenants.length !== 1 ? "s" : ""}
                    {paginationStatus === "Exhausted" && " (all loaded)"}
                  </div>
                  {paginationStatus === "CanLoadMore" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadMore(PAGE_SIZE)}
                      className="whitespace-nowrap"
                    >
                      Load More
                    </Button>
                  )}
                  {paginationStatus === "LoadingMore" && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Spinner className="size-3" />
                      Loading more&hellip;
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <CreateTenantDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleCreate}
        />
        <ResetTenantDialog
          open={tenantToReset !== null}
          tenant={tenantToReset}
          onOpenChange={(open) => {
            if (!open) {
              setTenantToReset(null);
            }
          }}
          onSubmit={handleReset}
        />
      </div>
    </div>
  );
}

function TenantRow({
  tenant,
  onRegenerate,
  onResetRequest,
}: {
  tenant: Doc<"tenants">;
  onRegenerate: (tenant: Doc<"tenants">) => Promise<void>;
  onResetRequest: (tenant: Doc<"tenants">) => void;
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
        {dateFormatter.format(tenant._creationTime)}
      </TableCell>
      <TableCell className="tabular-nums">
        <InviteExpiry expiresAt={tenant.inviteExpiresAt} status={tenant.status} />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          {tenant.status === "pending_signup" ||
          tenant.status === "invite_expired" ? (
            <Button
              variant="outline"
              size="sm"
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
                <>
                  <Spinner data-icon="inline-start" />
                  Regenerating&hellip;
                </>
              ) : (
                <>
                  <CopyIcon data-icon="inline-start" aria-hidden="true" />
                  Regenerate
                </>
              )}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            size="sm"
            aria-label={`Delete ${tenant.companyName} completely`}
            onClick={() => onResetRequest(tenant)}
          >
            <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({ status }: { status: TenantStatus }) {
  const config = tenantStatusConfig[status as SharedTenantStatus];
  if (!config) {
    return <Badge variant="secondary">{status}</Badge>;
  }
  return <Badge variant={config.badgeVariant}>{config.label}</Badge>;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

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
  const [now] = useState(Date.now);

  if (status !== "pending_signup" && status !== "invite_expired") {
    return <span className="text-xs text-muted-foreground">&mdash;</span>;
  }

  const isExpired = expiresAt < now;

  return (
    <time
      dateTime={new Date(expiresAt).toISOString()}
      className={isExpired ? "text-destructive" : "text-muted-foreground"}
      title={dateTimeFormatter.format(expiresAt)}
    >
      <span className="text-sm">{dateTimeFormatter.format(expiresAt)}</span>
      {isExpired ? (
        <span className="ml-1.5 text-[11px] font-medium uppercase tracking-wider text-destructive">
          Expired
        </span>
      ) : null}
    </time>
  );
}

function computeStats(tenants: Doc<"tenants">[] | undefined) {
  const counts = {
    pending_signup: 0,
    invite_expired: 0,
    pending_calendly: 0,
    active: 0,
    total: 0,
  };

  if (tenants) {
    counts.total = tenants.length;
    for (const t of tenants) {
      if (t.status === "pending_signup") counts.pending_signup++;
      else if (t.status === "invite_expired") counts.invite_expired++;
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
      label: "Expired Invites",
      value: String(counts.invite_expired),
      accentClass: "text-destructive",
    },
    {
      label: "Active",
      value: String(counts.active),
      accentClass: "text-primary",
    },
  ];
}

function getResetToastTitle(result: ResetTenantResult) {
  if (
    result.webhookCleanup.status === "deleted" &&
    result.workosCleanup.deletedOrganization
  ) {
    return "Tenant deleted. External systems were deprovisioned.";
  }

  if (result.webhookCleanup.status === "not_configured") {
    return "Tenant deleted. No Calendly webhook was configured.";
  }

  return "Tenant deleted. Review external cleanup status.";
}

function getResetToastDescription(result: ResetTenantResult) {
  const base = [
    `${result.workosCleanup.deletedUsers} WorkOS users removed`,
    `${result.deletedRawWebhookEvents} webhook events removed`,
    `${result.deletedCalendlyOrgMembers} Calendly members removed`,
    `${result.deletedUsers} app users removed`,
  ].join(" • ");

  const tokenSummary = [
    `Calendly access token: ${formatTokenCleanupStatus(result.tokenCleanup.accessToken)}`,
    `refresh token: ${formatTokenCleanupStatus(result.tokenCleanup.refreshToken)}`,
  ].join(" • ");

  return `${base} • ${tokenSummary} • Tenant row deleted. Create a new invite to start over.`;
}

function formatTokenCleanupStatus(
  status: ResetTenantResult["tokenCleanup"]["accessToken"],
) {
  if (status === "revoked") {
    return "revoked";
  }

  if (status === "already_invalid") {
    return "already invalid";
  }

  return "not present";
}
