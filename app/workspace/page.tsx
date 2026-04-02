"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { redirect } from "next/navigation";

export default function WorkspaceRoot() {
  const user = useQuery(api.users.queries.getCurrentUser);

  if (user === undefined) return null; // Loading
  if (user === null) return null; // Not provisioned — layout handles this

  // Closers get redirected to their dedicated dashboard
  if (user.role === "closer") {
    redirect("/workspace/closer");
  }

  // Owner/Admin see the admin dashboard (built in Phase 4)
  // Placeholder until Phase 4 builds the real content
  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="text-muted-foreground mt-2">
        Welcome back, {user.fullName ?? user.email}.
        Admin dashboard content coming in Phase 4.
      </p>
    </div>
  );
}
