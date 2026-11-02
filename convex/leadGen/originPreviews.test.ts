import { convexTest } from "convex-test";
import { describe, expect, it, vi, afterEach } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { ensureOriginPreview } from "./originPreviews";
import { parseInstagramPreview } from "./instagramPreview";

const url = "https://www.instagram.com/reel/DVXcIyOmvWA/";
afterEach(() => vi.useRealTimers());
describe("Instagram previews", () => {
  it("decodes metadata and parses the caption, author, date, and image", () => {
    expect(parseInstagramPreview(`<meta property="og:title" content="Cole DaSilva on Instagram: &quot;Make time to go to the gym&quot;" />
<meta name="description" content="50K likes, 617 comments - coleluisdasilva on March 1, 2026: &quot;Make time to go to the gym&quot;. " />
<meta name="twitter:title" content="Cole DaSilva (&#064;coleluisdasilva) &#x2022; Instagram reel" />
<meta name="twitter:image" content="https://scontent.cdninstagram.com/image.jpg?stp=a&amp;oe=b" />`)).toEqual({ authorName: "Cole DaSilva", handle: "coleluisdasilva", caption: "Make time to go to the gym", postedOn: "2026-03-01", image: "https://scontent.cdninstagram.com/image.jpg?stp=a&oe=b" });
    expect(parseInstagramPreview("<html>Login</html>")).toBeNull();
  });
  it("uses description captions and og images and caps captions", () => {
    const parsed = parseInstagramPreview(`<meta content='on December 12, 2025: &quot;${"x".repeat(400)}&quot;' name='description'><meta content='https://example.test/a' property='og:image'>`);
    expect(parsed?.caption).toHaveLength(300);
    expect(parsed?.postedOn).toBe("2025-12-12");
    expect(parsed?.image).toBe("https://example.test/a");
  });
  it("inserts and schedules once, skips unsupported URLs, and isolates tenants", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, convexTestModules);
    const tenantId = await t.run(async ctx => {
      const tenantId = await ctx.db.insert("tenants", { companyName: "Preview", contactEmail: "test@example.test", workosOrgId: "org_preview", status: "active", inviteExpiresAt: 0, createdBy: "test" });
      for (const [subject, role] of [["user_admin", "tenant_admin"], ["user_closer", "closer"]] as const) await ctx.db.insert("users", { tenantId, workosUserId: subject, email: `${subject}@example.test`, role, isActive: true });
      const otherTenant = await ctx.db.insert("tenants", { companyName: "Other", contactEmail: "other@example.test", workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test" });
      await ctx.db.insert("leadGenOriginPreviews", { tenantId: otherTenant, originKey: "secret", url, status: "ready", caption: "Private", attempts: 1, requestedAt: 0 });
      await ensureOriginPreview(ctx, { tenantId, originKey: url, url });
      await ensureOriginPreview(ctx, { tenantId, originKey: url, url });
      for (const unsupported of ["https://example.test/reel/a/", "https://instagram.com/stories/a/", "https://instagram.com.evil.test/p/a/"]) await ensureOriginPreview(ctx, { tenantId, originKey: unsupported, url: unsupported });
      expect(await ctx.db.query("leadGenOriginPreviews").take(10)).toHaveLength(2);
      const jobs = await ctx.db.system.query("_scheduled_functions").take(10);
      expect(jobs).toHaveLength(1);
      // Leave the scheduled action pending; this test never advances timers or fetches.
      return tenantId;
    });
    const admin = t.withIdentity({ subject: "user_admin", org_id: "org_preview" });
    expect(await admin.query(api.leadGen.originPreviews.listOriginPreviews, { originKeys: [url, "secret"] })).toEqual([{ originKey: url, status: "pending", thumbnailUrl: null }]);
    await expect(t.withIdentity({ subject: "user_closer", org_id: "org_preview" }).query(api.leadGen.originPreviews.listOriginPreviews, { originKeys: [url] })).rejects.toThrow("Insufficient permissions");
    await t.run(async ctx => {
      const row = await ctx.db.query("leadGenOriginPreviews").withIndex("by_tenantId_and_originKey", q => q.eq("tenantId", tenantId).eq("originKey", url)).unique();
      expect(row).not.toBeNull();
    });
  });
  it("stops retrying after three failures", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, convexTestModules);
    const previewId = await t.run(async ctx => {
      const tenantId = await ctx.db.insert("tenants", { companyName: "Preview", contactEmail: "test@example.test", workosOrgId: "org_preview", status: "active", inviteExpiresAt: 0, createdBy: "test" });
      return await ctx.db.insert("leadGenOriginPreviews", { tenantId, originKey: url, url, status: "pending", attempts: 0, requestedAt: 0 });
    });
    for (let i = 0; i < 4; i++) await t.mutation(internal.leadGen.originPreviews.failOriginPreview, { previewId });
    await t.run(async ctx => {
      expect(await ctx.db.get("leadGenOriginPreviews", previewId)).toMatchObject({ attempts: 3, status: "unavailable" });
      expect(await ctx.db.system.query("_scheduled_functions").take(10)).toHaveLength(2);
    });
  });
});
