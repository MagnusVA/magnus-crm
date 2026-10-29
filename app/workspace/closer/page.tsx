import { requireRole } from "@/lib/auth";
import { CloserTodayPageClient } from "./_components/closer-today-page-client";

export const unstable_instant = false;

export default async function CloserTodayPage() {
	await requireRole(["closer"]);
	return <CloserTodayPageClient />;
}
