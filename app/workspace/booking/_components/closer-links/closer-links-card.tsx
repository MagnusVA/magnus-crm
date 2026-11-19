"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { TranslatableText } from "@/components/translatable-text";
import posthog from "@/lib/posthog-browser";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { cardButton, PortalCard, PortalRow } from "../portal/portal-card";

type CloserLinksData = FunctionReturnType<typeof api.bookingSetup.closerLinks.listCloserLinks>;
type CloserRow = CloserLinksData["closers"][number];
type CalendarOption = FunctionReturnType<typeof api.bookingSetup.closerLinks.listCloserCalendarOptions>[number];

const PASTE = "paste";

const INPUT =
  "h-8 w-full min-w-0 rounded-[7px] border border-input bg-card px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-primary-ink focus-visible:ring-3 focus-visible:ring-primary-ink/20";

/** A Calendly URL without its host: "/marco-ptdom/sales-call". */
export function shortLinkPath(url: string) {
  try {
    return new URL(url).pathname.replace(/\/+$/g, "") || url;
  } catch {
    return url;
  }
}

/** Options the closer link can use: Ready, or Ready once saved. */
function isSelectable(option: CalendarOption) {
  return option.disabledReason === null;
}

/**
 * The phone closers card: each active phone closer's link, its status, the
 * "In portal" switch, and an editor that opens under the row.
 */
export function CloserLinksCard({ closers }: { closers: CloserRow[] }) {
  const setInPortal = useMutation(api.bookingSetup.closerLinks.setCloserLinkInPortal);
  const [editing, setEditing] = useState<Id<"users"> | null>(null);
  const [toggling, setToggling] = useState<Id<"users"> | null>(null);
  const ready = closers.filter((closer) => closer.status === "ready").length;

  async function togglePortal(closer: CloserRow, next: boolean) {
    setToggling(closer.userId);
    try {
      await setInPortal({ userId: closer.userId, inPortal: next });
      posthog.capture("closer_link_portal_toggled", { inPortal: next });
      toast.success(next ? `${closer.name} is in the portal` : `${closer.name} is out of the portal`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not update the portal"));
    } finally {
      setToggling(null);
    }
  }

  return (
    <PortalCard
      id="card-closer-links"
      title="Phone closer links"
      meta={closers.length ? `${ready} of ${closers.length} ready` : undefined}
    >
      {closers.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted-foreground">
          No active phone closers. Add one in{" "}
          <Link href="/workspace/team" className="font-medium text-foreground underline-offset-2 hover:underline">
            Team
          </Link>
          .
        </p>
      ) : (
        <ul aria-label="Phone closers">
          {closers.map((closer) => {
            const open = editing === closer.userId;
            const isReady = closer.status === "ready";
            // A paused opt-in can always be switched off.
            const canToggle = isReady || closer.inPortal || closer.portalPaused;
            return (
              <li key={closer.userId} className="border-b border-border last:border-b-0">
                <PortalRow className="flex-wrap border-b-0 py-2">
                  <MemberAvatar identity={closer.avatar} />
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="truncate text-[13.5px] font-medium">{closer.name}</div>
                    {closer.personalEventTypeUri ? (
                      <div
                        className="truncate font-mono text-[12px] text-muted-foreground"
                        translate="no"
                        title={closer.personalEventTypeUri}
                      >
                        {shortLinkPath(closer.personalEventTypeUri)}
                      </div>
                    ) : (
                      <div className="text-[12px] text-muted-foreground">No link yet</div>
                    )}
                  </div>
                  <span
                    className={cn(
                      "inline-flex max-w-[220px] items-center gap-[6px] text-[12.5px] font-medium",
                      isReady ? "text-stage-booked-ink" : "text-warning-ink",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn("size-1.5 flex-none rounded-full", isReady ? "bg-stage-booked" : "bg-warning")}
                    />
                    <span className="truncate" title={closer.statusLabel}>
                      {closer.statusLabel}
                    </span>
                  </span>
                  <label
                    className={cn(
                      "flex items-center gap-2 text-[12.5px] text-muted-foreground",
                      !canToggle && "cursor-not-allowed",
                    )}
                    title={
                      closer.portalPaused
                        ? "Switched on, but the DM portal hides this closer until their link is Ready"
                        : canToggle
                          ? undefined
                          : "Needs a Ready link first"
                    }
                  >
                    {toggling === closer.userId ? <Spinner className="size-3" /> : null}
                    {closer.portalPaused ? (
                      <span className="text-warning-ink">
                        <TranslatableText>Hidden until Ready</TranslatableText>
                      </span>
                    ) : (
                      <TranslatableText>In portal</TranslatableText>
                    )}
                    <Switch
                      checked={closer.inPortal || closer.portalPaused}
                      disabled={!canToggle || toggling !== null}
                      aria-label={
                        closer.portalPaused
                          ? `${closer.name} is switched on for the DM portal but hidden until their link is Ready`
                          : `Show ${closer.name} in the DM portal`
                      }
                      onCheckedChange={(next) => void togglePortal(closer, next)}
                      className="data-[state=checked]:bg-foreground"
                    />
                  </label>
                  <button
                    type="button"
                    className={cardButton({ size: "sm" })}
                    aria-expanded={open}
                    onClick={() => setEditing(open ? null : closer.userId)}
                  >
                    {closer.personalEventTypeUri ? "Edit" : "Set link"}
                  </button>
                </PortalRow>
                {open ? <CloserLinkEditor closer={closer} onDone={() => setEditing(null)} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </PortalCard>
  );
}

function defaultChoice(closer: CloserRow, options: CalendarOption[]): string {
  const current = options.find((option) => option.eventTypeConfigId === closer.linkEventTypeConfigId);
  if (current && isSelectable(current)) return current.eventTypeConfigId;
  return options.find(isSelectable)?.eventTypeConfigId ?? PASTE;
}

/** The editor under a closer's row: pick one of their event types, or paste a link. */
function CloserLinkEditor({ closer, onDone }: { closer: CloserRow; onDone: () => void }) {
  const setCloserLink = useMutation(api.bookingSetup.closerLinks.setCloserLink);
  const options = useQuery(api.bookingSetup.closerLinks.listCloserCalendarOptions, { userId: closer.userId });
  const ids = useId();
  const [picked, setChoice] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [saving, setSaving] = useState(false);

  const loading = options === undefined;
  // A pick a sync has since removed or disabled is cleared, so the admin picks again.
  const pickedOption = options?.find((option) => option.eventTypeConfigId === picked);
  const stillPickable = picked === PASTE || (pickedOption !== undefined && isSelectable(pickedOption));
  const choice = picked !== null ? (stillPickable ? picked : null) : loading ? null : defaultChoice(closer, options);
  const pasting = choice === PASTE;
  const canSave = !saving && choice !== null && (pasting ? pasted.trim().length > 0 : true);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const { status, statusLabel } = await setCloserLink(
        pasting
          ? { userId: closer.userId, url: pasted.trim() }
          : { userId: closer.userId, eventTypeConfigId: choice as Id<"eventTypeConfigs"> },
      );
      posthog.capture("closer_link_set", { source: pasting ? "pasted" : "picked" });
      toast.success(`${closer.name}’s link saved`, {
        description:
          status === "ready" || status === "program_from_link_off"
            ? undefined
            : `Used for follow-ups. Not a closer link yet: ${statusLabel}.`,
      });
      onDone();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not save the link"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="cov-row-in flex flex-col gap-2.5 border-t border-border bg-background px-4 py-3"
    >
      <p className="text-[12.5px] text-muted-foreground">
        Pick one of {closer.name}’s own event types: a one-on-one, or a round robin with only them as host. The same
        link is used for their follow-up and no-show reschedule links.
      </p>
      {closer.calendlyLinked ? null : (
        <p className="text-[12.5px] text-warning-ink">
          To put {closer.name} in the portal, link them to their Calendly member in{" "}
          <Link href="/workspace/team" className="font-medium underline underline-offset-2">
            Team
          </Link>
          . A pasted link still works for follow-ups.
        </p>
      )}
      {loading ? (
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Spinner className="size-3" /> Loading {closer.name}’s event types…
        </p>
      ) : (
      <RadioGroup value={choice ?? ""} onValueChange={setChoice} aria-label={`${closer.name}’s link`} className="gap-0">
        {options.map((option) => {
          const selectable = isSelectable(option);
          const current = option.eventTypeConfigId === closer.linkEventTypeConfigId;
          const id = `${ids}-${option.eventTypeConfigId}`;
          return (
            <label
              key={option.eventTypeConfigId}
              htmlFor={id}
              className={cn(
                "flex items-start gap-2.5 rounded-[7px] px-2 py-1.5",
                selectable ? "cursor-pointer hover:bg-card" : "cursor-not-allowed opacity-60",
              )}
            >
              <RadioGroupItem id={id} value={option.eventTypeConfigId} disabled={!selectable} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-medium">
                  {option.displayName}
                  {option.durationMinutes ? (
                    <span className="text-[12px] font-normal text-muted-foreground">{option.durationMinutes} min</span>
                  ) : null}
                  {option.pooled ? (
                    <span className="text-[12px] font-normal text-muted-foreground">Round robin, only them</span>
                  ) : null}
                  {current ? (
                    <span className="font-condensed text-[12px] leading-none font-bold tracking-[0.08em] text-muted-foreground uppercase">
                      Current
                    </span>
                  ) : null}
                </span>
                <span className="block truncate font-mono text-[12px] text-muted-foreground" translate="no">
                  {option.url ? shortLinkPath(option.url) : "No booking URL"}
                </span>
                {option.disabledReason === null ? null : (
                  <span className="block text-[12px] text-warning-ink">{option.disabledReason}</span>
                )}
              </span>
            </label>
          );
        })}
        <label
          htmlFor={`${ids}-paste`}
          className="flex cursor-pointer items-start gap-2.5 rounded-[7px] px-2 py-1.5 hover:bg-card"
        >
          <RadioGroupItem id={`${ids}-paste`} value={PASTE} className="mt-0.5" />
          <span className="text-[13.5px] font-medium">Paste a link instead</span>
        </label>
      </RadioGroup>
      )}
      {options?.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          No event types of {closer.name}’s are synced. Sync now in Booking → Event types, or paste their Calendly
          link.
        </p>
      ) : null}
      {pasting ? (
        <input
          autoFocus
          aria-label={`${closer.name}’s Calendly link`}
          placeholder="https://calendly.com/name/sales-call"
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onDone()}
          className={INPUT}
          translate="no"
        />
      ) : null}
      <div className="flex justify-end gap-1.5">
        <button type="button" className={cardButton({ size: "sm" })} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={cardButton({ size: "sm", tone: "ink" })} disabled={!canSave}>
          {saving ? <Spinner className="size-3" /> : null}
          <TranslatableText>Save link</TranslatableText>
        </button>
      </div>
    </form>
  );
}
