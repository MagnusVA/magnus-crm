"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { CopyIcon, KeyRoundIcon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/errors";

function formatDate(timestamp: number | null) {
  if (timestamp === null) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon aria-hidden="true" className="size-4" />
          API keys
        </CardTitle>
        <CardDescription>
          Let an outside dashboard read this workspace&apos;s metrics: leads, qualifications, calls, deals and cash.
          History refreshes every 6 hours; today&apos;s numbers are live. Keys can&apos;t read people or change anything.
        </CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Create key
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {keys === undefined ? (
          <Skeleton className="h-16 w-full" />
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.keyId}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs">{key.prefix}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(key.createdAt)}
                    {key.createdByName ? ` by ${key.createdByName}` : ""}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(key.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    {key.revokedAt !== null ? (
                      <Badge variant="secondary">Revoked</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking({ keyId: key.keyId, name: key.name })}>
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>Name it after the dashboard or person who will use it.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
            <Input
              id="api-key-name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="Sales dashboard"
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || name.trim().length === 0}>
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newKey !== null} onOpenChange={(open) => !open && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your key</DialogTitle>
            <DialogDescription>
              This is the only time the key is shown. Store it somewhere safe; if it&apos;s lost, revoke it and create
              another.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="api-key-value">Key</FieldLabel>
            <Input id="api-key-value" readOnly value={newKey ?? ""} className="font-mono text-xs" />
            <FieldDescription>Send it as `Authorization: Bearer &lt;key&gt;`.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={copyKey}>
              <CopyIcon aria-hidden="true" />
              Copy
            </Button>
            <Button onClick={() => setNewKey(null)}>Done</Button>
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
            <AlertDialogAction onClick={handleRevoke}>Revoke key</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
