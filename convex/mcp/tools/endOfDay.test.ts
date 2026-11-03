import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, createMcpHarness, mcpConnect, seedTenantWithCloser } from "../../../tests/mcpHarness";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("magnus_day_summary and magnus_end_day", () => {
  it("summarizes, ends the day as the agent, and returns the first report on a repeat", async () => {
    const { t, signToken } = await createMcpHarness();
    const seeded = await seedTenantWithCloser(t);
    const token = await signToken("user_alex", { org_id: seeded.orgId });
    const { sessionId } = await mcpConnect(t, token, "hermes-agent");

    const summary = await callTool(t, token, sessionId, "magnus_day_summary");
    expect(summary.isError).toBe(false);
    expect(summary.data).toMatchObject({ slackChannel: null, numbers: { newCalls: { scheduled: 0 } } });

    const first = await callTool(t, token, sessionId, "magnus_end_day", { narrative: "Quiet day." });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({
      repeated: false,
      slackStatus: "not_configured",
      message: "Saved in Magnus. No end-of-day channel is set, so nothing was posted.",
    });

    const second = await callTool(t, token, sessionId, "magnus_end_day", { narrative: "Again." });
    expect(second.data).toMatchObject({ repeated: true });

    const reports = await t.run((ctx) => ctx.db.query("endOfDayReports").collect());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ endedVia: "agent", agentClient: "hermes-agent", narrativeMarkdown: "Quiet day." });
  });
});
