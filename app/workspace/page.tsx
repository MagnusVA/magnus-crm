"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useQuery } from "convex/react";
import {
  ActivityIcon,
  CalendarCheck2Icon,
  CopyIcon,
  ExternalLinkIcon,
  LogOutIcon,
  RadioTowerIcon,
  ShieldCheckIcon,
  TerminalIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOT_GRID =
  "radial-gradient(circle, oklch(1 0 0 / 0.03) 1px, transparent 1px)";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const SUBSYSTEMS = [
  {
    key: "onboarding",
    icon: ShieldCheckIcon,
    label: "Identity & Onboarding",
    value: "Operational",
    active: true,
  },
  {
    key: "calendly",
    icon: CalendarCheck2Icon,
    label: "Calendly OAuth",
    value: "Connected",
    active: true,
  },
  {
    key: "webhooks",
    icon: RadioTowerIcon,
    label: "Webhook Pipeline",
    value: "Receiving",
    active: true,
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(timestamp: number, now: number): string {
  const diffMs = timestamp - now;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (Math.abs(diffDays) > 0) {
    return relativeTimeFormatter.format(diffDays, "day");
  }
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  if (Math.abs(diffHours) > 0) {
    return relativeTimeFormatter.format(diffHours, "hour");
  }
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  return relativeTimeFormatter.format(diffMinutes, "minute");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspacePage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user, signOut } = useAuth();
  const tenant = useQuery(
    api.tenants.getCurrentTenant,
    isAuthenticated ? {} : "skip",
  );

  // ---- Gate: loading ----
  if (isLoading || (isAuthenticated && tenant === undefined)) {
    return <GateScreen />;
  }

  // ---- Gate: no access ----
  if (!isAuthenticated || !user || !tenant) {
    return <NoAccessScreen />;
  }

  return (
    <div
      className="relative min-h-screen bg-background"
      style={{ backgroundImage: DOT_GRID, backgroundSize: "24px 24px" }}
    >
      {/* Ambient glow — top edge */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-48 opacity-40"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(ellipse 60% 100% at 50% 0%, oklch(0.448 0.119 151.328 / 0.15), transparent)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-0 px-4 sm:px-6 lg:px-8">
        {/* ── Top bar ────────────────────────────────────── */}
        <TopBar
          companyName={tenant.companyName}
          userEmail={user.email}
          userName={user.firstName ?? user.email}
          onSignOut={() => signOut()}
        />

        {/* ── Main content ───────────────────────────────── */}
        <main className="flex flex-col gap-6 pb-12">
          {/* Hero section */}
          <HeroSection
            companyName={tenant.companyName}
            status={tenant.status}
            onboardingCompletedAt={tenant.onboardingCompletedAt}
          />

          {/* Subsystem status grid */}
          <section aria-label="System status">
            <SectionHeader label="Subsystems" />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {SUBSYSTEMS.map((sys, idx) => (
                <SubsystemCard
                  key={sys.key}
                  icon={sys.icon}
                  label={sys.label}
                  value={sys.value}
                  active={sys.active}
                  delay={idx * 100}
                />
              ))}
            </div>
          </section>

          {/* System details */}
          <section aria-label="System details">
            <SectionHeader label="Configuration" />
            <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
              <SystemDetailRow
                label="Organization"
                value={tenant.companyName}
              />
              <SystemDetailRow
                label="Org ID"
                value={tenant.workosOrgId}
                copyable
                mono
              />
              <SystemDetailRow
                label="Tenant ID"
                value={tenant.tenantId}
                copyable
                mono
              />
              <SystemDetailRow
                label="Webhook Endpoint"
                value={tenant.calendlyWebhookUri ?? "Not provisioned"}
                copyable={!!tenant.calendlyWebhookUri}
                mono
              />
              <SystemDetailRow
                label="Status"
                value={tenant.status}
                badge
                last
              />
            </div>
          </section>

          {/* Actions */}
          <section aria-label="Quick actions">
            <SectionHeader label="Actions" />
            <div className="mt-3 flex flex-wrap gap-3">
              <Button variant="outline" asChild>
                <Link
                  href="https://calendly.com/event_types/user/me"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <CalendarCheck2Icon data-icon="inline-start" aria-hidden="true" />
                  Open Calendly
                  <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/">
                  <TerminalIcon data-icon="inline-start" aria-hidden="true" />
                  Home
                </Link>
              </Button>
              <Button
                variant="destructive"
                onClick={() => signOut()}
              >
                <LogOutIcon data-icon="inline-start" aria-hidden="true" />
                Sign Out
              </Button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top Bar
// ---------------------------------------------------------------------------

function TopBar({
  companyName,
  userEmail,
  userName,
  onSignOut,
}: {
  companyName: string;
  userEmail: string;
  userName: string;
  onSignOut: () => void;
}) {
  return (
    <header className="flex items-center justify-between border-b border-border py-4">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Magnus
        </Link>
        <Separator orientation="vertical" className="h-4" />
        <span className="text-xs text-muted-foreground">{companyName}</span>
      </div>

      <div className="flex items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <UserIcon className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{userName}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{userEmail}</p>
          </TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          variant="ghost"
          onClick={onSignOut}
          aria-label="Sign out"
        >
          <LogOutIcon data-icon="inline-start" aria-hidden="true" />
          <span className="hidden sm:inline">Sign Out</span>
        </Button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Hero Section
// ---------------------------------------------------------------------------

function HeroSection({
  companyName,
  status,
  onboardingCompletedAt,
}: {
  companyName: string;
  status: string;
  onboardingCompletedAt?: number;
}) {
  const [now] = useState(Date.now);

  const completedLabel = onboardingCompletedAt
    ? formatRelativeTime(onboardingCompletedAt, now)
    : "recently";

  return (
    <section className="pt-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-600">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {/* Live status indicator */}
          <span className="relative flex size-2.5" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-primary">
            {status === "active" ? "All Systems Operational" : status.replace(/_/g, " ")}
          </p>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl text-balance">
          {companyName}
        </h1>

        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground text-pretty">
          Workspace is active and receiving Calendly events. Onboarding completed{" "}
          <time
            dateTime={
              onboardingCompletedAt
                ? new Date(onboardingCompletedAt).toISOString()
                : undefined
            }
            title={
              onboardingCompletedAt
                ? dateTimeFormatter.format(onboardingCompletedAt)
                : undefined
            }
          >
            {completedLabel}
          </time>
          .
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Subsystem Card
// ---------------------------------------------------------------------------

function SubsystemCard({
  icon: Icon,
  label,
  value,
  active,
  delay,
}: {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  value: string;
  active: boolean;
  delay: number;
}) {
  return (
    <div
      className="group relative overflow-hidden rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/30 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-400"
      style={{ animationDelay: `${200 + delay}ms` }}
    >
      {/* Subtle glow on hover */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(circle at 50% 0%, oklch(0.448 0.119 151.328 / 0.06), transparent 70%)",
        }}
      />

      <div className="relative flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <Icon className="size-4 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-sm font-semibold text-card-foreground">
            {value}
          </p>
        </div>
        {/* Status dot */}
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            active ? "bg-primary" : "bg-destructive",
          )}
          aria-label={active ? "Operational" : "Issue detected"}
          role="img"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section Header
// ---------------------------------------------------------------------------

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <Separator className="flex-1" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// System Detail Row
// ---------------------------------------------------------------------------

function SystemDetailRow({
  label,
  value,
  copyable = false,
  mono = false,
  badge = false,
  last = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  mono?: boolean;
  badge?: boolean;
  last?: boolean;
}) {
  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-5 py-3 text-sm",
        !last && "border-b border-border",
      )}
    >
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        {badge ? (
          <Badge variant={value === "active" ? "default" : "secondary"}>
            {value}
          </Badge>
        ) : (
          <span
            className={cn(
              "truncate text-right font-medium text-card-foreground",
              mono && "font-mono text-xs",
            )}
            title={value}
          >
            {value}
          </span>
        )}
        {copyable ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={handleCopy}
                aria-label={`Copy ${label}`}
              >
                <CopyIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p>Copy</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gate Screens
// ---------------------------------------------------------------------------

function GateScreen() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      role="status"
    >
      <div className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
        <Spinner />
        Loading workspace&hellip;
      </div>
    </div>
  );
}

function NoAccessScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="h-0.5 bg-destructive" />
          <div className="flex flex-col gap-5 p-8 text-center">
            <div className="flex flex-col gap-2">
              <ActivityIcon
                className="mx-auto size-8 text-muted-foreground/50"
                aria-hidden="true"
              />
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                Workspace Unavailable
              </p>
              <h1 className="text-xl font-semibold tracking-tight text-card-foreground">
                No Active Tenant Found
              </h1>
              <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted-foreground text-pretty">
                Sign in with a provisioned tenant account or complete onboarding
                to access this workspace.
              </p>
            </div>
            <div className="flex flex-col gap-2.5 pt-1">
              <Button asChild size="lg" className="w-full">
                <Link href="/sign-in">Sign In</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/">Return Home</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
