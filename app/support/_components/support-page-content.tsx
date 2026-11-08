import { PublicShell } from "@/components/public-shell";
import { PageBand } from "@/app/workspace/_components/page-band";
import { Fact } from "@/app/workspace/settings/_components/settings-ui";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { SupportRequestForm } from "./support-request-form";

// The support page's body, apart from page.tsx so the dev demo harness (a
// client tree) can render it: a page that exports metadata can't be imported
// there. No hooks and no server-only APIs, so it renders as a server
// component from page.tsx.

/** What to send for each kind of issue, so support can find the workspace. */
const supportItems = [
  {
    label: "Slack connection",
    detail: "Your organization, Slack workspace, the page or command you used, and any error you saw.",
  },
  {
    label: "Leads and alerts",
    detail: "The Slack channel, rough time, lead name if known, and what you expected to happen.",
  },
  {
    label: "Data and privacy",
    detail: "The organization and workspace involved, so we can route it to the right account.",
  },
];

export function SupportPageContent() {
  return (
    <PublicShell current="/support">
      <PageBand
        title="Support"
        description="Get help with Magnus CRM or the Magnus Slack app. We usually reply within 1 business day."
      />

      <SupportRequestForm />

      <section aria-labelledby="support-include-title" className={CARD}>
        <CardHead
          title={<span id="support-include-title">What to include</span>}
          meta="So we can find your workspace and the issue."
        />
        <dl className="divide-y divide-border py-1">
          {supportItems.map((item) => (
            <Fact key={item.label} label={item.label}>
              {item.detail}
            </Fact>
          ))}
        </dl>
      </section>
    </PublicShell>
  );
}
