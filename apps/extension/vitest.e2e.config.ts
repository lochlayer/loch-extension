import { defineConfig } from "vitest/config";

// The end-to-end tests drive Chromium through the Playwright library. They run under vitest
// rather than the Playwright test runner: the runner's module loader cannot load
// @solana/web3.js, which the mock chain and services need in the same process.
export default defineConfig({
  test: {
    include: ["e2e/**/*.spec.ts"],
    environment: "node",
    testTimeout: 150_000,
    hookTimeout: 150_000,
    fileParallelism: false,
    // One browser, one extension, one mock chain: the tests tell one story, in order.
    sequence: { concurrent: false },
    bail: 1,
    // Lets Playwright report the requests an extension service worker makes.
    env: { PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS: "1" },
  },
});
