"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { CopyIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { CARD, CardHead, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { NoteLine, StatusWord } from "../settings-ui";

/** NAME · KEY · CREATED · LAST USED · STATUS · revoke, from the card's `@2xl`. */
const KEY_GRID =
  "@2xl/keys:grid @2xl/keys:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,0.9fr)_5.5rem_4.5rem] @2xl/keys:items-center @2xl/keys:gap-x-4";

/** "Oct 12", or "Oct 12, 2025" outside this year; with the time when asked. */
function formatDate(timestamp: number, withTime = false) {
  const sameYear = new Date(timestamp).getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(timestamp));
}

/**
 * Keys for `/api/v1`, the read-only metrics API an outside dashboard uses
 * (docs/api/openapi.yaml). Owners and admins create and revoke them; the
 * secret shows once.
 */
export function ApiKeysCard() {
  const { hasPermission } = useRole();
  const canManage = hasPermission("settings:manage");
  const keys = useQuery(api.analytics.api.keys.list, canManage ? {} : "skip");
  const createKey = useAction(api.analytics.api.keys.create);
  const revokeKey = useMutation(api.analytics.api.keys.revoke);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ keyId: string; name: string } | null>(null);

  if (!canManage) return null;

  const handleCreate = async () => {
    setCreating(true);
    try {
      const created = await createKey({ name });
      setCreateOpen(false);
      setName("");
      setNewKey(created.key);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not create the key."));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeKey({ keyId: revoking.keyId });
      toast.success(`Revoked ${revoking.name}.`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not revoke the key."));
    } finally {
      setRevoking(null);
    }
  };

  const copyKey = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    toast.success("Key copied.");
  };

  const activeCount = keys?.filter((key) => key.revokedAt === null).length ?? 0;

  return (
    <section aria-label="API keys" className={cn(CARD, "@container/keys")}>
      <CardHead title="API keys" meta={keys && keys.length > 0 ? `${activeCount} active` : undefined}>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          New key
        </Button>
      </CardHead>
      <div className="border-b border-border px-4 py-2.5">
        <NoteLine>
          <HelpTip tip="Leads, qualifications, calls, deals and cash. History refreshes every 6 hours; today's numbers are live.">
            Read-only access to this workspace&apos;s metrics
          </HelpTip>{" "}
          for an outside dashboard. Keys can&apos;t read people or change anything.
        </NoteLine>
      </div>

      {keys === undefined ? (
        <div role="status" aria-label="Loading API keys">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex h-11 items-center gap-4 border-b border-border px-4 last:border-b-0">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : keys.length === 0 ? (
        <SectionEmpty title="No API keys yet.">
          Make one for each dashboard that reads this workspace&apos;s metrics, so each can be revoked alone.
        </SectionEmpty>
      ) : (
        <div role="table" aria-label="API keys">
          <div role="row" className={cn("hidden h-8 border-b border-border px-4", KEY_GRID)}>
            <span role="columnheader" className={LABEL}>
              Name
            </span>
            <span role="columnheader" className={LABEL}>
              <HelpTip tip="The start of the key, enough to tell keys apart. The full key showed once, when it was made.">
                Key
              </HelpTip>
            </span>
            <span role="columnheader" className={LABEL}>
              Created
            </span>
            <span role="columnheader" className={LABEL}>
              <HelpTip tip="The last request that used this key.">Last used</HelpTip>
            </span>
            <span role="columnheader" className={LABEL}>
              Status
            </span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {keys.map((key) => {
            const revoked = key.revokedAt !== null;
            return (
              <div
                key={key.keyId}
                role="row"
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-border px-4 py-2 last:border-b-0 @2xl/keys:min-h-11 @2xl/keys:py-1.5",
                  KEY_GRID,
                )}
              >
                <span
                  role="cell"
                  className={cn("min-w-0 truncate text-sm font-medium", revoked && "text-muted-foreground line-through")}
                >
                  {key.name}
                </span>
                <span role="cell" className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end @2xl/keys:hidden">
                  <StatusWord tone="muted">{revoked ? "Revoked" : "Active"}</StatusWord>
                </span>
                <span
                  role="cell"
                  translate="no"
                  className="col-span-2 min-w-0 truncate font-mono text-[12.5px] text-muted-foreground @2xl/keys:col-span-1"
                >
                  {key.prefix}
                </span>
                <span role="cell" className="col-span-2 min-w-0 truncate text-[13px] text-muted-foreground @2xl/keys:col-span-1">
                  <span className="sr-only @2xl/keys:hidden">Created </span>
                  <span className="font-condensed text-[14px] text-foreground tabular-nums">{formatDate(key.createdAt)}</span>
                  {key.createdByName ? ` by ${key.createdByName}` : ""}
                  <span className="@2xl/keys:hidden">
                    {" · last used "}
                    {key.lastUsedAt === null ? "never" : formatDate(key.lastUsedAt, true)}
                  </span>
                </span>
                <span role="cell" className="hidden text-[13px] text-muted-foreground @2xl/keys:block">
                  {key.lastUsedAt === null ? (
                    "Never"
                  ) : (
                    <span className="font-condensed text-[14px] text-foreground tabular-nums">
                      {formatDate(key.lastUsedAt, true)}
                    </span>
                  )}
                </span>
                <span role="cell" className="hidden @2xl/keys:block">
                  <StatusWord tone="muted">{revoked ? "Revoked" : "Active"}</StatusWord>
                </span>
                <span role="cell" className="col-span-2 flex justify-start @2xl/keys:col-span-1 @2xl/keys:justify-end">
                  {revoked ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="-ml-2 text-danger-ink hover:text-danger-ink @2xl/keys:ml-0"
                      aria-label={`Revoke ${key.name}`}
                      onClick={() => setRevoking({ keyId: key.keyId, name: key.name })}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>Name it after the dashboard or member who will use it.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="api-key-name" className="text-[13px] font-normal text-muted-foreground">
              Name
            </FieldLabel>
            <Input
              id="api-key-name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="Sales dashboard"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button className="font-semibold" onClick={handleCreate} disabled={creating || name.trim().length === 0}>
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newKey !== null} onOpenChange={(open) => !open && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your key</DialogTitle>
            <DialogDescription className="flex items-start gap-2 text-warning-ink">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                This is the only time the key is shown. Store it somewhere safe; if it&apos;s lost, revoke it and create
                another.
              </span>
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="api-key-value" className="text-[13px] font-normal text-muted-foreground">
              Key
            </FieldLabel>
            <div className="flex gap-2">
              <Input id="api-key-value" readOnly value={newKey ?? ""} className="font-mono text-xs" translate="no" />
              <Button variant="outline" onClick={copyKey}>
                <CopyIcon aria-hidden="true" />
                Copy
              </Button>
            </div>
            <FieldDescription className="text-[13px]">
              Send it as <code className="font-mono text-[12.5px]">Authorization: Bearer &lt;key&gt;</code>.
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewKey(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this key stops working on its next request. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleRevoke}>
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
