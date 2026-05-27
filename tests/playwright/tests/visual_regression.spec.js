/**
 * Playwright visual regression tests â€” screenshot comparison.
 *
 * Captures element-level screenshots of overlay and toolbar states.
 * First run generates baselines in tests/visual_regression.spec.js-snapshots/.
 * Subsequent runs compare pixel-by-pixel (1% tolerance).
 *
 * To update baselines after intentional CSS changes:
 *   npx playwright test tests/visual_regression.spec.js --update-snapshots
 */
const path = require("path");
const { spawn } = require("child_process");
const { test, expect } = require("@playwright/test");

const SERVE_JS = path.resolve(__dirname, "..", "..", "..", "serve.js");
const LAST_FOLDER_FILE = path.resolve(__dirname, "..", "..", "..", ".scratch", "last_folder.txt");
const PACKAGE_MIN = path.resolve(__dirname, "..", "..", "automation", "fixtures", "package_min");

const PORT = 14000 + Math.floor(Math.random() * 5000);
const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.01 };

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
    const timeout = setTimeout(() => {
      reject(new Error("serve.js startup timeout. stderr: " + stderrBuf));
    }, 10000);
    serverProc.stdout.on("data", (d) => {
      if (d.toString().includes("http://")) { clearTimeout(timeout); resolve(); }
    });
    serverProc.on("close", (code) => {
      clearTimeout(timeout);
      reject(new Error("serve.js exited with code " + code + ". stderr: " + stderrBuf));
    });
    serverProc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
});

test.afterAll(async () => {
  if (serverProc) { serverProc.kill(); serverProc = null; }
});

async function loadPackageMin(page) {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await expect(page.locator("#cardsView")).toBeVisible();
  await page.evaluate(async (dirPath) => {
    await loadFolderFromServer(dirPath);
  }, PACKAGE_MIN);
  await expect(page.locator(".segment-card")).toHaveCount(3, { timeout: 5000 });
}

// â”€â”€ 1. Multi-format overlay: bold+italic+color+comment on same row â”€â”€

test("visual: multi-format overlay on tid_test_000001", async ({ page }) => {
  await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000001"]');
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");
  await expect(overlay).toBeAttached();

  // Wait for rendering to settle (overlay layout is timing-sensitive)
  await page.waitForTimeout(500);

  await expect(overlay).toHaveScreenshot("overlay-multi-format.png", SCREENSHOT_OPTS);
});

// â”€â”€ 2. Adjacent same-format: visual merge (no gap) â”€â”€

test("visual: adjacent same-format annotations merge visually", async ({ page }) => {
  await loadPackageMin(page);

  // Create two adjacent bold annotations on tid_test_000003
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  // Bold first 3 chars
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");
  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Bold next 2 chars
  for (let i = 0; i < 2; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Click away to dismiss toolbar
  await page.locator("#cardsView").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(500);

  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");
  await expect(overlay).toHaveScreenshot("overlay-adjacent-same-format.png", SCREENSHOT_OPTS);
});

// â”€â”€ 3. Adjacent different-format: gap between â”€â”€

test("visual: adjacent different-format annotations have gap", async ({ page }) => {
  await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  // Bold first 3 chars
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");
  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Italic next 2 chars
  for (let i = 0; i < 2; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="italic"]').click();

  await page.locator("#cardsView").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(500);

  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");
  await expect(overlay).toHaveScreenshot("overlay-adjacent-diff-format.png", SCREENSHOT_OPTS);
});

// â”€â”€ 4. Toolbar: all format buttons active â”€â”€

test("visual: toolbar with all formats active", async ({ page }) => {
  await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  // Select first 3 chars, apply bold + italic + superscript
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();
  await toolbar.locator('[data-ann-action="italic"]').click();
  await toolbar.locator('[data-ann-action="superscript"]').click();

  await page.waitForTimeout(100);
  await expect(toolbar).toHaveScreenshot("toolbar-all-active.png", SCREENSHOT_OPTS);
});

// â”€â”€ 5. Toolbar + color panel expanded â”€â”€

test("visual: toolbar with color panel open", async ({ page }) => {
  await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Open color panel
  await toolbar.locator('[data-ann-action="color"]').click();
  await page.waitForTimeout(100);

  await expect(toolbar).toHaveScreenshot("toolbar-color-panel.png", SCREENSHOT_OPTS);
});

// â”€â”€ 6. Toolbar + comment panel with text â”€â”€

test("visual: toolbar with comment panel", async ({ page }) => {
  await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Open comment panel
  await toolbar.locator('[data-ann-action="comment"]').click();
  const commentInput = toolbar.locator(".ann-tb-comment-input");
  await expect(commentInput).toBeVisible({ timeout: 2000 });

  // Type some comment text
  await commentInput.fill("Review this section");
  await page.waitForTimeout(100);

  await expect(toolbar).toHaveScreenshot("toolbar-comment-panel.png", SCREENSHOT_OPTS);
});
