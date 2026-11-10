"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { ChevronRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { IntegrationCardSkeleton } from "@/app/workspace/settings/_components/settings-skeleton";
import {
  ActionRow,
  FACT_FIGURE,
  Fact,
  Facts,
  NoteLine,
  StatusWord,
} from "@/app/workspace/settings/_components/settings-ui";
import {
  FATHOM_SETTINGS_HREF,
  FathomKeyForm,
  dayTimeFormat,
  fathomState,
  memberCounts,
} from "./fathom-settings-parts";

/**
 * Fathom on the Integrations tab (docs/plans/closer-assistant.md §6.5): one
 * status word and the connection as dense facts, then a link to its own page,
 * where members are linked and recordings assigned. Before it's connected the
 * card holds the key field; Connect is lime only once Calendly and Slack have
 * theirs (`quiet` while they don't).
 */
export function FathomIntegrationCard({ quiet = false }: { quiet?: boolean }) {
  const { role } = useRole();
  return role === "tenant_admin" || role === "tenant_master" ? <FathomSummary quiet={quiet} /> : null;
}

function FathomSummary({ quiet }: { quiet: boolean }) {
  const settings = useQuery(api.fathom.connection.settings, {});

  if (!settings) return <IntegrationCardSkeleton label="Loading Fathom connection" groups={[3]} />;

  const connection = settings.connection;
  const connected = connection?.status === "connected";
  const state = fathomState(connection);
  const { linked, toLink } = memberCounts(settings.members);
  const unmatched = settings.unmatched.length;

  return (
    <section aria-label="Fathom" className={CARD}>
      <CardHead title="Fathom">
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </CardHead>

      {connected ? (
        <Facts>
          <Fact label="API key" tip="Magnus keeps the key server-side and shows only its last four characters.">
            <span translate="no" className="font-mono text-[12.5px]">
              •••• {connection.keyLast4}
            </span>
          </Fact>
          <Fact label="Last webhook" tip="When Fathom last sent Magnus a recording. Magnus also checks Fathom for missed ones.">
            {connection.lastWebhookAt ? (
              <span className={FACT_FIGURE}>{dayTimeFormat.format(connection.lastWebhookAt)}</span>
            ) : (
              <span className="text-muted-foreground">None yet</span>
            )}
          </Fact>
          <Fact label="Members" tip="People in your Fathom account. Each person who records sales calls needs a Magnus user.">
            <span className={FACT_FIGURE}>{linked}</span> linked
            {toLink > 0 ? (
              <span className="text-warning-ink">
                {" · "}
                <span className={FACT_FIGURE}>{toLink}</span> to link
              </span>
            ) : null}
          </Fact>
          {unmatched > 0 ? (
            <Fact label="No meeting" tip="Recordings Magnus couldn't tie to a meeting. Assign them on the Fathom page.">
              <span className="text-warning-ink">
                <span className={FACT_FIGURE}>{unmatched}</span> {unmatched === 1 ? "recording" : "recordings"}
              </span>
            </Fact>
          ) : null}
        </Facts>
      ) : (
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <NoteLine>
            Ties each sales call&apos;s Fathom recording to its meeting. Transcripts stay 90 days; summaries stay with
            the call.
          </NoteLine>
          {connection?.status === "invalid_key" ? (
            <NoteLine tone="danger" role="alert">
              Fathom refused the saved key. Paste a new one.
            </NoteLine>
          ) : null}
        </div>
      )}

      {connection?.lastError ? (
        <div className="border-b border-border px-4 py-2.5">
          <NoteLine tone="danger" role="alert">
            {connection.lastError}
          </NoteLine>
        </div>
      ) : null}

      {connected ? (
        <ActionRow>
          <Button asChild variant="outline" size="sm">
            <Link href={FATHOM_SETTINGS_HREF}>
              {toLink > 0 ? "Link members" : "Manage Fathom"}
              <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        </ActionRow>
      ) : (
        <FathomKeyForm replacing={false} quiet={quiet} onDone={() => {}} />
      )}
    </section>
  );
}
