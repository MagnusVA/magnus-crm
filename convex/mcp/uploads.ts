import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  env,
  httpAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { mcpCallerValidator, requireMcpUser } from "./guard";
import { sha256Hex } from "./confirm";

/**
 * Proof files for agents with a shell (docs/plans/closer-assistant.md §6.3).
 * `magnus_proof_upload_url` issues a single-use URL; the agent runs
 * `curl --data-binary @receipt.pdf <url>`; the route below checks and stores
 * the file and returns an `uploadId` that `magnus_log_payment` attaches.
 *
 * The ticket is 32 random bytes and only its SHA-256 is stored. It can only
 * upload, works once, belongs to one user and expires in 10 minutes. The
 * route never hands out a raw Convex upload URL, because a `_storage` ID
 * alone doesn't say who uploaded the file.
 */
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const TICKET_TTL_MS = 10 * 60 * 1000;
// A ready file nothing attaches within an hour expires and is deleted.
const READY_TTL_MS = 60 * 60 * 1000;

export type ProofType = "image/jpeg" | "image/png" | "image/gif" | "application/pdf";

/** Decides the type from the first bytes, never from a header or a name. */
export function sniffProofType(bytes: Uint8Array): ProofType | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  return null;
}

function ticketFromBytes(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c] ?? "");
}

function uploadBaseUrl(): string | null {
  const resource = env.MCP_RESOURCE_URL?.trim();
  if (!resource) return null;
  try {
    return new URL(resource).origin;
  } catch {
    return null;
  }
}

/** `magnus_proof_upload_url`. */
export const issueUploadUrl = internalMutation({
  args: { caller: mcpCallerValidator },
  returns: v.object({
    uploadUrl: v.string(),
    uploadId: v.id("paymentProofUploads"),
    expiresInSeconds: v.number(),
    instructions: v.string(),
  }),
  handler: async (ctx, { caller }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const base = uploadBaseUrl();
    if (!base) throw new Error("MCP_RESOURCE_URL is not set");
    const ticket = ticketFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    const uploadId = await ctx.db.insert("paymentProofUploads", {
      tenantId: me.tenantId,
      userId: me.userId,
      source: "upload_url",
      ticketHash: await sha256Hex(ticket),
      ticketExpiresAt: now + TICKET_TTL_MS,
      status: "pending",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(READY_TTL_MS, internal.mcp.uploads.expireUpload, { uploadId });
    return {
      uploadUrl: `${base}/mcp/uploads/${ticket}`,
      uploadId,
      expiresInSeconds: TICKET_TTL_MS / 1000,
      instructions:
        "POST the file's raw bytes to uploadUrl, for example: curl --data-binary @receipt.pdf <uploadUrl>. JPEG, PNG, GIF or PDF, up to 10 MB. The URL works once.",
    };
  },
});

export const checkTicket = internalQuery({
  args: { ticketHash: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string(), status: v.number() }),
  ),
  handler: async (ctx, { ticketHash }) => {
    const upload = await ctx.db
      .query("paymentProofUploads")
      .withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
      .first();
    if (!upload) return { ok: false as const, code: "upload.unknown", message: "This upload link isn't valid. Ask for a new one.", status: 404 };
    if (upload.status !== "pending") return { ok: false as const, code: "upload.used", message: "This upload link was already used. Ask for a new one.", status: 410 };
    if ((upload.ticketExpiresAt ?? 0) < Date.now()) return { ok: false as const, code: "upload.expired", message: "This upload link expired. Ask for a new one.", status: 410 };
    return { ok: true as const };
  },
});

/** Claims the ticket and records the stored file, atomically. */
export const claimTicket = internalMutation({
  args: {
    ticketHash: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), uploadId: v.id("paymentProofUploads"), sizeBytes: v.number() }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string(), status: v.number() }),
  ),
  handler: async (ctx, { ticketHash, storageId, contentType }) => {
    const upload = await ctx.db
      .query("paymentProofUploads")
      .withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
      .first();
    const reject = (code: string, message: string, status: number) => ({ ok: false as const, code, message, status });
    if (!upload) return reject("upload.unknown", "This upload link isn't valid. Ask for a new one.", 404);
    if (upload.status !== "pending") return reject("upload.used", "This upload link was already used. Ask for a new one.", 410);
    if ((upload.ticketExpiresAt ?? 0) < Date.now()) return reject("upload.expired", "This upload link expired. Ask for a new one.", 410);
    const file = await ctx.db.system.get("_storage", storageId);
    if (!file) return reject("upload.failed", "The file didn't store. Try again with a new link.", 500);
    await ctx.db.patch("paymentProofUploads", upload._id, {
      status: "ready",
      storageId,
      contentType,
      sizeBytes: file.size,
      sha256: file.sha256,
    });
    return { ok: true as const, uploadId: upload._id, sizeBytes: file.size };
  },
});

/** Expires an upload nothing attached, and deletes its file. */
export const expireUpload = internalMutation({
  args: { uploadId: v.id("paymentProofUploads") },
  returns: v.null(),
  handler: async (ctx, { uploadId }) => {
    const upload = await ctx.db.get("paymentProofUploads", uploadId);
    if (!upload || upload.status === "attached" || upload.status === "expired") return null;
    if (upload.storageId) await ctx.storage.delete(upload.storageId);
    await ctx.db.patch("paymentProofUploads", uploadId, { status: "expired", storageId: undefined });
    return null;
  },
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** `POST /mcp/uploads/<ticket>`. */
export const handleProofUpload = httpAction(async (ctx, request) => {
  const ticket = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(ticket)) {
    return json(404, { code: "upload.unknown", error: "This upload link isn't valid. Ask for a new one." });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_PROOF_BYTES) {
    return json(413, { code: "upload.too_large", error: "That file is over 10 MB." });
  }
  const ticketHash = await sha256Hex(ticket);
  const check = await ctx.runQuery(internal.mcp.uploads.checkTicket, { ticketHash });
  if (!check.ok) return json(check.status, { code: check.code, error: check.message });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return json(400, { code: "upload.empty", error: "The upload had no file in it." });
  if (bytes.byteLength > MAX_PROOF_BYTES) return json(413, { code: "upload.too_large", error: "That file is over 10 MB." });
  const contentType = sniffProofType(bytes);
  if (!contentType) {
    return json(415, { code: "upload.bad_type", error: "Proof must be a JPEG, PNG, GIF or PDF." });
  }
  const storageId: Id<"_storage"> = await ctx.storage.store(new Blob([bytes], { type: contentType }));
  const claimed = await ctx.runMutation(internal.mcp.uploads.claimTicket, { ticketHash, storageId, contentType });
  if (!claimed.ok) {
    await ctx.storage.delete(storageId);
    return json(claimed.status, { code: claimed.code, error: claimed.message });
  }
  return json(200, { uploadId: claimed.uploadId, status: "ready", type: contentType, sizeBytes: claimed.sizeBytes });
});
