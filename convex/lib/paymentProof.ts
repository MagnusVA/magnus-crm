import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Provenance } from "../mcp/guard";
import { expectedError, rejectRequest } from "./observability/errors";
import type { CrmRole } from "./roleMapping";
import {
  PROOF_CONTENT_TYPES,
  PROOF_MAX_BYTES,
  PROOF_REQUIRED_MESSAGE,
} from "../../lib/paymentProof";

// No proof, no payment (docs/plans/closer-assistant.md §5.3, decision 3): a
// closer's payment needs a proof file on every path, the agent's included,
// and any file given must be one the dialogs accept. Admins keep proof
// optional. The rule lives in the payment writes, so no client gets around it.

export { PROOF_CONTENT_TYPES, PROOF_MAX_BYTES, PROOF_REQUIRED_MESSAGE };

/** A proof file that passed the rule, with the hash `_storage` holds. */
export type CheckedProof = { proofFileId: Id<"_storage">; sha256: string };

function normalizedContentType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase() || undefined;
}

/**
 * Applies the proof rule for `role`, reading the file's `_storage` row.
 * Returns the checked file, or null when an admin gave none. Throws a
 * `ConvexError` the dialogs and agents show as is.
 */
export async function checkPaymentProof(
  ctx: QueryCtx | MutationCtx,
  args: { role: CrmRole; userId: Id<"users">; proofFileId: Id<"_storage"> | undefined },
): Promise<CheckedProof | null> {
  // Queries re-run on subscription updates, so a query's refusal skips the
  // `request.rejected` log line, as requireTenantUser does.
  const reject: typeof rejectRequest =
    "scheduler" in ctx ? rejectRequest : (code, message) => expectedError(code, message);
  const attrs = { userId: args.userId, role: args.role };

  if (!args.proofFileId) {
    if (args.role === "closer") {
      throw reject("payment.proof_required", PROOF_REQUIRED_MESSAGE, attrs);
    }
    return null;
  }

  const file = await ctx.db.system.get("_storage", args.proofFileId);
  if (!file) {
    throw reject(
      "payment.proof_missing",
      "The proof file wasn't found. Upload it again.",
      attrs,
    );
  }
  if (file.size > PROOF_MAX_BYTES) {
    throw reject(
      "payment.proof_too_large",
      "The proof file is over 10 MB. Upload a smaller file.",
      { ...attrs, size: file.size },
    );
  }
  const contentType = normalizedContentType(file.contentType);
  if (!contentType || !(PROOF_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw reject(
      "payment.proof_type",
      "The proof file must be a JPEG, PNG, GIF or PDF.",
      { ...attrs, contentType: file.contentType ?? "none" },
    );
  }
  return { proofFileId: args.proofFileId, sha256: file.sha256 };
}

/**
 * The fields every new payment row gets (§6.3): how it was entered, the
 * agent's client, and the proof's hash, with `proofReused` when another
 * payment in the tenant already holds the same file. A reused proof is a
 * flag for the Billing reviewer, not a refusal. Call it before inserting the
 * row, so the lookup can't find the payment itself.
 */
export async function newPaymentFields(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  proof: CheckedProof | null,
  provenance: Provenance,
): Promise<{
  recordedVia: "web" | "mcp";
  agentClient?: string;
  proofSha256?: string;
  proofReused?: true;
}> {
  const via =
    provenance.via === "mcp"
      ? { recordedVia: "mcp" as const, agentClient: provenance.agentClient }
      : { recordedVia: "web" as const };
  if (!proof) return via;

  const other = await ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_proofSha256", (q) =>
      q.eq("tenantId", tenantId).eq("proofSha256", proof.sha256),
    )
    .first();
  return {
    ...via,
    proofSha256: proof.sha256,
    ...(other ? { proofReused: true as const } : {}),
  };
}

/**
 * How a payment's check treats the proof file. The cores always check it. A
 * preview may `skip` it, to check the rest before the closer has a file to
 * give, such as before an agent hands out the payment link.
 */
export type ProofCheckOptions = { proof?: "check" | "skip" };
