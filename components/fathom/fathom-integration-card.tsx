"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import { SecondOpinionSettingsRow } from "@/components/second-opinion/settings-row";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CARD, CardHead, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { IntegrationCardSkeleton } from "@/app/workspace/settings/_components/settings-skeleton";
import {
  ActionRow,
  FACT_FIGURE,
  Fact,
  Facts,
  NoteLine,
  StatusWord,
  type Tone,
} from "@/app/workspace/settings/_components/settings-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { UnmatchedRecordingList } from "./unmatched-recordings";

const keySchema = z.object({
  apiKey: z.string().trim().min(8, "Enter your Fathom API key.").max(1024),
});

type Settings = FunctionReturnType<typeof api.fathom.connection.settings>;
type Connection = NonNullable<Settings["connection"]>;

const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** One status word for the title row. Fathom is optional, so not connected is slate, not owed. */
function fathomState(connection: Connection | null): { word: string; tone: Tone } {
  switch (connection?.status) {
    case "connected":
      return { word: "Connected", tone: "ok" };
    case "invalid_key":
      return { word: "Invalid key", tone: "danger" };
    case "disconnected":
      return { word: "Disconnected", tone: "muted" };
    default:
      return { word: "Not connected", tone: "muted" };
  }
}

/**
 * Fathom (docs/plans/closer-assistant.md §6.5): one status word, the key,
 * webhook and members as dense facts, the members to link and the
 * recordings without a meeting as ruled rows, the second opinion, then the
 * card's actions in the footer. Lime only on Connect, and only once
 * Calendly and Slack have theirs (`quiet` while they don't).
 */
export function FathomIntegrationCard({ quiet = false }: { quiet?: boolean }) {
  const { role } = useRole();
  return role === "tenant_admin" || role === "tenant_master" ? <FathomSettings quiet={quiet} /> : null;
}

function FathomSettings({ quiet }: { quiet: boolean }) {
  const settings = useQuery(api.fathom.connection.settings, {});
  const disconnect = useAction(api.fathom.connection.disconnect);
  const importDays = useAction(api.fathom.connection.importLast30Days);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<null | "import" | "disconnect">(null);

  if (!settings) return <IntegrationCardSkeleton label="Loading Fathom connection" groups={[3, 2]} />;

  const connection = settings.connection;
  const connected = connection?.status === "connected";
  const state = fathomState(connection);
  const linked = settings.members.filter((member) => member.userId).length;
  const toLink = settings.members.filter((member) => !member.ignored && !member.userId).length;

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
    <section aria-label="Fathom" className={CARD}>
      <CardHead title="Fathom">
        <StatusWord tone={state.tone}>{state.word}</StatusWord>
      </CardHead>

      {!connected ? (
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
      ) : (
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
          <Fact label="Members" tip="People in your Fathom account. Each person who records sales calls needs a Magnus user.">
            <span className={FACT_FIGURE}>{linked}</span> linked
            {toLink > 0 ? (
              <span className="text-warning-ink">
                {" · "}
                <span className={FACT_FIGURE}>{toLink}</span> to link
              </span>
            ) : null}
          </Fact>
        </Facts>
      )}

      {connection?.lastError ? (
        <div className="border-b border-border px-4 py-2.5">
          <NoteLine tone="danger" role="alert">
            {connection.lastError}
          </NoteLine>
        </div>
      ) : null}
      {settings.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5">
          {settings.warnings.map((warning) => (
            <li key={warning}>
              <NoteLine tone="warning">{warning}</NoteLine>
            </li>
          ))}
        </ul>
      ) : null}

      {connected && settings.members.length > 0 ? (
        <div className="border-b border-border">
          <div className="flex min-h-9 items-center gap-2 border-b border-border px-4 py-1">
            <span className={LABEL}>
              <HelpTip tip="Link each sales recorder's Fathom address to their Magnus user, or ignore members who don't take sales calls.">
                Members
              </HelpTip>
            </span>
          </div>
          <ul>
            {settings.members.map((member) => (
              <MemberRow key={member.memberId} member={member} users={settings.users} />
            ))}
          </ul>
        </div>
      ) : null}

      {connected || settings.unmatched.length > 0 ? (
        <div className="border-b border-border">
          <UnmatchedRecordingList recordings={settings.unmatched} capped={settings.capped} />
        </div>
      ) : null}

      {settings.capped || connection?.droppedCount ? (
        <div className="flex flex-col gap-1 border-b border-border px-4 py-2">
          {settings.capped ? <NoteLine>Member and recording lists are partial.</NoteLine> : null}
          {connection?.droppedCount ? (
            <NoteLine>
              <span className="font-condensed text-[14px] tabular-nums">{connection.droppedCount}</span> ignored or
              internal-only calls discarded.
            </NoteLine>
          ) : null}
        </div>
      ) : null}

      <SecondOpinionSettingsRow fathomConnected={connected} />

      {!connected || replacing ? (
        <KeyForm
          replacing={connected}
          quiet={quiet}
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

/** The key field and its footer: Connect (lime unless `quiet`) or Replace key with Cancel. */
function KeyForm({
  replacing,
  quiet,
  onDone,
  onCancel,
}: {
  replacing: boolean;
  quiet: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const connect = useAction(api.fathom.connection.connect);
  const replace = useAction(api.fathom.connection.replaceKey);
  const form = useForm({
    resolver: standardSchemaResolver(keySchema),
    defaultValues: { apiKey: "" },
  });

  async function submit(values: z.infer<typeof keySchema>) {
    try {
      await (replacing ? replace : connect)(values);
      form.reset();
      onDone();
      toast.success(replacing ? "Fathom key replaced." : "Fathom connected.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not connect Fathom. Check the key and try again."));
    }
  }

  const submitting = form.formState.isSubmitting;
  return (
    <form onSubmit={form.handleSubmit(submit)}>
      <Controller
        control={form.control}
        name="apiKey"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5 px-4 py-3">
            <FieldLabel htmlFor="fathom-api-key" className="text-[13px] font-medium">
              {replacing ? "New Fathom API key" : "Fathom API key"}
            </FieldLabel>
            <Input
              {...field}
              id="fathom-api-key"
              type="password"
              autoComplete="off"
              aria-invalid={fieldState.invalid || undefined}
            />
            <FieldDescription className="text-[13px] leading-[1.45]">
              From a Fathom Team or Business seat that can see the sales team&apos;s calls. Share external meetings
              with User&apos;s Team, with the full lock. Magnus creates its own webhook.
            </FieldDescription>
            <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
          </Field>
        )}
      />
      <ActionRow>
        <Button
          type="submit"
          size="sm"
          variant={replacing || quiet ? "outline" : "default"}
          className={cn(!replacing && "font-semibold")}
          disabled={submitting}
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          {replacing ? "Replace key" : "Connect Fathom"}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => {
              form.reset();
              onCancel();
            }}
          >
            Cancel
          </Button>
        ) : null}
      </ActionRow>
    </form>
  );
}

/** One Fathom member: name and email, then the Magnus user they record for. */
function MemberRow({ member, users }: { member: Settings["members"][number]; users: Settings["users"] }) {
  const link = useMutation(api.fathom.connection.linkMember);
  const [busy, setBusy] = useState(false);
  const unlinked = !member.ignored && !member.userId;

  async function change(value: string) {
    setBusy(true);
    try {
      await link({
        memberId: member.memberId,
        userId: value === "unlinked" || value === "ignored" ? undefined : (value as Id<"users">),
        ignored: value === "ignored",
      });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not link member."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 last:border-b-0">
      <div className={cn("min-w-0 flex-1 basis-40", member.ignored && "opacity-60")}>
        <p className="truncate text-sm font-medium" translate="no">
          {member.name ?? member.email}
        </p>
        <p className="truncate text-[13px] text-muted-foreground" translate="no">
          {member.email}
          {member.viewAccessLevel ? ` · ${member.viewAccessLevel.replaceAll("_", " ")}` : ""}
        </p>
      </div>
      <Select
        disabled={busy}
        value={member.ignored ? "ignored" : (member.userId ?? "unlinked")}
        onValueChange={(value) => void change(value)}
      >
        <SelectTrigger
          size="sm"
          className={cn("w-44 max-w-full", unlinked && "text-warning-ink")}
          aria-label={`Magnus user for ${member.email}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="unlinked">Not linked</SelectItem>
            <SelectItem value="ignored">Ignored</SelectItem>
            {users.map((user) => (
              <SelectItem key={user.userId} value={user.userId}>
                {user.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </li>
  );
}
