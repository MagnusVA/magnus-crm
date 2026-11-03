"use client";

import { SecondOpinionSettingsRow } from "@/components/second-opinion/settings-row";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRole } from "@/components/auth/role-context";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";
import { UnmatchedRecordingList } from "./unmatched-recordings";

const keySchema = z.object({
  apiKey: z.string().trim().min(8, "Enter your Fathom API key.").max(1024),
});
type Settings = FunctionReturnType<typeof api.fathom.connection.settings>;
export function FathomIntegrationCard() {
  const { role } = useRole();
  return role === "tenant_admin" || role === "tenant_master" ? (
    <FathomSettings />
  ) : null;
}
function FathomSettings() {
  const settings = useQuery(api.fathom.connection.settings, {});
  const connect = useAction(api.fathom.connection.connect);
  const replace = useAction(api.fathom.connection.replaceKey);
  const disconnect = useAction(api.fathom.connection.disconnect);
  const importDays = useAction(api.fathom.connection.importLast30Days);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useForm({
    resolver: standardSchemaResolver(keySchema),
    defaultValues: { apiKey: "" },
  });
  const connected = settings?.connection?.status === "connected";
  async function submit(values: z.infer<typeof keySchema>) {
    setBusy(true);
    try {
      await (connected ? replace : connect)(values);
      form.reset();
      setReplacing(false);
      toast.success("Fathom connected");
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          "Could not connect Fathom. Check the key and try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await action();
      toast.success(message);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not update Fathom."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Fathom</CardTitle>
          {settings?.connection && (
            <Badge variant={connected ? "secondary" : "outline"}>
              {settings.connection.status.replaceAll("_", " ")}
            </Badge>
          )}
        </div>
        <CardDescription>
          Connect your sales team&apos;s recordings to their meetings.
          Transcripts stay for 90 days; summaries stay with the call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!settings ? (
          <Skeleton
            role="status"
            aria-label="Loading Fathom connection"
            className="h-24"
          />
        ) : (
          <>
            {settings.connection?.keyLast4 && (
              <p className="text-sm">
                API key ending in{" "}
                <span className="font-mono">
                  {settings.connection.keyLast4}
                </span>
              </p>
            )}
            {(!connected || replacing) && (
              <form onSubmit={form.handleSubmit(submit)} className="space-y-3">
                <FieldGroup>
                  <Controller
                    control={form.control}
                    name="apiKey"
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel htmlFor="fathom-api-key">
                          Fathom API key
                        </FieldLabel>
                        <Input
                          {...field}
                          id="fathom-api-key"
                          type="password"
                          autoComplete="off"
                          aria-invalid={fieldState.invalid}
                        />
                        <FieldDescription>
                          Use a seat with access to the Sales team. External
                          meetings should be shared with User&apos;s Team, with
                          the full lock.
                        </FieldDescription>
                        <FieldError errors={[fieldState.error]} />
                      </Field>
                    )}
                  />
                </FieldGroup>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy}>
                    {busy
                      ? "Connecting…"
                      : connected
                        ? "Replace key"
                        : "Connect Fathom"}
                  </Button>
                  {replacing && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setReplacing(false);
                        form.reset();
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}
            {settings.connection?.lastError && (
              <p role="alert" className="text-sm text-destructive">
                {settings.connection.lastError}
              </p>
            )}
            {settings.warnings.length > 0 && (
              <ul className="space-y-2 rounded-lg border p-3 text-sm text-muted-foreground">
                {settings.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            )}
            {connected && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || settings.connection?.importing}
                    onClick={() =>
                      run(
                        () => importDays({}),
                        "Import queued. Recordings will arrive shortly.",
                      )
                    }
                  >
                    {settings.connection?.importing
                      ? "Importing…"
                      : "Import last 30 days"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setReplacing(true)}
                  >
                    Replace key
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      run(() => disconnect({}), "Fathom disconnected")
                    }
                  >
                    Disconnect
                  </Button>
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Members</h3>
                  <p className="text-xs text-muted-foreground">
                    Link personal Fathom addresses to Magnus users, or ignore
                    members who do not take sales calls.
                  </p>
                  <ul className="divide-y">
                    {settings.members.map((member) => (
                      <MemberRow
                        key={member.memberId}
                        member={member}
                        users={settings.users}
                      />
                    ))}
                  </ul>
                </div>
              </>
            )}
            <UnmatchedRecordingList
              recordings={settings.unmatched}
              capped={settings.capped}
            />
            {settings.capped && (
              <p className="text-xs text-muted-foreground">
                Member and recording lists are partial.
              </p>
            )}
            {!!settings.connection?.droppedCount && (
              <p className="text-xs text-muted-foreground">
                {settings.connection.droppedCount} ignored or internal-only
                calls discarded.
              </p>
            )}
          </>
        )}
        <SecondOpinionSettingsRow />
      </CardContent>
    </Card>
  );
}
function MemberRow({
  member,
  users,
}: {
  member: Settings["members"][number];
  users: Settings["users"];
}) {
  const link = useMutation(api.fathom.connection.linkMember);
  const [busy, setBusy] = useState(false);
  async function change(value: string) {
    setBusy(true);
    try {
      await link({
        memberId: member.memberId,
        userId:
          value === "unlinked" || value === "ignored"
            ? undefined
            : (value as Id<"users">),
        ignored: value === "ignored",
      });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not link member."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.name ?? member.email}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {member.email}
          {member.viewAccessLevel
            ? ` · ${member.viewAccessLevel.replaceAll("_", " ")}`
            : ""}
        </p>
      </div>
      <Select
        disabled={busy}
        value={member.ignored ? "ignored" : (member.userId ?? "unlinked")}
        onValueChange={change}
      >
        <SelectTrigger aria-label={`Magnus user for ${member.email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="unlinked">Unlinked</SelectItem>
            <SelectItem value="ignored">Ignored</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.userId} value={u.userId}>
                {u.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </li>
  );
}
