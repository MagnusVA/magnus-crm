import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { classifyFailure } from "../../lib/observability/error-rules";
import schema from "../schema";
import { convexTestModules } from "../test.setup";
import { registerComponents } from "../../tests/bookingHarness";

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const POST_URL = "https://slack.com/api/chat.postMessage";
const ACTION = "slack/notify:postLeadGenSubmission";

/** What the Convex runtime threw in production on Nov 2. */
const transportError = () => new TypeError(`error sending request for url (${POST_URL})`);
const posted = () => Response.json({ ok: true, channel: "C_LEADGEN", ts: "1.0" });

async function fixture() {
  const t = convexTest(schema, convexTestModules);
  registerComponents(t);
  const ids = await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Slack test", contactEmail: "test@example.test", workosOrgId: "org_slack",
      status: "active", inviteExpiresAt: 0, createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId, workosUserId: "user_slack", email: "admin@example.test", fullName: "Ana Admin",
      role: "tenant_admin", isActive: true,
    });
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
      botUserId: "B1", botAccessToken: "xoxb-test", scopes: [], leadGenNotifyChannelId: "C_LEADGEN",
      leadGenNotifyChannelName: "lead-gen", installedByWorkosUserId: "user_slack", installedAt: 0,
      // Far enough out that the post never refreshes the token first.
      tokenExpiresAt: NOW + 24 * 60 * 60 * 1000, refreshToken: "r", status: "active",
    });
    return { tenantId, installationId };
  });
  const caller = t.withIdentity({ subject: "user_slack", org_id: "org_slack" });
  const submit = async (handle: string) =>
    (
      await caller.mutation(api.leadGen.capture.submit, {
        source: "instagram", rawHandleOrProfileUrl: handle, originKind: "follower",
      })
    ).submissionId as Id<"leadGenSubmissions">;
  return { t, submit, ...ids };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

/** Stubs `fetch` with one outcome per Slack post; the last one repeats. */
function stubSlack(...outcomes: Array<() => Response | Error>) {
  let call = 0;
  const fetch = vi.fn(async (url: string | URL, _init?: { body?: string }) => {
    if (String(url) !== POST_URL) return Response.json({});
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)]();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  vi.stubGlobal("fetch", fetch);
  return {
    posts: () =>
      fetch.mock.calls
        .filter(([url]) => String(url) === POST_URL)
        .map(([, init]) => JSON.parse(init?.body ?? "{}") as Record<string, unknown>),
  };
}

/** The post action's pending runs, with how long each waits from now. */
async function pendingPosts(t: Harness["t"]) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").take(100))
      .filter((job) => job.name === ACTION && job.state.kind === "pending")
      .map((job) => ({
        attempt: (job.args[0] as { attempt?: number }).attempt,
        delayMs: job.scheduledTime - Date.now(),
      })),
  );
}

/** Runs the post that is due now, and nothing scheduled for later. */
async function runDuePost(t: Harness["t"]) {
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

function reportedFailures(calls: unknown[][]) {
  return calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("slack.notify.post_failed"))
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf("{"))) as {
          integration?: string;
          error: { message: string };
        },
    );
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("lead gen submission post that Slack doesn't answer", () => {
  it("is retried after a transport error, and stops once Slack accepts it", async () => {
    const h = await fixture();
    const slack = stubSlack(transportError, posted);
    await h.submit("@prospect.one");

    await runDuePost(h.t);
    expect(slack.posts()).toHaveLength(1);
    expect(await pendingPosts(h.t)).toEqual([{ attempt: 2, delayMs: 15_000 }]);

    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slack.posts()).toHaveLength(2);
    expect(await pendingPosts(h.t)).toEqual([]);
  });

  it("gives up after three attempts with a failure that classifies as a Slack integration error", async () => {
    const h = await fixture();
    const slack = stubSlack(transportError);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.submit("@prospect.one");

    await runDuePost(h.t);
    expect(await pendingPosts(h.t)).toEqual([{ attempt: 2, delayMs: 15_000 }]);
    vi.advanceTimersByTime(15_000);
    await h.t.finishInProgressScheduledFunctions();
    expect(await pendingPosts(h.t)).toEqual([{ attempt: 3, delayMs: 60_000 }]);

    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(slack.posts()).toHaveLength(3);
    expect(await pendingPosts(h.t)).toEqual([]);

    // Reported once, at the end, in the shape the classifier reads.
    const failures = reportedFailures(errors.mock.calls);
    expect(failures).toHaveLength(1);
    // A handled report is filed as an integration failure by this attribute;
    // the message shape does the same if the error is ever thrown instead.
    expect(failures[0].integration).toBe("slack");
    expect(failures[0].error.message).toBe(
      "Slack chat.postMessage failed: request error transport_error after 3 attempts",
    );
    expect(
      classifyFailure({
        functionPath: ACTION,
        errorName: "Error",
        errorMessage: failures[0].error.message,
        fromClient: false,
      }),
    ).toMatchObject({ kind: "integration", integration: "slack" });
  });

  it("retries a rate limit and a Slack outage the same way", async () => {
    const h = await fixture();
    const slack = stubSlack(
      () => new Response("", { status: 429 }),
      () => new Response("", { status: 503 }),
      posted,
    );
    await h.submit("@prospect.one");

    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(slack.posts()).toHaveLength(3);
  });

  it("waits as long as Slack's Retry-After asks", async () => {
    const h = await fixture();
    stubSlack(
      () => new Response("", { status: 429, headers: { "Retry-After": "90" } }),
      () => new Response("", { status: 429, headers: { "Retry-After": "3600" } }),
      posted,
    );
    await h.submit("@prospect.one");

    await runDuePost(h.t);
    expect(await pendingPosts(h.t)).toEqual([{ attempt: 2, delayMs: 90_000 }]);
    vi.advanceTimersByTime(90_000);
    await h.t.finishInProgressScheduledFunctions();
    expect(await pendingPosts(h.t)).toEqual([{ attempt: 3, delayMs: 3_600_000 }]);
  });

  it("doesn't retry an error Slack answered with", async () => {
    const h = await fixture();
    const slack = stubSlack(() => Response.json({ ok: false, error: "channel_not_found" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.submit("@prospect.one");

    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(slack.posts()).toHaveLength(1);
  });
});

// These prove what the retry sends and when it stops. They can't prove that
// Slack drops a repeat of a post it already accepted: Slack documents no
// dedupe on `client_msg_id`.
describe("lead gen submission post that may already have reached Slack", () => {
  it("sends every attempt with one message id made from the submission", async () => {
    const h = await fixture();
    const slack = stubSlack(transportError, transportError, posted);
    const first = await h.submit("@prospect.one");
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const second = await h.submit("@prospect.two");
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    const [a1, a2, a3, b1] = slack.posts();
    expect(slack.posts()).toHaveLength(4);
    // Same submission: the same id, channel and message on every attempt.
    expect(a1.client_msg_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a2).toEqual(a1);
    expect(a3).toEqual(a1);
    // Another submission: another id.
    expect(first).not.toBe(second);
    expect(b1.client_msg_id).not.toBe(a1.client_msg_id);
  });

  it("posts once when Slack accepts the first attempt", async () => {
    const h = await fixture();
    const slack = stubSlack(posted);
    await h.submit("@prospect.one");

    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(slack.posts()).toHaveLength(1);
    expect(await pendingPosts(h.t)).toEqual([]);
  });

  it("doesn't post again once the submission is voided or the channel is turned off or changed", async () => {
    for (const change of ["voided", "channel_off", "channel_changed"] as const) {
      const h = await fixture();
      const slack = stubSlack(transportError, posted);
      const submissionId = await h.submit("@prospect.one");
      await runDuePost(h.t);
      expect(slack.posts()).toHaveLength(1);

      await h.t.run(async (ctx) => {
        if (change === "voided") {
          await ctx.db.patch("leadGenSubmissions", submissionId, { voidedAt: Date.now() });
        } else {
          await ctx.db.patch("slackInstallations", h.installationId, {
            leadGenNotifyChannelId: change === "channel_off" ? undefined : "C_OTHER",
          });
        }
      });
      await h.t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(slack.posts()).toHaveLength(1);
      expect(await pendingPosts(h.t)).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});
