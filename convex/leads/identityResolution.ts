import { blockBooking } from "../pipeline/blocked";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  areNamesSimilar,
  extractEmailDomain,
  normalizeEmail,
  normalizePhone,
  normalizeSocialHandle,
  type IdentifierType,
  type SocialPlatformType,
} from "../lib/normalization";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import { reportError } from "../lib/observability/log";
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { insertLeadAggregate } from "../reporting/writeHooks";
import { buildLeadSearchText } from "./searchTextBuilder";

type IdentifierSource =
  | "calendly_booking"
  | "manual_entry"
  | "merge"
  | "side_deal"
  | "slack_qualified";

type SocialHandleInput = {
  rawValue?: string;
  handle?: string;
  platform: SocialPlatformType;
};

export type ResolveLeadIdentityArgs = {
  tenantId: Id<"tenants">;
  fullName?: string;
  email?: string;
  phone?: string;
  socialHandle?: SocialHandleInput;
  identifierSource: IdentifierSource;
  createdAt: number;
  createIfMissing?: boolean;
  createIdentifiers?: boolean;
};

export type ResolveLeadIdentityResult = {
  lead: Doc<"leads">;
  leadId: Id<"leads">;
  created: boolean;
  isNewLead: boolean;
  resolvedVia: "email" | "social_handle" | "phone" | "new";
  potentialDuplicateLeadId?: Id<"leads">;
};

/** Public email domains excluded from fuzzy duplicate detection. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "mail.com",
  "live.com",
  "msn.com",
  "ymail.com",
  "zoho.com",
]);

async function followMergeChain(
  ctx: MutationCtx,
  lead: Doc<"leads">,
): Promise<Doc<"leads"> | undefined> {
  let current = lead;
  let depth = 0;
  const maxDepth = 5;

  while (
    current.status === "merged" &&
    current.mergedIntoLeadId &&
    depth < maxDepth
  ) {
    const next = await ctx.db.get("leads", current.mergedIntoLeadId);
    if (!next || next.tenantId !== lead.tenantId) {
      reportError("leads.identity.merge_chain_broken", "Merge chain target lead is missing", {
        severity: "error",
        fingerprint: "leads.identity.merge_chain_broken",
        tenantId: lead.tenantId,
        startLeadId: lead._id,
        leadId: current._id,
        mergedIntoLeadId: current.mergedIntoLeadId,
        depth,
      });
      return undefined;
    }
    current = next;
    depth += 1;
  }

  if (depth >= maxDepth || current.status === "merged") {
    reportError("leads.identity.merge_chain_unresolved", "Merge chain did not resolve to an active lead", {
      severity: "error",
      fingerprint: "leads.identity.merge_chain_unresolved",
      tenantId: lead.tenantId,
      startLeadId: lead._id,
      endLeadId: current._id,
      depth,
    });
    return undefined;
  }

  return current;
}

async function findLeadByIdentifier(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    type: IdentifierType;
    value: string;
  },
): Promise<Doc<"leads"> | null> {
  const identifiers = await ctx.db.query("leadIdentifiers")
    .withIndex("by_tenantId_and_type_and_value", q => q.eq("tenantId", args.tenantId).eq("type", args.type).eq("value", args.value)).take(17);
  if (identifiers.length > 16) blockBooking("identity_conflict");
  const matches = new Map<string, Doc<"leads">>();
  for (const identifier of identifiers) {
    const lead = await ctx.db.get("leads", identifier.leadId);
    if (!lead || lead.tenantId !== args.tenantId) blockBooking("invalid_identity_relationship");
    const resolved = await followMergeChain(ctx, lead);
    if (!resolved) blockBooking("invalid_identity_relationship");
    matches.set(resolved._id, resolved);
  }
  if (matches.size > 1) blockBooking("identity_conflict");
  return matches.values().next().value ?? null;
}

async function detectPotentialDuplicate(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  newLeadName: string | undefined,
  newLeadEmail: string,
  newLeadId: Id<"leads">,
): Promise<Id<"leads"> | undefined> {
  if (!newLeadName) {
    return undefined;
  }

  const emailDomain = extractEmailDomain(newLeadEmail);
  if (!emailDomain || PUBLIC_EMAIL_DOMAINS.has(emailDomain)) {
    return undefined;
  }

  const recentLeads = await ctx.db
    .query("leads")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .order("desc")
    .take(50);

  for (const candidate of recentLeads) {
    if (
      candidate._id === newLeadId ||
      candidate.status === "merged" ||
      candidate.status === "converted"
    ) {
      continue;
    }

    if (!candidate.email) {
      continue;
    }

    const candidateDomain = extractEmailDomain(candidate.email);
    if (candidateDomain !== emailDomain) {
      continue;
    }

    if (areNamesSimilar(newLeadName, candidate.fullName)) {
      return candidate._id;
    }
  }

  return undefined;
}

async function insertLeadIdentifierIfMissing(
  ctx: MutationCtx,
  record: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    type: IdentifierType;
    value: string;
    rawValue: string;
    source: IdentifierSource;
    confidence: "verified" | "inferred" | "suggested";
    createdAt: number;
  },
): Promise<"created" | "existing_same_lead" | "existing_other_lead"> {
  const existing = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_tenantId_and_type_and_value", (q) =>
      q
        .eq("tenantId", record.tenantId)
        .eq("type", record.type)
        .eq("value", record.value),
    )
    .first();

  if (existing) {
    return existing.leadId === record.leadId
      ? "existing_same_lead"
      : "existing_other_lead";
  }

  await ctx.db.insert("leadIdentifiers", record);
  return "created";
}

async function createManualIdentifiers(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    email?: string;
    rawEmail?: string;
    phone?: string;
    socialHandle?: SocialHandleInput;
    source: IdentifierSource;
    createdAt: number;
  },
): Promise<NonNullable<Doc<"leads">["socialHandles"]> | undefined> {
  if (args.email && args.rawEmail) {
    await insertLeadIdentifierIfMissing(ctx, {
      tenantId: args.tenantId,
      leadId: args.leadId,
      type: "email",
      value: args.email,
      rawValue: args.rawEmail,
      source: args.source,
      confidence: "verified",
      createdAt: args.createdAt,
    });
  }

  if (args.phone) {
    const normalizedPhone = normalizePhone(args.phone);
    if (normalizedPhone) {
      await insertLeadIdentifierIfMissing(ctx, {
        tenantId: args.tenantId,
        leadId: args.leadId,
        type: "phone",
        value: normalizedPhone,
        rawValue: args.phone,
        source: args.source,
        confidence: "verified",
        createdAt: args.createdAt,
      });
    }
  }

  if (!args.socialHandle) {
    return undefined;
  }

  const rawHandle =
    args.socialHandle.rawValue ?? args.socialHandle.handle ?? "";
  const normalizedHandle = normalizeSocialHandle(
    rawHandle,
    args.socialHandle.platform,
  );
  if (!normalizedHandle) {
    return undefined;
  }

  const socialInsertResult = await insertLeadIdentifierIfMissing(ctx, {
    tenantId: args.tenantId,
    leadId: args.leadId,
    type: args.socialHandle.platform,
    value: normalizedHandle,
    rawValue: rawHandle,
    source: args.source,
    confidence: "verified",
    createdAt: args.createdAt,
  });
  if (socialInsertResult === "existing_other_lead") {
    return undefined;
  }

  return [{ type: args.socialHandle.platform, handle: normalizedHandle }];
}

async function syncSubmittedIdentifiersForExistingLead(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  args: ResolveLeadIdentityArgs,
  normalizedEmail: string | undefined,
): Promise<Doc<"leads">> {
  if (!(args.createIdentifiers ?? false)) {
    return lead;
  }

  const submittedSocialHandles = await createManualIdentifiers(ctx, {
    tenantId: args.tenantId,
    leadId: lead._id,
    email: normalizedEmail,
    rawEmail: args.email,
    phone: args.phone?.trim() || undefined,
    socialHandle: args.socialHandle,
    source: args.identifierSource,
    createdAt: args.createdAt,
  });

  const nextSocialHandles = [...(lead.socialHandles ?? [])];
  for (const submittedHandle of submittedSocialHandles ?? []) {
    const alreadyPresent = nextSocialHandles.some(
      (handle) =>
        handle.type === submittedHandle.type &&
        handle.handle === submittedHandle.handle,
    );
    if (!alreadyPresent) {
      nextSocialHandles.push(submittedHandle);
    }
  }

  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", lead._id))
    .take(50);
  const identifierValues = identifiers.map((identifier) => identifier.value);
  const searchText = buildLeadSearchText(
    {
      fullName: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      socialHandles: nextSocialHandles,
    },
    identifierValues,
  );

  const socialHandlesChanged =
    nextSocialHandles.length !== (lead.socialHandles ?? []).length;
  const searchTextChanged = searchText !== lead.searchText;
  if (!socialHandlesChanged && !searchTextChanged) {
    return lead;
  }

  await ctx.db.patch("leads", lead._id, {
    ...(socialHandlesChanged ? { socialHandles: nextSocialHandles } : {}),
    ...(searchTextChanged ? { searchText } : {}),
  });
  await refreshOpportunitySearchForLead(ctx, lead.tenantId, lead._id);

  return (await ctx.db.get("leads", lead._id)) ?? lead;
}

export async function resolveLeadIdentity(
  ctx: MutationCtx,
  args: ResolveLeadIdentityArgs,
): Promise<ResolveLeadIdentityResult> {
  const createIfMissing = args.createIfMissing ?? true;
  const normalizedEmail = args.email ? normalizeEmail(args.email) : undefined;
  const rawSocialHandle =
    args.socialHandle?.rawValue ?? args.socialHandle?.handle ?? "";
  const normalizedSocialHandle = args.socialHandle
    ? normalizeSocialHandle(rawSocialHandle, args.socialHandle.platform)
    : undefined;
  const normalizedPhone = args.phone ? normalizePhone(args.phone) : undefined;

  const matches: { lead: Doc<"leads">; via: "email" | "social_handle" | "phone" }[] = [];
  if (normalizedEmail) {
    const legacy = await ctx.db.query("leads").withIndex("by_tenantId_and_email", q => q.eq("tenantId", args.tenantId).eq("email", normalizedEmail)).take(17);
    if (legacy.length > 16) blockBooking("identity_conflict");
    for (const lead of legacy) {
      const resolved = await followMergeChain(ctx, lead);
      if (!resolved) blockBooking("invalid_identity_relationship");
      matches.push({ lead: resolved, via: "email" });
    }
    const lead = await findLeadByIdentifier(ctx, { tenantId: args.tenantId, type: "email", value: normalizedEmail });
    if (lead) matches.push({ lead, via: "email" });
  }
  if (normalizedSocialHandle && args.socialHandle) {
    const lead = await findLeadByIdentifier(ctx, { tenantId: args.tenantId, type: args.socialHandle.platform, value: normalizedSocialHandle });
    if (lead) matches.push({ lead, via: "social_handle" });
  }
  if (normalizedPhone) {
    const lead = await findLeadByIdentifier(ctx, { tenantId: args.tenantId, type: "phone", value: normalizedPhone });
    if (lead) matches.push({ lead, via: "phone" });
  }
  const isBooking = args.identifierSource === "calendly_booking";
  if (isBooking && new Set(matches.map(m => m.lead._id)).size > 1) blockBooking("identity_conflict");
  const match = matches[0];
  if (match) {
    // A phone or handle is not permission to change a person's established email.
    // Existing aliases also require review if the canonical contact disagrees.
    if (isBooking && normalizedEmail && match.lead.email && normalizeEmail(match.lead.email) !== normalizedEmail) blockBooking("identity_conflict");
    const lead = await syncSubmittedIdentifiersForExistingLead(ctx, match.lead, args, normalizedEmail);
    return { lead, leadId: lead._id, created: false, isNewLead: false, resolvedVia: match.via };
  }

  if (!createIfMissing) {
    throw new Error("Lead not found.");
  }
  if (!normalizedEmail && !normalizedSocialHandle && !normalizedPhone) {
    throw new Error(
      "Cannot create lead - at least one of email, socialHandle, or phone is required.",
    );
  }

  const fullName = args.fullName?.trim() || undefined;
  const phone = args.phone?.trim() || undefined;
  const leadId = await ctx.db.insert("leads", {
    tenantId: args.tenantId,
    email: normalizedEmail,
    fullName,
    phone,
    customFields: undefined,
    status: "active",
    firstSeenAt: args.createdAt,
    updatedAt: args.createdAt,
    searchText: buildLeadSearchText({
      fullName,
      email: normalizedEmail,
      phone,
      socialHandles: undefined,
    }),
  });

  let socialHandles: NonNullable<Doc<"leads">["socialHandles"]> | undefined;
  if (args.createIdentifiers ?? false) {
    socialHandles = await createManualIdentifiers(ctx, {
      tenantId: args.tenantId,
      leadId,
      email: normalizedEmail,
      rawEmail: args.email,
      phone,
      socialHandle: args.socialHandle,
      source: args.identifierSource,
      createdAt: args.createdAt,
    });

    const identifierValues = [
      normalizedEmail,
      normalizedPhone,
      normalizedSocialHandle,
    ].filter((value): value is string => Boolean(value));
    if (phone && normalizedPhone && !identifierValues.includes(normalizedPhone)) {
      identifierValues.push(normalizedPhone);
    }
    if (socialHandles?.[0]) {
      identifierValues.push(socialHandles[0].handle);
    }

    await ctx.db.patch("leads", leadId, {
      socialHandles,
      searchText: buildLeadSearchText(
        {
          fullName,
          email: normalizedEmail,
          phone,
          socialHandles,
        },
        identifierValues,
      ),
    });
  }

  const newLead = await ctx.db.get("leads", leadId);
  if (!newLead) {
    throw new Error("Lead not found after creation.");
  }

  await insertLeadAggregate(ctx, leadId);
  await updateTenantStats(ctx, args.tenantId, {
    totalLeads: 1,
  });
  await rebuildLeadCustomerSearchRow(ctx, args.tenantId, leadId);

  const potentialDuplicateLeadId = normalizedEmail
    ? await detectPotentialDuplicate(
        ctx,
        args.tenantId,
        fullName,
        normalizedEmail,
        leadId,
      )
    : undefined;

  return {
    lead: newLead,
    leadId,
    created: true,
    isNewLead: true,
    resolvedVia: "new",
    potentialDuplicateLeadId,
  };
}

export async function resolveExistingLeadIdentity(
  ctx: MutationCtx,
  args: Omit<ResolveLeadIdentityArgs, "createIfMissing">,
): Promise<ResolveLeadIdentityResult | null> {
  try {
    return await resolveLeadIdentity(ctx, {
      ...args,
      createIfMissing: false,
      createIdentifiers: false,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Lead not found.") {
      return null;
    }
    throw error;
  }
}
