import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { SecondOpinionsPageClient } from "./_components/second-opinions-page-client";
import { SecondOpinionsSkeleton } from "./_components/second-opinions-skeleton";
export const unstable_instant = false;
export default async function SecondOpinionsPage() {
  await requirePermission("second-opinion:review");
  return (
    <Suspense fallback={<SecondOpinionsSkeleton />}>
      <SecondOpinionsPageClient />
    </Suspense>
  );
}
