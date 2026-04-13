import { requireRole } from "@/lib/auth";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server-side auth gate — redirects if not tenant_master or tenant_admin.
  // Cached per-request via React cache() inside lib/auth.ts.
  await requireRole(["tenant_master", "tenant_admin"]);

  return <>{children}</>;
}
