"use client";

import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, SETTINGS_ROOT, StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import { whopState } from "@/app/workspace/settings/_components/integrations/integration-status";
import { WhopConnectForm, useWhopConnection } from "@/components/whop/whop-settings-parts";
import { usePageTitle } from "@/hooks/use-page-title";
import { WhopCatalogCard } from "./catalog-card";
import { WhopConnectionCard } from "./connection-card";
import { WhopPageBand } from "./whop-page-band";
import { WhopPageSkeleton } from "./whop-page-skeleton";
import { WhopWebhookCard } from "./webhook-card";

/**
 * Whop's settings on their own page: products and prices down the left, where
 * the list can run long; the webhook steps and the connection's health on the
 * right. One column narrower, webhook first. Before Whop is connected (or after
 * its key is rejected) the page holds only the connect card.
 */
export function WhopPageClient() {
  usePageTitle("Whop");
  const connection = useWhopConnection();
  if (connection === undefined) return <WhopPageSkeleton />;

  if (connection?.status !== "connected") {
    const state = whopState(connection);
    return (
      <div className={SETTINGS_ROOT}>
        <WhopPageBand />
        <div className="grid max-w-[640px] gap-3.5">
          <SectionErrorBoundary sectionName="Whop connection">
            <section aria-label="Whop connection" className={CARD}>
              <CardHead title="Connection">
                <StatusWord tone={state.tone}>{state.word}</StatusWord>
              </CardHead>
              <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
                <NoteLine>
                  Connect your Whop account to read its payments. Once it&apos;s connected you&apos;ll set up the
                  webhook and map products and prices here.
                </NoteLine>
                {connection?.status === "invalid_key" ? (
                  <NoteLine tone="danger" role="alert">
                    Whop rejected the saved key. Paste a new one.
                  </NoteLine>
                ) : null}
              </div>
              <WhopConnectForm
                quiet={false}
                initialEnvironment={connection?.environment}
              />
            </section>
          </SectionErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <div className={SETTINGS_ROOT}>
      <WhopPageBand />
      <div className="grid gap-3.5 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] @4xl:items-start">
        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-2 @4xl:row-start-1">
          <SectionErrorBoundary sectionName="Whop webhook">
            <WhopWebhookCard connection={connection} />
          </SectionErrorBoundary>
          <SectionErrorBoundary sectionName="Whop connection">
            <WhopConnectionCard connection={connection} />
          </SectionErrorBoundary>
        </div>
        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-1">
          <SectionErrorBoundary sectionName="Whop products and prices">
            {/* A new connection (or a reconnect) reads the catalog again. */}
            <WhopCatalogCard key={`${connection.connectionId}:${connection.connectedAt}`} connectionId={connection.connectionId} />
          </SectionErrorBoundary>
        </div>
      </div>
    </div>
  );
}
