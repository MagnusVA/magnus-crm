import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query, type MutationCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { parseInstagramPreview } from "./instagramPreview";

// Previews are fetched when a post is captured, so only posts referenced from
// now on get one; posts captured before this shipped are not backfilled.
export async function ensureOriginPreview(ctx: MutationCtx, args: { tenantId: Id<"tenants">; originKey: string; url: string }) {
  let url: URL;
  try { url = new URL(args.url); } catch { return; }
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) || !/^\/(p|reel|reels|tv)\//.test(url.pathname)) return;
  const existing = await ctx.db.query("leadGenOriginPreviews").withIndex("by_tenantId_and_originKey", q => q.eq("tenantId", args.tenantId).eq("originKey", args.originKey)).unique();
  if (existing) return;
  const previewId = await ctx.db.insert("leadGenOriginPreviews", { tenantId: args.tenantId, originKey: args.originKey, url: args.url, status: "pending", attempts: 0, requestedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.leadGen.originPreviews.fetchOriginPreview, { previewId });
}
const previewArgs = { previewId: v.id("leadGenOriginPreviews") };
const fields = { authorName: v.optional(v.string()), handle: v.optional(v.string()), caption: v.optional(v.string()), postedOn: v.optional(v.string()) };
export const getOriginPreview = internalQuery({
  args: previewArgs,
  handler: async (ctx, { previewId }) => await ctx.db.get("leadGenOriginPreviews", previewId),
});
export const saveOriginPreview = internalMutation({
  args: { ...previewArgs, ...fields, thumbnailStorageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { previewId, ...data }) => {
    const row = await ctx.db.get("leadGenOriginPreviews", previewId);
    if (!row) { await ctx.storage.delete(data.thumbnailStorageId); return null; }
    if (row.thumbnailStorageId && row.thumbnailStorageId !== data.thumbnailStorageId) await ctx.storage.delete(row.thumbnailStorageId);
    await ctx.db.patch("leadGenOriginPreviews", previewId, { ...data, status: "ready", fetchedAt: Date.now(), attempts: row.attempts + 1 });
    return null;
  },
});
export const failOriginPreview = internalMutation({
  args: previewArgs,
  returns: v.null(),
  handler: async (ctx, { previewId }) => {
    const row = await ctx.db.get("leadGenOriginPreviews", previewId);
    if (!row || row.status === "ready" || row.attempts >= 3) return null;
    const attempts = row.attempts + 1;
    await ctx.db.patch("leadGenOriginPreviews", previewId, { status: "unavailable", attempts });
    if (attempts < 3) await ctx.scheduler.runAfter(attempts === 1 ? 3600000 : 43200000, internal.leadGen.originPreviews.fetchOriginPreview, { previewId });
    return null;
  },
});

export const fetchOriginPreview = internalAction({
  args: previewArgs,
  returns: v.null(),
  handler: async (ctx, { previewId }) => {
    const row: Doc<"leadGenOriginPreviews"> | null = await ctx.runQuery(internal.leadGen.originPreviews.getOriginPreview, { previewId });
    if (!row || row.status === "ready" || row.attempts >= 3) return null;
    let stored: Id<"_storage"> | undefined;
    try {
      const page = await fetch(row.url, { headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" }, signal: AbortSignal.timeout(10000) });
      if (!page.ok) throw new Error("Instagram unavailable");
      const preview = parseInstagramPreview(await page.text());
      if (!preview?.image) throw new Error("No thumbnail");
      const imageUrl = new URL(preview.image);
      if (imageUrl.protocol !== "https:" || !(imageUrl.hostname.endsWith(".cdninstagram.com") || imageUrl.hostname.endsWith(".fbcdn.net"))) throw new Error("Invalid image host");
      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(10000), redirect: "error" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.startsWith("image/") || !response.body) throw new Error("Invalid thumbnail");
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 3 * 1024 * 1024) { await reader.cancel(); throw new Error("Thumbnail too large"); }
        chunks.push(new Uint8Array(value));
      }
      stored = await ctx.storage.store(new Blob(chunks, { type: contentType }));
      const { image: _image, ...data } = preview;
      await ctx.runMutation(internal.leadGen.originPreviews.saveOriginPreview, { previewId, ...data, thumbnailStorageId: stored });
    } catch {
      if (stored) await ctx.storage.delete(stored);
      await ctx.runMutation(internal.leadGen.originPreviews.failOriginPreview, { previewId });
    }
    return null;
  },
});

export const listOriginPreviews = query({
  args: { originKeys: v.array(v.string()) },
  returns: v.array(v.object({ originKey: v.string(), status: v.union(v.literal("pending"), v.literal("ready"), v.literal("unavailable")), ...fields, thumbnailUrl: v.union(v.string(), v.null()) })),
  handler: async (ctx, { originKeys }) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);
    const rows = await Promise.all([...new Set(originKeys.slice(0, 50))].map(originKey => ctx.db.query("leadGenOriginPreviews").withIndex("by_tenantId_and_originKey", q => q.eq("tenantId", tenantId).eq("originKey", originKey)).unique()));
    return await Promise.all(rows.flatMap(row => row ? [row] : []).map(async row => ({ originKey: row.originKey, status: row.status, authorName: row.authorName, handle: row.handle, caption: row.caption, postedOn: row.postedOn, thumbnailUrl: row.thumbnailStorageId ? await ctx.storage.getUrl(row.thumbnailStorageId) : null })));
  },
});
