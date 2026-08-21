const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  timeout: 30_000,
  // Journeys share the same two dedicated test accounts (one customer, one
  // admin) — running them in parallel risks one test's basket/profile edit
  // interfering with another's. Serial keeps each run deterministic.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["html", { open: "never" }], ["list"]],
  globalSetup: require.resolve("./auth/get-tokens.js"),
  use: {
    baseURL: process.env.SMARTRETAILX_SITE_URL || "https://d1vxg10hlsklfv.cloudfront.net",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
