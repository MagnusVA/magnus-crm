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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
    return (
      <Skeleton
        className="h-72 w-full"
        role="status"
        aria-label="Loading campaign presets"
      />
    );
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
      <Card>
        <CardHeader>
          <CardTitle>Campaign Presets</CardTitle>
          <CardDescription>
            UTM campaign values DM closers pick from in the portal.
          </CardDescription>
          <CardAction>
            <Button type="button" size="sm" onClick={openCreateDialog}>
              <PlusIcon data-icon="inline-start" />
              New
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Campaign presets are being prepared.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {campaigns.map((campaign) => {
                const isPending = pendingCampaignId === campaign._id;
                const cannotDisable =
                  campaign.isActive && activeCampaignCount === 1;
                return (
                  <li
                    key={campaign._id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5",
                      !campaign.isActive && "bg-muted/30",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "truncate text-sm font-medium",
                            !campaign.isActive && "text-muted-foreground",
                          )}
                        >
                          {campaign.label}
                        </span>
                        {campaign.isDefault && campaign.isActive ? (
                          <Badge variant="secondary">
                            <StarIcon data-icon="inline-start" />
                            Default
                          </Badge>
                        ) : null}
                        {!campaign.isActive ? (
                          <Badge variant="muted">Disabled</Badge>
                        ) : null}
                      </div>
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
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
                          Make Default
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
        </CardContent>
      </Card>

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
