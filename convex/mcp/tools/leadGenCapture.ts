import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { captureConfirmation } from "../../../lib/lead-gen/capture-confirmation";
import { requireOperationalLeadGenWorker, resolveCaptureOrigin, submitCaptureCore } from "../../leadGen/capture";
import { lookupHandle, mergeLookups, verdictLine, type HandleLookup } from "../../leadGen/handleLookup";
import { normalizeLeadGenOrigin } from "../../leadGen/normalization";
import { leadGenOriginKindValidator, leadGenSourceValidator } from "../../leadGen/validators";
import { rejectRequest } from "../../lib/observability/errors";
import { maskContactText } from "../../lib/respark/people";
import { rememberTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation, sha256Hex, stableJson } from "../confirm";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { listPreview, sameAsPreview, withAgentErrors } from "../leadGenShared";

/**
 * `magnus_capture_prospects`: save a short list of handles from one origin
 * (docs/plans/lead-gen-assistant.md §2 row 10, §3). Two calls. The preview
 * reads every line and saves nothing. The commit reads every line again, and
 * saves only if the preview still says the same thing, all lines in one
 * transaction: one line that fails saves none, and the token stays unused.
 *
 * Each line's retry key comes from the user, the requestKey, the source, the
 * handle and the origin, not from the token. So the same list sent again
 * returns the rows it saved, even after a second preview, and a deliberate
 * repeat with a new requestKey is a new capture, counted as the web counts it.
 */
const TOOL = "magnus_capture_prospects";
export const MAX_CAPTURE_LINES = 10;
const MAX_REQUEST_KEY = 100;
const POST_OR_REEL_URL = /^https?:\/\/(www\.)?instagram\.com\/(?:[^/?#]+\/)?(p|reel|reels|tv)\/[^/?#]+/i;

export const captureArgs = {
  requestKey: v.string(),
  source: leadGenSourceValidator,
  origin: v.object({ kind: leadGenOriginKindValidator, value: v.optional(v.string()) }),
  handles: v.array(v.string()),
  includeDoNotContact: v.optional(v.boolean()),
  confirm: v.boolean(),
  confirmToken: v.optional(v.string()),
};

type CaptureArgs = {
  requestKey: string;
  source: Doc<"leadGenSubmissions">["source"];
  origin: { kind: Doc<"leadGenSubmissions">["originKind"]; value?: string };
  handles: string[];
  includeDoNotContact?: boolean;
};

type PlannedLine = {
  input: string;
  handle: string | null;
  verdict: Extract<HandleLookup, { valid: true }>["verdict"] | "invalid";
  summary: string;
  willSave: boolean;
  leftOut: string | null;
  key: string | null;
  saved: Doc<"leadGenSubmissions"> | null;
};

async function planCapture(ctx: MutationCtx, me: McpUser, workerId: Id<"leadGenWorkers">, args: CaptureArgs) {
  const requestKey = args.requestKey.trim();
  if (!requestKey || requestKey.length > MAX_REQUEST_KEY) {
    throw rejectRequest("capture.request_key", `Pass a requestKey of 1 to ${MAX_REQUEST_KEY} characters, new for each list.`);
  }
  if (args.handles.length < 1 || args.handles.length > MAX_CAPTURE_LINES) {
    throw rejectRequest("capture.count", `Pass 1 to ${MAX_CAPTURE_LINES} handles in one call.`);
  }
  const submitted = await withAgentErrors("capture.refused", () =>
    resolveCaptureOrigin({ source: args.source, originKind: args.origin.kind, originUrlOrLabel: args.origin.value }),
  );
  const rankable = submitted.originKind === "post" || submitted.originKind === "reel";
  if (rankable && !submitted.originUrlOrLabel?.trim()) {
    throw rejectRequest("capture.origin_url", "A post or reel origin needs its URL in origin.value.");
  }
  const origin = await withAgentErrors("capture.refused", () => normalizeLeadGenOrigin(submitted));

  const warnings: string[] = [];
  const postNotes: string[] = [];
  if (rankable && origin.originValue && !POST_OR_REEL_URL.test(origin.originValue)) {
    warnings.push("The origin doesn't look like a post or reel link. It may be a profile.");
  }
  if (rankable && origin.originKey) {
    const originKey = origin.originKey;
    const known = await ctx.db
      .query("leadGenOriginPreviews")
      .withIndex("by_tenantId_and_originKey", (q) => q.eq("tenantId", me.tenantId).eq("originKey", originKey))
      .first();
    if (known) {
      // Cached identity is advisory, and cannot add a numbered preview line.
      const oneLine = (value: string | undefined) => {
        const safe = maskContactText(value ?? "", [])
          .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { text: safe.slice(0, 180), truncated: safe.length > 180 };
      };
      const authorText = oneLine(known.authorName);
      const handleText = oneLine(known.handle);
      const author = authorText.text;
      const handle = handleText.text.replace(/^@/, "");
      const rawDate = known.postedOn ?? "";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && !Number.isNaN(Date.parse(rawDate)) && new Date(rawDate).toISOString().slice(0, 10) === rawDate ? rawDate : "";
      const identity = author || handle;
      if (identity || date) {
        const by = author && handle ? `${author} (@${handle})` : author || `@${handle}`;
        postNotes.push(`Post${identity ? ` by ${JSON.stringify({ text: by, personSupplied: true, truncated: authorText.truncated || handleText.truncated })}` : ""}${date ? `, posted on ${date}` : ""}.`);
      }
    }
    if (!known) warnings.push("This post or reel hasn't been used as an origin before. Check it's the right one.");
  }

  const lookups: HandleLookup[] = [];
  for (const input of args.handles) lookups.push(await lookupHandle(ctx, me.tenantId, input));

  const lines: PlannedLine[] = [];
  for (const lookup of mergeLookups(lookups)) {
    if (!lookup.valid) {
      lines.push({
        input: lookup.input,
        handle: null,
        verdict: "invalid",
        summary: lookup.reason,
        willSave: false,
        leftOut: "Left out.",
        key: null,
        saved: null,
      });
      continue;
    }
    const key = `mcp:${await sha256Hex(
      stableJson([me.userId, requestKey, args.source, lookup.dedupeKey, origin.originKey ?? submitted.originKind]),
    )}`;
    const saved = await ctx.db
      .query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_clientSubmissionKey", (q) =>
        q.eq("tenantId", me.tenantId).eq("workerId", workerId).eq("clientSubmissionKey", key),
      )
      .unique();
    let leftOut: string | null = null;
    if (saved) leftOut = "Already saved from this list.";
    else if (lookup.verdict === "conflict") leftOut = "Left out until an admin merges them.";
    else if (lookup.verdict === "do_not_contact" && !args.includeDoNotContact) leftOut = "Left out.";
    lines.push({
      input: lookup.input,
      handle: lookup.handle,
      verdict: lookup.verdict,
      summary: verdictLine(lookup),
      willSave: leftOut === null,
      leftOut,
      key,
      saved,
    });
  }

  const willSave = lines.filter((line) => line.willSave).length;
  const from =
    submitted.originKind === "source_only"
      ? "Meta Business"
      : `${submitted.originKind.replace("_", " ")}${origin.originValue ? ` ${origin.originValue}` : ""}`;
  const textLines = lines.map((line) => {
    const name = line.handle ? `@${line.handle}` : `"${line.input.slice(0, 60)}"`;
    const effect = line.willSave
      ? line.verdict === "captured_before"
        ? "Will save, and it counts as a dupe."
        : "Will save."
      : (line.leftOut ?? "Left out.");
    return `${name}: ${line.summary}. ${effect}`;
  });
  const previewText = listPreview(
    `Save ${willSave} of ${lines.length} ${lines.length === 1 ? "handle" : "handles"} as ${me.user.fullName ?? me.user.email}, from ${from}:`,
    textLines,
    [...postNotes, ...warnings.map((warning) => `Warning: ${warning}`), "A lead gen can't undo a capture."],
  );

  return { lines, textLines, willSave, warnings, previewText, submitted };
}

const lineValidator = v.object({
  input: v.string(),
  handle: v.union(v.string(), v.null()),
  verdict: v.string(),
  summary: v.string(),
  willSave: v.boolean(),
  leftOut: v.union(v.string(), v.null()),
});

const previewValidator = v.object({
  preview: v.string(),
  lines: v.array(lineValidator),
  warnings: v.array(v.string()),
  willSave: v.number(),
  // Absent when no line would save.
  confirmToken: v.optional(v.string()),
  expiresInSeconds: v.optional(v.number()),
});

const commitValidator = v.object({
  ok: v.literal(true),
  saved: v.array(
    v.object({
      handle: v.string(),
      submissionId: v.id("leadGenSubmissions"),
      kind: v.string(),
      confirmation: v.string(),
    }),
  ),
  alreadySaved: v.array(
    v.object({ handle: v.string(), submissionId: v.id("leadGenSubmissions"), voided: v.boolean() }),
  ),
  leftOut: v.array(v.object({ input: v.string(), handle: v.union(v.string(), v.null()), reason: v.string() })),
  message: v.string(),
});

function publicLine(line: PlannedLine) {
  return {
    input: line.input,
    handle: line.handle,
    verdict: line.verdict,
    summary: line.summary,
    willSave: line.willSave,
    leftOut: line.leftOut,
  };
}

async function activeWorker(ctx: MutationCtx, me: McpUser) {
  const worker = await ctx.db
    .query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", me.tenantId).eq("userId", me.userId))
    .unique();
  if (!worker?.isActive) {
    throw rejectRequest("lead_gen.inactive", "Lead gen access isn't active for you. Ask an admin.");
  }
  return worker;
}

export const capture = internalMutation({
  args: { caller: mcpCallerValidator, ...captureArgs },
  returns: v.union(previewValidator, commitValidator),
  handler: async (ctx, { caller, confirm, confirmToken, ...args }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    // What the token is bound to: the list as the lead gen gave it.
    const hashed = {
      requestKey: args.requestKey.trim(),
      source: args.source,
      origin: { kind: args.origin.kind, value: args.origin.value?.trim() ?? null },
      handles: args.handles,
      includeDoNotContact: args.includeDoNotContact === true,
    };

    if (!confirm) {
      const worker = await activeWorker(ctx, me);
      const plan = await planCapture(ctx, me, worker._id, args);
      const body = {
        preview: plan.previewText,
        lines: plan.lines.map(publicLine),
        warnings: plan.warnings,
        willSave: plan.willSave,
      };
      if (plan.willSave === 0) return body;
      const issued = await issueConfirmation(ctx, me, TOOL, hashed, plan.previewText);
      return { ...body, confirmToken: issued.confirmToken, expiresInSeconds: issued.expiresInSeconds };
    }

    const redeemed = await redeemConfirmation(ctx, me, TOOL, confirmToken, hashed);
    if (redeemed.kind === "replay") return redeemed.result as never;

    const now = Date.now();
    const worker = await withAgentErrors("capture.refused", () => requireOperationalLeadGenWorker(ctx, me, now));
    const plan = await planCapture(ctx, me, worker._id, args);
    const alreadySaved = plan.lines.map((line) => line.saved !== null);
    if (!sameAsPreview(redeemed.preview, plan.textLines, alreadySaved)) {
      // A teammate captured one of them, or someone's status changed. Nothing
      // is saved and the token stays unused.
      throw rejectRequest("capture.changed", "Something changed since the preview. Preview again, then ask for a yes.");
    }

    const timeZone = rememberTenantBusinessDay(ctx, me.tenant).timeZone;
    const saved = [];
    // One at a time: the lines share the day's and the origin's aggregate rows.
    for (const line of plan.lines) {
      if (!line.willSave || !line.handle || !line.key) continue;
      const result = await withAgentErrors("capture.refused", () =>
        submitCaptureCore(
          ctx,
          me,
          worker,
          {
            source: args.source,
            rawHandleOrProfileUrl: line.handle!,
            originKind: plan.submitted.originKind,
            originUrlOrLabel: plan.submitted.originUrlOrLabel,
            clientSubmissionKey: line.key!,
          },
          now,
          { via: "mcp", agentClient: me.agentClient },
        ),
      );
      const said = captureConfirmation(result, now, timeZone);
      saved.push({
        handle: line.handle,
        submissionId: result.submissionId,
        kind: said.kind,
        confirmation: said.detail ? `${said.title}. ${said.detail}` : said.title,
      });
    }

    const result = {
      ok: true as const,
      saved,
      alreadySaved: plan.lines
        .filter((line) => line.saved && line.handle)
        .map((line) => ({
          handle: line.handle!,
          submissionId: line.saved!._id,
          voided: line.saved!.voidedAt !== undefined,
        })),
      leftOut: plan.lines
        .filter((line) => !line.willSave && !line.saved)
        .map((line) => ({ input: line.input, handle: line.handle, reason: `${line.summary}. ${line.leftOut ?? "Left out."}` })),
      message: `Saved ${saved.length} ${saved.length === 1 ? "capture" : "captures"}.`,
    };
    await markConfirmationUsed(ctx, redeemed.confirmationId, result);
    return result;
  },
});
