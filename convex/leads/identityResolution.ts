import {
  blockBooking,
  holdEvidence,
  type BookingIdentifiers,
  type IdentityConflict,
} from "../pipeline/blocked";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  areNamesSimilar,
  extractEmailDomain,
  isPlaceholderEmail,
  normalizeEmail,
  normalizePhone,
  normalizeSocialHandle,
  type IdentifierType,
  type SocialPlatformType,
} from "../lib/normalization";
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";
import { refreshOpportunitySearchForLead } from "../lib/opportunitySearch";
import {
  initialLifecycleFields,
  readLifecycle,
  syncLeadStageEntries,
} from "../lib/leadLifecycle";
import { reportError } from "../lib/observability/log";
import type { LifecycleEvidence } from "./lifecycle";
import { buildLeadSearchText } from "./searchTextBuilder";

type IdentifierSource =
  | "calendly_booking"
  | "manual_entry"
  | "merge"
  | "side_deal"
  | "slack_qualified"
  | "lead_gen"
  | "dm_portal";

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
  /** The stage a new person starts at, from the record that created them. */
  initialLifecycle?: LifecycleEvidence;
  /** The booking's delivery, for an answer an admin gave about that one booking. */
  deliveryId?: Id<"webhookDeliveries">;
};

export type ResolveLeadIdentityResult = {
  lead: Doc<"leads">;
  leadId: Id<"leads">;
  created: boolean;
  isNewLead: boolean;
  resolvedVia: "email" | "social_handle" | "phone" | "new";
  potentialDuplicateLeadId?: Id<"leads">;
  /**
   * The other people a booking's email or phone named when its social handle
   * decided who it belongs to. They keep those identifiers, and the booking
   * opens a review.
   */
  conflicts?: IdentityConflict[];
  /** The booking's identifiers, normalized, when `conflicts` is set. */
  booking?: BookingIdentifiers;
  /**
   * Identifiers the booking may not give its person: an admin answered that
   * the person the phone names is someone else, and that person keeps it.
   */
  withheld?: "phone"[];
};

function distinctConflicts(
  matches: { lead: Doc<"leads">; via: IdentityConflict["via"] }[],
): IdentityConflict[] {
  const seen = new Set<string>();
  const conflicts: IdentityConflict[] = [];
  for (const { lead, via } of matches) {
    const key = `${lead._id}:${via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ leadId: lead._id, via });
  }
  return conflicts;
}

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

export async function followMergeChain(
  ctx: QueryCtx,
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

function viaOf(type: IdentifierType): IdentityConflict["via"] {
  return type === "email" || type === "phone" ? type : "social_handle";
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
  if (identifiers.length > 16)
    blockBooking("identity_conflict", undefined, holdEvidence("identifier_overflow", [], { truncated: true }));
  const matches = new Map<string, Doc<"leads">>();
  for (const identifier of identifiers) {
    const lead = await ctx.db.get("leads", identifier.leadId);
    if (!lead || lead.tenantId !== args.tenantId) blockBooking("invalid_identity_relationship");
    const resolved = await followMergeChain(ctx, lead);
    if (!resolved) blockBooking("invalid_identity_relationship");
    matches.set(resolved._id, resolved);
  }
  if (matches.size > 1)
    blockBooking(
      "identity_conflict",
      undefined,
      holdEvidence(
        "shared_identifier",
        [...matches.keys()].map((leadId) => ({ leadId: leadId as Id<"leads">, via: viaOf(args.type) })),
      ),
    );
  return matches.values().next().value ?? null;
}

const POLLUTION_SCAN_LIMIT = 50;

/**
 * Before placeholder phones and emails stopped being identity keys, every
 * booker who typed one was attached to the same lead, which collected their
 * emails and handles. Such a lead still holds a phone identifier that
 * `normalizePhone` now rejects, or an email identifier that
 * `isPlaceholderEmail` flags. Its email and handle identifiers can't be
 * trusted, so bookings that only agree with them need review. A lead with
 * more identifiers than we scan fails closed for the same reason.
 * TODO: drop once the split migration in docs/plans/polluted-lead-split.md ships.
 */
export async function isPlaceholderPollutedLead(
  ctx: MutationCtx,
  leadId: Id<"leads">,
): Promise<boolean> {
  const identifiers = await ctx.db
    .query("leadIdentifiers")
    .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
    .take(POLLUTION_SCAN_LIMIT + 1);
  if (identifiers.length > POLLUTION_SCAN_LIMIT) return true;
  return identifiers.some(
    (identifier) =>
      (identifier.type === "phone" && normalizePhone(identifier.value) === undefined) ||
      (identifier.type === "email" && isPlaceholderEmail(identifier.value)),
  );
}

/** Answers read for one booking email; past this, none is trusted. */
const IDENTITY_ANSWER_LIMIT = 16;

/**
 * Admins' answers to "Is this the same person?" for a booking, by the person
 * each answer is about as they are now (following merges). Keyed by the
 * booking's email, or by its delivery when the email is a placeholder. More
 * answers than the limit, or a person whose merge chain is broken, are
 * ignored, which leaves the booking to today's rules: it holds.
 */
async function readIdentityAnswers(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    identityEmail: string | undefined;
    deliveryId: Id<"webhookDeliveries"> | undefined;
  },
): Promise<Map<Id<"leads">, Doc<"bookingIdentityDecisions">["decision"]>> {
  const rows = args.identityEmail
    ? await ctx.db
        .query("bookingIdentityDecisions")
        .withIndex("by_tenantId_and_email_and_leadId", (q) =>
          q.eq("tenantId", args.tenantId).eq("email", args.identityEmail),
        )
        .take(IDENTITY_ANSWER_LIMIT + 1)
    : args.deliveryId
      ? await ctx.db
          .query("bookingIdentityDecisions")
          .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
          .take(IDENTITY_ANSWER_LIMIT + 1)
      : [];
  const answers = new Map<Id<"leads">, Doc<"bookingIdentityDecisions">["decision"]>();
  if (rows.length > IDENTITY_ANSWER_LIMIT) return answers;
  for (const row of rows) {
    if (row.tenantId !== args.tenantId) continue;
    const lead = await ctx.db.get("leads", row.leadId);
    if (!lead || lead.tenantId !== args.tenantId) continue;
    const current = await followMergeChain(ctx, lead);
    if (current) answers.set(current._id, row.decision);
  }
  return answers;
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

  // The 50 newest leads. Prospects are left out: they have no email, and
  // there are far more of them than leads
  // (docs/plans/phase-2-person-first.md §8).
  const recentRows = await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_visible_lifecycle_firstSeenAt", (q) =>
      q.eq("tenantId", tenantId).eq("isSearchVisible", true).eq("lifecycle", "lead"),
    )
    .order("desc")
    .take(50);

  for (const row of recentRows) {
    const candidate = await ctx.db.get("leads", row.leadId);
    if (
      !candidate ||
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
  // A placeholder email (email@gmail.com) never decides identity: it is not
  // looked up, not stored as an identifier, and never becomes the lead's email.
  const identityEmail =
    normalizedEmail && !isPlaceholderEmail(normalizedEmail)
      ? normalizedEmail
      : undefined;
  const rawSocialHandle =
    args.socialHandle?.rawValue ?? args.socialHandle?.handle ?? "";
  const normalizedSocialHandle = args.socialHandle
    ? normalizeSocialHandle(rawSocialHandle, args.socialHandle.platform)
    : undefined;
  const normalizedPhone = args.phone ? normalizePhone(args.phone) : undefined;

  const matches: { lead: Doc<"leads">; via: "email" | "social_handle" | "phone" }[] = [];
  if (identityEmail) {
    const legacy = await ctx.db.query("leads").withIndex("by_tenantId_and_email", q => q.eq("tenantId", args.tenantId).eq("email", identityEmail)).take(17);
    if (legacy.length > 16)
      blockBooking("identity_conflict", undefined, holdEvidence("identifier_overflow", [], { truncated: true }));
    for (const lead of legacy) {
      const resolved = await followMergeChain(ctx, lead);
      if (!resolved) blockBooking("invalid_identity_relationship");
      matches.push({ lead: resolved, via: "email" });
    }
    const lead = await findLeadByIdentifier(ctx, { tenantId: args.tenantId, type: "email", value: identityEmail });
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
  const booking: BookingIdentifiers = {
    ...(args.fullName?.trim() && { name: args.fullName.trim() }),
    ...(identityEmail && { email: identityEmail }),
    ...(normalizedPhone && { phone: normalizedPhone }),
    ...(normalizedSocialHandle && args.socialHandle && {
      socialHandle: { platform: args.socialHandle.platform, handle: normalizedSocialHandle },
    }),
  };
  // An admin may already have answered whether a person the phone alone
  // names is the one with this email ("Is this the same person?"). Bookings
  // only, and only when no handle matched anyone: a handle decides as it
  // always has. "Different person" drops that phone match and the person
  // keeps the phone; "Same person" lets the booking past the phone-only
  // check below. A booking with no phone-only match reads nothing.
  let withholdPhone = false;
  let samePersonAnswered = false;
  if (isBooking && !matches.some(m => m.via === "social_handle")) {
    const phoneOnly = [...new Set(matches.filter(m => m.via === "phone").map(m => m.lead._id))]
      .filter(leadId => !matches.some(m => m.lead._id === leadId && m.via !== "phone"));
    if (phoneOnly.length) {
      const answers = await readIdentityAnswers(ctx, {
        tenantId: args.tenantId,
        identityEmail,
        deliveryId: args.deliveryId,
      });
      for (const leadId of phoneOnly) {
        const answer = answers.get(leadId);
        if (answer === "different_person") {
          for (let i = matches.length - 1; i >= 0; i--)
            if (matches[i].lead._id === leadId) matches.splice(i, 1);
          withholdPhone = true;
        } else if (answer === "same_person" && new Set(matches.map(m => m.lead._id)).size === 1) {
          samePersonAnswered = true;
        }
      }
    }
  }
  let conflicts: IdentityConflict[] | undefined;
  if (isBooking && new Set(matches.map(m => m.lead._id)).size > 1) {
    // The social handle (the Instagram username on the Calendly form) decides.
    // Setters and DM closers book calls for the people they talk to, and may
    // type someone else's email or phone; the handle is the one the person
    // was qualified under. The other people keep their identifiers, and the
    // booking opens a review (docs/adr/0001-lead-lifecycle-model.md).
    const handleMatch = matches.find(m => m.via === "social_handle");
    if (!handleMatch)
      blockBooking(
        "identity_conflict",
        { conflicts: distinctConflicts(matches), booking },
        holdEvidence("several_people", distinctConflicts(matches)),
      );
    conflicts = distinctConflicts(matches.filter(m => m.lead._id !== handleMatch.lead._id));
    matches.splice(0, matches.length, handleMatch);
  }
  const match = matches[0];
  if (match) {
    if (isBooking && normalizedEmail && match.lead.email && normalizeEmail(match.lead.email) !== normalizedEmail) {
      // The canonical email is never changed here. All matches point at one
      // lead (checked above), so an email match means the email is already
      // one of this lead's known emails. Otherwise the email belongs to no
      // lead: a social handle vouches for it (the pipeline stores it as an
      // extra email identifier), but a phone alone does not, because shared
      // and fake phones once merged dozens of people into one lead. A
      // placeholder email counts as a different email here, so a phone alone
      // can't attach it to a lead that has a real one either. The booking is
      // held for "Is this the same person?", and an admin's "same person"
      // answer lets it through.
      const emailIsKnown = matches.some(m => m.via === "email");
      const handleMatched = matches.some(m => m.via === "social_handle");
      if (!emailIsKnown && !handleMatched && !samePersonAnswered)
        blockBooking(
          "phone_match_new_email",
          { conflicts: [{ leadId: match.lead._id, via: "phone" }], booking },
          holdEvidence("phone_only_new_email", [{ leadId: match.lead._id, via: "phone" }]),
        );
      if (await isPlaceholderPollutedLead(ctx, match.lead._id))
        blockBooking(
          "identity_conflict",
          conflicts && {
            conflicts: [{ leadId: match.lead._id, via: match.via }, ...conflicts],
            booking,
          },
          holdEvidence("polluted_person", [
            { leadId: match.lead._id, via: match.via },
            ...(conflicts ?? []),
          ]),
        );
    }
    // An identifier another person holds is theirs, not this booking's.
    const contested = new Set(conflicts?.map(c => c.via));
    if (withholdPhone) contested.add("phone");
    const lead = await syncSubmittedIdentifiersForExistingLead(
      ctx,
      match.lead,
      {
        ...args,
        ...(contested.has("email") && { email: undefined }),
        ...(contested.has("phone") && { phone: undefined }),
      },
      contested.has("email") ? undefined : identityEmail,
    );
    return {
      lead,
      leadId: lead._id,
      created: false,
      isNewLead: false,
      resolvedVia: match.via,
      ...(conflicts && { conflicts, booking }),
      ...(withholdPhone && { withheld: ["phone" as const] }),
    };
  }

  if (!createIfMissing) {
    throw new Error("Lead not found.");
  }
  // A placeholder email still counts as input here: a booking that has only
  // one gets a lead with no email and no identifiers.
  if (!normalizedEmail && !normalizedSocialHandle && !normalizedPhone) {
    throw new Error(
      "Cannot create lead - at least one of email, socialHandle, or phone is required.",
    );
  }

  if (!args.initialLifecycle) {
    throw new Error("Creating a lead needs its initial lifecycle stage.");
  }
  const fullName = args.fullName?.trim() || undefined;
  // A phone an admin said belongs to someone else stays theirs.
  const phone = withholdPhone ? undefined : args.phone?.trim() || undefined;
  const keptPhone = withholdPhone ? undefined : normalizedPhone;
  const leadId = await ctx.db.insert("leads", {
    ...initialLifecycleFields(args.initialLifecycle),
    tenantId: args.tenantId,
    email: identityEmail,
    fullName,
    phone,
    customFields: undefined,
    status: "active",
    // No touch yet, so out of the respark pool until the event that
    // touches them (docs/plans/respark.md §4.4).
    resparkGroup: "out",
    firstSeenAt: args.createdAt,
    updatedAt: args.createdAt,
    searchText: buildLeadSearchText({
      fullName,
      email: identityEmail,
      phone,
      socialHandles: undefined,
    }),
  });

  let socialHandles: NonNullable<Doc<"leads">["socialHandles"]> | undefined;
  if (args.createIdentifiers ?? false) {
    socialHandles = await createManualIdentifiers(ctx, {
      tenantId: args.tenantId,
      leadId,
      email: identityEmail,
      rawEmail: args.email,
      phone,
      socialHandle: args.socialHandle,
      source: args.identifierSource,
      createdAt: args.createdAt,
    });

    const identifierValues = [
      identityEmail,
      keptPhone,
      normalizedSocialHandle,
    ].filter((value): value is string => Boolean(value));
    if (socialHandles?.[0]) {
      identifierValues.push(socialHandles[0].handle);
    }

    await ctx.db.patch("leads", leadId, {
      socialHandles,
      searchText: buildLeadSearchText(
        {
          fullName,
          email: identityEmail,
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

  await syncLeadStageEntries(ctx, args.tenantId, leadId, null, readLifecycle(newLead));
  await rebuildLeadCustomerSearchRow(ctx, args.tenantId, leadId);

  const potentialDuplicateLeadId = identityEmail
    ? await detectPotentialDuplicate(
        ctx,
        args.tenantId,
        fullName,
        identityEmail,
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
    ...(withholdPhone && { withheld: ["phone" as const] }),
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
