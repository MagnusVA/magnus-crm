import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { insertProgram } from "../../../tests/closerPipelineDeskFixtures";
import { internal } from "../../_generated/api";
import { callTool, setStoredContentType, testCaller } from "../../../tests/mcpHarness";
import { storeProofFile } from "../../../tests/proofFixtures";
import { mcpToolsFixture } from "../../../tests/mcpToolsFixtures";
import { localDateKey } from "../time";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Fixture = Awaited<ReturnType<typeof mcpToolsFixture>>;
const tomorrow = () => localDateKey(Date.now() + 36 * 60 * 60 * 1000, "America/Tegucigalpa");
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);

async function withProgram(f: Fixture): Promise<Id<"tenantPrograms">> {
  return await f.t.run((ctx) => insertProgram(ctx, f.tenantId, f.ownerId, "Scale Program"));
}

async function uploadPdf(f: Fixture) {
  const ticket = await callTool(f.t, f.token, f.sessionId, "magnus_proof_upload_url");
  const { uploadUrl } = ticket.data as { uploadUrl: string };
  const path = new URL(uploadUrl).pathname;
  const response = await f.t.fetch(path, { method: "POST", body: PDF });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { uploadId: Id<"paymentProofUploads">; type: string };
  expect(body.type).toBe("application/pdf");
  const upload = await f.t.run((ctx) => ctx.db.get("paymentProofUploads", body.uploadId));
  expect(upload).toMatchObject({ status: "ready", contentType: "application/pdf" });
  await setStoredContentType(f.t, upload!.storageId!, "application/pdf");
  return body.uploadId;
}

describe("magnus_set_callback", () => {
  it("sets a call-back that records the call as held, and returns the same task on a retry", async () => {
    const f = await mcpToolsFixture();
    const args = { meetingId: f.meetingId, method: "call", date: tomorrow(), time: "16:00", note: "Confirm the signature" };
    const first = await callTool(f.t, f.token, f.sessionId, "magnus_set_callback", args);
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ meeting: "held", alreadyExisted: false });
    const meeting = await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId));
    expect(meeting?.status).toBe("held");
    const second = await callTool(f.t, f.token, f.sessionId, "magnus_set_callback", args);
    expect(second.data).toMatchObject({ alreadyExisted: true });
  });
});

describe("magnus_mark_no_show", () => {
  it("previews, commits with the token, and replays on a retry", async () => {
    const f = await mcpToolsFixture();
    const preview = await callTool(f.t, f.token, f.sessionId, "magnus_mark_no_show", {
      meetingId: f.meetingId,
      reason: "no_response",
      confirm: false,
    });
    expect(preview.isError).toBe(false);
    const { preview: text, confirmToken } = preview.data as { preview: string; confirmToken: string };
    expect(text).toContain("no-show");
    expect((await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId)))?.status).toBe("scheduled");

    const changed = await callTool(f.t, f.token, f.sessionId, "magnus_mark_no_show", {
      meetingId: f.meetingId,
      reason: "late_cancel",
      confirm: true,
      confirmToken,
    });
    expect(changed.text ?? "").toContain("differ from the preview");

    const commit = await callTool(f.t, f.token, f.sessionId, "magnus_mark_no_show", {
      meetingId: f.meetingId,
      reason: "no_response",
      confirm: true,
      confirmToken,
    });
    expect(commit.data).toMatchObject({ ok: true, alreadyDone: false });
    expect((await f.t.run((ctx) => ctx.db.get("meetings", f.meetingId)))?.status).toBe("no_show");

    const retry = await callTool(f.t, f.token, f.sessionId, "magnus_mark_no_show", {
      meetingId: f.meetingId,
      reason: "no_response",
      confirm: true,
      confirmToken,
    });
    expect(retry.data).toMatchObject({ ok: true, alreadyDone: true });
  });

  it("won't commit without a preview token", async () => {
    const f = await mcpToolsFixture();
    const result = await callTool(f.t, f.token, f.sessionId, "magnus_mark_no_show", {
      meetingId: f.meetingId,
      reason: "no_response",
      confirm: true,
    });
    expect(result.text ?? "").toContain("Preview first");
  });
});

describe("magnus_mark_lost", () => {
  it("refuses a loss without a reason, then closes the deal with one", async () => {
    const f = await mcpToolsFixture();
    const bare = await callTool(f.t, f.token, f.sessionId, "magnus_mark_lost", { meetingId: f.meetingId, confirm: false });
    expect(bare.text ?? "").toContain("A loss needs a reason. Ask why the deal was lost.");

    const args = { meetingId: f.meetingId, category: "not_a_fit", reason: "side business under 5k a month" };
    const preview = await callTool(f.t, f.token, f.sessionId, "magnus_mark_lost", { ...args, confirm: false });
    const { preview: text, confirmToken } = preview.data as { preview: string; confirmToken: string };
    expect(text).toContain('"Not a fit: side business under 5k a month"');
    expect(text).toContain("can't be undone");
    const commit = await callTool(f.t, f.token, f.sessionId, "magnus_mark_lost", { ...args, confirm: true, confirmToken });
    expect(commit.data).toMatchObject({ ok: true, deal: "Closed · lost" });
    const deal = await f.t.run((ctx) => ctx.db.get("opportunities", f.dealId));
    expect(deal).toMatchObject({ outcome: "lost", lostReason: "Not a fit: side business under 5k a month" });
  });
});

describe("magnus_log_payment", () => {
  it("returns the receipt link when the client passes no file, and saves nothing", async () => {
    const f = await mcpToolsFixture();
    const programId = await withProgram(f);
    const args = { meetingId: f.meetingId, amount: 500, currency: "USD", paymentType: "deposit", programId };
    const preview = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", { ...args, confirm: false });
    expect(preview.data).toMatchObject({ proof: "missing" });
    expect((preview.data as { preview: string }).preview).toContain("Proof file required.");
    const { confirmToken } = preview.data as { confirmToken: string };
    const commit = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", { ...args, confirm: true, confirmToken });
    expect(commit.data).toMatchObject({ status: "needs_proof", saved: false });
    expect((commit.data as { link: string }).link).toContain("/workspace/closer/pay?meetingId=");
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(5))).toHaveLength(0);
  });

  it("logs a payment with a shell upload, tagged with the client, and never twice", async () => {
    const f = await mcpToolsFixture();
    const programId = await withProgram(f);
    const args = { meetingId: f.meetingId, amount: 4500, currency: "USD", paymentType: "pif", programId };
    const preview = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", { ...args, confirm: false });
    const { confirmToken } = preview.data as { confirmToken: string };
    const uploadId = await uploadPdf(f);
    const commit = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", {
      ...args,
      uploadId,
      confirm: true,
      confirmToken,
    });
    expect(commit.isError).toBe(false);
    expect(commit.data).toMatchObject({ status: "recorded", alreadyDone: false });
    const payments = await f.t.run((ctx) => ctx.db.query("paymentRecords").take(5));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ recordedVia: "mcp", agentClient: "claude-ai", amountMinor: 450000 });
    expect(payments[0].proofSha256).toBeTruthy();

    const retry = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", {
      ...args,
      uploadId,
      confirm: true,
      confirmToken,
    });
    expect(retry.data).toMatchObject({ status: "recorded", alreadyDone: true });
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(5))).toHaveLength(1);
  });

  it("fetches ChatGPT's file from its file host only", async () => {
    const f = await mcpToolsFixture();
    const programId = await withProgram(f);
    const args = { meetingId: f.meetingId, amount: 500, currency: "USD", paymentType: "deposit", programId };
    const preview = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", {
      ...args,
      proof: { download_url: "https://files.oaiusercontent.com/file-1", file_id: "file-1", file_name: "IMG_4471.png" },
      confirm: false,
    });
    expect((preview.data as { preview: string }).preview).toContain("Proof: IMG_4471.png.");
    const { confirmToken } = preview.data as { confirmToken: string };
    const evil = await callTool(f.t, f.token, f.sessionId, "magnus_log_payment", {
      ...args,
      proof: { download_url: "https://example.com/file", file_id: "file-2" },
      confirm: true,
      confirmToken,
    });
    expect(evil.text ?? "").toContain("ChatGPT's own file host");
    expect(await f.t.run((ctx) => ctx.db.query("paymentRecords").take(5))).toHaveLength(0);
  });

  it("commits with the file ChatGPT passed, keeping no link", async () => {
    const f = await mcpToolsFixture();
    const programId = await withProgram(f);
    const caller = testCaller(f.orgId, "chatgpt");
    const args = { meetingId: f.meetingId, amount: 500, currency: "USD", paymentType: "deposit" as const, programId };
    const preview = await f.t.mutation(internal.mcp.tools.payments.previewPayment, {
      caller,
      ...args,
      proofKind: "file",
      proofName: "IMG_4471.png",
    });
    const storageId = await storeProofFile(f.t, { contentType: "image/png" });
    const commit = await f.t.mutation(internal.mcp.tools.payments.commitPayment, {
      caller,
      ...args,
      confirmToken: preview.confirmToken,
      storedFile: { storageId, fileName: "IMG_4471.png" },
    });
    expect(commit).toMatchObject({ status: "recorded", alreadyDone: false });
    const uploads = await f.t.run((ctx) => ctx.db.query("paymentProofUploads").take(5));
    expect(uploads[0]).toMatchObject({ source: "chatgpt_file", status: "attached", fileName: "IMG_4471.png" });
    const payments = await f.t.run((ctx) => ctx.db.query("paymentRecords").take(5));
    expect(payments[0]).toMatchObject({ recordedVia: "mcp", agentClient: "chatgpt", paymentType: "deposit" });
  });
});

describe("magnus_attach_proof", () => {
  it("attaches a receipt to the closer's payment that has none", async () => {
    const f = await mcpToolsFixture();
    const programId = await withProgram(f);
    const paymentId = await f.t.run((ctx) =>
      ctx.db.insert("paymentRecords", {
        tenantId: f.tenantId,
        opportunityId: f.dealId,
        attributedCloserId: f.closerId,
        amountMinor: 120000,
        currency: "USD",
        recordedByUserId: f.ownerId,
        programId,
        programName: "Scale Program",
        paymentType: "split",
        status: "recorded",
        recordedAt: Date.now(),
        origin: "admin_meeting",
      }),
    );
    const uploadId = await uploadPdf(f);
    const result = await callTool(f.t, f.token, f.sessionId, "magnus_attach_proof", { paymentId, uploadId });
    expect(result.data).toMatchObject({ ok: true, reused: false });
    const payment = await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId));
    expect(payment?.proofFileId).toBeTruthy();
    const again = await callTool(f.t, f.token, f.sessionId, "magnus_attach_proof", { paymentId, uploadId });
    expect(again.text ?? "").toContain("already has a proof file");
  });
});
