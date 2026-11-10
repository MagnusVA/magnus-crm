import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { contactAgainViewValidator, projectContactAgain, setContactAgainCore } from "../../leadGen/contactAgain";
import { loadStaffRedactor } from "../../leadGen/assistantText";
import { formatLocal } from "../time";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";

/**
 * `magnus_set_contact_again`: save or clear the date a person asked to be
 * contacted again (docs/plans/lead-gen-assistant.md, "Release 2").
 */
export const contactAgainArgs = {
  submissionId: v.optional(v.id("leadGenSubmissions")),
  itemId: v.optional(v.id("resparkBatchItems")),
  date: v.union(v.string(), v.null()),
  note: v.optional(v.string()),
};

export const setContactAgain = internalMutation({
  args: { caller: mcpCallerValidator, ...contactAgainArgs },
  returns: v.object({ changed: v.boolean(), contactAgain: v.union(v.object({
    date: v.string(), at: v.string(), note: contactAgainViewValidator.fields.note,
    withheldReason: contactAgainViewValidator.fields.withheldReason,
  }), v.null()), message: v.string() }),
  handler: async (ctx, { caller, ...args }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const result = await setContactAgainCore(ctx, me, args, Date.now(), { via: "mcp", agentClient: me.agentClient });
    const saved = projectContactAgain(result.lead, await loadStaffRedactor(ctx, me.tenantId));
    return { changed: result.changed, contactAgain: saved ? { ...saved, at: formatLocal(saved.at, me.timeZone) } : null,
      message: saved ? `Contact again on ${saved.date}. Until then, this person waits out of respark batches. No message or respark was recorded.` : "Contact-again date cleared." };
  },
});
