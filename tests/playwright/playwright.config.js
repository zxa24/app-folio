const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  // phase7_sc_convergence requires a richer source layout than package_min
  // provides. Ignored by default until a phase7-specific fixture exists.
  // Run manually with: npx playwright test phase7_sc_convergence
  testIgnore: ["**/phase7_sc_convergence.spec.js"],
  timeout: 30000,
  retries: 0,  // no retries -- tests must pass cleanly, not hide flakiness
  workers: 1,  // serialize to avoid port/browser collisions between spec files
  // .scratch/ convention: all runtime test artifacts (reports, traces,
  // attachments) go under repo-root .scratch/playwright/, so a single
  // .gitignore entry `.scratch/` covers them.
  outputDir: "./.scratch/playwright/test-results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "./.scratch/playwright/html-report" }]
  ],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 }
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ]
});
