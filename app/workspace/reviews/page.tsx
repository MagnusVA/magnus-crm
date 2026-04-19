import { requireRole } from "@/lib/auth";
import { ReviewsPageClient } from "./_components/reviews-page-client";

export const unstable_instant = false;

export default async function ReviewsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <ReviewsPageClient />;
}
