import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { validateRequiredString } from "../lib/validation";
import { requireTenantUser } from "../requireTenantUser";

const paymentLinkValidator = v.object({
  provider: v.string(),
  label: v.string(),
  url: v.string(),
});

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
    roundRobinEnabled: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { calendlyEventTypeUri, displayName, paymentLinks, roundRobinEnabled },
  ) => {
    console.log("[EventTypeConfig] upsertEventTypeConfig called", { displayName, hasPaymentLinks: !!paymentLinks, roundRobinEnabled });
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
        roundRobinEnabled:
          roundRobinEnabled === undefined
            ? existing.roundRobinEnabled
            : roundRobinEnabled,
      });

      console.log("[EventTypeConfig] upsertEventTypeConfig updated", { configId: existing._id });
      return existing._id;
    }

    const configId = await ctx.db.insert("eventTypeConfigs", {
      tenantId,
      calendlyEventTypeUri: normalizedEventTypeUri,
      displayName: normalizedDisplayName,
      paymentLinks: normalizedPaymentLinks,
      roundRobinEnabled: roundRobinEnabled ?? false,
      createdAt: Date.now(),
    });

    console.log("[EventTypeConfig] upsertEventTypeConfig created", { configId });
    return configId;
  },
});
