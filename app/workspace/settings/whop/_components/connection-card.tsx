"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import {
  ActionRow,
  FACT_FIGURE,
  Fact,
  Facts,
  NoteLine,
  StatusWord,
} from "@/app/workspace/settings/_components/settings-ui";
import { whopState, type WhopConnection } from "@/app/workspace/settings/_components/integrations/integration-status";
import { Button } from "@/components/ui/button";
import { dayTimeFormat, formatDay, whopErrorSentence } from "@/components/whop/whop-settings-parts";

const DisconnectWhopDialog = dynamic(() =>
  import("./disconnect-whop-dialog").then((module) => module.DisconnectWhopDialog),
);

/**
 * The connection and its health: the account and key, when Whop last sent a
 * payment, the 15-minute and nightly checks, and the error from the last one
 * in plain words. Disconnect is a quiet ghost at the foot.
 */
export function WhopConnectionCard({ connection }: { connection: WhopConnection }) {
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const state = whopState(connection);
  const errorSentence = whopErrorSentence(connection.lastErrorCode);

  return (
    <section aria-label="Whop connection health" className={CARD}>
      <CardHead title="Connection">
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </CardHead>
      <Facts>
        <Fact label="Account">
          <span translate="no" className="break-words">
            {connection.accountTitle ?? connection.accountId}
          </span>
          {connection.accountTitle ? (
            <span translate="no" className="block font-mono text-[12px] text-muted-foreground">
              {connection.accountId}
            </span>
          ) : null}
        </Fact>
        {connection.environment === "sandbox" ? <Fact label="Environment">Sandbox</Fact> : null}
        <Fact label="API key" tip="Magnus keeps the key server-side and shows only its last four characters.">
          <span translate="no" className="font-mono text-[12.5px]">
            •••• {connection.keyLast4}
          </span>
        </Fact>
        <Fact label="Connected">
          <span className={FACT_FIGURE}>{dayTimeFormat.format(connection.connectedAt)}</span>
        </Fact>
      </Facts>
      <Facts>
        <Fact label="Last webhook" tip="When Whop last sent Magnus a payment event.">
          <When at={connection.lastWebhookAt} none="None yet" />
        </Fact>
        <Fact label="15-minute check" tip="Every 15 minutes Magnus asks Whop for recent payments the webhook may have missed.">
          <When at={connection.lastSuccessfulSweepAt} none="Not yet" />
        </Fact>
        <Fact label="Nightly check" tip="Each night Magnus reads the full payment list from Whop.">
          <When at={connection.lastFullScanAt} none="Not yet" />
        </Fact>
      </Facts>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        {errorSentence ? (
          <NoteLine tone={state.tone === "danger" ? "danger" : "warning"} role="alert">
            {errorSentence}
          </NoteLine>
        ) : null}
        <NoteLine>
          Payments collected before <span className="whitespace-nowrap">{formatDay(connection.autoImportAfter)}</span>{" "}
          are history: they are shown in Billing and never proposed.
        </NoteLine>
      </div>
      <ActionRow className="border-t-0">
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-danger-ink hover:text-danger-ink"
          onClick={() => setDisconnectOpen(true)}
        >
          Disconnect
        </Button>
      </ActionRow>
      {disconnectOpen ? (
        <DisconnectWhopDialog
          connectionId={connection.connectionId}
          open={disconnectOpen}
          onOpenChange={setDisconnectOpen}
        />
      ) : null}
    </section>
  );
}

function When({ at, none }: { at: number | undefined; none: string }) {
  return at ? (
    <span className={FACT_FIGURE}>{dayTimeFormat.format(at)}</span>
  ) : (
    <span className="text-muted-foreground">{none}</span>
  );
}
