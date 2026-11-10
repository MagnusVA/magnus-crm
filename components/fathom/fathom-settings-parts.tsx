"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ActionRow, type Tone } from "@/app/workspace/settings/_components/settings-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

// The pieces the Integrations card and the Fathom settings page share.

export type FathomSettings = FunctionReturnType<typeof api.fathom.connection.settings>;
type Connection = NonNullable<FathomSettings["connection"]>;
type Member = FathomSettings["members"][number];

export const FATHOM_SETTINGS_HREF = "/workspace/settings/fathom";

export const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** One status word for the title row. Fathom is optional, so not connected is slate, not owed. */
export function fathomState(connection: Connection | null): { word: string; tone: Tone } {
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

export function memberCounts(members: Member[]) {
  return {
    linked: members.filter((member) => member.userId).length,
    toLink: members.filter((member) => !member.ignored && !member.userId).length,
  };
}

const keySchema = z.object({
  apiKey: z.string().trim().min(8, "Enter your Fathom API key.").max(1024),
});

/** The key field and its footer: Connect (lime unless `quiet`) or Replace key with Cancel. */
export function FathomKeyForm({
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

/** Members to link first, then linked, then ignored; by name within each. */
function memberOrder(member: Member) {
  if (member.ignored) return 2;
  return member.userId ? 1 : 0;
}

export function FathomMemberList({ members, users }: { members: Member[]; users: FathomSettings["users"] }) {
  const sorted = [...members].sort(
    (a, b) => memberOrder(a) - memberOrder(b) || (a.name ?? a.email).localeCompare(b.name ?? b.email),
  );
  return (
    <ul>
      {sorted.map((member) => (
        <MemberRow key={member.memberId} member={member} users={users} />
      ))}
    </ul>
  );
}

/** One Fathom member: name and email, then the Magnus user they record for. */
function MemberRow({ member, users }: { member: Member; users: FathomSettings["users"] }) {
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
