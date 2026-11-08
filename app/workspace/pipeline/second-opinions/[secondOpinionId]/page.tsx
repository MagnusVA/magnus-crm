import { requirePermission } from "@/lib/auth";
import type { Id } from "@/convex/_generated/dataModel";
import { SecondOpinionDetailPageClient } from "../_components/second-opinion-detail-page-client";
export const instant = false;
export default async function SecondOpinionDetailPage({
  params,
}: {
  params: Promise<{ secondOpinionId: string }>;
}) {
  await requirePermission("second-opinion:review");
  const { secondOpinionId } = await params;
  return (
    <SecondOpinionDetailPageClient
      secondOpinionId={secondOpinionId as Id<"secondOpinions">}
    />
  );
}
