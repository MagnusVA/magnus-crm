import { PostHog } from "posthog-node";
import { isPostHogEnabled } from "@/lib/posthog-config";

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  if (!isPostHogEnabled()) {
    return null;
  }

  if (!posthogClient) {
    posthogClient = new PostHog(
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!,
      {
        host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
      },
    );
  }
  return posthogClient;
}

export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
