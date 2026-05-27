/**
 * Playwright integration tests — annotation overlay rendering.
 *
 * Starts serve.js on a random port, loads package_min (which has
 * translations.json with annotations), and verifies overlay DOM.
 *
 * Fixture rows:
 *   tid_test_000001 — 4 adjacent annotations (bold, italic, color, comment)
 *   tid_test_000002 — 1 superscript annotation
 *   tid_test_000003 — no annotations (plain translated row)
 */
const path = require("path");
const { spawn } = require("child_process");
const { test, expect } = require("@playwright/test");

const SERVE_JS = path.resolve(__dirname, "..", "..", "..", "serve.js");
const LAST_FOLDER_FILE = path.resolve(__dirname, "..", "..", "..", ".scratch", "last_folder.txt");
const PACKAGE_MIN = path.resolve(__dirname, "..", "..", "automation", "fixtures", "package_min");

const PORT = 13000 + Math.floor(Math.random() * 5000);

let serverProc;

test.beforeAll(async () => {
  const fs = require("fs");
  try { fs.unlinkSync(LAST_FOLDER_FILE); } catch (_) {}

  serverProc = spawn(process.execPath, [SERVE_JS, String(PORT)], {
    stdio: "pipe",
    cwd: path.dirname(SERVE_JS)
  });

  // Collect stderr for diagnostics
  let stderrBuf = "";
  serverProc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("serve.js startup timeout. stderr: " + stderrBuf));
    }, 10000);

    serverProc.stdout.on("data", (d) => {
      if (d.toString().includes("http://")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    // Fail fast on early exit
    serverProc.on("close", (code) => {
      clearTimeout(timeout);
      reject(new Error("serve.js exited with code " + code + ". stderr: " + stderrBuf));
    });

    serverProc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
});

test.afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});

/**
 * Helper: navigate to app, load package_min, return pageErrors collector.
 * Every test MUST call `expect(pageErrors).toEqual([])` at the end.
 */
async function loadPackageMin(page) {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await expect(page.locator("#cardsView")).toBeVisible();

  await page.evaluate(async (dirPath) => {
    await loadFolderFromServer(dirPath);
  }, PACKAGE_MIN);

  // 3 segments in fixture
  await expect(page.locator(".segment-card")).toHaveCount(3, { timeout: 5000 });

  return pageErrors;
}

/**
 * Test-setup contract: tests asserting on [data-hotspot-owner] DOM must
 * explicitly request a PDF render and then wait for it to complete.
 *
 * Why: app.js's renderAll() at line 1757 invokes renderPdf() as
 * fire-and-forget (`void renderPdfAsync()`), and renderHotspots() bails
 * early when state.pdfViewBox is null. After certain interactions the
 * hotspot layer can also be cleared mid-test. Treating "render the PDF
 * and wait for hotspots to mount" as a single explicit test-setup step
 * avoids racing on the implicit initial render.
 *
 * Soundness: the helper clears the hotspot layer's children BEFORE
 * triggering renderPdf, so when the wait sees children > 0 again it
 * must be the freshly-requested render that populated them. If
 * renderHotspots ever regresses such that the layer is no longer
 * repopulated after a render request, this wait will time out and
 * surface the regression rather than masking it.
 */
async function waitForHotspots(page) {
  await page.evaluate(() => {
    const layer = document.getElementById("hotspotLayer");
    if (layer) {
      layer.innerHTML = "";
    }
    if (typeof window.renderPdf === "function") {
      window.renderPdf();
    }
  });
  await page.waitForFunction(
    () => {
      const layer = document.getElementById("hotspotLayer");
      return layer && layer.children.length > 0;
    },
    null,
    { timeout: 20000, polling: 250 }
  );
}

// ── Test 1: overlay renders .ann-highlight spans ──

test("annotation overlay renders .ann-highlight spans after loading package", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  const highlights = page.locator(".token-target-overlay .ann-highlight");
  await expect(highlights.first()).toBeAttached({ timeout: 3000 });

  const count = await highlights.count();
  expect(count).toBeGreaterThanOrEqual(4);

  const firstType = await highlights.first().getAttribute("data-ann-type");
  expect(["format", "comment"]).toContain(firstType);

  expect(pageErrors).toEqual([]);
});

// ── Test 2: data-ann-action attributes ──

test("annotation overlay has correct data-ann-action attributes", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  const highlights = page.locator(".token-target-overlay .ann-highlight");
  await expect(highlights.first()).toBeAttached({ timeout: 3000 });

  const actions = await highlights.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-ann-action")).filter(Boolean)
  );

  expect(actions).toContain("bold");
  expect(actions).toContain("italic");
  expect(actions).toContain("color");

  expect(pageErrors).toEqual([]);
});

// ── Test 3: annotation-free row has no highlights on its TARGET overlay ──

test("row without annotations has no .ann-highlight in target overlay", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  // tid_test_000003 has no annotations — its target overlay must be clean
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  await expect(card).toBeVisible();

  const targetOverlay = card.locator(".token-target-wrap.target-field .token-target-overlay");
  await expect(targetOverlay).toBeAttached();

  // Overlay should contain text but no .ann-highlight
  const highlightCount = await targetOverlay.locator(".ann-highlight").count();
  expect(highlightCount).toBe(0);

  // Verify it does have content (not vacuously empty)
  const text = await targetOverlay.textContent();
  expect(text).toContain("无标注的普通行");

  expect(pageErrors).toEqual([]);
});

// ── Test 4: classic view input triggers overlay refresh ──
// No if-guards — every step must succeed or the test fails.

test("classic view input triggers overlay refresh", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  // Switch to classic view via <select>
  const viewSelect = page.locator("#editorViewMode");
  await expect(viewSelect).toBeVisible({ timeout: 3000 });
  await viewSelect.selectOption("classic");

  // Select first segment row
  const firstRow = page.locator('.segment-row[data-tid="tid_test_000001"]');
  await expect(firstRow).toBeVisible({ timeout: 3000 });
  await firstRow.click();

  // Detail target textarea must be visible
  const targetInput = page.locator("#targetInput");
  await expect(targetInput).toBeVisible({ timeout: 3000 });

  // Get overlay content before edit
  const overlayBefore = await targetInput.evaluate((el) => {
    const wrap = el.parentElement;
    const ov = wrap && wrap.querySelector(".token-target-overlay");
    return ov ? ov.innerHTML : "";
  });
  expect(overlayBefore).toContain("ann-highlight");

  // Type at the end
  await targetInput.press("End");
  await targetInput.type("X");

  // Overlay must have updated
  const overlayAfter = await targetInput.evaluate((el) => {
    const wrap = el.parentElement;
    const ov = wrap && wrap.querySelector(".token-target-overlay");
    return ov ? ov.innerHTML : "";
  });

  expect(overlayAfter).not.toBe(overlayBefore);
  expect(overlayAfter).toContain("ann-highlight");
  // The appended "X" should appear in the overlay text
  expect(overlayAfter).toContain("X");

  expect(pageErrors).toEqual([]);
});

// ── Test 5: adjacent annotations produce distinct non-merged spans ──

test("adjacent annotations produce 4 distinct top-level ann-highlight spans", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000001"]');
  await expect(card).toBeVisible();

  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");
  await expect(overlay).toBeAttached();

  // Collect top-level children that are .ann-highlight (direct children of overlay)
  // and their data-ann-idx + textContent to verify exact structure.
  const spans = await overlay.evaluate((ov) => {
    const results = [];
    for (const child of ov.childNodes) {
      if (child.nodeType === 1 && child.classList.contains("ann-highlight")) {
        results.push({
          idx: child.getAttribute("data-ann-idx"),
          action: child.getAttribute("data-ann-action"),
          text: child.textContent
        });
      }
    }
    return results;
  });

  // Fixture: "你好"(bold,idx=0) "世界"(italic,idx=1) "测试"(color,idx=2) "文本"(comment,idx=3)
  // Must have exactly 4 top-level annotation spans
  expect(spans.length).toBe(4);

  // Verify each span maps to the correct annotation
  expect(spans[0]).toEqual({ idx: "0", action: "bold", text: "你好" });
  expect(spans[1]).toEqual({ idx: "1", action: "italic", text: "世界" });
  expect(spans[2]).toEqual({ idx: "2", action: "color", text: "测试" });
  expect(spans[3]).toEqual({ idx: "3", action: "", text: "文本" });

  expect(pageErrors).toEqual([]);
});

// ── Phase 2: Annotation toolbar tests ──

test("selecting text in target textarea shows annotation toolbar", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  // Use tid_test_000003 (no existing annotations) to test creation flow
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  await expect(card).toBeVisible();

  const textarea = card.locator(".card-target");
  await expect(textarea).toBeVisible();

  // Select text by clicking then shift-clicking to create selection
  await textarea.focus();
  // Select first 3 chars via keyboard
  await textarea.press("Home");
  await textarea.press("Shift+ArrowRight");
  await textarea.press("Shift+ArrowRight");
  await textarea.press("Shift+ArrowRight");
  // Trigger mouseup to show toolbar
  await textarea.dispatchEvent("mouseup");

  // Toolbar should appear
  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Should have format buttons
  await expect(toolbar.locator('[data-ann-action="bold"]')).toBeVisible();
  await expect(toolbar.locator('[data-ann-action="italic"]')).toBeVisible();
  await expect(toolbar.locator('[data-ann-action="superscript"]')).toBeVisible();
  await expect(toolbar.locator('[data-ann-action="color"]')).toBeVisible();
  await expect(toolbar.locator('[data-ann-action="comment"]')).toBeVisible();

  // Delete button should be hidden in create mode
  await expect(toolbar.locator('[data-ann-action="delete"]')).toBeHidden();

  expect(pageErrors).toEqual([]);
});

test("clicking bold button creates annotation and updates overlay", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  // Select "无标注" (first 3 chars)
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Click bold
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Toolbar stays visible after creation (user can add more formats)
  await expect(toolbar).toBeVisible();

  // Overlay should now have an ann-highlight span
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");
  const highlight = overlay.locator(".ann-highlight");
  await expect(highlight.first()).toBeAttached({ timeout: 2000 });

  // Verify the new annotation's data attributes
  const attrs = await highlight.first().evaluate((el) => ({
    type: el.getAttribute("data-ann-type"),
    action: el.getAttribute("data-ann-action"),
    text: el.textContent
  }));
  expect(attrs.type).toBe("format");
  expect(attrs.action).toBe("bold");
  expect(attrs.text).toBe("无标注");

  expect(pageErrors).toEqual([]);
});

test("clicking inside existing annotation shows toolbar in edit mode with delete button", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  // tid_test_000001 has annotations — click inside the bold annotation "你好"
  const card = page.locator('.segment-card[data-tid="tid_test_000001"]');
  const textarea = card.locator(".card-target");
  await textarea.focus();

  // Place cursor at offset 1 (inside "你好" bold annotation at [0,2))
  await textarea.press("Home");
  await textarea.press("ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Delete button should be visible in edit mode
  await expect(toolbar.locator('[data-ann-action="delete"]')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("delete button removes annotation", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  const card = page.locator('.segment-card[data-tid="tid_test_000001"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Count highlights before
  const countBefore = await overlay.locator(".ann-highlight").count();
  expect(countBefore).toBe(4);

  // Click inside first annotation to enter edit mode
  await textarea.focus();
  await textarea.press("Home");
  await textarea.press("ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Click delete
  await toolbar.locator('[data-ann-action="delete"]').click();

  // Toolbar stays visible after delete
  await expect(toolbar).toBeVisible();

  // One fewer highlight
  const countAfter = await overlay.locator(".ann-highlight").count();
  expect(countAfter).toBe(3);

  expect(pageErrors).toEqual([]);
});

// ── Tier 2: Cards view interaction flow tests ──

test("bold toggle off updates hotspot preview", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000001"]');
  const textarea = card.locator(".card-target");

  // Verify hotspot has formatted text initially
  const hotspot = page.locator('[data-hotspot-owner="tid_test_000001"] .hotspot-text');

  // Select bold text "你好" [0,2) and toggle bold off
  await textarea.focus();
  await textarea.press("Home");
  await textarea.press("Shift+ArrowRight");
  await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Hotspot should no longer have <b> for the removed annotation
  await waitForHotspots(page);
  await expect(hotspot).toBeAttached({ timeout: 2000 });
  const hotspotHtml = await hotspot.innerHTML();
  expect(hotspotHtml).not.toContain("<b>你好</b>");

  expect(pageErrors).toEqual([]);
});

test("multi-format: bold + italic coexist on same text", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Select first 3 chars, apply bold
  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Now apply italic to same range
  await toolbar.locator('[data-ann-action="italic"]').click();

  // Should have both bold and italic annotations
  const actions = await overlay.locator(".ann-highlight").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-ann-action")).filter(Boolean)
  );
  expect(actions).toContain("bold");
  expect(actions).toContain("italic");

  expect(pageErrors).toEqual([]);
});

test("sub-range toggle: bold on sub-range preserves rest", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Select all text, apply bold
  await textarea.focus();
  await textarea.press("Control+a");
  await textarea.dispatchEvent("mouseup");
  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Count highlights
  const countAll = await overlay.locator(".ann-highlight").count();
  expect(countAll).toBeGreaterThanOrEqual(1);

  // Now select sub-range [1,3) and toggle bold off
  await textarea.press("Home");
  await textarea.press("ArrowRight");
  await textarea.press("Shift+ArrowRight");
  await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Should still have highlights (split parts), but more spans now
  const highlights = await overlay.locator(".ann-highlight").evaluateAll((els) =>
    els.map((el) => ({ action: el.getAttribute("data-ann-action"), text: el.textContent }))
  );
  // Sub-range [1,3) should NOT be bold; surrounding parts should still be bold
  const boldTexts = highlights.filter(h => h.action === "bold").map(h => h.text);
  expect(boldTexts.length).toBeGreaterThanOrEqual(1);
  // The removed sub-range chars should not appear in any bold annotation
  for (const bt of boldTexts) {
    expect(bt).not.toContain("标注");
  }

  expect(pageErrors).toEqual([]);
});

test("multi-format overlap delete removes all annotations", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Select first 3 chars, apply bold + italic
  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");
  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();
  await toolbar.locator('[data-ann-action="italic"]').click();

  // Verify 2 annotations exist
  const countBefore = await overlay.locator(".ann-highlight").count();
  expect(countBefore).toBeGreaterThanOrEqual(2);

  // Delete all via delete button
  await toolbar.locator('[data-ann-action="delete"]').click();

  // All annotations on that range should be gone
  const countAfter = await overlay.locator(".ann-highlight").count();
  expect(countAfter).toBe(0);

  expect(pageErrors).toEqual([]);
});

test("Ctrl+B creates bold, Ctrl+B again removes it", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");

  // Ctrl+B to create
  await textarea.press("Control+b");
  let count = await overlay.locator(".ann-highlight").count();
  expect(count).toBeGreaterThanOrEqual(1);

  // Ctrl+B again to remove
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.press("Control+b");
  count = await overlay.locator(".ann-highlight").count();
  expect(count).toBe(0);

  expect(pageErrors).toEqual([]);
});

test("Ctrl+I creates italic, Ctrl+I again removes it", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.press("Control+i");
  let count = await overlay.locator(".ann-highlight").count();
  expect(count).toBeGreaterThanOrEqual(1);

  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.press("Control+i");
  count = await overlay.locator(".ann-highlight").count();
  expect(count).toBe(0);

  expect(pageErrors).toEqual([]);
});

test("toolbar stays visible after format button click", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");

  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();
  await expect(toolbar).toBeVisible();
  await toolbar.locator('[data-ann-action="italic"]').click();
  await expect(toolbar).toBeVisible();

  expect(pageErrors).toEqual([]);
});

// ── Tier 2: Classic view interaction flow tests ──

test("classic view: toolbar appears on selection", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  await page.locator("#editorViewMode").selectOption("classic");
  const firstRow = page.locator('.segment-row[data-tid="tid_test_000003"]');
  await expect(firstRow).toBeVisible({ timeout: 3000 });
  await firstRow.click();

  const targetInput = page.locator("#targetInput");
  await expect(targetInput).toBeVisible({ timeout: 3000 });
  await targetInput.press("Home");
  for (let i = 0; i < 3; i++) await targetInput.press("Shift+ArrowRight");
  await targetInput.dispatchEvent("mouseup");

  await expect(page.locator("#annotation-toolbar")).toBeVisible({ timeout: 3000 });

  expect(pageErrors).toEqual([]);
});

test("classic view: create bold via toolbar, overlay updates", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  await page.locator("#editorViewMode").selectOption("classic");
  const row = page.locator('.segment-row[data-tid="tid_test_000003"]');
  await expect(row).toBeVisible({ timeout: 3000 });
  await row.click();

  const targetInput = page.locator("#targetInput");
  await expect(targetInput).toBeVisible({ timeout: 3000 });
  await targetInput.press("Home");
  for (let i = 0; i < 3; i++) await targetInput.press("Shift+ArrowRight");
  await targetInput.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Overlay should have ann-highlight
  const overlayHtml = await targetInput.evaluate((el) => {
    const wrap = el.parentElement;
    const ov = wrap && wrap.querySelector(".token-target-overlay");
    return ov ? ov.innerHTML : "";
  });
  expect(overlayHtml).toContain("ann-highlight");

  expect(pageErrors).toEqual([]);
});

test("classic view: toggle off bold, hotspot updated", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  // Switch to classic, select tid_test_000001 which has bold annotation
  await page.locator("#editorViewMode").selectOption("classic");
  const row = page.locator('.segment-row[data-tid="tid_test_000001"]');
  await expect(row).toBeVisible({ timeout: 3000 });
  await row.click();

  const targetInput = page.locator("#targetInput");
  await expect(targetInput).toBeVisible({ timeout: 3000 });

  // Select bold text "你好" [0,2)
  await targetInput.press("Home");
  await targetInput.press("Shift+ArrowRight");
  await targetInput.press("Shift+ArrowRight");
  await targetInput.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  // Toggle bold off
  await toolbar.locator('[data-ann-action="bold"]').click();

  // Hotspot should reflect change
  await waitForHotspots(page);
  const hotspot = page.locator('[data-hotspot-owner="tid_test_000001"] .hotspot-text');
  await expect(hotspot).toBeAttached({ timeout: 2000 });
  const html = await hotspot.innerHTML();
  expect(html).not.toContain("<b>你好</b>");

  expect(pageErrors).toEqual([]);
});

test("classic view: segment switch resets overlay correctly", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  await page.locator("#editorViewMode").selectOption("classic");

  // Select tid_test_000001 (has annotations)
  const row1 = page.locator('.segment-row[data-tid="tid_test_000001"]');
  await expect(row1).toBeVisible({ timeout: 3000 });
  await row1.click();

  const targetInput = page.locator("#targetInput");
  const getOverlayHtml = () => targetInput.evaluate((el) => {
    const wrap = el.parentElement;
    const ov = wrap && wrap.querySelector(".token-target-overlay");
    return ov ? ov.innerHTML : "";
  });

  const html1 = await getOverlayHtml();
  expect(html1).toContain("ann-highlight");

  // Switch to tid_test_000003 (no annotations)
  const row3 = page.locator('.segment-row[data-tid="tid_test_000003"]');
  await expect(row3).toBeVisible({ timeout: 3000 });
  await row3.click();

  const html3 = await getOverlayHtml();
  expect(html3).not.toContain("ann-highlight");

  expect(pageErrors).toEqual([]);
});

// ── Tier 2 pending: comment lifecycle ──

test("comment: create via toolbar, blur submits, overlay highlights", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Select text
  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Click comment button — should create annotation + show input
  await toolbar.locator('[data-ann-action="comment"]').click();
  const commentInput = toolbar.locator(".ann-tb-comment-input");
  await expect(commentInput).toBeVisible({ timeout: 2000 });

  // Overlay should already have highlight (comment created immediately)
  const highlightsDuring = await overlay.locator(".ann-highlight").count();
  expect(highlightsDuring).toBeGreaterThanOrEqual(1);

  // Type comment text
  await commentInput.fill("Test comment");

  // Click outside to blur — should submit
  await page.locator("#cardsView").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);

  // Verify annotation persists with highlight
  const highlightsAfter = await overlay.locator(".ann-highlight").count();
  expect(highlightsAfter).toBeGreaterThanOrEqual(1);

  // Verify comment data in state
  const commentText = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    if (!row || !row.annotations) return null;
    const c = row.annotations.find(a => a.type === "comment");
    return c ? c.text : null;
  }, "tid_test_000003");
  expect(commentText).toBe("Test comment");

  expect(pageErrors).toEqual([]);
});

test("comment: empty content on blur deletes annotation", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Select and create comment
  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="comment"]').click();

  const commentInput = toolbar.locator(".ann-tb-comment-input");
  await expect(commentInput).toBeVisible({ timeout: 2000 });

  // Leave empty and blur
  await commentInput.fill("");
  await page.locator("#cardsView").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);

  // Annotation should be deleted — no highlights
  const count = await overlay.locator(".ann-highlight").count();
  expect(count).toBe(0);

  expect(pageErrors).toEqual([]);
});

// ── Tier 2 pending: color hotspot sync ──

test("color: select color chip updates hotspot, deselect removes", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");

  // Select text
  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Open color panel and select red
  await toolbar.locator('[data-ann-action="color"]').click();
  const colorPanel = toolbar.locator(".ann-tb-color-panel");
  await expect(colorPanel).toBeVisible({ timeout: 2000 });
  await colorPanel.locator('.ann-tb-color-chip[data-color="#ff0000"]').click();

  // Hotspot should have color span
  await waitForHotspots(page);
  const hotspot = page.locator('[data-hotspot-owner="tid_test_000003"] .hotspot-text');
  await expect(hotspot).toBeAttached({ timeout: 2000 });
  const html = await hotspot.innerHTML();
  expect(html).toContain("color");

  // Click same color again to remove
  await colorPanel.locator('.ann-tb-color-chip[data-color="#ff0000"]').click();

  // Hotspot should no longer have color
  const html2 = await hotspot.innerHTML();
  expect(html2).not.toContain("color:#ff0000");

  expect(pageErrors).toEqual([]);
});

// ── Tier 2 pending: hex input ──

test("hex input: can type and submit color via Enter", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });

  // Open color panel
  await toolbar.locator('[data-ann-action="color"]').click();
  const hexInput = toolbar.locator(".ann-tb-color-custom");
  await expect(hexInput).toBeVisible({ timeout: 2000 });

  // Type hex without # and press Enter
  await hexInput.click();
  await hexInput.fill("00cc00");
  await hexInput.press("Enter");

  // Should have created a color annotation
  const highlights = await overlay.locator(".ann-highlight").count();
  expect(highlights).toBeGreaterThanOrEqual(1);

  // Verify color in state
  const color = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    if (!row || !row.annotations) return null;
    const c = row.annotations.find(a => a.action === "color");
    return c ? c.color : null;
  }, "tid_test_000003");
  expect(color).toBe("#00cc00");

  expect(pageErrors).toEqual([]);
});

// ── Tier 2 pending: Reset ──

test("reset button clears annotations and hotspot text", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);

  // tid_test_000001 has annotations — use it
  const card = page.locator('.segment-card[data-tid="tid_test_000001"]');
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Verify annotations exist
  const countBefore = await overlay.locator(".ann-highlight").count();
  expect(countBefore).toBeGreaterThanOrEqual(1);

  // Click reset button
  const resetBtn = card.locator('[data-reset-row="tid_test_000001"]');
  await expect(resetBtn).toBeAttached({ timeout: 2000 });
  await resetBtn.click();

  // Overlay should have no highlights
  const countAfter = await overlay.locator(".ann-highlight").count();
  expect(countAfter).toBe(0);

  // After reset, tid_test_000001's hotspot is either absent (target_text
  // cleared back to todo) or present with no formatting. Either is valid;
  // what must NOT happen is bold/italic tags surviving the reset.
  await waitForHotspots(page);
  const hotspotHtmlJoined = await page
    .locator('[data-hotspot-owner="tid_test_000001"] .hotspot-text')
    .evaluateAll((els) => els.map((el) => el.innerHTML).join("|"));
  expect(hotspotHtmlJoined).not.toContain("<b>");
  expect(hotspotHtmlJoined).not.toContain("<i>");

  expect(pageErrors).toEqual([]);
});

// ── Tier 2: undo/redo offset regression ──

test("undo after typing preserves annotation offsets", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");
  const overlay = card.locator(".token-target-wrap.target-field .token-target-overlay");

  // Create bold on first 3 chars
  await textarea.focus();
  await textarea.press("Home");
  for (let i = 0; i < 3; i++) await textarea.press("Shift+ArrowRight");
  await textarea.press("Control+b");

  // Verify bold exists
  let highlights = await overlay.locator('.ann-highlight[data-ann-action="bold"]').count();
  expect(highlights).toBeGreaterThanOrEqual(1);

  // Get annotation before edit
  const annBefore = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    return row && row.annotations ? JSON.parse(JSON.stringify(row.annotations)) : [];
  }, "tid_test_000003");

  // Type a char at position 0
  await textarea.press("Home");
  await textarea.type("X");

  // Annotation should have shifted offset +1
  const annAfterType = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    return row && row.annotations ? JSON.parse(JSON.stringify(row.annotations)) : [];
  }, "tid_test_000003");
  expect(annAfterType.length).toBe(annBefore.length);
  if (annAfterType.length > 0 && annBefore.length > 0) {
    expect(annAfterType[0].offset).toBe(annBefore[0].offset + 1);
  }

  // Undo (Ctrl+Z)
  await textarea.press("Control+z");
  await page.waitForTimeout(100);

  // Annotation offset should shift back
  const annAfterUndo = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    return row && row.annotations ? JSON.parse(JSON.stringify(row.annotations)) : [];
  }, "tid_test_000003");
  expect(annAfterUndo.length).toBe(annBefore.length);
  if (annAfterUndo.length > 0 && annBefore.length > 0) {
    expect(annAfterUndo[0].offset).toBe(annBefore[0].offset);
  }

  expect(pageErrors).toEqual([]);
});

// ── Offset accuracy tests ──

test("offset accuracy: English long text paste then annotate", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");

  const longText = "The quick brown fox jumps over the lazy dog near the river bank on a sunny afternoon";
  await textarea.focus();
  await textarea.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, longText);

  // Select "jumps over" (offset 20, length 10)
  await textarea.press("Control+Home");
  for (let i = 0; i < 20; i++) await textarea.press("ArrowRight");
  for (let i = 0; i < 10; i++) await textarea.press("Shift+ArrowRight");
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  const ann = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    if (!row || !row.annotations) return null;
    return row.annotations.find(a => a.type === "format" && a.action === "bold");
  }, "tid_test_000003");

  expect(ann).not.toBeNull();
  expect(ann.offset).toBe(20);
  expect(ann.length).toBe(10);
  expect(ann.text).toBe("jumps over");

  expect(pageErrors).toEqual([]);
});

test("offset accuracy: Chinese long text paste then annotate", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");

  const longText = "如果您成功举办本次研讨会所需的所有材料都已包含在此领导指南与脚本中该文件包含一份完整的分步指南";
  // Simulate paste: set value + dispatch input event (not type() which is per-char)
  await textarea.focus();
  await textarea.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, longText);

  // Verify textarea value is correct after paste
  const valueAfterPaste = await textarea.inputValue();
  expect(valueAfterPaste).toBe(longText);

  // Verify row.target_text matches
  const rowText = await page.evaluate((tid) => {
    return state.translationsByTid[tid] ? state.translationsByTid[tid].target_text : null;
  }, "tid_test_000003");
  expect(rowText).toBe(longText);

  // Select "研讨会所需" (offset 9, length 5)
  // 如(0)果(1)您(2)成(3)功(4)举(5)办(6)本(7)次(8)研(9)讨(10)会(11)所(12)需(13)
  await textarea.press("Control+Home");
  for (let i = 0; i < 9; i++) await textarea.press("ArrowRight");
  for (let i = 0; i < 5; i++) await textarea.press("Shift+ArrowRight");

  const sel = await textarea.evaluate((el) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
    selectedText: el.value.substring(el.selectionStart, el.selectionEnd)
  }));
  expect(sel.start).toBe(9);
  expect(sel.end).toBe(14);
  expect(sel.selectedText).toBe("研讨会所需");

  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  const ann = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    if (!row || !row.annotations) return null;
    return row.annotations.find(a => a.type === "format" && a.action === "bold");
  }, "tid_test_000003");

  expect(ann).not.toBeNull();
  expect(ann.offset).toBe(9);
  expect(ann.length).toBe(5);
  expect(ann.text).toBe("研讨会所需");

  expect(pageErrors).toEqual([]);
});

test("offset accuracy: mixed CJK+Latin paste then annotate", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");

  const longText = "如果您成功举办本次研讨会的BrandLink页面该页面包含一份完整的分步指南可帮助您准备并成功举办本次研讨会";
  await textarea.focus();
  await textarea.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, longText);

  // Select "会的BrandLink" programmatically (offset 11, length 11)
  await textarea.evaluate((el) => {
    el.selectionStart = 11;
    el.selectionEnd = 22;
  });
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  const ann = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    if (!row || !row.annotations) return null;
    return row.annotations.find(a => a.type === "format" && a.action === "bold");
  }, "tid_test_000003");

  expect(ann).not.toBeNull();
  expect(ann.offset).toBe(11);
  expect(ann.length).toBe(11);
  expect(ann.text).toBe("会的BrandLink");

  expect(pageErrors).toEqual([]);
});

test("offset accuracy: paste replace then annotate middle", async ({ page }) => {
  const pageErrors = await loadPackageMin(page);
  const card = page.locator('.segment-card[data-tid="tid_test_000003"]');
  const textarea = card.locator(".card-target");

  const text1 = "这是第一段测试文本用于验证偏移量的准确性";
  await textarea.focus();
  await textarea.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text1);

  // Replace with second paste
  const text2 = "样例品牌甲公司概况这是一份关于Example Brand的概述文件请仔细阅读";
  await textarea.evaluate((el, text) => {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text2);

  // Select "Example Brand" programmatically (offset 15, length 13)
  await textarea.evaluate((el) => {
    el.selectionStart = 15;
    el.selectionEnd = 28;
  });
  await textarea.dispatchEvent("mouseup");

  const toolbar = page.locator("#annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 3000 });
  await toolbar.locator('[data-ann-action="bold"]').click();

  const ann = await page.evaluate((tid) => {
    const row = state.translationsByTid[tid];
    if (!row || !row.annotations) return null;
    return row.annotations.find(a => a.type === "format" && a.action === "bold");
  }, "tid_test_000003");

  expect(ann).not.toBeNull();
  expect(ann.offset).toBe(15);
  expect(ann.length).toBe(13);
  expect(ann.text).toBe("Example Brand");

  expect(pageErrors).toEqual([]);
});
