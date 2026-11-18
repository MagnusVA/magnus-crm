import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "edge-runtime",
    // Fixtures use a Whop Sandbox connection, which records only on the
    // development deployment. Tests of the production refusal stub this.
    env: { CONVEX_CLOUD_URL: "https://cautious-donkey-511.convex.cloud" },
    include: [
      "convex/**/*.test.ts",
      "lib/**/*.test.ts",
    ],
    server: { deps: { inline: ["convex-test"] } },
  },
});
