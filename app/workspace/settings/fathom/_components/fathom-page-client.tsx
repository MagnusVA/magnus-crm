"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import {
  ActionRow,
  FACT_FIGURE,
  Fact,
  Facts,
  NoteLine,
  SETTINGS_ROOT,
  StatusWord,
} from "@/app/workspace/settings/_components/settings-ui";
import { SecondOpinionSettingsRow } from "@/components/second-opinion/settings-row";
import {
  FathomKeyForm,
  FathomMemberList,
  dayTimeFormat,
  fathomState,
  memberCounts,
  type FathomSettings,
} from "@/components/fathom/fathom-settings-parts";
import { UnmatchedRecordingList } from "@/components/fathom/unmatched-recordings";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { FathomPageBand } from "./fathom-page-band";
import { FathomPageSkeleton } from "./fathom-page-skeleton";

/**
 * Fathom's settings (docs/plans/closer-assistant.md §6.5) on their own page:
 * the members to link down the left, where the list can run long; the
 * connection, recordings without a meeting and the second opinion on the
 * right. One column narrower.
 */
export function FathomPageClient() {
  usePageTitle("Fathom");
  const settings = useQuery(api.fathom.connection.settings, {});
  if (!settings) return <FathomPageSkeleton />;

  const connected = settings.connection?.status === "connected";
  const showMembers = connected && settings.members.length > 0;
  return (
    <div className={SETTINGS_ROOT}>
      <FathomPageBand />
      <div
        className={
          showMembers
            ? "grid gap-3.5 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] @4xl:items-start"
            : "grid max-w-[640px] gap-3.5"
        }
      >
        {showMembers ? (
          <SectionErrorBoundary sectionName="Fathom members">
            <MembersCard settings={settings} />
          </SectionErrorBoundary>
        ) : null}
        <div className="flex min-w-0 flex-col gap-3.5">
          <SectionErrorBoundary sectionName="Fathom connection">
            <ConnectionCard settings={settings} />
          </SectionErrorBoundary>
          {connected || settings.unmatched.length > 0 ? (
            <SectionErrorBoundary sectionName="Recordings without a meeting">
              <section aria-label="Recordings without a meeting" className={CARD}>
                <UnmatchedRecordingList recordings={settings.unmatched} capped={settings.capped} />
              </section>
            </SectionErrorBoundary>
          ) : null}
          <SectionErrorBoundary sectionName="Second opinion">
            <section aria-label="Second opinion" className={CARD}>
              <SecondOpinionSettingsRow fathomConnected={connected} />
            </section>
          </SectionErrorBoundary>
        </div>
      </div>
    </div>
  );
}

function MembersCard({ settings }: { settings: FathomSettings }) {
  const { linked, toLink } = memberCounts(settings.members);
  return (
    <section aria-label="Fathom members" className={CARD}>
      <CardHead
        title="Members"
        meta={
          <>
            {linked} linked
            {toLink > 0 ? <span className="text-warning-ink">{` · ${toLink} to link`}</span> : null}
          </>
        }
      />
      <p className="border-b border-border px-4 py-2.5 text-[13px] leading-[1.45] text-muted-foreground">
        Link each sales recorder to their Magnus user, and mark everyone else Ignored, so their recordings are
        discarded.
      </p>
      <FathomMemberList members={settings.members} users={settings.users} />
    </section>
  );
}

function ConnectionCard({ settings }: { settings: FathomSettings }) {
  const disconnect = useAction(api.fathom.connection.disconnect);
  const importDays = useAction(api.fathom.connection.importLast30Days);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<null | "import" | "disconnect">(null);

  const connection = settings.connection;
  const connected = connection?.status === "connected";
  const state = fathomState(connection);

  async function run(kind: "import" | "disconnect", action: () => Promise<unknown>, message: string) {
    setBusy(kind);
    try {
      await action();
      toast.success(message);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not update Fathom."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Fathom connection" className={CARD}>
      <CardHead title="Connection">
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </CardHead>

      {connected ? (
        <Facts>
          <Fact
            label="API key"
            tip="A key from a Fathom seat that can see the sales team's calls. Magnus keeps it server-side and shows only its last four characters."
          >
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
          <Fact label="Discarded" tip="Calls from ignored members, or with no one from outside your company.">
            <span className={FACT_FIGURE}>{connection.droppedCount}</span>{" "}
            {connection.droppedCount === 1 ? "call" : "calls"}
          </Fact>
        </Facts>
      ) : connection?.status === "invalid_key" ? (
        <div className="border-b border-border px-4 py-2.5">
          <NoteLine tone="danger" role="alert">
            Fathom refused the saved key. Paste a new one.
          </NoteLine>
        </div>
      ) : null}

      {connection?.lastError ? (
        <div className="border-b border-border px-4 py-2.5">
          <NoteLine tone="danger" role="alert">
            {connection.lastError}
          </NoteLine>
        </div>
      ) : null}
      {settings.warnings.length > 0 || settings.capped ? (
        <ul className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5">
          {settings.warnings.map((warning) => (
            <li key={warning}>
              <NoteLine tone="warning">{warning}</NoteLine>
            </li>
          ))}
          {settings.capped ? (
            <li>
              <NoteLine>Member and recording lists are partial.</NoteLine>
            </li>
          ) : null}
        </ul>
      ) : null}

      {!connected || replacing ? (
        <FathomKeyForm
          replacing={connected}
          quiet={false}
          onDone={() => setReplacing(false)}
          onCancel={replacing ? () => setReplacing(false) : undefined}
        />
      ) : (
        <ActionRow>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || connection.importing}
            onClick={() => run("import", () => importDays({}), "Import queued. Recordings will arrive shortly.")}
          >
            {connection.importing || busy === "import" ? <Spinner data-icon="inline-start" /> : null}
            {connection.importing ? "Importing…" : "Import last 30 days"}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setReplacing(true)}>
            Replace key
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-danger-ink hover:text-danger-ink"
            disabled={busy !== null}
            onClick={() => run("disconnect", () => disconnect({}), "Fathom disconnected.")}
          >
            {busy === "disconnect" ? <Spinner data-icon="inline-start" /> : null}
            Disconnect
          </Button>
        </ActionRow>
      )}
    </section>
  );
}
