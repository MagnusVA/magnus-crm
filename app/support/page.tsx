import type { Metadata } from "next";
import Link from "next/link";
import { LifeBuoyIcon, MailIcon } from "lucide-react";

import { MagnusBrand } from "@/components/magnus-brand";
import { Button } from "@/components/ui/button";
import { DOT_GRID_STYLE } from "@/lib/dot-grid";
import { SupportRequestForm } from "./_components/support-request-form";

export const unstable_instant = false;

export const metadata: Metadata = {
  title: "Support",
  description: "Support contact information for Magnus CRM and the Magnus Slack app.",
};

const supportItems = [
  {
    label: "Slack installation or connection issues",
    detail:
      "Include your organization name, Slack workspace name, the page or command you used, and any error message you saw.",
  },
  {
    label: "Lead qualification or notification issues",
    detail:
      "Include the Slack channel, approximate time, lead name if available, and what you expected to happen.",
  },
  {
    label: "Data and privacy requests",
    detail:
      "Tell us the organization and workspace involved so we can route the request to the correct account.",
  },
];

export default function SupportPage() {
  return (
    <main
      className="min-h-screen bg-background px-5 py-6 text-foreground sm:px-8 lg:px-10"
      style={DOT_GRID_STYLE}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        <header className="flex items-center justify-between gap-4">
          <Link
            href="/"
            aria-label="MAGNUS CRM home"
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <MagnusBrand size="sm" priority />
          </Link>
          <Link
            href="/privacy"
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Privacy
          </Link>
        </header>

        <section className="border-b border-border pb-8">
          <div className="mb-5 flex size-11 items-center justify-center rounded-md border border-border bg-card text-primary">
            <LifeBuoyIcon className="size-5" aria-hidden="true" />
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Magnus CRM Support
          </h1>
          <p className="mt-5 text-base leading-7 text-muted-foreground">
            Need help with Magnus CRM or the Magnus Slack app? Email support and
            include enough context for us to identify your workspace and issue.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <a href="mailto:vas.claudio15+supportmagnus@icloud.com">
                <MailIcon data-icon="inline-start" aria-hidden="true" />
                vas.claudio15+supportmagnus@icloud.com
              </a>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Typical response time: within 1 business day.
          </p>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold tracking-tight">
            What to Include
          </h2>
          <div className="grid gap-3">
            {supportItems.map((item) => (
              <article
                key={item.label}
                className="rounded-md border border-border bg-card px-4 py-4"
              >
                <h3 className="text-sm font-semibold">{item.label}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {item.detail}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-t border-border pt-8">
          <h2 className="text-xl font-semibold tracking-tight">Basics</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-foreground">Product</dt>
              <dd className="mt-1 text-muted-foreground">
                Magnus CRM and Magnus Slack app
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Support channel</dt>
              <dd className="mt-1 text-muted-foreground">
                <a
                  href="mailto:vas.claudio15+supportmagnus@icloud.com"
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  vas.claudio15+supportmagnus@icloud.com
                </a>
              </dd>
            </div>
          </dl>
        </section>

        <SupportRequestForm />
      </div>
    </main>
  );
}
