import type { Metadata } from "next";

import { PublicShell } from "@/components/public-shell";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD } from "@/app/workspace/team/_components/team-ui";

export const instant = false;

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for Magnus CRM and the Magnus Slack app.",
};

const effectiveDate = "May 13, 2026";

const SUPPORT_EMAIL = "vas.claudio15+supportmagnus@icloud.com";

const sections = [
  {
    title: "Information we collect",
    body: [
      "Magnus CRM collects account, organization, workspace, and user information needed to provide the CRM and Slack integration. This may include names, email addresses, organization identifiers, Slack workspace identifiers, Slack user identifiers, channel identifiers, app installation metadata, OAuth tokens, lead details submitted through the app, meeting information, notes, and related operational records.",
      "We may also collect limited technical information such as logs, device/browser metadata, request timestamps, error details, and usage events to operate, secure, debug, and improve the service.",
    ],
  },
  {
    title: "How we use information",
    body: [
      "We use information to provide and maintain Magnus CRM, connect Slack workspaces to the correct CRM tenant, process slash commands and interactive Slack workflows, create and update CRM records, send configured notifications, troubleshoot issues, prevent abuse, and comply with legal obligations.",
      "We do not sell personal information. We do not use Slack customer data for advertising.",
    ],
  },
  {
    title: "Slack data",
    body: [
      "When a workspace installs the Magnus Slack app, we process Slack data only as needed to deliver the integration. Slack tokens are stored securely and used to call Slack APIs for the installed workspace. Workspace administrators may disconnect the Slack integration from Magnus CRM, and Slack app uninstallation events are used to deactivate the integration.",
      "Slack messages are not broadly imported into Magnus CRM. The integration processes the commands, form submissions, identifiers, and events needed for the configured workflows.",
    ],
  },
  {
    title: "Sharing and service providers",
    body: [
      "We may share information with service providers that host, process, monitor, or support the service, including cloud hosting, authentication, analytics, communications, and backend infrastructure providers. These providers are authorized to process information only for service-related purposes.",
      "We may disclose information if required by law, to protect rights and security, or in connection with a business transaction such as a merger, acquisition, or asset transfer.",
    ],
  },
  {
    title: "Retention and deletion",
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
    title: "Your choices",
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

/** One ruled section of the policy: a 15px title over 14px paragraphs at a reading line-height. */
function PolicySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4 py-4">
      <h2 className="text-[15px] leading-snug font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const PARAGRAPH = "text-sm leading-[1.65] text-pretty text-foreground";

export default function PrivacyPage() {
  return (
    <PublicShell current="/privacy">
      <PageBand
        title="Privacy policy"
        description={`Effective ${effectiveDate}`}
      />

      <article className={`${CARD} divide-y divide-border`}>
        <div className="px-4 py-4">
          <p className={PARAGRAPH}>
            This Privacy Policy explains how Magnus CRM collects, uses, shares,
            and protects information when customers use Magnus CRM and the
            Magnus Slack app.
          </p>
        </div>
        {sections.map((section) => (
          <PolicySection key={section.title} title={section.title}>
            {section.body.map((paragraph) => (
              <p key={paragraph} className={PARAGRAPH}>
                {paragraph}
              </p>
            ))}
          </PolicySection>
        ))}
        <PolicySection title="Contact">
          <p className={PARAGRAPH}>
            For privacy questions or requests, email{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="rounded-sm font-medium break-words text-foreground underline decoration-input underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </PolicySection>
      </article>
    </PublicShell>
  );
}
