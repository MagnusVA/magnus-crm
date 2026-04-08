import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { FeaturedMeetingCardWrapper } from "./featured-meeting-card-wrapper";

/**
 * Async server component for the featured/next meeting card.
 *
 * Streams independently in its own `<Suspense>` boundary.
 * Requires the session `token` for authenticated `preloadQuery` calls
 * (the closer's Convex queries check identity via `requireTenantUser`).
 */
export async function FeaturedMeetingSection({
  token,
}: {
  token: string;
}) {
  const preloadedMeeting = await preloadQuery(
    api.closer.dashboard.getNextMeeting,
    {},
    { token },
  );

  return <FeaturedMeetingCardWrapper preloadedMeeting={preloadedMeeting} />;
}
