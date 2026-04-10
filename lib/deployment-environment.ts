/**
 * Returns whether the current app is running in a non-production deployment.
 *
 * Order matters:
 * - Vercel preview/dev deployments expose `VERCEL_ENV`
 * - Local Convex development exposes `CONVEX_DEPLOYMENT=dev:...`
 * - `NODE_ENV=development` is the final local fallback
 */
export function isNonProductionDeployment() {
  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV !== "production";
  }

  if (process.env.CONVEX_DEPLOYMENT) {
    return process.env.CONVEX_DEPLOYMENT.startsWith("dev:");
  }

  return process.env.NODE_ENV === "development";
}
