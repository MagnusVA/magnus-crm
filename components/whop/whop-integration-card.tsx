"use client";

import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
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
import { whopState } from "@/app/workspace/settings/_components/integrations/integration-status";
import {
  ScopeList,
  WHOP_DISPUTE_SCOPES,
  WHOP_SETTINGS_HREF,
  WhopConnectForm,
  dayTimeFormat,
  useWhopConnection,
  whopErrorSentence,
} from "./whop-settings-parts";

/**
 * Whop on the Integrations tab: one status word and the connection as dense
 * facts, then a link to its own page, where the webhook is finished and
 * products and prices are mapped. Before it's connected the card holds the
 * account and key fields; Connect is lime only once the integrations before it
 * have theirs (`quiet` while they don't).
 */
export function WhopIntegrationCard({ quiet = false }: { quiet?: boolean }) {
  const { role } = useRole();
  return role === "tenant_admin" || role === "tenant_master" ? <WhopSummary quiet={quiet} /> : null;
}

function WhopSummary({ quiet }: { quiet: boolean }) {
  const connection = useWhopConnection();

  if (connection === undefined) return <IntegrationCardSkeleton label="Loading Whop connection" groups={[4]} />;

  const state = whopState(connection);
  const connected = connection?.status === "connected";
  const errorSentence = connected ? whopErrorSentence(connection.lastErrorCode) : null;

  return (
    <section aria-label="Whop" className={CARD}>
      <CardHead title="Whop">
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </CardHead>

      {connected ? (
        <>
          <Facts>
            <Fact label="Account">
              <span translate="no">{connection.accountTitle ?? connection.accountId}</span>
              {connection.accountTitle ? (
                <span translate="no" className="ml-1.5 font-mono text-[12px] text-muted-foreground">
                  {connection.accountId}
                </span>
              ) : null}
              {connection.environment === "sandbox" ? (
                <span className="text-muted-foreground"> · Sandbox</span>
              ) : null}
            </Fact>
            <Fact label="API key" tip="Magnus keeps the key server-side and shows only its last four characters.">
              <span translate="no" className="font-mono text-[12.5px]">
                •••• {connection.keyLast4}
              </span>
            </Fact>
            <Fact label="Last Whop event" tip="When Whop last sent Magnus a payment, refund or dispute event.">
              {connection.lastWebhookAt ? (
                <span className={FACT_FIGURE}>{dayTimeFormat.format(connection.lastWebhookAt)}</span>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              )}
            </Fact>
            <Fact label="Last checked" tip="Every 15 minutes Magnus also asks Whop for payments it may have missed.">
              {connection.lastSuccessfulSweepAt ? (
                <span className={FACT_FIGURE}>{dayTimeFormat.format(connection.lastSuccessfulSweepAt)}</span>
              ) : (
                <span className="text-muted-foreground">Not yet</span>
              )}
            </Fact>
          </Facts>
          {connection.disputeAccess === "forbidden" ? (
            <div className="border-b border-border px-4 py-2.5">
              <NoteLine tone="warning" role="alert">
                To read disputes, add <ScopeList scopes={WHOP_DISPUTE_SCOPES} /> to the Whop key and reconnect.
              </NoteLine>
            </div>
          ) : null}
          {errorSentence && !(connection.disputeAccess === "forbidden" && connection.lastErrorCode === "forbidden") ? (
            <div className="border-b border-border px-4 py-2.5">
              <NoteLine tone={state.tone === "danger" ? "danger" : "warning"} role="alert">
                {errorSentence}
              </NoteLine>
            </div>
          ) : !connection.hasWebhookSecret ? (
            <div className="border-b border-border px-4 py-2.5">
              <NoteLine tone="warning">
                Without the webhook, Magnus checks Whop every 15 minutes. Add the webhook in Whop and paste its secret here so payments arrive right away.
              </NoteLine>
            </div>
          ) : null}
          <ActionRow className="border-t-0">
            <Button asChild variant="outline" size="sm">
              <Link href={WHOP_SETTINGS_HREF}>
                {connection.hasWebhookSecret ? "Manage Whop" : "Finish webhook setup"}
                <ChevronRightIcon data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          </ActionRow>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
            <NoteLine>
              Whop payments appear in Billing as evidence for payments your team records. They never count as cash by themselves.
            </NoteLine>
            {connection?.status === "invalid_key" ? (
              <NoteLine tone="danger" role="alert">
                Whop rejected the saved key. Paste a new one.
              </NoteLine>
            ) : null}
          </div>
          <WhopConnectForm
            quiet={quiet}
            existing={connection ? { accountId: connection.accountId, environment: connection.environment } : null}
          />
        </>
      )}
    </section>
  );
}
