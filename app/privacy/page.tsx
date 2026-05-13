import type { Metadata } from "next";
import Link from "next/link";

import { MagnusBrand } from "@/components/magnus-brand";
import { DOT_GRID_STYLE } from "@/lib/dot-grid";

export const unstable_instant = false;

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for Magnus CRM and the Magnus Slack app.",
};

const effectiveDate = "May 13, 2026";

const sections = [
  {
    title: "Information We Collect",
    body: [
      "Magnus CRM collects account, organization, workspace, and user information needed to provide the CRM and Slack integration. This may include names, email addresses, organization identifiers, Slack workspace identifiers, Slack user identifiers, channel identifiers, app installation metadata, OAuth tokens, lead details submitted through the app, meeting information, notes, and related operational records.",
      "We may also collect limited technical information such as logs, device/browser metadata, request timestamps, error details, and usage events to operate, secure, debug, and improve the service.",
    ],
  },
  {
    title: "How We Use Information",
    body: [
      "We use information to provide and maintain Magnus CRM, connect Slack workspaces to the correct CRM tenant, process slash commands and interactive Slack workflows, create and update CRM records, send configured notifications, troubleshoot issues, prevent abuse, and comply with legal obligations.",
      "We do not sell personal information. We do not use Slack customer data for advertising.",
    ],
  },
  {
    title: "Slack Data",
    body: [
      "When a workspace installs the Magnus Slack app, we process Slack data only as needed to deliver the integration. Slack tokens are stored securely and used to call Slack APIs for the installed workspace. Workspace administrators may disconnect the Slack integration from Magnus CRM, and Slack app uninstallation events are used to deactivate the integration.",
      "Slack messages are not broadly imported into Magnus CRM. The integration processes the commands, form submissions, identifiers, and events needed for the configured workflows.",
    ],
  },
  {
    title: "Sharing and Service Providers",
    body: [
      "We may share information with service providers that host, process, monitor, or support the service, including cloud hosting, authentication, analytics, communications, and backend infrastructure providers. These providers are authorized to process information only for service-related purposes.",
      "We may disclose information if required by law, to protect rights and security, or in connection with a business transaction such as a merger, acquisition, or asset transfer.",
    ],
  },
  {
    title: "Retention and Deletion",
    body: [
      "We retain information for as long as needed to provide the service, meet operational and legal requirements, resolve disputes, and enforce agreements. Retention periods may vary based on account status, data type, and legal obligations.",
      "A customer may request deletion of their account or integration data by contacting support. Some information may remain in backups, logs, or records where retention is required or technically necessary for a limited period.",
    ],
  },
  {
    title: "Security",
    body: [
      "We use reasonable administrative, technical, and organizational safeguards designed to protect information against unauthorized access, loss, misuse, or alteration. No system can be guaranteed to be completely secure.",
    ],
  },
  {
    title: "Your Choices",
    body: [
      "You may access, update, export, or delete certain information through Magnus CRM where available. Workspace administrators may manage Slack installation settings and disconnect the Slack app.",
      "For privacy requests, contact us using the support information below.",
    ],
  },
  {
    title: "Changes",
    body: [
      "We may update this policy from time to time. If changes are material, we will provide notice through the service or another reasonable channel. The updated policy will be effective when posted unless otherwise stated.",
    ],
  },
];

export default function PrivacyPage() {
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
            href="/support"
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Support
          </Link>
        </header>

        <section className="border-b border-border pb-8">
          <p className="mb-3 text-sm font-medium text-primary">
            Effective {effectiveDate}
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-5 text-base leading-7 text-muted-foreground">
            This Privacy Policy explains how Magnus CRM collects, uses, shares,
            and protects information when customers use Magnus CRM and the
            Magnus Slack app.
          </p>
        </section>

        <div className="flex flex-col gap-8">
          {sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-3">
              <h2 className="text-xl font-semibold tracking-tight">
                {section.title}
              </h2>
              {section.body.map((paragraph) => (
                <p
                  key={paragraph}
                  className="text-sm leading-7 text-muted-foreground"
                >
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>

        <section className="border-t border-border pt-8">
          <h2 className="text-xl font-semibold tracking-tight">Contact</h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            For privacy questions or requests, email{" "}
            <a
              href="mailto:vas.claudio15+supportmagnus@icloud.com"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              vas.claudio15+supportmagnus@icloud.com
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
