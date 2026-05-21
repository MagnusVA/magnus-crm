import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { normalizeUtmValue, slugifyAttributionLabel } from "../lib/attribution/normalize";
import { requireTenantUser } from "../requireTenantUser";

const MAX_CAMPAIGN_VALUE_LENGTH = 40;
const MAX_CAMPAIGN_LABEL_LENGTH = 40;

const DEFAULT_CAMPAIGNS = [
  { label: "Organic", utmCampaign: "organic" },
  { label: "Paid", utmCampaign: "paid" },
  { label: "Story", utmCampaign: "story" },
  { label: "DM", utmCampaign: "dm" },
] as const;

type CampaignPreset = Doc<"linkPortalCampaignPresets">;

async function listCampaignsByTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  return await ctx.db
    .query("linkPortalCampaignPresets")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(100);
}

function normalizeCampaignInput(args: { label: string; utmCampaign: string }) {
  const label = args.label.trim();
  const utmCampaign = args.utmCampaign.trim();

  if (!label) {
    throw new Error("Campaign label is required.");
  }
  if (label.length > MAX_CAMPAIGN_LABEL_LENGTH) {
    throw new Error("Campaign label must be 40 characters or fewer.");
  }
  if (!utmCampaign) {
    throw new Error("UTM campaign is required.");
  }
  if (utmCampaign.length > MAX_CAMPAIGN_VALUE_LENGTH) {
    throw new Error("UTM campaign must be 40 characters or fewer.");
  }

  const normalizedUtmCampaign = normalizeUtmValue(utmCampaign);
  if (!normalizedUtmCampaign) {
    throw new Error("UTM campaign is required.");
  }

  const slug =
    slugifyAttributionLabel(label) || slugifyAttributionLabel(utmCampaign);
  if (!slug) {
    throw new Error("Campaign label must contain at least one letter or number.");
  }

  return {
    label,
    utmCampaign,
    normalizedUtmCampaign,
    slug,
  };
}

async function assertCampaignUnique(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    normalizedUtmCampaign: string;
    excludeCampaignPresetId?: Id<"linkPortalCampaignPresets">;
  },
) {
  const existing = await ctx.db
    .query("linkPortalCampaignPresets")
    .withIndex("by_tenantId_and_normalizedUtmCampaign", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("normalizedUtmCampaign", args.normalizedUtmCampaign),
    )
    .take(5);

  if (
    existing.some(
      (campaign) => campaign._id !== args.excludeCampaignPresetId,
    )
  ) {
    throw new Error("A campaign preset already uses this UTM campaign.");
  }
}

async function clearOtherDefaults(
  ctx: MutationCtx,
  campaigns: CampaignPreset[],
  defaultCampaignPresetId: Id<"linkPortalCampaignPresets"> | null,
  now: number,
) {
  await Promise.all(
    campaigns
      .filter(
        (campaign) =>
          campaign._id !== defaultCampaignPresetId && campaign.isDefault,
      )
      .map((campaign) =>
        ctx.db.patch(campaign._id, {
          isDefault: false,
          updatedAt: now,
        }),
      ),
  );
}

export const ensureDefaultCampaignPresets = mutation({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const existing = await listCampaignsByTenant(ctx, tenantId);
    const existingByNormalized = new Map(
      existing.map((row) => [row.normalizedUtmCampaign, row]),
    );
    const activeDefaults = existing.filter(
      (row) => row.isDefault && row.isActive,
    );
    let hasActiveDefault = activeDefaults.length > 0;

    const now = Date.now();
    const ids = existing.map((row) => row._id);
    if (activeDefaults.length > 1) {
      await Promise.all(
        activeDefaults.slice(1).map((row) =>
          ctx.db.patch(row._id, {
            isDefault: false,
            updatedAt: now,
          }),
        ),
      );
    }

    if (!hasActiveDefault) {
      const existingOrganic = existingByNormalized.get("organic");
      const defaultCandidate =
        (existingOrganic?.isActive ? existingOrganic : undefined) ??
        existing.find((row) => row.isActive);
      if (defaultCandidate) {
        await ctx.db.patch(defaultCandidate._id, {
          isDefault: true,
          updatedAt: now,
        });
        hasActiveDefault = true;
      }
    }

    let insertedCount = 0;
    for (const preset of DEFAULT_CAMPAIGNS) {
      if (preset.utmCampaign.length > MAX_CAMPAIGN_VALUE_LENGTH) {
        throw new Error("Campaign preset exceeds the maximum length.");
      }

      const normalized = normalizeUtmValue(preset.utmCampaign);
      if (!normalized) {
        throw new Error("Campaign preset is invalid.");
      }
      if (existingByNormalized.has(normalized)) {
        continue;
      }

      const isDefault = !hasActiveDefault;
      ids.push(
        await ctx.db.insert("linkPortalCampaignPresets", {
          tenantId,
          slug: slugifyAttributionLabel(preset.label),
          label: preset.label,
          utmCampaign: preset.utmCampaign,
          normalizedUtmCampaign: normalized,
          isDefault,
          isActive: true,
          sortOrder: existing.length + insertedCount,
          createdAt: now,
          updatedAt: now,
        }),
      );
      insertedCount += 1;
      hasActiveDefault = hasActiveDefault || isDefault;
    }

    return ids;
  },
});

export const createCampaignPreset = mutation({
  args: {
    label: v.string(),
    utmCampaign: v.string(),
    isDefault: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const normalized = normalizeCampaignInput(args);
    await assertCampaignUnique(ctx, {
      tenantId,
      normalizedUtmCampaign: normalized.normalizedUtmCampaign,
    });

    const campaigns = await listCampaignsByTenant(ctx, tenantId);
    const now = Date.now();
    const hasActiveDefault = campaigns.some(
      (campaign) => campaign.isActive && campaign.isDefault,
    );
    const isDefault = args.isDefault === true || !hasActiveDefault;

    if (isDefault) {
      await clearOtherDefaults(ctx, campaigns, null, now);
    }

    return await ctx.db.insert("linkPortalCampaignPresets", {
      tenantId,
      slug: normalized.slug,
      label: normalized.label,
      utmCampaign: normalized.utmCampaign,
      normalizedUtmCampaign: normalized.normalizedUtmCampaign,
      isDefault,
      isActive: true,
      sortOrder: campaigns.length,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateCampaignPreset = mutation({
  args: {
    campaignPresetId: v.id("linkPortalCampaignPresets"),
    label: v.string(),
    utmCampaign: v.string(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const campaign = await ctx.db.get(args.campaignPresetId);
    if (!campaign || campaign.tenantId !== tenantId) {
      throw new Error("Campaign preset not found.");
    }

    const normalized = normalizeCampaignInput(args);
    await assertCampaignUnique(ctx, {
      tenantId,
      normalizedUtmCampaign: normalized.normalizedUtmCampaign,
      excludeCampaignPresetId: args.campaignPresetId,
    });

    await ctx.db.patch(args.campaignPresetId, {
      slug: normalized.slug,
      label: normalized.label,
      utmCampaign: normalized.utmCampaign,
      normalizedUtmCampaign: normalized.normalizedUtmCampaign,
      updatedAt: Date.now(),
    });
    return args.campaignPresetId;
  },
});

export const setCampaignPresetActive = mutation({
  args: {
    campaignPresetId: v.id("linkPortalCampaignPresets"),
    isActive: v.boolean(),
  },
  handler: async (ctx, { campaignPresetId, isActive }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const campaign = await ctx.db.get(campaignPresetId);
    if (!campaign || campaign.tenantId !== tenantId) {
      throw new Error("Campaign preset not found.");
    }
    if (campaign.isActive === isActive) {
      return campaignPresetId;
    }

    const campaigns = await listCampaignsByTenant(ctx, tenantId);
    const now = Date.now();

    if (!isActive) {
      const activeAfterDisable = campaigns.filter(
        (candidate) => candidate._id !== campaignPresetId && candidate.isActive,
      );
      if (activeAfterDisable.length === 0) {
        throw new Error("At least one active campaign preset is required.");
      }

      const defaultAfterDisable =
        activeAfterDisable.find((candidate) => candidate.isDefault) ??
        activeAfterDisable[0];
      await clearOtherDefaults(
        ctx,
        campaigns,
        defaultAfterDisable._id,
        now,
      );
      await ctx.db.patch(defaultAfterDisable._id, {
        isDefault: true,
        updatedAt: now,
      });
      await ctx.db.patch(campaignPresetId, {
        isActive: false,
        isDefault: false,
        updatedAt: now,
      });
      return campaignPresetId;
    }

    const activeDefault = campaigns.find(
      (candidate) => candidate.isActive && candidate.isDefault,
    );
    await ctx.db.patch(campaignPresetId, {
      isActive: true,
      isDefault: activeDefault === undefined,
      updatedAt: now,
    });
    return campaignPresetId;
  },
});

export const setCampaignPresetDefault = mutation({
  args: {
    campaignPresetId: v.id("linkPortalCampaignPresets"),
  },
  handler: async (ctx, { campaignPresetId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const campaign = await ctx.db.get(campaignPresetId);
    if (!campaign || campaign.tenantId !== tenantId) {
      throw new Error("Campaign preset not found.");
    }
    if (!campaign.isActive) {
      throw new Error("Enable a campaign preset before making it the default.");
    }

    const campaigns = await listCampaignsByTenant(ctx, tenantId);
    const now = Date.now();
    await clearOtherDefaults(ctx, campaigns, campaignPresetId, now);
    await ctx.db.patch(campaignPresetId, {
      isDefault: true,
      updatedAt: now,
    });
    return campaignPresetId;
  },
});
