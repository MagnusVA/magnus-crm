import { SystemHealth } from "./system-health";

/**
 * Server component wrapper for the system health card.
 *
 * `SystemHealth` is a client component that uses `useQuery` internally
 * for the Calendly connection status — it manages its own data loading
 * and skeleton state. Wrapping it in its own `<Suspense>` boundary
 * ensures errors are isolated from the rest of the dashboard.
 */
export function SystemHealthSection() {
  return <SystemHealth />;
}
