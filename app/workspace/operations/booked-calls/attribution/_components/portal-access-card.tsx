"use client";

import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SetPortalPasswordDialog } from "./set-portal-password-dialog";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type PendingAction = "toggle" | "slug" | "ttl" | null;

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
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [ttlHours, setTtlHours] = useState(() =>
    formatTtlHours(config?.sessionTtlSeconds),
  );
  const [syncedTtlSeconds, setSyncedTtlSeconds] = useState(
    config?.sessionTtlSeconds,
  );
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);

  // Reload the TTL input whenever the saved TTL changes.
  if (config?.sessionTtlSeconds !== syncedTtlSeconds) {
    setSyncedTtlSeconds(config?.sessionTtlSeconds);
    setTtlHours(formatTtlHours(config?.sessionTtlSeconds));
  }

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
        getErrorMessage(error, "Could not update portal"),
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
        getErrorMessage(error, "Could not rotate portal path"),
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
        getErrorMessage(error, "Could not update session duration"),
      );
    } finally {
      setPendingAction(null);
    }
  }

  if (config === undefined) {
    return (
      <Skeleton
        className="h-96 w-full"
        role="status"
        aria-label="Loading portal access"
      />
    );
  }

  const isEnabled = config?.isEnabled ?? false;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Portal Access</CardTitle>
          <CardDescription>
            Password-protected page where external DM closers generate
            booking links.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {config === null ? (
            <Alert>
              <ShieldCheckIcon data-icon="inline-start" />
              <AlertTitle>Portal access is not configured</AlertTitle>
              <AlertDescription>
                Set a password to create the private portal path and access
                credentials.
              </AlertDescription>
            </Alert>
          ) : null}

          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border p-3",
              isEnabled
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "bg-muted/40",
            )}
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  isEnabled ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {isEnabled ? "Portal is live" : "Portal is off"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Turning it off signs out every active session.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {pendingAction === "toggle" ? <Spinner /> : null}
              <Switch
                checked={isEnabled}
                disabled={!config || isBusy}
                aria-label="Toggle public portal access"
                onCheckedChange={handlePortalToggle}
              />
            </div>
          </div>

          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="portal-url">Portal path</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="portal-url"
                  value={portalPath}
                  readOnly
                  disabled={!portalPath}
                  className="font-mono text-xs"
                  translate="no"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <InputGroupAddon align="inline-end">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton
                        size="icon-xs"
                        aria-label="Copy portal path"
                        disabled={!portalPath}
                        onClick={() => copyPortalPath(portalPath)}
                      >
                        <CopyIcon />
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent>Copy path</TooltipContent>
                  </Tooltip>
                  {portalPath && isEnabled ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <InputGroupButton
                          size="icon-xs"
                          aria-label="Open portal in a new tab"
                          asChild
                        >
                          <a
                            href={portalPath}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLinkIcon />
                          </a>
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent>Open portal</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton
                        size="icon-xs"
                        aria-label="Rotate portal path"
                        disabled={!config || isBusy}
                        onClick={handleRotateSlug}
                      >
                        {pendingAction === "slug" ? (
                          <Spinner />
                        ) : (
                          <RotateCcwIcon />
                        )}
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent>Rotate path</TooltipContent>
                  </Tooltip>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription>
                Rotating the path breaks the old one immediately.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="portal-session-duration">
                Session duration
              </FieldLabel>
              <div className="flex gap-2">
                <InputGroup>
                  <InputGroupInput
                    id="portal-session-duration"
                    type="number"
                    inputMode="decimal"
                    min="0.25"
                    max="24"
                    step="0.25"
                    value={ttlHours}
                    disabled={!config || isBusy}
                    className="tabular-nums"
                    onChange={(event) => setTtlHours(event.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>hours</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                <Button
                  type="button"
                  variant={ttlIsDirty ? "default" : "outline"}
                  disabled={!config || !ttlIsDirty || isBusy}
                  onClick={handleSaveTtl}
                >
                  {pendingAction === "ttl" ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  Save
                </Button>
              </div>
              <FieldDescription>
                Between 0.25 and 24 hours.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <KeyRoundIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 text-sm">
                <p className="font-medium">Password</p>
                <p className="text-xs text-muted-foreground">
                  {config?.passwordSetAt === undefined
                    ? "Not set"
                    : `${config.passwordRotatedAt ? "Rotated" : "Set"} ${formatTimestamp(
                        config.passwordRotatedAt ?? config.passwordSetAt,
                      )}`}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => setPasswordDialogOpen(true)}
            >
              {config?.passwordSetAt ? "Rotate" : "Set Password"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <SetPortalPasswordDialog
        open={passwordDialogOpen}
        hasExistingPassword={config?.passwordSetAt !== undefined}
        onOpenChange={setPasswordDialogOpen}
      />
    </>
  );
}
