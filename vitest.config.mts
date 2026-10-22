import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "edge-runtime",
    include: [
      "convex/**/*.test.ts",
      "lib/**/*.test.ts",
    ],
    server: { deps: { inline: ["convex-test"] } },
  },
});
