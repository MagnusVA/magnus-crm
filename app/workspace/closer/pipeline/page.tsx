import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { CloserPipelinePageClient } from "./_components/closer-pipeline-page-client";
import { PipelinePageSkeleton } from "./_components/pipeline-skeleton";

export const instant = false;

export default async function CloserPipelinePage() {
	await requireRole(["closer"]);
	return (
		<Suspense fallback={<PipelinePageSkeleton />}>
			<CloserPipelinePageClient />
		</Suspense>
	);
}
