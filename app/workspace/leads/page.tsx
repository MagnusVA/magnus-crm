import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth";

export const unstable_instant = false;

export default async function LegacyLeadsPage({
	searchParams,
}: {
	searchParams: Promise<{ status?: string }>;
}) {
	await requirePermission("lead:view-all");
	const { status } = await searchParams;
	const params = new URLSearchParams();
	if (status === "converted") params.set("lifecycle", "customer");
	const suffix = params.toString();
	redirect(`/workspace/leads-customers${suffix ? `?${suffix}` : ""}`);
}
