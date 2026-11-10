import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { businessDayStart } from "../../lib/businessDay";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { CONTACT_AGAIN_NOTE_MAX, contactAgainForbidden, visibleContactAgain, type ContactAgain } from "../lib/contactAgain";
import { emitDomainEvent } from "../lib/domainEvents";
import { rejectRequest } from "../lib/observability/errors";
import { isAdminRole } from "../lib/roleMapping";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import type { Provenance } from "../mcp/guard";
import { loadStaffRedactor, type StaffRedactor } from "./assistantText";

export const contactAgainTargetArgs = {
  submissionId: v.optional(v.id("leadGenSubmissions")),
  itemId: v.optional(v.id("resparkBatchItems")),
  leadId: v.optional(v.id("leads")),
};
type Target = { submissionId?: Doc<"leadGenSubmissions">["_id"]; itemId?: Doc<"resparkBatchItems">["_id"]; leadId?: Doc<"leads">["_id"] };
export const contactAgainViewValidator = v.object({
  date: v.string(), at: v.number(),
  note: v.union(v.object({ text: v.string(), personSupplied: v.literal(true), truncated: v.boolean() }), v.null()),
  withheldReason: v.union(v.literal("staff_roster_too_large"), v.null()),
});
export type ContactAgainView = Infer<typeof contactAgainViewValidator>;

/** No setter identity is exposed. A lead gen's note uses the shared staff redactor. */
export function projectContactAgain(lead: Doc<"leads">, redactor?: StaffRedactor): ContactAgainView | null {
  const saved = visibleContactAgain(lead);
  if (!saved) return null;
  const safe = redactor?.safeNote(saved.note, [lead]);
  return { date: saved.date, at: saved.at,
    note: safe ? safe.note : { text: saved.note, personSupplied: true, truncated: false },
    withheldReason: safe?.withheld ?? null };
}

async function resolveTarget(ctx: QueryCtx, access: TenantUserResult, target: Target, now: number) {
  const { tenantId, userId, role } = access;
  if ([target.submissionId, target.itemId, target.leadId].filter(Boolean).length !== 1) {
    throw rejectRequest("contact_again.target", "Choose one capture or one person.");
  }
  const admin = isAdminRole(role);
  if (role === "closer") {
    throw rejectRequest("contact_again.forbidden", "Only an admin can change this date.");
  }
  if (target.leadId) {
    if (!admin) throw rejectRequest("contact_again.proof", "Choose one of your captures or a person in your held batch.");
    const lead = await ctx.db.get("leads", target.leadId);
    if (!lead || lead.tenantId !== tenantId) throw rejectRequest("contact_again.not_found", "Person not found.");
    return lead;
  }
  const worker = admin ? null : await ctx.db.query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", q => q.eq("tenantId", tenantId).eq("userId", userId)).unique();
  if (!admin && !worker?.isActive) throw rejectRequest("lead_gen.inactive", "Lead gen access isn't active for you.");
  if (target.submissionId) {
    const submission = await ctx.db.get("leadGenSubmissions", target.submissionId);
    if (!submission || submission.tenantId !== tenantId || submission.voidedAt !== undefined ||
      (!admin && (submission.workerId !== worker!._id || submission.userId !== userId))) {
      throw rejectRequest("contact_again.capture", "Choose one of your captures that hasn't been voided.");
    }
    const prospect = await ctx.db.get("leadGenProspects", submission.prospectId);
    const lead = prospect?.tenantId === tenantId ? await ctx.db.get("leads", prospect.leadId) : null;
    if (!lead || lead.tenantId !== tenantId) throw rejectRequest("contact_again.not_found", "Person not found.");
    return lead;
  }
  const item = await ctx.db.get("resparkBatchItems", target.itemId!);
  const batch = item?.tenantId === tenantId ? await ctx.db.get("resparkBatches", item.batchId) : null;
  if (!item || !batch || batch.tenantId !== tenantId || item.heldUntil <= now || batch.heldUntil <= now ||
    (!admin && (item.userId !== userId || batch.userId !== userId || item.workerId !== worker!._id ||
      batch.workerId !== worker!._id || !worker!.teamId || batch.teamId !== worker!.teamId))) {
    throw rejectRequest("contact_again.batch", "Choose a person in your held batch before it ends.");
  }
  const lead = await ctx.db.get("leads", item.leadId);
  if (!lead || lead.tenantId !== tenantId || (!admin && lead.resparkTeamId !== worker!.teamId)) {
    throw rejectRequest("contact_again.not_found", "This person is no longer in your team's pool.");
  }
  return lead;
}

export async function setContactAgainCore(
  ctx: MutationCtx, access: TenantUserResult, args: Target & { date: string | null; note?: string },
  now: number, provenance: Provenance = { via: "web" },
) {
  const lead = await resolveTarget(ctx, access, args, now);
  const forbidden = contactAgainForbidden(lead);
  if (forbidden) throw rejectRequest("contact_again.forbidden", forbidden);
  const before = lead.contactAgain;
  let after: ContactAgain | undefined;
  if (args.date !== null) {
    const note = args.note?.trim() ?? "";
    if (!note || note.length > CONTACT_AGAIN_NOTE_MAX) throw rejectRequest("contact_again.note", "Write a note of 1 to 500 characters.");
    const setting = await getTenantBusinessDay(ctx, access.tenantId);
    let at: number;
    try { at = businessDayStart(args.date, setting); }
    catch { throw rejectRequest("contact_again.date", "Choose a real date in YYYY-MM-DD form."); }
    if (at <= now) throw rejectRequest("contact_again.date", "Choose a future business date.");
    if (before?.date === args.date && before.note === note) return { changed: false, lead };
    after = { date: args.date, at, ...setting, note, setByUserId: access.userId, setAt: now };
  } else if (!before) return { changed: false, lead };
  await ctx.db.patch("leads", lead._id, { contactAgain: after });
  await emitDomainEvent(ctx, { tenantId: access.tenantId, entityType: "lead", entityId: lead._id,
    leadId: lead._id, eventType: "lead.contact_again_changed", actorUserId: access.userId,
    source: isAdminRole(access.role) ? "admin" : "pipeline", occurredAt: now,
    metadata: { previousDate: before?.date ?? null, date: after?.date ?? null,
      ...(provenance.via === "mcp" && { via: "mcp", agentClient: provenance.agentClient }) } });
  return { changed: true, lead: { ...lead, contactAgain: after } };
}

export const getContactAgain = query({
  args: { ...contactAgainTargetArgs, currentBusinessDate: v.optional(v.string()) },
  returns: v.object({ contactAgain: v.union(contactAgainViewValidator, v.null()), canEdit: v.boolean(), hidden: v.boolean() }),
  handler: async (ctx, args) => {
    // No closer: a closer's person card shows the date from the person it
    // already loaded, and a lead id alone must not open another person's note.
    const access = await requireTenantUser(ctx, ["tenant_master", "tenant_admin", "lead_generator"]);
    const lead = await resolveTarget(ctx, access, args, Date.now());
    const redactor = access.role === "lead_generator" ? await loadStaffRedactor(ctx, access.tenantId) : undefined;
    return { contactAgain: projectContactAgain(lead, redactor), canEdit: access.role !== "closer", hidden: contactAgainForbidden(lead) !== null };
  },
});
export const setContactAgain = mutation({
  args: { ...contactAgainTargetArgs, date: v.union(v.string(), v.null()), note: v.optional(v.string()) },
  returns: v.object({ changed: v.boolean(), contactAgain: v.union(contactAgainViewValidator, v.null()) }),
  handler: async (ctx, args) => {
    const access = await requireTenantUser(ctx, ["tenant_master", "tenant_admin", "lead_generator"]);
    const result = await setContactAgainCore(ctx, access, args, Date.now());
    const redactor = access.role === "lead_generator" ? await loadStaffRedactor(ctx, access.tenantId) : undefined;
    return { changed: result.changed, contactAgain: projectContactAgain(result.lead, redactor) };
  },
});
