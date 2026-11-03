"use client";

import { useId, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import posthog from "posthog-js";
import { CopyIcon, ExternalLinkIcon, KeyRoundIcon, RotateCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { generatePortalPassword } from "./portal/generate-password";
import {
  cardButton,
  ConfirmStrip,
  ICON_BUTTON,
  PortalCard,
  PortalRow,
  RowText,
} from "./portal/portal-card";
import { SetPortalPasswordDialog } from "./set-portal-password-dialog";

type Pending = "toggle" | "slug" | "ttl" | "password" | null;
type Confirm = "path" | "password" | null;

const SESSION_CHOICES = [900, 3600, 4 * 3600, 8 * 3600, 12 * 3600, 24 * 3600];

function sessionLabel(seconds: number) {
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round((seconds / 3600) * 100) / 100;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

async function copyText(text: string, success: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Could not copy. Select it and copy by hand.");
  }
}

/**
 * Concept C's Access card: the live switch, the portal path (copy, open,
 * rotate), the session length and the password. Rotations confirm in place
 * and say who they affect; a generated password is shown once.
 */
export function PortalAccessCard() {
  const config = useQuery(api.linkPortal.configQueries.getPortalConfigForSettings, {});
  const closers = useQuery(api.attribution.dmClosers.listDmClosers, {});
  const setPortalEnabled = useMutation(api.linkPortal.configMutations.setPortalEnabled);
  const updateSessionTtl = useMutation(api.linkPortal.configMutations.updateSessionTtl);
  const rotateSlug = useAction(api.linkPortal.slugActions.rotatePortalSlug);
  const rotatePassword = useAction(api.linkPortal.passwordActions.rotatePortalPassword);
  const [pending, setPending] = useState<Pending>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const sessionId = useId();

  if (config === undefined) return <PortalAccessSkeleton />;

  const isEnabled = config?.isEnabled ?? false;
  const hasPassword = config?.passwordSetAt !== undefined;
  const portalPath = config ? `/dm-links/${config.publicSlug}` : null;
  const activeClosers = closers?.filter((closer) => closer.isActive).length ?? null;
  const closersWord =
    activeClosers === null ? "every DM closer" : activeClosers === 1 ? "the 1 DM closer" : `all ${activeClosers} DM closers`;
  const busy = pending !== null;
  const ttl = config?.sessionTtlSeconds ?? 8 * 3600;
  const sessionChoices = SESSION_CHOICES.includes(ttl) ? SESSION_CHOICES : [...SESSION_CHOICES, ttl].sort((a, b) => a - b);

  async function toggle(next: boolean) {
    setPending("toggle");
    try {
      await setPortalEnabled({ isEnabled: next });
      posthog.capture("link_portal_toggled", { enabled: next });
      toast.success(next ? "Portal is live" : "Portal is off. Every session signed out.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not update the portal"));
    } finally {
      setPending(null);
    }
  }

  async function confirmRotatePath() {
    setPending("slug");
    try {
      await rotateSlug({});
      setConfirm(null);
      posthog.capture("link_portal_path_rotated");
      toast.success("Path rotated. The old link stopped working.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not rotate the portal path"));
    } finally {
      setPending(null);
    }
  }

  async function changeSession(seconds: number) {
    const previous = ttl;
    if (seconds === previous) return;
    setPending("ttl");
    try {
      await updateSessionTtl({ sessionTtlSeconds: seconds });
      toast.success(`Sessions now last ${sessionLabel(seconds)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void updateSessionTtl({ sessionTtlSeconds: previous }).catch((error: unknown) => {
              reportClientError(error, { flow: "link_portal_session_undo" });
              toast.error(getErrorMessage(error, "Could not undo"));
            });
          },
        },
      });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not save the session length"));
    } finally {
      setPending(null);
    }
  }

  async function confirmRotatePassword() {
    const password = generatePortalPassword();
    setPending("password");
    try {
      await rotatePassword({ password });
      setConfirm(null);
      setNewPassword(password);
      posthog.capture("link_portal_password_rotated", { generated: true });
      toast.success(hasPassword ? "Password rotated. Every session signed out." : "Password set");
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not rotate the password"));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <PortalCard id="card-access" title="Access" meta="Who can open the portal, and for how long">
        <PortalRow>
          <RowText
            title={
              <span className="inline-flex items-center gap-[5px] font-condensed text-[12px] leading-none font-bold tracking-[0.08em] uppercase">
                <span aria-hidden className={cn("size-1.5 rounded-full", isEnabled ? "bg-primary" : "bg-muted-foreground/60")} />
                {isEnabled ? "Portal is live" : "Portal is off"}
              </span>
            }
            detail={
              config === null || !hasPassword
                ? "Set a password first. Then turn it on."
                : "Turning it off signs out every open session."
            }
          />
          {pending === "toggle" ? <Spinner /> : null}
          <Switch
            checked={isEnabled}
            disabled={!config || !hasPassword || busy}
            aria-label="Portal on or off"
            onCheckedChange={(next) => void toggle(next)}
            className="data-[state=checked]:bg-foreground"
          />
        </PortalRow>

        <PortalRow className={cn(confirm === "path" && "border-b-0")}>
          <div className="min-w-0 flex-1">
            <div className="mb-[5px] text-[12px] text-muted-foreground">Portal path</div>
            <div className="flex h-8 min-w-0 items-center gap-1 rounded-[7px] border border-input bg-background pr-1 pl-2.5 font-mono text-[12.5px]">
              <span className="min-w-0 flex-1 truncate" translate="no" title={portalPath ?? undefined}>
                {portalPath ?? "Set a password to create the portal path"}
              </span>
              {portalPath ? (
                <>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    title="Copy link"
                    aria-label="Copy the portal link"
                    onClick={() => void copyText(`${window.location.origin}${portalPath}`, "Portal link copied")}
                  >
                    <CopyIcon aria-hidden className="size-3.5" />
                  </button>
                  <a
                    href={portalPath}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={ICON_BUTTON}
                    title="Open the portal"
                    aria-label="Open the portal in a new tab"
                  >
                    <ExternalLinkIcon aria-hidden className="size-3.5" />
                  </a>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    title="Rotate path"
                    aria-label="Rotate the portal path"
                    aria-expanded={confirm === "path"}
                    disabled={busy}
                    onClick={() => setConfirm(confirm === "path" ? null : "path")}
                  >
                    <RotateCwIcon aria-hidden className="size-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </PortalRow>
        {confirm === "path" ? (
          <ConfirmStrip
            actions={
              <>
                <button type="button" className={cardButton({ size: "sm" })} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  autoFocus
                  className={cardButton({ size: "sm", tone: "ink" })}
                  disabled={busy}
                  onClick={() => void confirmRotatePath()}
                >
                  {pending === "slug" ? <Spinner className="size-3" /> : null}
                  Rotate path
                </button>
              </>
            }
          >
            Rotating breaks the old link for {closersWord} right away.
          </ConfirmStrip>
        ) : null}

        <PortalRow className={cn(confirm === "path" && "border-t border-border")}>
          <RowText title={<label htmlFor={sessionId}>Session length</label>} detail="Between 15 minutes and 24 hours." />
          {pending === "ttl" ? <Spinner /> : null}
          <select
            id={sessionId}
            value={ttl}
            disabled={!config || busy}
            onChange={(event) => void changeSession(Number(event.target.value))}
            className="h-8 min-w-0 appearance-none rounded-[7px] border border-input bg-card bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2212%22%20height=%2212%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%234f596b%22%20stroke-width=%222.2%22%3E%3Cpath%20d=%22m6%209%206%206%206-6%22/%3E%3C/svg%3E')] bg-[position:right_9px_center] bg-no-repeat pr-7 pl-2.5 text-[13.5px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            {sessionChoices.map((seconds) => (
              <option key={seconds} value={seconds}>
                {sessionLabel(seconds)}
              </option>
            ))}
          </select>
        </PortalRow>

        <PortalRow className="border-b-0">
          <KeyRoundIcon aria-hidden className="size-4 flex-none text-muted-foreground" />
          <RowText
            title="Password"
            detail={
              config?.passwordSetAt === undefined
                ? "Not set yet"
                : `${config.passwordRotatedAt ? "Rotated" : "Set"} ${formatTimestamp(config.passwordRotatedAt ?? config.passwordSetAt)}`
            }
          />
          <button
            type="button"
            className={cardButton()}
            disabled={busy}
            aria-expanded={confirm === "password"}
            onClick={() => setConfirm(confirm === "password" ? null : "password")}
          >
            <RotateCwIcon aria-hidden className="size-3.5" />
            {hasPassword ? "Rotate" : "Set password"}
          </button>
        </PortalRow>
        {confirm === "password" ? (
          <ConfirmStrip
            actions={
              <>
                <button type="button" className={cardButton({ size: "sm" })} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={cardButton({ size: "sm" })}
                  onClick={() => {
                    setConfirm(null);
                    setDialogOpen(true);
                  }}
                >
                  Choose my own…
                </button>
                <button
                  type="button"
                  autoFocus
                  className={cardButton({ size: "sm", tone: "ink" })}
                  disabled={busy}
                  onClick={() => void confirmRotatePassword()}
                >
                  {pending === "password" ? <Spinner className="size-3" /> : null}
                  {hasPassword ? "Rotate password" : "Set password"}
                </button>
              </>
            }
          >
            {hasPassword
              ? "Every open session signs out. DM closers need the new password to get back in."
              : "We’ll make a password you can share with your DM closers."}
          </ConfirmStrip>
        ) : null}
        {newPassword ? (
          <div className="cov-row-in flex flex-wrap items-center gap-2 border-t border-border bg-stage-booked/[0.07] px-4 py-2.5 text-[13px]">
            <span className="whitespace-nowrap">New password</span>
            <code
              translate="no"
              className="rounded-[5px] border border-border bg-card px-2 py-[3px] font-mono text-[14px] font-semibold tracking-[0.02em] whitespace-nowrap select-all"
            >
              {newPassword}
            </code>
            <button
              type="button"
              className={cardButton({ size: "sm" })}
              onClick={() => void copyText(newPassword, "Password copied")}
            >
              <CopyIcon aria-hidden className="size-3" />
              Copy
            </button>
            <span className="ml-auto text-[12px] text-muted-foreground">Shown once</span>
            <button type="button" className={ICON_BUTTON} aria-label="Hide the new password" onClick={() => setNewPassword(null)}>
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : null}
      </PortalCard>

      <SetPortalPasswordDialog open={dialogOpen} hasExistingPassword={hasPassword} onOpenChange={setDialogOpen} />
    </>
  );
}

function PortalAccessSkeleton() {
  return (
    <PortalCard title="Access" meta="Who can open the portal, and for how long">
      <div role="status" aria-label="Loading portal access">
        <PortalRow>
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </PortalRow>
        <PortalRow>
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-full" />
          </div>
        </PortalRow>
        <PortalRow>
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-8 w-24" />
        </PortalRow>
        <PortalRow>
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-8 w-20" />
        </PortalRow>
      </div>
    </PortalCard>
  );
}
