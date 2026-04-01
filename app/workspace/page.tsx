"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useQuery } from "convex/react";
import { CalendarCheck2, Clock3, RadioTower, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const STATUS_ITEMS = [
  {
    icon: ShieldCheck,
    label: "Tenant onboarding",
    value: "Complete",
  },
  {
    icon: CalendarCheck2,
    label: "Calendly OAuth",
    value: "Connected",
  },
  {
    icon: RadioTower,
    label: "Webhook subscription",
    value: "Provisioned",
  },
] as const;

export default function WorkspacePage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();
  const tenant = useQuery(api.tenants.getCurrentTenant, isAuthenticated ? {} : "skip");

  if (isLoading || (isAuthenticated && tenant === undefined)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background" role="status">
        <div className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading workspace&hellip;
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user || !tenant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
            Workspace Unavailable
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-card-foreground">
            No tenant workspace found
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Sign in with a provisioned tenant account or complete onboarding first.
          </p>
          <div className="mt-6 flex justify-center">
            <Button asChild>
              <Link href="/sign-in">Sign In</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const completedAt = tenant.onboardingCompletedAt
    ? new Date(tenant.onboardingCompletedAt).toLocaleString()
    : "Recently";

  return (
    <main className="min-h-screen bg-background px-4 py-12 sm:px-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="bg-primary px-6 py-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-primary-foreground">
            Tenant Workspace
          </div>
          <div className="grid gap-6 px-6 py-8 sm:px-8 lg:grid-cols-[1.5fr_1fr]">
            <div>
              <p className="text-sm text-muted-foreground">Ready for ingestion</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-card-foreground text-balance">
                {tenant.companyName} is onboarded
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                This is a temporary post-onboarding placeholder. The tenant has completed
                Calendly connection and is no longer in the onboarding path.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-muted/30 p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
                <Clock3 className="size-4 text-primary" aria-hidden="true" />
                Onboarding snapshot
              </div>
              <dl className="mt-4 space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="font-medium text-card-foreground">{tenant.status}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd className="font-medium text-card-foreground">{completedAt}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Webhook URI</dt>
                  <dd className="break-all font-medium text-card-foreground">
                    {tenant.calendlyWebhookUri ?? "Missing"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {STATUS_ITEMS.map(({ icon: Icon, label, value }) => (
            <div
              key={label}
              className="rounded-xl border border-border bg-card p-5 shadow-sm"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
                <Icon className="size-4 text-primary" aria-hidden="true" />
                {label}
              </div>
              <p className="mt-4 text-xl font-semibold tracking-tight text-card-foreground">
                {value}
              </p>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
