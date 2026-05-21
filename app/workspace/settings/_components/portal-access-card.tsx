"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  CopyIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { OneTimePasswordDialog } from "./one-time-password-dialog";

type PendingAction = "toggle" | "slug" | "password" | "ttl" | null;
type PasswordResult = {
  portalUrlPath: string;
  plainPassword: string;
};

function formatTimestamp(timestamp: number | undefined) {
  if (timestamp === undefined) {
    return "Never";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatTtlHours(sessionTtlSeconds: number | undefined) {
  if (sessionTtlSeconds === undefined) {
    return "8";
  }
  const hours = sessionTtlSeconds / 3600;
  return Number.isInteger(hours) ? String(hours) : String(hours.toFixed(2));
}

async function copyPortalPath(portalPath: string) {
  try {
    await navigator.clipboard.writeText(portalPath);
    toast.success("Portal path copied");
  } catch {
    toast.error("Could not copy portal path");
  }
}

export function PortalAccessCard() {
  const config = useQuery(
    api.linkPortal.configQueries.getPortalConfigForSettings,
    {},
  );
  const setPortalEnabled = useMutation(
    api.linkPortal.configMutations.setPortalEnabled,
  );
  const updateSessionTtl = useMutation(
    api.linkPortal.configMutations.updateSessionTtl,
  );
  const rotateSlug = useAction(api.linkPortal.slugActions.rotatePortalSlug);
  const rotatePassword = useAction(
    api.linkPortal.passwordActions.rotatePortalPassword,
  );
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [ttlHours, setTtlHours] = useState("8");
  const [passwordResult, setPasswordResult] = useState<PasswordResult | null>(
    null,
  );

  useEffect(() => {
    setTtlHours(formatTtlHours(config?.sessionTtlSeconds));
  }, [config?.sessionTtlSeconds]);

  const portalPath = config ? `/dm-links/${config.publicSlug}` : "";
  const ttlSecondsFromInput = useMemo(() => {
    const hours = Number(ttlHours);
    if (!Number.isFinite(hours)) {
      return null;
    }
    return Math.round(hours * 3600);
  }, [ttlHours]);
  const ttlIsDirty =
    config !== null &&
    config !== undefined &&
    ttlSecondsFromInput !== null &&
    ttlSecondsFromInput !== config.sessionTtlSeconds;
  const isBusy = pendingAction !== null;

  async function handlePortalToggle(isEnabled: boolean) {
    setPendingAction("toggle");
    try {
      await setPortalEnabled({ isEnabled });
      toast.success(isEnabled ? "Portal enabled" : "Portal disabled");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update portal",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRotateSlug() {
    setPendingAction("slug");
    try {
      const result = await rotateSlug({});
      toast.success(`Portal path rotated to ${result.portalUrlPath}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not rotate portal path",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRotatePassword() {
    setPendingAction("password");
    try {
      const result = await rotatePassword({});
      setPasswordResult({
        portalUrlPath: result.portalUrlPath,
        plainPassword: result.plainPassword,
      });
      toast.success("Portal password generated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not rotate password",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function handleSaveTtl() {
    if (ttlSecondsFromInput === null) {
      toast.error("Enter a valid session duration");
      return;
    }
    setPendingAction("ttl");
    try {
      await updateSessionTtl({ sessionTtlSeconds: ttlSecondsFromInput });
      toast.success("Session duration updated");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update session duration",
      );
    } finally {
      setPendingAction(null);
    }
  }

  if (config === undefined) {
    return <Skeleton className="h-80 w-full" />;
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>DM Link Portal</CardTitle>
          <CardDescription>
            Tenant-wide password access for external DM link generation.
          </CardDescription>
          <CardAction>
            <Badge variant={config?.isEnabled ? "secondary" : "outline"}>
              {config?.isEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {config === null ? (
            <Alert>
              <ShieldCheckIcon data-icon="inline-start" />
              <AlertTitle>Portal access is not configured</AlertTitle>
              <AlertDescription>
                Generate a password to create the private portal path and access
                credentials.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="portal-url">Portal path</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="portal-url"
                    value={portalPath}
                    readOnly
                    disabled={!portalPath}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Copy portal path"
                    disabled={!portalPath}
                    onClick={() => copyPortalPath(portalPath)}
                  >
                    <CopyIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Rotate portal path"
                    disabled={!config || isBusy}
                    onClick={handleRotateSlug}
                  >
                    {pendingAction === "slug" ? <Spinner /> : <RotateCcwIcon />}
                  </Button>
                </div>
              </Field>

              <Field>
                <FieldLabel htmlFor="portal-session-duration">
                  Session duration
                </FieldLabel>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="portal-session-duration"
                    type="number"
                    inputMode="decimal"
                    min="0.25"
                    max="24"
                    step="0.25"
                    value={ttlHours}
                    disabled={!config || isBusy}
                    onChange={(event) => setTtlHours(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!config || !ttlIsDirty || isBusy}
                    onClick={handleSaveTtl}
                  >
                    {pendingAction === "ttl" ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    Save Duration
                  </Button>
                </div>
                <FieldDescription>
                  Measured in hours. Backend bounds are 0.25 to 24 hours.
                </FieldDescription>
              </Field>
            </FieldGroup>

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/25 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Public access</p>
                  <p className="text-xs text-muted-foreground">
                    Disabling revokes active portal sessions.
                  </p>
                </div>
                <Switch
                  checked={config?.isEnabled ?? false}
                  disabled={!config || isBusy}
                  aria-label="Toggle public portal access"
                  onCheckedChange={handlePortalToggle}
                />
              </div>

              <div className="flex flex-col gap-1 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Password set</span>
                  <span>{formatTimestamp(config?.passwordSetAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Last rotated</span>
                  <span>
                    {formatTimestamp(
                      config?.passwordRotatedAt ?? config?.passwordSetAt,
                    )}
                  </span>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={handleRotatePassword}
              >
                {pendingAction === "password" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <KeyRoundIcon data-icon="inline-start" />
                )}
                Generate or Rotate Password
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <OneTimePasswordDialog
        open={passwordResult !== null}
        password={passwordResult?.plainPassword ?? ""}
        portalUrlPath={passwordResult?.portalUrlPath ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            setPasswordResult(null);
          }
        }}
      />
    </>
  );
}
