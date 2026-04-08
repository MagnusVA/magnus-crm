import { requireWorkspaceUser } from "@/lib/auth";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { ProfilePageClient } from "./_components/profile-page-client";

export const unstable_instant = { prefetch: "static" };

export default async function ProfilePage() {
  const { session } = await requireWorkspaceUser();

  const preloadedProfile = await preloadQuery(
    api.users.queries.getCurrentUser,
    {},
    { token: session.accessToken },
  );

  return <ProfilePageClient preloadedProfile={preloadedProfile} />;
}
