import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { validateRequiredString } from "../lib/validation";
import { requireTenantUser } from "../requireTenantUser";

const paymentLinkValidator = v.object({
  provider: v.string(),
  label: v.string(),
  url: v.string(),
});

const socialHandleTypeValidator = v.union(
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("twitter"),
  v.literal("other_social"),
);

const customFieldMappingsValidator = v.object({
  socialHandleField: v.optional(v.string()),
  socialHandleType: v.optional(socialHandleTypeValidator),
  phoneField: v.optional(v.string()),
});

function normalizeCustomFieldMappings(customFieldMappings: {
  socialHandleField?: string;
  socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
  phoneField?: string;
}) {
  const normalized: {
    socialHandleField?: string;
    socialHandleType?: "instagram" | "tiktok" | "twitter" | "other_social";
    phoneField?: string;
  } = {};

  if (customFieldMappings.socialHandleField) {
    normalized.socialHandleField = customFieldMappings.socialHandleField;
    if (customFieldMappings.socialHandleType) {
      normalized.socialHandleType = customFieldMappings.socialHandleType;
    }
  }

  if (customFieldMappings.phoneField) {
    normalized.phoneField = customFieldMappings.phoneField;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePaymentLinks(
  paymentLinks:
    | Array<{
        provider: string;
        label: string;
        url: string;
      }>
    | undefined,
) {
  if (paymentLinks === undefined) {
    return undefined;
  }

  return paymentLinks.map((link) => {
    const provider = link.provider.trim();
    const label = link.label.trim();
    const url = link.url.trim();

    const providerValidation = validateRequiredString(provider, {
      fieldName: "Payment provider",
    });
    if (!providerValidation.valid) {
      throw new Error(providerValidation.error);
    }

    const labelValidation = validateRequiredString(label, {
      fieldName: "Payment label",
    });
    if (!labelValidation.valid) {
      throw new Error(labelValidation.error);
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Invalid URL protocol");
      }
    } catch {
      throw new Error(
        `Invalid payment URL "${url}". Expected a valid http/https URL.`,
      );
    }

    return {
      provider,
      label,
      url,
    };
  });
}

/**
 * Create or update an event type config for the current tenant.
 */
export const upsertEventTypeConfig = mutation({
  args: {
    calendlyEventTypeUri: v.string(),
    displayName: v.string(),
    paymentLinks: v.optional(v.array(paymentLinkValidator)),
  },
  handler: async (
    ctx,
    { calendlyEventTypeUri, displayName, paymentLinks },
  ) => {
    console.log("[EventTypeConfig] upsertEventTypeConfig called", { displayName, hasPaymentLinks: !!paymentLinks });
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const uriValidation = validateRequiredString(calendlyEventTypeUri, {
      fieldName: "Calendly event type URI",
      maxLength: 512,
    });
    if (!uriValidation.valid) {
      throw new Error(uriValidation.error);
    }

    const displayNameValidation = validateRequiredString(displayName, {
      fieldName: "Display name",
      maxLength: 120,
    });
    if (!displayNameValidation.valid) {
      throw new Error(displayNameValidation.error);
    }
    console.log("[EventTypeConfig] upsertEventTypeConfig validation passed", { tenantId });

    const normalizedEventTypeUri = calendlyEventTypeUri.trim();
    const normalizedDisplayName = displayName.trim();
    const normalizedPaymentLinks = normalizePaymentLinks(paymentLinks);

    const existing = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("calendlyEventTypeUri", normalizedEventTypeUri),
      )
      .unique();

    console.log("[EventTypeConfig] upsertEventTypeConfig existing check", { exists: !!existing, existingId: existing?._id });
    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: normalizedDisplayName,
        paymentLinks:
          normalizedPaymentLinks === undefined
            ? existing.paymentLinks
            : normalizedPaymentLinks,
      });

      console.log("[EventTypeConfig] upsertEventTypeConfig updated", { configId: existing._id });
      return existing._id;
    }

    const configId = await ctx.db.insert("eventTypeConfigs", {
      tenantId,
      calendlyEventTypeUri: normalizedEventTypeUri,
      displayName: normalizedDisplayName,
      paymentLinks: normalizedPaymentLinks,
      createdAt: Date.now(),
    });

    console.log("[EventTypeConfig] upsertEventTypeConfig created", { configId });
    return configId;
  },
});

/**
 * Update the custom field mappings for an event type config.
 * Admin-only: configures which Calendly form questions map to CRM identity fields.
 * Feature E (Lead Identity Resolution) reads these mappings during pipeline processing.
 */
export const updateCustomFieldMappings = mutation({
  args: {
    eventTypeConfigId: v.id("eventTypeConfigs"),
    customFieldMappings: customFieldMappingsValidator,
  },
  handler: async (ctx, { eventTypeConfigId, customFieldMappings }) => {
    console.log("[EventTypeConfig] updateCustomFieldMappings called", {
      eventTypeConfigId,
      customFieldMappings,
    });
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Load and validate ownership
    const config = await ctx.db.get(eventTypeConfigId);
    if (!config) {
      throw new Error("Event type configuration not found.");
    }
    if (config.tenantId !== tenantId) {
      // Deliberately vague error to avoid leaking info about other tenants
      throw new Error("Event type configuration not found.");
    }

    // Validate that mapped fields exist in knownCustomFieldKeys (if available)
    const knownKeys = config.knownCustomFieldKeys ?? [];
    if (knownKeys.length > 0) {
      if (
        customFieldMappings.socialHandleField &&
        !knownKeys.includes(customFieldMappings.socialHandleField)
      ) {
        throw new Error(
          `Social handle field "${customFieldMappings.socialHandleField}" is not a known form field for this event type.`,
        );
      }
      if (
        customFieldMappings.phoneField &&
        !knownKeys.includes(customFieldMappings.phoneField)
      ) {
        throw new Error(
          `Phone field "${customFieldMappings.phoneField}" is not a known form field for this event type.`,
        );
      }
    }

    // Validate socialHandleType is required when socialHandleField is set
    if (
      customFieldMappings.socialHandleField &&
      !customFieldMappings.socialHandleType
    ) {
      throw new Error(
        "Social handle platform type is required when a social handle field is selected.",
      );
    }

    // Validate no double-mapping (same question for both social handle and phone)
    if (
      customFieldMappings.socialHandleField &&
      customFieldMappings.phoneField &&
      customFieldMappings.socialHandleField === customFieldMappings.phoneField
    ) {
      throw new Error(
        "Social handle field and phone field cannot be the same question.",
      );
    }

    // Normalize: clear socialHandleType if socialHandleField is cleared.
    const normalizedMappings =
      normalizeCustomFieldMappings(customFieldMappings);

    await ctx.db.patch(eventTypeConfigId, {
      customFieldMappings: normalizedMappings,
    });

    console.log("[EventTypeConfig] updateCustomFieldMappings saved", {
      configId: eventTypeConfigId,
      mappings: normalizedMappings,
    });
  },
});
