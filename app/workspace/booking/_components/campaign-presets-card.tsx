"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import posthog from "@/lib/posthog-browser";
import { PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import { CampaignPresetDialog } from "./campaign-preset-dialog";
import { cardButton, ICON_BUTTON, PortalCard, PortalCardFoot, PortalRow } from "./portal/portal-card";

type CampaignPreset = Doc<"linkPortalCampaignPresets">;

const INPUT =
  "h-8 w-full min-w-0 rounded-[7px] border border-input bg-card px-2.5 text-[14px] outline-none focus-visible:border-primary-ink focus-visible:ring-3 focus-visible:ring-primary-ink/20";

function utmFromLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * Concept C's Campaign presets card: the utm_campaign values DM closers pick
 * from. Make default, remove (with Undo), add inline; click a preset to edit
 * it. Changes reach the portal right away.
 */
export function CampaignPresetsCard() {
  const campaigns = useQuery(api.linkPortal.campaignQueries.listCampaignPresetsForSettings, {});
  const ensureDefaults = useMutation(api.linkPortal.campaignMutations.ensureDefaultCampaignPresets);
  const createPreset = useMutation(api.linkPortal.campaignMutations.createCampaignPreset);
  const setActive = useMutation(api.linkPortal.campaignMutations.setCampaignPresetActive);
  const setDefault = useMutation(api.linkPortal.campaignMutations.setCampaignPresetDefault);
  const seedRequestedRef = useRef(false);
  const [pendingId, setPendingId] = useState<Id<"linkPortalCampaignPresets"> | null>(null);
  const [editing, setEditing] = useState<CampaignPreset | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [utm, setUtm] = useState("");
  const [utmTouched, setUtmTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [freshId, setFreshId] = useState<string | null>(null);

  useEffect(() => {
    if (campaigns === undefined || seedRequestedRef.current) return;
    seedRequestedRef.current = true;
    void ensureDefaults({}).catch((error: unknown) => {
      toast.error(getErrorMessage(error, "Could not seed campaign presets"));
    });
  }, [campaigns, ensureDefaults]);

  if (campaigns === undefined) return <CampaignPresetsSkeleton />;

  const active = campaigns.filter((campaign) => campaign.isActive);
  const removed = campaigns.filter((campaign) => !campaign.isActive);

  async function run(id: Id<"linkPortalCampaignPresets">, work: () => Promise<void>, fallback: string) {
    setPendingId(id);
    try {
      await work();
    } catch (error) {
      toast.error(getErrorMessage(error, fallback));
    } finally {
      setPendingId(null);
    }
  }

  function makeDefault(campaign: CampaignPreset) {
    const previous = active.find((candidate) => candidate.isDefault);
    void run(
      campaign._id,
      async () => {
        await setDefault({ campaignPresetId: campaign._id });
        posthog.capture("link_portal_campaign_default_set");
        toast.success(`${campaign.label} is the default campaign`, {
          action: previous
            ? {
                label: "Undo",
                onClick: () => {
                  void setDefault({ campaignPresetId: previous._id }).catch((error: unknown) => {
                    reportClientError(error, { flow: "link_portal_campaign_default_undo" });
                    toast.error(getErrorMessage(error, "Could not undo"));
                  });
                },
              }
            : undefined,
        });
      },
      "Could not change the default campaign",
    );
  }

  function remove(campaign: CampaignPreset) {
    const wasDefault = campaign.isDefault;
    void run(
      campaign._id,
      async () => {
        await setActive({ campaignPresetId: campaign._id, isActive: false });
        posthog.capture("link_portal_campaign_removed");
        toast.success(`${campaign.label} removed from the portal`, {
          action: {
            label: "Undo",
            onClick: () => {
              // Removing the default promoted another preset; put it back too.
              void (async () => {
                await setActive({ campaignPresetId: campaign._id, isActive: true });
                if (wasDefault) await setDefault({ campaignPresetId: campaign._id });
              })().catch((error: unknown) => {
                reportClientError(error, { flow: "link_portal_campaign_remove_undo" });
                toast.error(getErrorMessage(error, "Could not undo"));
              });
            },
          },
        });
      },
      "Could not remove the campaign",
    );
  }

  function restore(campaign: CampaignPreset) {
    void run(
      campaign._id,
      async () => {
        await setActive({ campaignPresetId: campaign._id, isActive: true });
        toast.success(`${campaign.label} is back in the portal`);
      },
      "Could not bring the campaign back",
    );
  }

  function closeAdd() {
    setAdding(false);
    setLabel("");
    setUtm("");
    setUtmTouched(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const nextLabel = label.trim();
    const nextUtm = (utmTouched ? utm : utmFromLabel(label)).trim();
    if (!nextLabel || !nextUtm) {
      toast.error("A preset needs a label and a utm_campaign value");
      return;
    }
    setSaving(true);
    try {
      const id = await createPreset({ label: nextLabel, utmCampaign: nextUtm });
      posthog.capture("link_portal_campaign_created");
      setFreshId(typeof id === "string" ? id : null);
      toast.success(`${nextLabel} added. It’s in the portal now.`);
      closeAdd();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not add the preset"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PortalCard
        id="card-presets"
        title="Campaign presets"
        meta="utm_campaign values DM closers pick from"
        right={
          <button type="button" className={cardButton({ size: "sm" })} onClick={() => setAdding(true)} disabled={adding}>
            <PlusIcon aria-hidden className="size-[13px]" />
            Preset
          </button>
        }
      >
        <ul aria-label="Campaign presets">
          {active.map((campaign) => (
            <li key={campaign._id} className={cn(freshId === campaign._id && "cov-row-in")}>
              <PortalRow>
                <button
                  type="button"
                  onClick={() => setEditing(campaign)}
                  className="min-w-0 flex-1 rounded-[4px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Edit"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium">
                    <span className="truncate">{campaign.label}</span>
                    {campaign.isDefault ? (
                      <span className="ml-1.5 inline-flex flex-none items-center gap-[5px] font-condensed text-[12px] leading-none font-bold tracking-[0.08em] uppercase">
                        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/60" />
                        Default
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate font-mono text-[12px] text-muted-foreground" translate="no">
                    utm_campaign={campaign.utmCampaign}
                  </span>
                </button>
                {pendingId === campaign._id ? <Spinner /> : null}
                {campaign.isDefault ? null : (
                  <>
                    <button
                      type="button"
                      className={cardButton({ size: "sm" })}
                      disabled={pendingId !== null}
                      onClick={() => makeDefault(campaign)}
                    >
                      Make default
                    </button>
                    <button
                      type="button"
                      className={ICON_BUTTON}
                      title="Remove"
                      aria-label={`Remove ${campaign.label}`}
                      disabled={pendingId !== null || active.length <= 1}
                      onClick={() => remove(campaign)}
                    >
                      <XIcon aria-hidden className="size-3.5" />
                    </button>
                  </>
                )}
              </PortalRow>
            </li>
          ))}
        </ul>
        {active.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted-foreground">Campaign presets are being prepared.</p>
        ) : null}

        {adding ? (
          <form onSubmit={(event) => void save(event)} className="cov-row-in flex flex-wrap items-center gap-2 border-t border-border bg-background px-4 py-2.5">
            <input
              autoFocus
              aria-label="Preset label"
              placeholder="Label, e.g. Reels"
              value={label}
              maxLength={40}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && closeAdd()}
              className={cn(INPUT, "max-w-[150px] flex-1 basis-28")}
            />
            <input
              aria-label="utm_campaign value"
              placeholder="utm_campaign"
              value={utmTouched ? utm : utmFromLabel(label)}
              maxLength={40}
              onChange={(event) => {
                setUtmTouched(true);
                setUtm(event.target.value);
              }}
              onKeyDown={(event) => event.key === "Escape" && closeAdd()}
              className={cn(INPUT, "max-w-[150px] flex-1 basis-28 font-mono text-[12.5px]")}
              translate="no"
            />
            <button type="submit" className={cardButton({ size: "sm", tone: "ink" })} disabled={saving}>
              {saving ? <Spinner className="size-3" /> : null}
              Save
            </button>
            <button type="button" className={cardButton({ size: "sm" })} onClick={closeAdd}>
              Cancel
            </button>
          </form>
        ) : null}

        {removed.length > 0 ? (
          <div className="border-t border-border bg-background px-4 py-2 text-[12.5px] text-muted-foreground">
            Removed:{" "}
            {removed.map((campaign, index) => (
              <span key={campaign._id}>
                <button
                  type="button"
                  className="font-medium text-primary-ink underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-50"
                  disabled={pendingId !== null}
                  onClick={() => restore(campaign)}
                  title={`Bring ${campaign.label} back`}
                >
                  {campaign.label}
                </button>
                {index < removed.length - 1 ? " · " : ""}
              </span>
            ))}{" "}
            <span className="text-[12px]">(click to bring back)</span>
          </div>
        ) : null}

        <PortalCardFoot>Presets reach the portal right away.</PortalCardFoot>
      </PortalCard>

      <CampaignPresetDialog
        open={editing !== null}
        campaign={editing ?? undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSuccess={() => toast.success("Campaign updated")}
      />
    </>
  );
}

function CampaignPresetsSkeleton() {
  return (
    <PortalCard title="Campaign presets" meta="utm_campaign values DM closers pick from">
      <div role="status" aria-label="Loading campaign presets">
        {Array.from({ length: 3 }, (_, row) => (
          <PortalRow key={row}>
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </PortalRow>
        ))}
      </div>
    </PortalCard>
  );
}
