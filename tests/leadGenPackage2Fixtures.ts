import { expect, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithLeadGen } from "./mcpHarness";

export const SHIFT_NOW = Date.parse("2026-11-09T16:00:00Z");
export const SHIFT_DAY = "2026-11-09";
export const DAY_MS = 86_400_000;
export async function package2Fixture() {
  const h = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(h.t);
  const agent = async (sub = "user_sofia", orgId = seed.orgId) => {
    const token = await h.signToken(sub, { org_id: orgId });
    const { sessionId } = await mcpConnect(h.t, token);
    return async (name: string, args: Record<string, unknown> = {}) => callTool(h.t, token, sessionId, name, args);
  };
  const tool = await agent();
  const web = (sub = "user_sofia") => h.t.withIdentity({ subject: sub, org_id: seed.orgId });
  const capture = async (handle: string, sub = "user_sofia", at = SHIFT_NOW - 3_600_000) => {
    vi.setSystemTime(at);
    const result = await web(sub).mutation(api.leadGen.capture.submit, { source: "instagram", rawHandleOrProfileUrl: handle, originKind: "follower" });
    vi.setSystemTime(SHIFT_NOW);
    return result;
  };
  return { ...h, ...seed, agent, tool, web, capture };
}
export type Package2Fixture = Awaited<ReturnType<typeof package2Fixture>>;
export function toolData<T>(result: Awaited<ReturnType<typeof callTool>>): T {
  expect(result.response.body?.error, result.text).toBeUndefined();
  expect(result.isError, result.text).toBe(false);
  return result.data as T;
}
export async function shiftChannel(f: Package2Fixture) {
  return await f.t.run(ctx => ctx.db.insert("slackInstallations", {
    tenantId: f.tenantId, teamId: "T_SHIFT", teamName: "Team", isEnterpriseInstall: false,
    appId: "A1", botUserId: "B1", botAccessToken: "test-token", scopes: [], notifyChannelId: "C_OTHER", eodReportChannelId: "C_CLOSER",
    leadGenNotifyChannelId: "C_LEAD_GEN", leadGenNotifyChannelName: "lead-gen", installedByWorkosUserId: "user_admin", installedAt: 0,
    tokenExpiresAt: SHIFT_NOW + 7 * DAY_MS, refreshToken: "test-refresh", status: "active",
  }));
}
export async function noShow(ctx: MutationCtx, f: Package2Fixture, leadId: Id<"leads">,
  options: { scheduledAt?: number; createdAt?: number; opportunityId?: Id<"opportunities">; note?: string; category?: Doc<"meetings">["noShowReason"]; status?: Doc<"meetings">["status"] } = {}) {
  const opportunityId = options.opportunityId ?? await ctx.db.insert("opportunities", {
    tenantId: f.tenantId, leadId, assignedCloserId: f.closerId, stage: "closed", outcome: "lost",
    createdAt: options.createdAt ?? SHIFT_NOW, updatedAt: SHIFT_NOW,
  });
  const meetingId = await ctx.db.insert("meetings", { tenantId: f.tenantId, opportunityId, assignedCloserId: f.closerId,
    calendlyEventUri: "event/test", calendlyInviteeUri: "invitee/test", scheduledAt: options.scheduledAt ?? SHIFT_NOW,
    durationMinutes: 30, status: options.status ?? "no_show", createdAt: SHIFT_NOW - DAY_MS,
    noShowNote: options.note, noShowReason: options.category });
  return { opportunityId, meetingId };
}
