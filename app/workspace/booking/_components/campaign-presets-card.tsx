"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  BanIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CardNote, StatusWord } from "./attribution-ui";
import { CampaignPresetDialog } from "./campaign-preset-dialog";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type CampaignPreset = Doc<"linkPortalCampaignPresets">;

export function CampaignPresetsCard() {
  const campaigns = useQuery(
    api.linkPortal.campaignQueries.listCampaignPresetsForSettings,
    {},
  );
  const ensureDefaults = useMutation(
    api.linkPortal.campaignMutations.ensureDefaultCampaignPresets,
  );
  const setActive = useMutation(
    api.linkPortal.campaignMutations.setCampaignPresetActive,
  );
  const setDefault = useMutation(
    api.linkPortal.campaignMutations.setCampaignPresetDefault,
  );
  const seedRequestedRef = useRef(false);
  const [pendingCampaignId, setPendingCampaignId] =
    useState<Id<"linkPortalCampaignPresets"> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] =
    useState<CampaignPreset | null>(null);

  useEffect(() => {
    if (campaigns === undefined || seedRequestedRef.current) {
      return;
    }
    seedRequestedRef.current = true;
    void ensureDefaults({}).catch((error) => {
      toast.error(
        getErrorMessage(error, "Could not seed campaign presets"),
      );
    });
  }, [campaigns, ensureDefaults]);

  if (campaigns === undefined) {
    return <CampaignPresetsSkeleton />;
  }

  const activeCampaignCount = campaigns.filter(
    (campaign) => campaign.isActive,
  ).length;

  async function handleSetActive(campaign: CampaignPreset, isActive: boolean) {
    setPendingCampaignId(campaign._id);
    try {
      await setActive({
        campaignPresetId: campaign._id,
        isActive,
      });
      toast.success(isActive ? "Campaign enabled" : "Campaign disabled");
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Could not update campaign"),
      );
    } finally {
      setPendingCampaignId(null);
    }
  }

  async function handleSetDefault(campaign: CampaignPreset) {
    setPendingCampaignId(campaign._id);
    try {
      await setDefault({ campaignPresetId: campaign._id });
      toast.success("Default campaign updated");
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Could not update default campaign"),
      );
    } finally {
      setPendingCampaignId(null);
    }
  }

  function openCreateDialog() {
    setEditingCampaign(null);
    setDialogOpen(true);
  }

  function openEditDialog(campaign: CampaignPreset) {
    setEditingCampaign(campaign);
    setDialogOpen(true);
  }

  return (
    <>
      <DetailCard
        title="Campaign presets"
        className="min-w-0"
        meta={
          <Button type="button" size="sm" variant="outline" onClick={openCreateDialog}>
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            New campaign
          </Button>
        }
      >
        <CardNote>UTM campaign values DM closers pick from in the portal.</CardNote>
        {campaigns.length === 0 ? (
          <SectionEmpty title="Campaign presets are being prepared." />
        ) : (
          <ul aria-label="Campaign presets" className="divide-y">
            {campaigns.map((campaign) => {
              const isPending = pendingCampaignId === campaign._id;
              const cannotDisable =
                campaign.isActive && activeCampaignCount === 1;
              return (
                <li
                  key={campaign._id}
                  className="flex min-h-11 items-center gap-3 px-4 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "truncate font-medium",
                          !campaign.isActive && "text-muted-foreground",
                        )}
                      >
                        {campaign.label}
                      </span>
                      {campaign.isDefault && campaign.isActive ? (
                        <StatusWord tone="active">Default</StatusWord>
                      ) : null}
                      {!campaign.isActive ? (
                        <StatusWord tone="inactive">Disabled</StatusWord>
                      ) : null}
                    </div>
                    <div
                      className="truncate font-mono text-[13px] text-muted-foreground"
                      translate="no"
                    >
                      utm_campaign={campaign.utmCampaign}
                    </div>
                  </div>
                  {isPending ? <Spinner /> : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        disabled={isPending}
                        aria-label={`Actions for ${campaign.label}`}
                      >
                        <EllipsisIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => openEditDialog(campaign)}
                      >
                        <PencilIcon />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!campaign.isActive || campaign.isDefault}
                        onClick={() => handleSetDefault(campaign)}
                      >
                        <StarIcon />
                        Make default
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={cannotDisable}
                        onClick={() =>
                          handleSetActive(campaign, !campaign.isActive)
                        }
                      >
                        {campaign.isActive ? <BanIcon /> : <CheckIcon />}
                        {campaign.isActive ? "Disable" : "Enable"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </DetailCard>

      <CampaignPresetDialog
        open={dialogOpen}
        campaign={editingCampaign ?? undefined}
        onOpenChange={setDialogOpen}
        onSuccess={() => {
          toast.success(
            editingCampaign ? "Campaign updated" : "Campaign created",
          );
        }}
      />
    </>
  );
}

function CampaignPresetsSkeleton() {
  return (
    <DetailCard title="Campaign presets" className="min-w-0">
      <div role="status" aria-label="Loading campaign presets" className="divide-y">
        {Array.from({ length: 3 }, (_, row) => (
          <div key={row} className="flex min-h-11 flex-col justify-center gap-1.5 px-4 py-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
    </DetailCard>
  );
}
