import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      EVOLUTION_API_BASE_URL: "https://evolution.test",
      EVOLUTION_GLOBAL_API_KEY: "test-global-key",
      // Read by POST /api/whatsapp/evolution/connect's webhookUrl() to
      // register the inbound webhook — throws a clear error if unset.
      NEXT_PUBLIC_SITE_URL: "https://app.test",
    },
    clearMocks: true,
  },
});
