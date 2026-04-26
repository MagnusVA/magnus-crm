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
import { updateTenantStats } from "../lib/tenantStatsHelper";
import { insertLeadAggregate } from "../reporting/writeHooks";
import { buildLeadSearchText } from "./searchTextBuilder";

type IdentifierSource =
  | "calendly_booking"
  | "manual_entry"
  | "merge"
  | "side_deal";

type SocialHandleInput = {
  rawValue?: string;
  handle?: string;
  platform: SocialPlatformType;
};

export type ResolveLeadIdentityArgs = {
  tenantId: Id<"tenants">;
  fullName?: string;
  email: string;
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
    const next = await ctx.db.get(current.mergedIntoLeadId);
    if (!next) {
      console.error(
        "[LeadIdentity] Broken merge chain",
        {
          leadId: current._id,
          mergedIntoLeadId: current.mergedIntoLeadId,
          depth,
        },
      );
      return undefined;
    }
    current = next;
    depth += 1;
  }

  if (depth >= maxDepth || current.status === "merged") {
    console.error("[LeadIdentity] Merge chain unresolved", {
      startLeadId: lead._id,
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
  const identifier = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_tenantId_and_type_and_value", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("type", args.type)
        .eq("value", args.value),
    )
    .first();

  if (!identifier) {
    return null;
  }

  const matchedLead = await ctx.db.get(identifier.leadId);
  if (!matchedLead || matchedLead.tenantId !== args.tenantId) {
    return null;
  }

  return (await followMergeChain(ctx, matchedLead)) ?? null;
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

    const candidateDomain = extractEmailDomain(candidate.email);
    if (candidateDomain !== emailDomain) {
      continue;
    }

    if (areNamesSimilar(newLeadName, candidate.fullName)) {
      console.log("[LeadIdentity] Potential duplicate detected", {
        newLeadId,
        candidateLeadId: candidate._id,
        domain: emailDomain,
      });
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
): Promise<void> {
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
    return;
  }

  await ctx.db.insert("leadIdentifiers", record);
}

async function createManualIdentifiers(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    email: string;
    rawEmail: string;
    phone?: string;
    socialHandle?: SocialHandleInput;
    source: IdentifierSource;
    createdAt: number;
  },
): Promise<NonNullable<Doc<"leads">["socialHandles"]> | undefined> {
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

  await insertLeadIdentifierIfMissing(ctx, {
    tenantId: args.tenantId,
    leadId: args.leadId,
    type: args.socialHandle.platform,
    value: normalizedHandle,
    rawValue: rawHandle,
    source: args.source,
    confidence: "verified",
    createdAt: args.createdAt,
  });

  return [{ type: args.socialHandle.platform, handle: normalizedHandle }];
}

export async function resolveLeadIdentity(
  ctx: MutationCtx,
  args: ResolveLeadIdentityArgs,
): Promise<ResolveLeadIdentityResult> {
  const createIfMissing = args.createIfMissing ?? true;
  const normalizedEmail = normalizeEmail(args.email);

  if (normalizedEmail) {
    const legacyLead = await ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", args.tenantId).eq("email", normalizedEmail),
      )
      .unique();

    if (legacyLead) {
      const activeLead = await followMergeChain(ctx, legacyLead);
      if (activeLead) {
        return {
          lead: activeLead,
          leadId: activeLead._id,
          created: false,
          isNewLead: false,
          resolvedVia: "email",
        };
      }
    }

    const emailLead = await findLeadByIdentifier(ctx, {
      tenantId: args.tenantId,
      type: "email",
      value: normalizedEmail,
    });
    if (emailLead) {
      return {
        lead: emailLead,
        leadId: emailLead._id,
        created: false,
        isNewLead: false,
        resolvedVia: "email",
      };
    }
  }

  if (args.socialHandle) {
    const rawHandle =
      args.socialHandle.rawValue ?? args.socialHandle.handle ?? "";
    const normalizedHandle = normalizeSocialHandle(
      rawHandle,
      args.socialHandle.platform,
    );
    if (normalizedHandle) {
      const socialLead = await findLeadByIdentifier(ctx, {
        tenantId: args.tenantId,
        type: args.socialHandle.platform,
        value: normalizedHandle,
      });
      if (socialLead) {
        return {
          lead: socialLead,
          leadId: socialLead._id,
          created: false,
          isNewLead: false,
          resolvedVia: "social_handle",
        };
      }
    }
  }

  if (args.phone) {
    const normalizedPhone = normalizePhone(args.phone);
    if (normalizedPhone) {
      const phoneLead = await findLeadByIdentifier(ctx, {
        tenantId: args.tenantId,
        type: "phone",
        value: normalizedPhone,
      });
      if (phoneLead) {
        return {
          lead: phoneLead,
          leadId: phoneLead._id,
          created: false,
          isNewLead: false,
          resolvedVia: "phone",
        };
      }
    }
  }

  if (!createIfMissing) {
    throw new Error("Lead not found.");
  }
  if (!normalizedEmail) {
    throw new Error("Email is required for new leads in MVP.");
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

    const identifierValues = [normalizedEmail];
    if (phone) {
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone) {
        identifierValues.push(normalizedPhone);
      }
    }
    if (socialHandles?.[0]) {
      identifierValues.push(socialHandles[0].handle);
    }

    await ctx.db.patch(leadId, {
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

  const newLead = await ctx.db.get(leadId);
  if (!newLead) {
    throw new Error("Lead not found after creation.");
  }

  await insertLeadAggregate(ctx, leadId);
  await updateTenantStats(ctx, args.tenantId, {
    totalLeads: 1,
  });

  const potentialDuplicateLeadId = await detectPotentialDuplicate(
    ctx,
    args.tenantId,
    fullName,
    normalizedEmail,
    leadId,
  );

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
