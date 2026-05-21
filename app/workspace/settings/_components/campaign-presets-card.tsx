"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { PencilIcon, PlusIcon, StarIcon } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CampaignPresetDialog } from "./campaign-preset-dialog";

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
  const [seedRequested, setSeedRequested] = useState(false);
  const [pendingCampaignId, setPendingCampaignId] =
    useState<Id<"linkPortalCampaignPresets"> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] =
    useState<CampaignPreset | null>(null);

  useEffect(() => {
    if (campaigns === undefined || seedRequested) {
      return;
    }
    setSeedRequested(true);
    void ensureDefaults({}).catch((error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not seed campaign presets",
      );
    });
  }, [campaigns, ensureDefaults, seedRequested]);

  if (campaigns === undefined) {
    return <Skeleton className="h-72 w-full" />;
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
        error instanceof Error ? error.message : "Could not update campaign",
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
        error instanceof Error
          ? error.message
          : "Could not update default campaign",
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
            Canonical UTM campaign values available in the public portal.
          </CardDescription>
          <CardAction>
            <Button type="button" size="sm" onClick={openCreateDialog}>
              <PlusIcon data-icon="inline-start" />
              New Campaign
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>UTM Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="h-24 text-center text-muted-foreground"
                  >
                    Campaign presets are being prepared.
                  </TableCell>
                </TableRow>
              ) : null}
              {campaigns.map((campaign) => {
                const isPending = pendingCampaignId === campaign._id;
                const cannotDisable =
                  campaign.isActive && activeCampaignCount === 1;
                return (
                  <TableRow key={campaign._id}>
                    <TableCell>{campaign.label}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {campaign.utmCampaign}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {campaign.isDefault && campaign.isActive ? (
                          <Badge variant="secondary">Default</Badge>
                        ) : null}
                        <Badge
                          variant={campaign.isActive ? "outline" : "muted"}
                        >
                          {campaign.isActive ? "Active" : "Disabled"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => openEditDialog(campaign)}
                        >
                          <PencilIcon data-icon="inline-start" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            isPending ||
                            !campaign.isActive ||
                            campaign.isDefault
                          }
                          onClick={() => handleSetDefault(campaign)}
                        >
                          {isPending ? (
                            <Spinner data-icon="inline-start" />
                          ) : (
                            <StarIcon data-icon="inline-start" />
                          )}
                          Make Default
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={isPending || cannotDisable}
                          onClick={() =>
                            handleSetActive(campaign, !campaign.isActive)
                          }
                        >
                          {isPending ? <Spinner data-icon="inline-start" /> : null}
                          {campaign.isActive ? "Disable" : "Enable"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
