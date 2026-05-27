const path = require("path");
const { spawn } = require("child_process");
const { test, expect } = require("@playwright/test");

const SERVE_JS = path.resolve(__dirname, "..", "..", "..", "serve.js");
// Post-2026-05-02: webapp persists last-folder under <webapp>/.scratch/
// (single .gitignore-able dir for all runtime output). Pre-migration tests
// referenced <webapp>/.last_folder; serve.js auto-migrates that legacy path
// on startup, so cleaning the new location alone is sufficient.
const LAST_FOLDER_FILE = path.resolve(__dirname, "..", "..", "..", ".scratch", "last_folder.txt");
const PORT = 12000 + Math.floor(Math.random() * 1000);

let serverProc;

test.beforeAll(async () => {
  const fs = require("fs");
  try { fs.unlinkSync(LAST_FOLDER_FILE); } catch (_) {}

  serverProc = spawn(process.execPath, [SERVE_JS, String(PORT)], {
    stdio: "pipe",
    cwd: path.dirname(SERVE_JS)
  });

  let stderrBuf = "";
  serverProc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("serve.js timeout. stderr: " + stderrBuf)), 10000);
    serverProc.stdout.on("data", (d) => {
      if (d.toString().includes("http://")) { clearTimeout(timeout); resolve(); }
    });
    serverProc.on("close", (code) => { clearTimeout(timeout); reject(new Error("serve.js exited " + code)); });
    serverProc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
});

test.afterAll(async () => {
  if (serverProc) { serverProc.kill(); serverProc = null; }
});

test("translator app shell renders without runtime exception", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });

  await page.goto(`http://localhost:${PORT}/index.html`);
  // Commit 0c0db30 demoted "Open Package Folder" to a neutral `class="btn"`
  // (only the two ZIP buttons keep `.btn.primary`). Match on label class + text;
  // for="packageInput" is stripped at runtime when serve.js is detected.
  await expect(page.locator('label.btn:has-text("Open Package Folder")')).toBeVisible();
  await expect(page.locator("#cardsView")).toBeVisible();
  await expect(page.locator("#themeModeBtn")).toBeVisible();

  expect(pageErrors).toEqual([]);
});
