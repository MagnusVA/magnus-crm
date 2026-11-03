import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { rejectRequest } from "../lib/observability/errors";

/**
 * Preview, then commit, for writes that last (decision 17). The preview
 * stores the arguments' hash with a random token; the commit must present the
 * token and the same arguments within ten minutes, so the model can't change
 * the amount between the read-back and the write. A used token keeps the
 * result, and a retried commit returns it instead of writing twice.
 */
const CONFIRM_TTL_MS = 10 * 60 * 1000;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON: object keys sorted, undefined dropped. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `ct_${btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c] ?? "")}`;
}

export async function issueConfirmation(
  ctx: MutationCtx,
  who: { tenantId: Id<"tenants">; userId: Id<"users"> },
  tool: string,
  args: unknown,
  preview: string,
): Promise<{ preview: string; confirmToken: string; expiresInSeconds: number }> {
  const token = randomToken();
  await ctx.db.insert("mcpConfirmations", {
    tenantId: who.tenantId,
    userId: who.userId,
    tool,
    tokenHash: await sha256Hex(token),
    argsHash: await sha256Hex(stableJson(args)),
    preview,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  return { preview, confirmToken: token, expiresInSeconds: CONFIRM_TTL_MS / 1000 };
}

/**
 * Checks a commit's token. A token already used returns its stored result, so
 * the caller hands it back instead of writing twice. Otherwise the caller may
 * write, then must call `markConfirmationUsed` in the same transaction.
 */
export async function redeemConfirmation(
  ctx: MutationCtx,
  who: { userId: Id<"users"> },
  tool: string,
  token: string | undefined,
  args: unknown,
): Promise<
  | { kind: "replay"; result: unknown }
  | { kind: "fresh"; confirmationId: Id<"mcpConfirmations"> }
> {
  if (!token) {
    throw rejectRequest(
      "confirm.token_required",
      "Preview first with confirm: false, read the preview to the closer, then commit with its confirmToken.",
    );
  }
  const tokenHash = await sha256Hex(token);
  const row = await ctx.db
    .query("mcpConfirmations")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .first();
  if (!row || row.userId !== who.userId || row.tool !== tool) {
    throw rejectRequest(
      "confirm.token_unknown",
      "That preview token isn't valid. Preview again, then ask the closer.",
    );
  }
  if (row.usedAt !== undefined) {
    return { kind: "replay", result: row.resultJson ? JSON.parse(row.resultJson) : null };
  }
  if (row.expiresAt < Date.now()) {
    throw rejectRequest("confirm.expired", "That preview expired. Preview it again, then ask the closer.");
  }
  if (row.argsHash !== (await sha256Hex(stableJson(args)))) {
    throw rejectRequest(
      "confirm.args_changed",
      "These details differ from the preview. Preview again, then ask the closer.",
    );
  }
  return { kind: "fresh", confirmationId: row._id };
}

export async function markConfirmationUsed(
  ctx: MutationCtx,
  confirmationId: Id<"mcpConfirmations">,
  result: unknown,
): Promise<void> {
  await ctx.db.patch("mcpConfirmations", confirmationId, {
    usedAt: Date.now(),
    resultJson: JSON.stringify(result ?? null),
  });
}
