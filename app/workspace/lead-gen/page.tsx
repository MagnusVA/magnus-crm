import { redirect } from "next/navigation";

export const unstable_instant = false;

/**
 * The admin lead-gen dashboard moved under Operations.
 * Lead-generator pages (capture, my-activity) and settings keep their URLs.
 */
export default function LeadGenAdminPage() {
  redirect("/workspace/operations/lead-gen");
}
