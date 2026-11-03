import { v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  env,
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../../_generated/server";
import { checkMeetingPaymentAllowed, recordMeetingPayment } from "../../closer/payments";
import { checkTaskPaymentAllowed, recordTaskPayment } from "../../closer/reminderOutcomes";
import { emitDomainEvent } from "../../lib/domainEvents";
import { checkPaymentProof, newPaymentFields } from "../../lib/paymentProof";
import { paymentTypeValidator, type PaymentType } from "../../lib/paymentTypes";
import { rejectRequest } from "../../lib/observability/errors";
import { normalizeProgramName } from "../../tenantPrograms/shared";
import { buildPaymentLink } from "../../../lib/paymentLink";
import { issueConfirmation, markConfirmationUsed, redeemConfirmation } from "../confirm";
import { mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import { formatLocal } from "../time";
import { MAX_PROOF_BYTES, sniffProofType } from "../uploads";
import { loadOwnMeeting, loadOwnTask, withAgentErrors } from "./outcomes";

/**
 * Payments from the agent (docs/plans/closer-assistant.md §6.3). No proof, no
 * payment (§5.3): the proof is an upload the closer's agent made
 * (`magnus_proof_upload_url`), or the file ChatGPT hands over through
 * `openai/fileParams`. A client that can pass neither, such as Claude's apps,
 * gets a link to the receipt page instead, and nothing is saved until the
 * closer adds the file there.
 */

const TYPE_LABEL: Record<PaymentType, string> = {
  pif: "paid in full",
  split: "split payment",
  monthly: "monthly payment",
  deposit: "deposit",
};

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const paymentInputArgs = {
  meetingId: v.optional(v.id("meetings")),
  taskId: v.optional(v.id("followUps")),
  amount: v.number(),
  currency: v.optional(v.string()),
  paymentType: paymentTypeValidator,
  programId: v.optional(v.id("tenantPrograms")),
  program: v.optional(v.string()),
};

type PaymentInput = {
  meetingId?: Id<"meetings">;
  taskId?: Id<"followUps">;
  amount: number;
  currency?: string;
  paymentType: PaymentType;
  programId?: Id<"tenantPrograms">;
  program?: string;
};

type Resolved = {
  target: { meeting: Doc<"meetings"> } | { task: Doc<"followUps"> };
  opportunityId: Id<"opportunities">;
  program: Doc<"tenantPrograms">;
  currency: string;
  person: string;
  when: string;
  hashed: Record<string, unknown>;
};

async function resolvePayment(ctx: MutationCtx, me: McpUser, input: PaymentInput): Promise<Resolved> {
  if (Boolean(input.meetingId) === Boolean(input.taskId)) {
    throw rejectRequest("payment.target_required", "Pass the meetingId of the call, or the taskId of the call-back.");
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw rejectRequest("payment.amount_invalid", "The amount must be a positive number in major units, such as 4500.");
  }
  let target: Resolved["target"];
  let opportunityId: Id<"opportunities">;
  let person: string;
  let when: string;
  if (input.meetingId) {
    const meeting = await loadOwnMeeting(ctx, me, input.meetingId);
    target = { meeting };
    opportunityId = meeting.opportunityId;
    person = meeting.leadName ?? "this person";
    when = `the call on ${formatLocal(meeting.scheduledAt, me.timeZone)}`;
  } else {
    const task = await loadOwnTask(ctx, me, input.taskId!);
    target = { task };
    opportunityId = task.opportunityId;
    const lead = await ctx.db.get("leads", task.leadId);
    person = lead?.fullName ?? "this person";
    when = "their call-back";
  }
  const deal = await ctx.db.get("opportunities", opportunityId);

  let program: Doc<"tenantPrograms"> | null = null;
  if (input.programId) {
    program = await ctx.db.get("tenantPrograms", input.programId);
  } else if (input.program?.trim()) {
    program = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_normalizedName", (q) =>
        q.eq("tenantId", me.tenantId).eq("normalizedName", normalizeProgramName(input.program!)),
      )
      .first();
  } else {
    const bookedId =
      ("meeting" in target ? target.meeting.bookingProgramId : undefined) ?? deal?.firstBookingProgramId;
    program = bookedId ? await ctx.db.get("tenantPrograms", bookedId) : null;
  }
  if (!program || program.tenantId !== me.tenantId || program.archivedAt !== undefined) {
    const active = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_archivedAt", (q) => q.eq("tenantId", me.tenantId).eq("archivedAt", undefined))
      .take(20);
    throw rejectRequest(
      "payment.program_required",
      `Which program is this for? Pass program as one of: ${active.map((p) => p.name).join(", ") || "none set up"}.`,
    );
  }
  const currency = (input.currency?.trim() || program.defaultCurrency || "USD").toUpperCase();
  return {
    target,
    opportunityId,
    program,
    currency,
    person,
    when,
    hashed: {
      meetingId: input.meetingId,
      taskId: input.taskId,
      amount: input.amount,
      currency,
      paymentType: input.paymentType,
      programId: program._id,
    },
  };
}

async function checkPayment(ctx: MutationCtx, me: McpUser, input: PaymentInput, r: Resolved, proofFileId?: Id<"_storage">) {
  const common = {
    amount: input.amount,
    currency: r.currency,
    programId: r.program._id,
    paymentType: input.paymentType,
    ...(proofFileId ? { proofFileId } : {}),
  };
  if ("meeting" in r.target) {
    const args = { ...common, opportunityId: r.opportunityId, meetingId: r.target.meeting._id };
    const check = await checkMeetingPaymentAllowed(ctx, me, args, { proof: proofFileId ? "check" : "skip" });
    if (!check.ok) throw rejectRequest(check.code, check.message);
    return { kind: "meeting" as const, args };
  }
  const args = { ...common, followUpId: r.target.task._id };
  const check = await checkTaskPaymentAllowed(ctx, me, args, { proof: proofFileId ? "check" : "skip" });
  if (!check.ok) throw rejectRequest(check.code, check.message);
  return { kind: "task" as const, args };
}

function paymentLink(input: PaymentInput, r: Resolved) {
  const base = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;
  return buildPaymentLink(
    {
      ...("meeting" in r.target ? { meetingId: r.target.meeting._id } : { followUpId: r.target.task._id }),
      amount: input.amount,
      currency: r.currency,
      paymentType: input.paymentType,
      programId: r.program._id,
    },
    base ? { baseUrl: base } : {},
  );
}

const previewResult = v.object({
  preview: v.string(),
  confirmToken: v.string(),
  expiresInSeconds: v.number(),
  proof: v.union(v.literal("upload"), v.literal("file"), v.literal("missing")),
});

export const previewPayment = internalMutation({
  args: {
    caller: mcpCallerValidator,
    ...paymentInputArgs,
    proofKind: v.union(v.literal("upload"), v.literal("file"), v.literal("missing")),
    proofName: v.optional(v.string()),
  },
  returns: previewResult,
  handler: async (ctx, { caller, proofKind, proofName, ...input }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const r = await resolvePayment(ctx, me, input);
    await checkPayment(ctx, me, input, r);
    const proofLine =
      proofKind === "missing"
        ? "Proof file required."
        : `Proof: ${proofName ?? (proofKind === "upload" ? "the uploaded file" : "the attached file")}.`;
    const issued = await issueConfirmation(
      ctx,
      me,
      "magnus_log_payment",
      r.hashed,
      `Log ${money(input.amount, r.currency)} ${TYPE_LABEL[input.paymentType]} for ${r.person} · ${r.program.name} · ${r.when}. ${proofLine}`,
    );
    return { ...issued, proof: proofKind };
  },
});

const commitResult = v.union(
  v.object({
    status: v.literal("needs_proof"),
    saved: v.literal(false),
    link: v.string(),
    message: v.string(),
  }),
  v.object({
    status: v.literal("recorded"),
    paymentId: v.id("paymentRecords"),
    deal: v.string(),
    message: v.string(),
    alreadyDone: v.boolean(),
    discardStorageId: v.optional(v.id("_storage")),
  }),
);

type RecordedResult = {
  status: "recorded";
  paymentId: Id<"paymentRecords">;
  deal: string;
  message: string;
  alreadyDone: boolean;
  discardStorageId?: Id<"_storage">;
};

export const commitPayment = internalMutation({
  args: {
    caller: mcpCallerValidator,
    ...paymentInputArgs,
    confirmToken: v.optional(v.string()),
    uploadId: v.optional(v.id("paymentProofUploads")),
    // A file the action downloaded from ChatGPT's file host and stored.
    storedFile: v.optional(v.object({ storageId: v.id("_storage"), fileName: v.optional(v.string()) })),
  },
  returns: commitResult,
  handler: async (ctx, { caller, confirmToken, uploadId, storedFile, ...input }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const r = await resolvePayment(ctx, me, input);
    const redeemed = await redeemConfirmation(ctx, me, "magnus_log_payment", confirmToken, r.hashed);
    if (redeemed.kind === "replay") {
      return {
        ...(redeemed.result as RecordedResult),
        alreadyDone: true,
        ...(storedFile ? { discardStorageId: storedFile.storageId } : {}),
      };
    }

    let upload: Doc<"paymentProofUploads"> | null = null;
    if (uploadId) {
      upload = await ctx.db.get("paymentProofUploads", uploadId);
      if (!upload || upload.userId !== me.userId || upload.tenantId !== me.tenantId) {
        throw rejectRequest("upload.unknown", "That upload isn't one of yours. Ask for a new upload link.");
      }
      if (upload.status === "attached" && upload.paymentId) {
        // An upload attaches once: a retry gets the payment it already backs.
        return {
          status: "recorded" as const,
          paymentId: upload.paymentId,
          deal: "Closed · won",
          message: "Already logged with this file. Nothing was logged twice.",
          alreadyDone: true,
        };
      }
      if (upload.status !== "ready" || !upload.storageId) {
        throw rejectRequest(
          upload.status === "expired" ? "upload.expired" : "upload.not_ready",
          upload.status === "expired"
            ? "This upload expired. Ask for a new upload link."
            : "That upload has no file yet. POST the file to the upload URL first.",
        );
      }
    } else if (storedFile) {
      const file = await ctx.db.system.get("_storage", storedFile.storageId);
      const insertedId = await ctx.db.insert("paymentProofUploads", {
        tenantId: me.tenantId,
        userId: me.userId,
        source: "chatgpt_file",
        storageId: storedFile.storageId,
        ...(storedFile.fileName ? { fileName: storedFile.fileName.slice(0, 200) } : {}),
        ...(file?.contentType ? { contentType: file.contentType } : {}),
        ...(file ? { sizeBytes: file.size, sha256: file.sha256 } : {}),
        status: "ready",
        createdAt: Date.now(),
      });
      upload = await ctx.db.get("paymentProofUploads", insertedId);
    } else {
      // Nothing is saved; the closer adds the file on the receipt page. The
      // token stays unused, so the same preview can still commit with a file.
      await checkPayment(ctx, me, input, r);
      return {
        status: "needs_proof" as const,
        saved: false as const,
        link: paymentLink(input, r),
        message: "Nothing is logged yet. Open this link, add the receipt, and confirm there.",
      };
    }

    const proofFileId = upload!.storageId!;
    const checked = await checkPayment(ctx, me, input, r, proofFileId);
    const provenance = { via: "mcp" as const, agentClient: me.agentClient };
    const paymentId = await withAgentErrors(() =>
      checked.kind === "meeting"
        ? recordMeetingPayment(ctx, me, { ...checked.args, proofFileId }, provenance)
        : recordTaskPayment(ctx, me, { ...checked.args, proofFileId }, provenance),
    );
    await ctx.db.patch("paymentProofUploads", upload!._id, { status: "attached", paymentId });
    const result: RecordedResult = {
      status: "recorded",
      paymentId,
      deal: "Closed · won",
      message: `Logged ${money(input.amount, r.currency)} ${TYPE_LABEL[input.paymentType]} for ${r.person}. The deal is won, and the payment is waiting for review in Billing.`,
      alreadyDone: false,
    };
    await markConfirmationUsed(ctx, redeemed.confirmationId, result);
    return result;
  },
});

/**
 * The file ChatGPT passes through `openai/fileParams`: a temporary download
 * link to OpenAI's file host. It works as a bearer link, so it's never
 * stored or logged, and only that host is fetched.
 */
type ChatGptFile = { download_url: string; file_id?: string; file_name?: string; mime_type?: string };

function parseChatGptFile(raw: unknown): ChatGptFile | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Record<string, unknown>;
  if (typeof file.download_url !== "string") return null;
  return {
    download_url: file.download_url,
    ...(typeof file.file_id === "string" ? { file_id: file.file_id } : {}),
    ...(typeof file.file_name === "string" ? { file_name: file.file_name } : {}),
    ...(typeof file.mime_type === "string" ? { mime_type: file.mime_type } : {}),
  };
}

export function isChatGptFileHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "files.oaiusercontent.com" || hostname.endsWith(".oaiusercontent.com"));
  } catch {
    return false;
  }
}

async function storeChatGptFile(
  ctx: { storage: { store: (blob: Blob) => Promise<Id<"_storage">> } },
  file: ChatGptFile,
): Promise<{ storageId: Id<"_storage">; fileName?: string }> {
  if (!isChatGptFileHost(file.download_url)) {
    throw rejectRequest("proof.host_refused", "Magnus only accepts files from ChatGPT's own file host.");
  }
  const response = await fetch(file.download_url, { redirect: "error" });
  if (!response.ok) throw rejectRequest("proof.download_failed", "The file couldn't be downloaded. Attach it again.");
  if (Number(response.headers.get("content-length") ?? "0") > MAX_PROOF_BYTES) {
    throw rejectRequest("proof.too_large", "That file is over 10 MB.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROOF_BYTES) throw rejectRequest("proof.too_large", "That file is over 10 MB.");
  const type = sniffProofType(bytes);
  if (!type) throw rejectRequest("proof.bad_type", "Proof must be a JPEG, PNG, GIF or PDF.");
  const storageId = await ctx.storage.store(new Blob([bytes], { type }));
  return { storageId, ...(file.file_name ? { fileName: file.file_name } : {}) };
}

/** `magnus_log_payment`. */
export const logPayment = internalAction({
  args: {
    caller: mcpCallerValidator,
    ...paymentInputArgs,
    uploadId: v.optional(v.id("paymentProofUploads")),
    // ChatGPT's file param; validated by hand because its shape is ChatGPT's.
    proof: v.optional(v.any()),
    confirm: v.boolean(),
    confirmToken: v.optional(v.string()),
  },
  returns: v.union(previewResult, commitResult),
  handler: async (
    ctx,
    { caller, uploadId, proof, confirm, confirmToken, ...input },
  ): Promise<Infer<typeof previewResult> | Infer<typeof commitResult>> => {
    const file = parseChatGptFile(proof);
    if (!confirm) {
      // Annotated: a same-file runMutation would otherwise make the
      // generated API type circular.
      const preview: Infer<typeof previewResult> = await ctx.runMutation(
        internal.mcp.tools.payments.previewPayment,
        {
          caller,
          ...input,
          proofKind: uploadId ? "upload" : file ? "file" : "missing",
          ...(file?.file_name ? { proofName: file.file_name } : {}),
        },
      );
      return preview;
    }
    const stored = file && !uploadId ? await storeChatGptFile(ctx, file) : null;
    try {
      const result: Infer<typeof commitResult> = await ctx.runMutation(internal.mcp.tools.payments.commitPayment, {
        caller,
        ...input,
        ...(confirmToken ? { confirmToken } : {}),
        ...(uploadId ? { uploadId } : {}),
        ...(stored ? { storedFile: stored } : {}),
      });
      if (result.status === "recorded" && result.discardStorageId) {
        await ctx.storage.delete(result.discardStorageId);
      }
      return result;
    } catch (error) {
      if (stored) await ctx.storage.delete(stored.storageId);
      throw error;
    }
  },
});

// ── magnus_attach_proof (decision 12a) ──────────────────────────────

const attachResult = v.object({ ok: v.literal(true), message: v.string(), reused: v.boolean() });

export const attachProofToPayment = internalMutation({
  args: {
    caller: mcpCallerValidator,
    paymentId: v.id("paymentRecords"),
    uploadId: v.optional(v.id("paymentProofUploads")),
    storedFile: v.optional(v.object({ storageId: v.id("_storage"), fileName: v.optional(v.string()) })),
  },
  returns: attachResult,
  handler: async (ctx, { caller, paymentId, uploadId, storedFile }) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    const payment = await ctx.db.get("paymentRecords", paymentId);
    if (
      !payment ||
      payment.tenantId !== me.tenantId ||
      (payment.recordedByUserId !== me.userId && payment.attributedCloserId !== me.userId)
    ) {
      throw rejectRequest("payment.not_yours", "That isn't one of your payments.");
    }
    if (payment.proofFileId) {
      throw rejectRequest("payment.has_proof", "This payment already has a proof file. An admin can replace it in Billing.");
    }
    let storageId: Id<"_storage">;
    let upload: Doc<"paymentProofUploads"> | null = null;
    if (uploadId) {
      upload = await ctx.db.get("paymentProofUploads", uploadId);
      if (!upload || upload.userId !== me.userId || upload.status !== "ready" || !upload.storageId) {
        throw rejectRequest("upload.not_ready", "That upload isn't ready. Upload the file first.");
      }
      storageId = upload.storageId;
    } else if (storedFile) {
      storageId = storedFile.storageId;
    } else {
      throw rejectRequest("proof.required", "Attach the receipt: pass an uploadId, or the file itself in ChatGPT.");
    }
    const checked = await checkPaymentProof(ctx, { role: "closer", userId: me.userId, proofFileId: storageId });
    const fields = await newPaymentFields(ctx, me.tenantId, checked, { via: "mcp", agentClient: me.agentClient });
    await ctx.db.patch("paymentRecords", payment._id, {
      proofFileId: storageId,
      ...(fields.proofSha256 ? { proofSha256: fields.proofSha256 } : {}),
      ...(fields.proofReused ? { proofReused: true } : {}),
    });
    if (upload) {
      await ctx.db.patch("paymentProofUploads", upload._id, { status: "attached", paymentId });
    } else if (storedFile) {
      await ctx.db.insert("paymentProofUploads", {
        tenantId: me.tenantId,
        userId: me.userId,
        source: "chatgpt_file",
        storageId,
        ...(storedFile.fileName ? { fileName: storedFile.fileName.slice(0, 200) } : {}),
        status: "attached",
        paymentId,
        createdAt: Date.now(),
      });
    }
    await emitDomainEvent(ctx, {
      tenantId: me.tenantId,
      entityType: "payment",
      entityId: payment._id,
      eventType: "payment.proof_attached",
      source: "closer",
      actorUserId: me.userId,
      metadata: { via: "mcp", agentClient: me.agentClient, reused: Boolean(fields.proofReused) },
    });
    return {
      ok: true as const,
      reused: Boolean(fields.proofReused),
      message: fields.proofReused
        ? "Attached. This file also backs another payment, so Billing will flag it for the reviewer."
        : "Attached. The payment shows its proof in Billing now.",
    };
  },
});

/** `magnus_attach_proof`. */
export const attachProof = internalAction({
  args: {
    caller: mcpCallerValidator,
    paymentId: v.id("paymentRecords"),
    uploadId: v.optional(v.id("paymentProofUploads")),
    proof: v.optional(v.any()),
  },
  returns: attachResult,
  handler: async (ctx, { caller, paymentId, uploadId, proof }): Promise<Infer<typeof attachResult>> => {
    const file = parseChatGptFile(proof);
    const stored = file && !uploadId ? await storeChatGptFile(ctx, file) : null;
    try {
      const result: Infer<typeof attachResult> = await ctx.runMutation(internal.mcp.tools.payments.attachProofToPayment, {
        caller,
        paymentId,
        ...(uploadId ? { uploadId } : {}),
        ...(stored ? { storedFile: stored } : {}),
      });
      return result;
    } catch (error) {
      if (stored) await ctx.storage.delete(stored.storageId);
      throw error;
    }
  },
});
