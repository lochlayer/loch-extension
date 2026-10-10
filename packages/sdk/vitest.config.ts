import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Groth16 proving with the real devnet artifacts takes a few seconds per proof.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
