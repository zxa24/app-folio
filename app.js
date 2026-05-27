"use strict";

const els = {
  packageInput: document.getElementById("packageInput"),
  packageZipInput: document.getElementById("packageZipInput"),
  progressInput: document.getElementById("progressInput"),
  saveAllBtn: document.getElementById("saveAllBtn"),
  savePackageZipBtn: document.getElementById("savePackageZipBtn"),
  themeModeBtn: document.getElementById("themeModeBtn"),
  packageStatus: document.getElementById("packageStatus"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageLabel: document.getElementById("pageLabel"),
  zoomPercentInput: document.getElementById("zoomPercentInput"),
  pdfCanvas: document.getElementById("pdfCanvas"),
  pdfStage: document.getElementById("pdfStage"),
  hotspotLayer: document.getElementById("hotspotLayer"),
  emptyPdfHint: document.getElementById("emptyPdfHint"),
  segmentsTabBtn: document.getElementById("segmentsTabBtn"),
  aiTabBtn: document.getElementById("aiTabBtn"),
  segmentsTab: document.getElementById("segmentsTab"),
  aiTab: document.getElementById("aiTab"),
  searchInput: document.getElementById("searchInput"),
  editorViewMode: document.getElementById("editorViewMode"),
  pageFilter: document.getElementById("pageFilter"),
  styleFilter: document.getElementById("styleFilter"),
  textFilterBtn: document.getElementById("textFilterBtn"),
  textFilterPanel: document.getElementById("textFilterPanel"),
  filterSimpleText: document.getElementById("filterSimpleText"),
  filterEmptySource: document.getElementById("filterEmptySource"),
  filterHiddenObjects: document.getElementById("filterHiddenObjects"),
  segmentsSummary: document.getElementById("segmentsSummary"),
  cardsView: document.getElementById("cardsView"),
  classicView: document.getElementById("classicView"),
  segmentList: document.getElementById("segmentList"),
  editorEmpty: document.getElementById("editorEmpty"),
  editorFields: document.getElementById("editorFields"),
  tidInput: document.getElementById("tidInput"),
  sourceInput: document.getElementById("sourceInput"),
  targetInput: document.getElementById("targetInput"),
  statusInput: document.getElementById("statusInput"),
  notesInput: document.getElementById("notesInput"),
  aiSummary: document.getElementById("aiSummary"),
  aiList: document.getElementById("aiList"),
  exportPdfBtn: document.getElementById("exportPdfBtn"),
  drawHotspotBtn: document.getElementById("drawHotspotBtn"),
  formatAwareSoftBreakMergeSwitch: document.getElementById("formatAwareSoftBreakMerge")
};

const PDFJS_DOWNLOADS = {
  script: {
    name: "pdf.min.js",
    url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
  },
  worker: {
    name: "pdf.worker.min.js",
    url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
  }
};

const CONTROL_TOKEN_RE = /\[\[CTRL_([0-9A-Fa-f]{4})\]\]/g;
const PAGE_CURRENT_TOKEN = "{PAGE_CURRENT}";
const PAGE_TOTAL_TOKEN = "{PAGE_TOTAL}";
const PAGE_CURRENT_TOKEN_RE = /\{PAGE_CURRENT\}/g;
const PAGE_TOTAL_TOKEN_RE = /\{PAGE_TOTAL\}/g;
const THEME_STORAGE_KEY = "translator_app.theme_mode";
const THEME_MODE_SYSTEM = "system";
const THEME_MODE_LIGHT = "light";
const THEME_MODE_DARK = "dark";

// ── Local server integration ──
// When served by serve.js, files can be written directly to disk.
const localServer = {
  available: false,
  baseUrl: "",
  packageDirPath: ""   // absolute path of the opened package folder
};

(function detectLocalServer() {
  // If page is served from localhost, check for our server
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  var pingUrl = location.origin + "/api/ping";
  fetch(pingUrl).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.ok && d.server === "translator-app-local") {
      localServer.available = true;
      localServer.baseUrl = location.origin;
      console.log("[local-server] Detected local server at " + location.origin);
      // Rewire "Open Package Folder" to use path prompt instead of file input
      var label = document.querySelector("label[for='packageInput']");
      if (label) {
        label.removeAttribute("for");
        label.style.cursor = "pointer";
        label.addEventListener("click", onLocalOpenFolder);
        var origInput = document.getElementById("packageInput");
        if (origInput) origInput.disabled = true;
      }
      // #SEC7: Show the path being auto-loaded in the package-status banner
      // before we actually load it, so a malicious last_folder rewrite (or
      // even a benign stale entry) is visible at a glance rather than
      // silently exercising the filesystem-read pipeline. Status text uses
      // textContent so the path can't escape into HTML.
      if (d.lastFolder) {
        var statusEl = document.getElementById("packageStatus");
        if (statusEl) {
          statusEl.textContent = "Auto-loading last folder: " + d.lastFolder;
        }
        console.log("[local-server] Auto-loading last folder: " + d.lastFolder);
        loadFolderFromServer(d.lastFolder, { silent: true });
      }
    }
  }).catch(function () {});
})();

const state = {
  packageName: "",
  packageFiles: [],
  packageRoot: "",
  segmentsPayload: null,
  segments: [],
  segmentByTid: {},
  translationsByTid: {},
  aiItems: [],
  pages: [],
  pageGeometryByIndex: {},
  currentPage: null,
  selectedTid: null,
  selectedAiTaskId: null,
  searchText: "",
  editorViewMode: "page_cards",
  pageFilter: "all",
  styleFilter: "all",
  filterSimpleText: true,
  filterEmptySource: true,
  filterHiddenObjects: true,
  themeMode: THEME_MODE_SYSTEM,
  themeMediaDark: null,
  styles: [],
  pdfFile: null,
  pdfDoc: null,
  pdfRenderSeq: 0,
  pdfViewBox: null,
  zoomPercent: 100,
  resizeRaf: 0,
  promptedMissingPdfJs: false,
  activeTab: "segments",
  // ── Manual hotspots ──
  manualHotspots: [],
  manualHotspotById: {},
  selectedManualHotspotId: null,
  drawMode: false,
  drawStart: null,
  draggingHotspot: null,
  resizingHotspot: null,
  _mhCounter: 0,
  // ── Font-size diagnostic ──
  // Toggle `state.fontDebug = true` in console, then re-render or export PDF
  // to collect per-hotspot decisions into state.fontDebugLog[].
  fontDebug: false,
  fontDebugLog: [],
  // Phase 7-SC: Preview-side opt-in. true (default) → Preview goes through
  // the same DOM measurement module the PDF uses, so they stay aligned.
  // false → Preview falls back to Phase 5 fitTextInBox (legacy path).
  phase7PreviewEnabled: true,
  // Phase 7-SC visual scale (TEMPORARY constant pending Phase 5C font-metric
  // capture). CJK glyphs fill the em box (visible height ≈ pointSize) while
  // Latin glyphs fill cap-height ≈ 0.7 × pointSize. Rendering CJK at the
  // source pointSize makes Chinese look ~40% taller than the source English.
  // Multiplying maxFontSize by 0.75 before measurement yields a fontSize
  // whose CJK visible height ≈ source Latin cap height.
  // The right long-term fix is Phase 5C (capture source font's capHeight
  // ratio + measure target font em-fill ratio); this constant is the
  // placeholder. Tunable in console: state.cjkVisualScale = 0.8 etc.
  cjkVisualScale: 0.75,

  // ── Soft-break merge rule ──
  // When true: same-paragraph soft-break sub-segments are auto-merged into
  // one card ONLY when the format on both sides of the soft break matches
  // (font family / weight / size / fill color, ±0.5pt size tolerance —
  // identical to InDesign-side `splitSoftBreaksWithFormatChange` rule).
  // Mismatched groups stay as independent cards so each sub-segment gets
  // its own translation slot.
  // When false: legacy behavior — always merge soft-break sub-segments.
  // Default: true. Persisted to localStorage so the choice survives reload.
  formatAwareSoftBreakMerge: true
};

// Restore persisted formatAwareSoftBreakMerge from localStorage.
try {
  var _stored = window.localStorage && window.localStorage.getItem("formatAwareSoftBreakMerge");
  if (_stored !== null && _stored !== undefined) {
    state.formatAwareSoftBreakMerge = (_stored === "true");
  }
} catch (_) { /* non-browser / storage disabled */ }

// Expose for browser console debugging + Playwright tests. `const state` and
// function declarations don't auto-attach to `window` in modern script
// contexts, so test code has to read them through these handles.
try {
  window.state = state;
  window.renderPdf = typeof renderPdf === "function" ? renderPdf : window.renderPdf;
} catch (_) { /* non-browser, ignore */ }

init();

function init() {
  initThemeMode();
  preloadHotspotFonts();
  els.packageInput.addEventListener("change", onPackageInputChange);
  if (els.packageZipInput) {
    els.packageZipInput.addEventListener("change", onPackageZipInputChange);
  }
  if (els.progressInput) {
    els.progressInput.addEventListener("change", onProgressInputChange);
  }
  els.saveAllBtn.addEventListener("click", onSaveAll);
  if (els.savePackageZipBtn) {
    els.savePackageZipBtn.addEventListener("click", onSavePackageZip);
  }
  if (els.exportPdfBtn) {
    els.exportPdfBtn.addEventListener("click", () => exportAnnotatedPdf());
  }
  if (els.formatAwareSoftBreakMergeSwitch) {
    els.formatAwareSoftBreakMergeSwitch.checked = !!state.formatAwareSoftBreakMerge;
    els.formatAwareSoftBreakMergeSwitch.addEventListener("change", onFormatAwareMergeSwitchChange);
  }
  if (els.drawHotspotBtn) {
    els.drawHotspotBtn.addEventListener("click", toggleDrawMode);
  }
  initDrawMode();
  if (els.themeModeBtn) {
    els.themeModeBtn.addEventListener("click", onThemeModeBtnClick);
  }
  els.prevPageBtn.addEventListener("click", () => shiftPage(-1));
  els.nextPageBtn.addEventListener("click", () => shiftPage(1));
  if (els.zoomPercentInput) {
    els.zoomPercentInput.addEventListener("change", () => {
      setZoomPercent(els.zoomPercentInput.value, true);
    });
    els.zoomPercentInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        setZoomPercent(els.zoomPercentInput.value, true);
      }
    });
  }
  if (els.editorViewMode) {
    els.editorViewMode.addEventListener("change", () => {
      setEditorViewMode(els.editorViewMode.value);
    });
  }
  els.searchInput.addEventListener("input", () => {
    state.searchText = els.searchInput.value.trim().toLowerCase();
    renderSegmentsPane();
  });
  els.pageFilter.addEventListener("change", () => {
    state.pageFilter = els.pageFilter.value;
    renderSegmentsPane();
  });
  els.styleFilter.addEventListener("change", () => {
    state.styleFilter = els.styleFilter.value;
    renderSegmentsPane();
  });
  if (els.textFilterBtn && els.textFilterPanel) {
    els.textFilterBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleTextFilterPanel();
    });
    els.textFilterPanel.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
    document.addEventListener("click", onDocumentClickForFilterPanel);
    document.addEventListener("keydown", onDocumentKeydownForFilterPanel);
  }
  // Phase 8C-FP: dismiss the format-paint popover when clicking elsewhere
  document.addEventListener("click", onDocumentClickToCloseEmpPopover, true);
  document.addEventListener("keydown", function (ev) {
    if (ev && ev.key === "Escape" && _empPopoverEl) {
      ev.preventDefault();
      closeEmpPopover();
    }
  });
  if (els.filterSimpleText) {
    els.filterSimpleText.addEventListener("change", onTextFilterSwitchChange);
  }
  if (els.filterEmptySource) {
    els.filterEmptySource.addEventListener("change", onTextFilterSwitchChange);
  }
  if (els.filterHiddenObjects) {
    els.filterHiddenObjects.addEventListener("change", onTextFilterSwitchChange);
  }

  els.segmentsTabBtn.addEventListener("click", () => setActiveTab("segments"));
  els.aiTabBtn.addEventListener("click", () => setActiveTab("ai"));

  els.sourceInput.addEventListener("input", onSourceInput);
  els.targetInput.addEventListener("input", onTargetInput);
  els.targetInput.addEventListener("keydown", onTargetKeydown);
  els.statusInput.addEventListener("change", onStatusChange);
  els.notesInput.addEventListener("input", onNotesInput);

  window.addEventListener("resize", onViewportResize);
  renderEmptyState();
  installDevTranslateBridge();

  if (!hasPdfJs()) {
    els.packageStatus.textContent =
      "PDF.js local assets missing: translator_app/vendor/pdf.min.js";
  }

  // URL-param automation hook (e2e drivers / Playwright / cron):
  //   ?package=<path>     load that folder via local server's read-dir
  //   &direction=zh-en    or en-zh   sets dev-translate direction
  //   &autoTranslate=1    invoke silent runAutoTranslate after load
  //   &overwrite=1        overwriteExisting in config
  //   &autoSave=1         click Save Outputs after translate
  //   &closeAfter=1       window.close() after save
  // Defers until localServer is detected (read-dir / serve-file endpoints).
  scheduleUrlAutomation();
}

function scheduleUrlAutomation() {
  // #SEC1: Defense-in-depth against the iframe attack — even if a CSP gap
  // lets a cross-origin parent embed us, refuse to drive automation when
  // we're not the top-level document. The CSP frame-ancestors 'none' +
  // X-Frame-Options: DENY in serve.js is the primary defense; this is the
  // belt-and-braces check for browsers that fail-open on CSP.
  try {
    if (window.self !== window.top) {
      console.warn("[automation] running inside an iframe — refusing URL-driven automation");
      return;
    }
  } catch (eFr) {
    // Cross-origin parent throws on access; that itself proves we're framed.
    return;
  }
  var params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
  var pkg = params.get("package");
  if (!pkg) return;
  var direction = params.get("direction") || "";
  var autoTranslate = params.get("autoTranslate") === "1";
  var overwrite = params.get("overwrite") === "1";
  var autoSave = params.get("autoSave") === "1";
  var closeAfter = params.get("closeAfter") === "1";

  // #SEC8: Surface the wait in the UI so the user / e2e driver knows the
  // app is intentionally idling. Without this banner the 15 s window looked
  // like a stalled page; worse, the user could click "Open Folder" manually
  // and collide with the automation entry point (_pickingFolder lock only
  // covers manual entries).
  var statusEl = document.getElementById("packageStatus");
  function setAutomationStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }
  setAutomationStatus("Automation: waiting for local server (package=" + pkg + ")…");

  var attempts = 0;
  function tryRun() {
    attempts += 1;
    if (!localServer || !localServer.available) {
      if (attempts < 60) { setTimeout(tryRun, 250); return; }
      setAutomationStatus("Automation: local server not detected after 15s — aborted");
      console.error("[automation] local server not detected after 15s — abort");
      return;
    }
    setAutomationStatus("Automation: loading package " + pkg + "…");
    runAutomation();
  }

  async function runAutomation() {
    try {
      console.log("[automation] loading package:", pkg);
      await loadFolderFromServer(pkg);
      if (autoTranslate) {
        // small delay so renderAll completes
        await new Promise(function (r) { setTimeout(r, 300); });
        if (typeof window.__devTranslateRun !== "function") {
          console.error("[automation] __devTranslateRun unavailable — dev_translate.js not loaded?");
          return;
        }
        console.log("[automation] running auto-translate direction=" + direction);
        var stats = await window.__devTranslateRun({
          direction: direction,
          silent: true,
          overwriteExisting: overwrite
        });
        console.log("[automation] translate result:", stats);
      }
      if (autoSave) {
        await new Promise(function (r) { setTimeout(r, 300); });
        // Override the alert in onSaveAll so it doesn't block automation.
        var origAlert = window.alert;
        window.alert = function () { console.log("[automation alert suppressed]", Array.from(arguments)); };
        try { onSaveAll(); } finally {
          // Wait long enough for downloadFile promises to settle.
          await new Promise(function (r) { setTimeout(r, 2000); });
          window.alert = origAlert;
        }
        console.log("[automation] save complete");
        // #AUTOMATION-DONE-SIGNAL: drop a marker file in the package
        // folder so external pollers (CI runs, MCP-driven e2e harnesses)
        // can detect completion without waiting on a fixed timer. The
        // marker carries translation stats so consumers can verify the
        // run actually wrote something instead of just signalling
        // success on a no-op pass.
        try {
          var doneMarker = {
            ok: true,
            timestamp_utc: new Date().toISOString(),
            translate: {
              direction: direction || null,
              auto_translate: autoTranslate
            },
            translate_stats: (typeof stats !== "undefined" && stats) ? stats : null,
            package: pkg
          };
          var sep = pkg.indexOf("\\") >= 0 ? "\\" : "/";
          var donePath = pkg.replace(/[\\/]+$/, "") + sep + "__automation_done.json";
          await fetch("/api/write-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: donePath, content: JSON.stringify(doneMarker, null, 2) })
          });
          console.log("[automation] wrote done marker:", donePath);
        } catch (eMark) {
          console.warn("[automation] done marker write failed:", eMark);
        }
      }
      if (closeAfter) {
        await new Promise(function (r) { setTimeout(r, 500); });
        // NOTE: window.close() only succeeds for windows opened via
        // window.open() / Playwright's launched browsers. For a user who
        // navigated here manually, the browser will silently ignore this
        // and the page stays open — the automation IS finished, just no
        // visible cue that the window can be closed. Surface a hint in
        // the banner so the human flow doesn't look hung.
        setAutomationStatus("Automation: complete. You may close this tab.");
        window.close();
      }
    } catch (err) {
      console.error("[automation] failed:", err);
    }
  }

  tryRun();
}

function initThemeMode() {
  state.themeMode = loadThemeMode();
  if (window.matchMedia) {
    state.themeMediaDark = window.matchMedia("(prefers-color-scheme: dark)");
    if (state.themeMediaDark && typeof state.themeMediaDark.addEventListener === "function") {
      state.themeMediaDark.addEventListener("change", onSystemThemeChange);
    } else if (state.themeMediaDark && typeof state.themeMediaDark.addListener === "function") {
      state.themeMediaDark.addListener(onSystemThemeChange);
    }
  }
  applyThemeMode(false);
}

function onSystemThemeChange() {
  if (state.themeMode !== THEME_MODE_SYSTEM) {
    return;
  }
  applyThemeMode(false);
}

function onThemeModeBtnClick() {
  state.themeMode = cycleThemeMode(state.themeMode);
  applyThemeMode(true);
}

function cycleThemeMode(mode) {
  const cur = safeThemeMode(mode);
  if (cur === THEME_MODE_SYSTEM) {
    return THEME_MODE_LIGHT;
  }
  if (cur === THEME_MODE_LIGHT) {
    return THEME_MODE_DARK;
  }
  return THEME_MODE_SYSTEM;
}

function applyThemeMode(remember) {
  const root = document.documentElement;
  const mode = safeThemeMode(state.themeMode);
  const effective = getEffectiveThemeMode(mode);
  state.themeMode = mode;
  if (root) {
    root.setAttribute("data-theme-mode", mode);
    root.setAttribute("data-theme-effective", effective);
  }
  if (remember) {
    saveThemeMode(mode);
  }
  renderThemeModeButton(mode, effective);
}

function getEffectiveThemeMode(mode) {
  const cur = safeThemeMode(mode);
  if (cur === THEME_MODE_LIGHT || cur === THEME_MODE_DARK) {
    return cur;
  }
  return !!(state.themeMediaDark && state.themeMediaDark.matches)
    ? THEME_MODE_DARK
    : THEME_MODE_LIGHT;
}

function renderThemeModeButton(mode, effective) {
  let label = "Theme: System";
  if (!els.themeModeBtn) {
    return;
  }
  if (mode === THEME_MODE_SYSTEM) {
    label = "Theme: System (" + (effective === THEME_MODE_DARK ? "Dark" : "Light") + ")";
  } else if (mode === THEME_MODE_LIGHT) {
    label = "Theme: Light";
  } else if (mode === THEME_MODE_DARK) {
    label = "Theme: Dark";
  }
  els.themeModeBtn.textContent = label;
  els.themeModeBtn.title = "Click to switch theme mode: System -> Light -> Dark";
}

function safeThemeMode(mode) {
  if (mode === THEME_MODE_LIGHT || mode === THEME_MODE_DARK || mode === THEME_MODE_SYSTEM) {
    return mode;
  }
  return THEME_MODE_SYSTEM;
}

function loadThemeMode() {
  let raw = "";
  try {
    raw = localStorage.getItem(THEME_STORAGE_KEY) || "";
  } catch (e) {}
  return safeThemeMode(raw);
}

function saveThemeMode(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, safeThemeMode(mode));
  } catch (e) {}
}

function onViewportResize() {
  if (state.resizeRaf) {
    cancelAnimationFrame(state.resizeRaf);
  }
  state.resizeRaf = requestAnimationFrame(() => {
    state.resizeRaf = 0;
    renderPdf();
  });
}

function setZoomPercent(value, rerender) {
  state.zoomPercent = safeZoomPercent(value);
  if (els.zoomPercentInput) {
    els.zoomPercentInput.value = String(state.zoomPercent);
  }
  if (rerender) {
    renderPdf();
  }
}

function renderEmptyState() {
  els.pageLabel.textContent = "Page - / -";
  els.segmentList.innerHTML = "";
  els.aiList.innerHTML = "";
  els.segmentsSummary.textContent = "Segments: 0";
  els.aiSummary.textContent = "AI handoff rows: 0";
  setZoomPercent(100, false);
  setEditorViewMode("page_cards", false);
  els.cardsView.innerHTML = "";
  els.segmentList.innerHTML = "";
  els.classicView.classList.add("hidden");
  els.cardsView.classList.remove("hidden");
  clearPdfCanvas();
  els.hotspotLayer.innerHTML = "";
  els.saveAllBtn.disabled = true;
  if (els.savePackageZipBtn) els.savePackageZipBtn.disabled = true;
  if (els.exportPdfBtn) els.exportPdfBtn.disabled = true;
  if (els.drawHotspotBtn) els.drawHotspotBtn.disabled = true;
  state.selectedAiTaskId = null;
}

function setEditorViewMode(mode, rerender) {
  state.editorViewMode = safeEditorViewMode(mode);
  if (els.editorViewMode) {
    els.editorViewMode.value = state.editorViewMode;
  }
  if (els.pageFilter) {
    els.pageFilter.disabled = state.editorViewMode === "page_cards";
  }
  if (rerender !== false) {
    renderFilters();
    renderSegmentsPane();
  }
}

function onDocumentClickForFilterPanel(event) {
  if (!els.textFilterPanel || els.textFilterPanel.classList.contains("hidden")) {
    return;
  }
  if (!event || !event.target) {
    return;
  }
  if (els.textFilterPanel.contains(event.target)) {
    return;
  }
  if (els.textFilterBtn && els.textFilterBtn.contains(event.target)) {
    return;
  }
  closeTextFilterPanel();
}

function onDocumentKeydownForFilterPanel(event) {
  if (!event || event.key !== "Escape") {
    return;
  }
  closeTextFilterPanel();
}

function toggleTextFilterPanel() {
  if (!els.textFilterPanel) {
    return;
  }
  const shouldOpen = els.textFilterPanel.classList.contains("hidden");
  els.textFilterPanel.classList.toggle("hidden", !shouldOpen);
  if (shouldOpen) {
    renderTextFilterControls();
  }
}

function closeTextFilterPanel() {
  if (!els.textFilterPanel) {
    return;
  }
  els.textFilterPanel.classList.add("hidden");
}

function onTextFilterSwitchChange() {
  state.filterSimpleText = !!(els.filterSimpleText && els.filterSimpleText.checked);
  state.filterEmptySource = !!(els.filterEmptySource && els.filterEmptySource.checked);
  state.filterHiddenObjects = !!(els.filterHiddenObjects && els.filterHiddenObjects.checked);
  renderTextFilterControls();
  renderSegmentsPane();
}

function renderTextFilterControls() {
  if (els.filterSimpleText) {
    els.filterSimpleText.checked = !!state.filterSimpleText;
  }
  if (els.filterEmptySource) {
    els.filterEmptySource.checked = !!state.filterEmptySource;
  }
  if (els.filterHiddenObjects) {
    els.filterHiddenObjects.checked = !!state.filterHiddenObjects;
  }
  if (els.textFilterBtn) {
    // "active" state highlights the button when any filter is on.
    // Format-aware merge defaults ON, so we don't count it toward "active";
    // only the 3 filters do.
    els.textFilterBtn.classList.toggle("active", !!(state.filterSimpleText || state.filterHiddenObjects || state.filterEmptySource));
    els.textFilterBtn.textContent = "Card Options";
  }
  if (els.formatAwareSoftBreakMergeSwitch) {
    els.formatAwareSoftBreakMergeSwitch.checked = !!state.formatAwareSoftBreakMerge;
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  const isSegments = tab === "segments";
  els.segmentsTabBtn.classList.toggle("active", isSegments);
  els.aiTabBtn.classList.toggle("active", !isSegments);
  els.segmentsTab.classList.toggle("active", isSegments);
  els.aiTab.classList.toggle("active", !isSegments);
}

var _pickingFolder = false;

async function loadFolderFromServer(dirPath, options) {
  var silent = !!(options && options.silent);
  var label = document.querySelector("label.btn.primary");
  var origText = label ? label.textContent : "";
  if (label) label.textContent = "Loading\u2026";

  try {
    localServer.packageDirPath = dirPath;
    console.log("[local-server] Package dir: " + dirPath);

    var filesResp = await fetch(localServer.baseUrl + "/api/package-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath })
    });
    var filesData = await filesResp.json();
    if (!filesData.ok || !filesData.files || filesData.files.length === 0) {
      if (!silent) alert("No supported files found in: " + dirPath);
      else console.warn("[local-server] Auto-load skipped — no supported files in: " + dirPath);
      return;
    }

    var folderName = dirPath.replace(/^.*[\\/]/, "");
    var sep = dirPath.indexOf("\\") >= 0 ? "\\" : "/";
    var virtualFiles = [];

    for (var fi = 0; fi < filesData.files.length; fi++) {
      var f = filesData.files[fi];
      var blob;
      if (f.type === "binary") {
        var binResp = await fetch(localServer.baseUrl + "/api/serve-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: dirPath + sep + f.name })
        });
        if (!binResp.ok) continue;
        blob = await binResp.blob();
      } else {
        blob = new Blob([f.data], { type: "text/plain;charset=utf-8" });
      }
      var file = new File([blob], f.name, { type: blob.type });
      Object.defineProperty(file, "webkitRelativePath", {
        value: folderName + "/" + f.name,
        writable: false
      });
      virtualFiles.push(file);
    }

    maybePromptDownloadMissingPdfJs();
    await loadPackage(virtualFiles);
    renderAll();
    // Remember folder only after successful load
    fetch(localServer.baseUrl + "/api/remember-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath })
    }).catch(function () {});
  } catch (err) {
    console.error(err);
    if (!silent) alert("Failed to load package: " + err.message);
    else console.warn("[local-server] Auto-load failed: " + err.message);
  } finally {
    if (label) label.textContent = origText;
  }
}

async function onLocalOpenFolder(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  if (_pickingFolder) return;
  _pickingFolder = true;
  try {
    var input = prompt(
      "Paste the full path to the translation package folder:\n" +
      "(e.g. C:\\\\Projects\\\\my_package or /Users/me/my_package)"
    );
    if (!input || !input.trim()) return;
    await loadFolderFromServer(input.trim().replace(/^["']+|["']+$/g, "").replace(/[\\/]+$/, ""));
  } finally {
    _pickingFolder = false;
  }
}

async function onPackageInputChange(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) {
    return;
  }
  maybePromptDownloadMissingPdfJs();
  try {
    await loadPackage(files);
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Failed to load package: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// ZIP package open/save — pure-additive paths (do not replace folder open
// or 3-file Save Outputs). Uses lib/zip_core.js + vendor/fflate.umd.js.
//
// Open: a single .zip is unpacked in-browser into a synthetic File[] with
//   webkitRelativePath preserved from the archive entry paths, then handed
//   to the same loadPackage() that the folder path uses. No downstream
//   changes — findFile() is basename-based and ignores subdirs.
//
// Save: re-zip every file currently in state.packageFiles, REPLACING the
//   three output filenames (translations.json + translation_qc_report.txt
//   + ai_manual_handoff.txt) with the freshly-built content. Files that
//   weren't in the original package (first save, no template) are appended
//   at the same archive root as segments.json. Output is guaranteed
//   reopen-able by the Open Package ZIP path above.
// ---------------------------------------------------------------------------

async function onPackageZipInputChange(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;
  const zipFile = files[0];
  if (!/\.zip$/i.test(zipFile.name)) {
    alert("Please pick a .zip file.");
    return;
  }
  if (typeof window.ZipCore === "undefined") {
    alert("ZipCore not loaded — check that vendor/fflate.umd.js and lib/zip_core.js are present.");
    return;
  }
  maybePromptDownloadMissingPdfJs();
  try {
    const unpacked = await unzipPackageFile(zipFile);
    if (unpacked.length === 0) {
      alert("ZIP contained no files.");
      return;
    }
    await loadPackage(unpacked);
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Failed to load ZIP: " + err.message);
  } finally {
    // Allow re-selecting the same file later (browsers suppress change
    // events on identical re-selection without this).
    try { event.target.value = ""; } catch (e) {}
  }
}

async function unzipPackageFile(zipFile) {
  const ab = await readArrayBuffer(zipFile);
  const entries = window.ZipCore.readZip(new Uint8Array(ab));
  const out = [];
  const keys = Object.keys(entries);
  for (let i = 0; i < keys.length; i++) {
    const archivePath = keys[i];
    // Skip directory entries (path ends with "/", zero bytes)
    if (archivePath.charAt(archivePath.length - 1) === "/" && entries[archivePath].length === 0) {
      continue;
    }
    const bytes = entries[archivePath];
    const baseName = archivePath.replace(/^.*\//, "");
    const f = new File([bytes], baseName);
    // findFile() uses basename; inferPackageRoot() reads webkitRelativePath
    // and takes everything before the first "/" — so preserving the entry
    // path here gives correct package-root inference for free.
    Object.defineProperty(f, "webkitRelativePath", {
      value: archivePath,
      writable: false
    });
    out.push(f);
  }
  return out;
}

function onSavePackageZip() {
  if (typeof window.ZipCore === "undefined") {
    alert("ZipCore not loaded — check that vendor/fflate.umd.js and lib/zip_core.js are present.");
    return;
  }
  if (!state.packageFiles || state.packageFiles.length === 0) {
    alert("No package loaded — open a folder or ZIP first.");
    return;
  }
  const btn = els.savePackageZipBtn;
  const origLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Building ZIP..."; }
  buildPackageZipAndDownload()
    .then(function (info) {
      alert(
        "Saved package ZIP:\n" + info.filename + "\n\n" +
        "Files: " + info.fileCount + " (" + Math.round(info.zipBytes / 1024) + " KB)\n" +
        "Includes the 3 outputs:\n" +
        "  - translations.json\n  - translation_qc_report.txt\n  - ai_manual_handoff.txt"
      );
    })
    .catch(function (err) {
      console.error(err);
      alert("Save Package ZIP failed: " + err.message);
    })
    .then(function () {
      if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    });
}

async function buildPackageZipAndDownload() {
  const out = buildTranslationsOutput();
  const translations = out.payload;
  const qcText = buildControlTokenQaText(out.qa_rows);
  const aiText = buildAiHandoffText();

  const enc = new TextEncoder();
  const outputBytesByName = {
    "translations.json":         enc.encode(JSON.stringify(translations, null, 2)),
    "translation_qc_report.txt": enc.encode(qcText),
    "ai_manual_handoff.txt":     enc.encode(aiText)
  };

  // Derive archive root from segments.json's webkitRelativePath ("pkg/" or "")
  let rootDir = "";
  const segFile = findFile(state.packageFiles, "segments.json");
  if (segFile && segFile.webkitRelativePath) {
    const rp = String(segFile.webkitRelativePath);
    const idx = rp.lastIndexOf("/");
    if (idx > 0) rootDir = rp.substring(0, idx + 1);
  }

  const entries = {};
  const seenOutputs = {};
  // Re-add originals; replace bytes when basename matches one of the 3 outputs
  for (let i = 0; i < state.packageFiles.length; i++) {
    const f = state.packageFiles[i];
    const archivePath = String(f.webkitRelativePath || f.name);
    const baseName = archivePath.replace(/^.*\//, "");
    if (Object.prototype.hasOwnProperty.call(outputBytesByName, baseName)) {
      entries[archivePath] = outputBytesByName[baseName];
      seenOutputs[baseName] = true;
    } else {
      const ab = await readArrayBuffer(f);
      entries[archivePath] = new Uint8Array(ab);
    }
  }
  // Append any output files that weren't in the original package
  const outputNames = Object.keys(outputBytesByName);
  for (let j = 0; j < outputNames.length; j++) {
    const k = outputNames[j];
    if (!seenOutputs[k]) {
      entries[rootDir + k] = outputBytesByName[k];
    }
  }

  const zipBytes = window.ZipCore.createZip(entries);

  const baseName = safeStr(state.packageName) || "package";
  const filename = baseName + "_translated_" + zipTimestampSuffix() + ".zip";
  triggerBinaryDownload(filename, zipBytes, "application/zip");

  return { filename: filename, fileCount: Object.keys(entries).length, zipBytes: zipBytes.length };
}

function zipTimestampSuffix() {
  const d = new Date();
  const pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + "_" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function triggerBinaryDownload(filename, u8Bytes, mimeType) {
  const blob = new Blob([u8Bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function maybePromptDownloadMissingPdfJs() {
  var shouldDownload = false;
  if (hasPdfJs()) {
    return;
  }
  if (state.promptedMissingPdfJs) {
    return;
  }
  state.promptedMissingPdfJs = true;
  // #SEC6: README emphasizes "strict offline" — be explicit that hitting OK
  // here opens an external CDN tab. The URLs are visible in the message so
  // the user can copy them and download via another channel if they prefer.
  shouldDownload = confirm(
    "PDF preview is disabled because pdf.min.js is missing.\n\n" +
    "Click OK to open two CDN URLs in new tabs (external network request):\n" +
    "  " + PDFJS_DOWNLOADS.script.url + "\n" +
    "  " + PDFJS_DOWNLOADS.worker.url + "\n\n" +
    "Or click Cancel and place the files into translator_app/vendor/ manually."
  );
  if (!shouldDownload) {
    return;
  }
  openDownloadTarget(PDFJS_DOWNLOADS.script.url);
  openDownloadTarget(PDFJS_DOWNLOADS.worker.url);
  alert(
    "Download links opened.\n\n" +
    "Place files into:\n" +
    "translator_app/vendor/\n\n" +
    "Required: " + PDFJS_DOWNLOADS.script.name + "\n" +
    "Optional in file:// mode: " + PDFJS_DOWNLOADS.worker.name + "\n\n" +
    "If popups were blocked, open manually:\n" +
    PDFJS_DOWNLOADS.script.url + "\n" +
    PDFJS_DOWNLOADS.worker.url + "\n\n" +
    "Then reload this page."
  );
}

function openDownloadTarget(url) {
  var a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function loadPackage(files) {
  await cleanupPdfDocument();

  state.packageFiles = files;
  state.packageRoot = inferPackageRoot(files);
  state.packageName = state.packageRoot || "package";
  els.emptyPdfHint.textContent =
    "Open a translation package folder to load `preview.pdf` and `segments.json`.";

  const segmentsFile = findFile(files, "segments.json");
  if (!segmentsFile) {
    throw new Error("segments.json not found in selected folder");
  }
  const previewPdf = findFile(files, "preview.pdf");
  const translationsFile = findFile(files, "translations.json");
  const templateFile = findFile(files, "translations_template.json");

  const segmentsPayload = await readJsonFile(segmentsFile);
  if (!segmentsPayload || !Array.isArray(segmentsPayload.segments)) {
    throw new Error("invalid segments.json: missing segments[]");
  }

  state.segmentsPayload = segmentsPayload;
  state.segments = segmentsPayload.segments
    .filter(s => s && s.tid)
    .map(s => normalizeSegment(s));
  state.segmentByTid = {};
  state.segments.forEach(s => {
    state.segmentByTid[s.tid] = s;
  });

  var translationsPayloadForInit = translationsFile ? await readJsonFile(translationsFile) : null;
  state.translationsByTid = buildInitialTranslations(
    state.segments,
    translationsPayloadForInit,
    templateFile ? await readJsonFile(templateFile) : null
  );
  loadManualHotspotsFromPayload(translationsPayloadForInit);
  // Per-package card_options override localStorage browser default. Read
  // BEFORE autoMergeSoftBreakGroups so the merge rule reflects the package's
  // last-saved state (e.g., translator A toggled OFF; QA reviewer B opens
  // the same package on a fresh browser → still sees OFF, no card layout drift).
  applyCardOptionsFromPayload(translationsPayloadForInit);
  autoMergeSoftBreakGroups();

  state.aiItems = normalizeAiItems(segmentsPayload.manual_handoff && segmentsPayload.manual_handoff.ai_items);
  state.styles = sortedUnique(state.segments.map(s => s.paragraph_style || "[None]"));

  computePagesAndGeometry();
  deriveNormalizedRectsFromLegacy();
  state.currentPage = state.pages.length > 0 ? state.pages[0] : null;
  state.selectedTid = state.segments.length > 0 ? state.segments[0].tid : null;
  state.selectedAiTaskId = state.aiItems.length > 0 ? state.aiItems[0].task_id : null;

  if (previewPdf) {
    state.pdfFile = previewPdf;
    try {
      await loadPdfDocument(previewPdf);
      els.emptyPdfHint.style.display = "none";
    } catch (pdfErr) {
      state.pdfDoc = null;
      state.pdfViewBox = null;
      clearPdfCanvas();
      els.emptyPdfHint.style.display = "flex";
      els.emptyPdfHint.textContent =
        "PDF preview unavailable (" + pdfErr.message + "). Segments can still be edited.";
    }
  } else {
    state.pdfFile = null;
    state.pdfDoc = null;
    state.pdfViewBox = null;
    els.emptyPdfHint.style.display = "flex";
  }

  const segCount = state.segments.length;
  const aiCount = state.aiItems.length;
  els.packageStatus.textContent =
    `Loaded ${state.packageName} | segments=${segCount} | ai_handoff=${aiCount}`;
  els.saveAllBtn.disabled = false;
  if (els.savePackageZipBtn) els.savePackageZipBtn.disabled = false;
  if (els.exportPdfBtn) els.exportPdfBtn.disabled = false;
  if (els.drawHotspotBtn) els.drawHotspotBtn.disabled = false;
}

function isAnchoredObjectOnlyText(text) {
  const t = safeStr(text).replace(/[\r\n\s]/g, "");
  return t.length > 0 && t.replace(/\uFFFC/g, "").length === 0;
}

function normalizeSegment(seg) {
  const sourceRaw = safeStr(seg.source_text);
  const controlOnlyDetected = isControlOnlyText(sourceRaw);
  const anchoredObjectOnly = isAnchoredObjectOnlyText(sourceRaw);
  const hasTableAnchorToken = sourceRaw.indexOf(String.fromCharCode(0x16)) >= 0;
  const segmentKindRaw = safeSegmentKind(seg.segment_kind);
  const translatableRaw = typeof seg.translatable === "boolean" ? !!seg.translatable : null;
  const targetPolicyRaw = safeTargetPolicy(seg.target_policy);
  let segmentKind = segmentKindRaw;
  let translatable = translatableRaw;
  let targetPolicy = targetPolicyRaw;
  let controlOnlyLabel = "";
  let controlOnly = false;
  if (!segmentKind) {
    if (controlOnlyDetected || anchoredObjectOnly) {
      segmentKind = hasTableAnchorToken ? "table_anchor" : "control_anchor";
    } else {
      segmentKind = "text";
    }
  }
  // Override translatable for anchored-object-only text even if the export
  // (or an older package) marked it as translatable, since writing to U+FFFC
  // paragraphs destroys the anchored inline frame.
  if (anchoredObjectOnly) {
    translatable = false;
  }
  if (translatable === null) {
    translatable = !(segmentKind === "table_anchor" || segmentKind === "control_anchor");
  }
  if (!targetPolicy) {
    targetPolicy = translatable ? "translate" : "preserve_source";
  }
  controlOnly = !translatable || targetPolicy === "preserve_source";
  if (segmentKind === "table_anchor") {
    controlOnlyLabel = "Table Anchor";
  } else if (segmentKind === "control_anchor") {
    controlOnlyLabel = "Control Anchor";
  } else if (controlOnlyDetected) {
    controlOnlyLabel = controlOnlyLabelForSourceText(sourceRaw);
  }
  const storyIdNum = Number(seg.story_id);
  const paraIdxNum = Number(seg.paragraph_index);
  const tableIdNum = Number(seg.table_id);
  const tableIndexNum = Number(seg.table_index);
  const cellRowNum = Number(seg.cell_row);
  const cellColNum = Number(seg.cell_col);
  const rowSpanNum = Number(seg.row_span);
  const colSpanNum = Number(seg.col_span);
  const cellParaIdxNum = Number(seg.cell_para_index);
  const cellParaCountNum = Number(seg.cell_para_count);
  const lineRects = Array.isArray(seg.line_rects) ? seg.line_rects.filter(Boolean) : [];
  const lineRectsNorm = Array.isArray(seg.line_rects_norm) ? seg.line_rects_norm.filter(Boolean) : [];
  const pages = Array.isArray(seg.page_indexes) ? seg.page_indexes.filter(isFiniteNumber) : [];
  lineRects.forEach(r => {
    if (isFiniteNumber(r.page_index)) {
      pages.push(r.page_index);
    }
  });
  lineRectsNorm.forEach(r => {
    if (isFiniteNumber(r.page_index)) {
      pages.push(r.page_index);
    }
  });
  return {
    tid: String(seg.tid),
    story_id: Number.isFinite(storyIdNum) ? storyIdNum : -1,
    paragraph_index: Number.isFinite(paraIdxNum) ? paraIdxNum : -1,
    source_text: toVisibleControlTokens(sourceRaw),
    source_text_raw: sourceRaw,
    segment_kind: segmentKind,
    translatable: !!translatable,
    target_policy: targetPolicy,
    table_id: Number.isFinite(tableIdNum) ? tableIdNum : -1,
    table_index: Number.isFinite(tableIndexNum) ? tableIndexNum : -1,
    table_uid: safeStr(seg.table_uid),
    cell_uid: safeStr(seg.cell_uid),
    cell_row: Number.isFinite(cellRowNum) ? cellRowNum : -1,
    cell_col: Number.isFinite(cellColNum) ? cellColNum : -1,
    row_span: Number.isFinite(rowSpanNum) && rowSpanNum > 0 ? rowSpanNum : 1,
    col_span: Number.isFinite(colSpanNum) && colSpanNum > 0 ? colSpanNum : 1,
    cell_para_index: Number.isFinite(cellParaIdxNum) ? cellParaIdxNum : -1,
    cell_para_count: Number.isFinite(cellParaCountNum) ? cellParaCountNum : 0,
    control_only: controlOnly,
    control_only_label: controlOnlyLabel,
    is_hidden_object: !!seg.is_hidden_object,
    hidden_reason: safeStr(seg.hidden_reason),
    required_control_tokens: collectControlTokenCounts(sourceRaw),
    paragraph_style: safeStr(seg.paragraph_style || "[None]"),
    line_rects: lineRects.map(r => ({
      page_index: isFiniteNumber(r.page_index) ? Number(r.page_index) : -1,
      x0: toNumber(r.x0),
      y0: toNumber(r.y0),
      x1: toNumber(r.x1),
      y1: toNumber(r.y1)
    })),
    line_rects_norm: lineRectsNorm.map(r => ({
      page_index: isFiniteNumber(r.page_index) ? Number(r.page_index) : -1,
      nx0: toNumber(r.nx0),
      ny0: toNumber(r.ny0),
      nx1: toNumber(r.nx1),
      ny1: toNumber(r.ny1)
    })),
    page_indexes: sortedUnique(pages.map(Number)),
    point_size: (typeof seg.point_size === "number" && isFinite(seg.point_size) && seg.point_size > 0) ? seg.point_size : 0,
    leading_pt: (typeof seg.leading_pt === "number" && isFinite(seg.leading_pt) && seg.leading_pt > 0) ? seg.leading_pt : 0,
    leading_ratio: (typeof seg.leading_ratio === "number" && isFinite(seg.leading_ratio) && seg.leading_ratio > 0) ? seg.leading_ratio : 0,
    leading_auto: !!seg.leading_auto,
    soft_break_group: safeStr(seg.soft_break_group),
    soft_break_index: isFiniteNumber(Number(seg.soft_break_index)) ? Number(seg.soft_break_index) : -1,
    soft_break_separators: Array.isArray(seg.soft_break_separators) ? seg.soft_break_separators.map(String) : [],
    // Phase 8B/8C: pass-through visual snapshots so the format-paint
    // overlay (lib/emphasis_overlay.js) can render emphasis runs on the
    // source pane and the auto-suggester can project them onto target.
    // The whitelist above intentionally drops fields not used by the
    // translator; format_snapshot is now used, so it gets through.
    format_snapshot: (seg.format_snapshot && typeof seg.format_snapshot === "object")
        ? seg.format_snapshot
        : null,
    paragraph_snapshot: (seg.paragraph_snapshot && typeof seg.paragraph_snapshot === "object")
        ? seg.paragraph_snapshot
        : null,
    // #34: source-side hyperlinks from the InDesign doc. Each entry =
    // { offset, length, url, name, text } with paragraph-relative offsets.
    // Renderer (renderSourceDecoratedHtml) wraps matching ranges in
    // <span class="emp source-link-emp" data-link-idx="N" data-link-tid="TID">
    // so they share the .emp highlight UI; clicking opens the format-paint
    // popover (mirrors emphasis-run clicks), and Apply commits a link
    // annotation into row.annotations.
    source_links: Array.isArray(seg.source_links)
        ? seg.source_links.filter(l =>
            l && typeof l.offset === "number" && typeof l.length === "number" && l.length > 0 && safeStr(l.url))
          .map(l => ({
            offset: Number(l.offset),
            length: Number(l.length),
            url:    safeStr(l.url),
            name:   safeStr(l.name) || undefined,
            text:   safeStr(l.text) || undefined
          }))
        : []
  };
}

function buildInitialTranslations(segments, translationsPayload, templatePayload) {
  const out = {};
  const segByTid = {};
  segments.forEach(s => {
    const isControlOnly = isControlOnlySegment(s);
    const prefillTarget = buildDefaultControlPrefillText(s.source_text);
    segByTid[s.tid] = s;
    out[s.tid] = {
      tid: s.tid,
      source_text: s.source_text,
      target_text: prefillTarget,
      target_auto_prefill: prefillTarget.length > 0,
      merge_head_tid: "",
      status: isControlOnly ? "skip" : "todo",
      notes: "",
      annotations: []
    };
  });

  const fromPayload = normalizeTranslationsPayload(translationsPayload || templatePayload);
  fromPayload.forEach(row => {
    let visibleTarget;
    let status;
    let prefillTarget;
    let effectiveEmpty;
    let mergeHeadTid;
    let shouldPrefill;
    if (!row.tid || !out[row.tid]) {
      return;
    }
    const seg = segByTid[row.tid];
    const isControlOnly = isControlOnlySegment(seg);
    visibleTarget = toVisibleControlTokens(safeStr(row.target_text));
    prefillTarget = buildDefaultControlPrefillText(out[row.tid].source_text);
    effectiveEmpty = isEffectiveEmptyTargetText(visibleTarget);
    status = safeStatus(row.status);
    mergeHeadTid = safeStr(row.merge_head_tid);
    shouldPrefill = effectiveEmpty && prefillTarget.length > 0 && status !== "merge_tail";
    out[row.tid] = {
      tid: row.tid,
      source_text: out[row.tid].source_text,
      target_text: isControlOnly ? (prefillTarget || visibleTarget) : (shouldPrefill ? prefillTarget : visibleTarget),
      target_auto_prefill: isControlOnly ? true : shouldPrefill,
      merge_head_tid: isControlOnly ? "" : (status === "merge_tail" ? mergeHeadTid : ""),
      status: isControlOnly ? "skip" : (effectiveEmpty && status !== "skip" && status !== "merge_tail" ? "todo" : status),
      notes: safeStr(row.notes),
      soft_break_unmerged: !!(row.soft_break_unmerged),
      annotations: normalizeAnnotations(row.annotations)
    };
  });

  return out;
}

const VALID_FORMAT_ACTIONS = ["bold", "italic", "underline", "superscript", "color", "link"];

function isValidAnnotation(a) {
  if (!a || typeof a !== "object") return false;
  const t = safeStr(a.type);
  if (t !== "format" && t !== "comment") return false;
  if (t === "format") {
    const action = safeStr(a.action);
    if (VALID_FORMAT_ACTIONS.indexOf(action) < 0) return false;
    if (!safeStr(a.text)) return false;
    if (typeof a.offset !== "number" || a.offset < 0) return false;
    if (typeof a.length !== "number" || a.length <= 0) return false;
    if (action === "color" && !safeStr(a.color)) return false;
    if (action === "link" && !safeStr(a.url)) return false;
  }
  return true;
}

function normalizeAnnotationItem(a) {
  const t = safeStr(a.type);
  if (t === "format") {
    return {
      type: t,
      action: safeStr(a.action),
      text: safeStr(a.text),
      offset: Number(a.offset),
      length: Number(a.length),
      context_before: safeStr(a.context_before),
      context_after: safeStr(a.context_after),
      color: safeStr(a.color) || undefined,
      url:   safeStr(a.url)   || undefined
    };
  }
  // comment — fill defaults for missing fields
  return {
    type: t,
    text: safeStr(a.text),
    offset: typeof a.offset === "number" ? a.offset : -1,
    length: typeof a.length === "number" ? a.length : -1,
    context_before: safeStr(a.context_before),
    context_after: safeStr(a.context_after)
  };
}

function normalizeAnnotations(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isValidAnnotation).map(normalizeAnnotationItem);
}

function normalizeTranslationsPayload(payload) {
  if (!payload) {
    return [];
  }
  const rows = Array.isArray(payload.translations)
    ? payload.translations
    : (Array.isArray(payload) ? payload : []);
  return rows.map(r => ({
    tid: safeStr(r && r.tid),
    target_text: safeStr(r && r.target_text),
    status: safeStatus(r && r.status),
    merge_head_tid: safeStr(r && r.merge_head_tid),
    notes: safeStr(r && r.notes),
    soft_break_unmerged: !!(r && r.soft_break_unmerged),
    annotations: normalizeAnnotations(r && r.annotations)
  }));
}

function normalizeAiItems(items) {
  const src = Array.isArray(items) ? items : [];
  return src.map((it, idx) => ({
    task_id: safeStr(it.task_id || ("ai_task_" + String(idx + 1).padStart(3, "0"))),
    page: safeStr(it.page),
    page_index: safeStr(it.page_index),
    object_id: safeStr(it.object_id),
    graphic_id: safeStr(it.graphic_id),
    asset_name: safeStr(it.asset_name),
    link_state: safeStr(it.link_state),
    link_status_raw: safeStr(it.link_status_raw),
    link_needed_raw: safeStr(it.link_needed_raw),
    link_type: safeStr(it.link_type),
    link_path: safeStr(it.link_path),
    path_exists: !!(it && it.path_exists),
    recoverability: safeStr(it.recoverability),
    can_unembed: !!(it && it.can_unembed),
    placed_bounds: it && typeof it.placed_bounds === "object" ? it.placed_bounds : null,
    placed_bounds_norm: it && typeof it.placed_bounds_norm === "object" ? it.placed_bounds_norm : null,
    source_text: safeStr(it.source_text || "[MANUAL_CAPTURE]"),
    target_text: safeStr(it.target_text),
    status: safeStr(it.status || "todo_manual"),
    note: safeStr(it.note)
  }));
}

function computePagesAndGeometry() {
  const pages = [];
  const contentBounds = {};
  const docInfo = state.segmentsPayload && state.segmentsPayload.document
    ? state.segmentsPayload.document
    : {};
  const pageCount = Number(docInfo.page_count);
  const exportedGeos = Array.isArray(docInfo.page_geometries) ? docInfo.page_geometries : [];

  if (Number.isFinite(pageCount) && pageCount > 0) {
    for (let p = 0; p < pageCount; p += 1) {
      pages.push(p);
    }
  }

  state.segments.forEach(seg => {
    seg.page_indexes.forEach(p => {
      if (isFiniteNumber(p)) {
        pages.push(Number(p));
      }
    });
    seg.line_rects_norm.forEach(rect => {
      const p = Number(rect.page_index);
      if (!isFiniteNumber(p)) {
        return;
      }
      pages.push(p);
    });
    seg.line_rects.forEach(rect => {
      const p = Number(rect.page_index);
      if (!isFiniteNumber(p)) {
        return;
      }
      pages.push(p);
      if (!contentBounds[p]) {
        contentBounds[p] = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      }
      const b = contentBounds[p];
      b.minX = Math.min(b.minX, rect.x0, rect.x1);
      b.maxX = Math.max(b.maxX, rect.x0, rect.x1);
      b.minY = Math.min(b.minY, rect.y0, rect.y1);
      b.maxY = Math.max(b.maxY, rect.y0, rect.y1);
    });
  });

  exportedGeos.forEach(g => {
    if (!g || !isFiniteNumber(g.page_index)) {
      return;
    }
    pages.push(Number(g.page_index));
  });

  state.aiItems.forEach(it => {
    const p = Number(it && it.page_index);
    if (isFiniteNumber(p)) {
      pages.push(p);
    }
  });

  state.pages = sortedUnique(pages.map(Number));
  state.pageGeometryByIndex = {};

  exportedGeos.forEach(g => {
    const p = Number(g && g.page_index);
    if (!isFiniteNumber(p)) {
      return;
    }
    const x0 = toNumber(g.x0);
    const y0 = toNumber(g.y0);
    const x1 = toNumber(g.x1);
    const y1 = toNumber(g.y1);
    if (Math.abs(x1 - x0) < 0.001 || Math.abs(y1 - y0) < 0.001) {
      return;
    }
    state.pageGeometryByIndex[p] = {
      x0: Math.min(x0, x1),
      y0: Math.min(y0, y1),
      x1: Math.max(x0, x1),
      y1: Math.max(y0, y1)
    };
  });

  state.pages.forEach(p => {
    if (state.pageGeometryByIndex[p]) {
      return;
    }
    const b = contentBounds[p];
    if (!b || !isFiniteNumber(b.minX) || !isFiniteNumber(b.maxX) || !isFiniteNumber(b.minY) || !isFiniteNumber(b.maxY)) {
      state.pageGeometryByIndex[p] = { x0: 0, y0: 0, x1: 1000, y1: 1400 };
      return;
    }
    const padX = Math.max(24, (b.maxX - b.minX) * 0.08);
    const padY = Math.max(24, (b.maxY - b.minY) * 0.08);
    state.pageGeometryByIndex[p] = {
      x0: b.minX - padX,
      y0: b.minY - padY,
      x1: b.maxX + padX,
      y1: b.maxY + padY
    };
  });
}

function rectToNormByMode(rect, geom, mode) {
  const gx0 = Math.min(geom.x0, geom.x1);
  const gy0 = Math.min(geom.y0, geom.y1);
  const w = Math.max(0.001, Math.abs(geom.x1 - geom.x0));
  const h = Math.max(0.001, Math.abs(geom.y1 - geom.y0));
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);

  if (mode === "local") {
    return {
      nx0: x0 / w,
      ny0: y0 / h,
      nx1: x1 / w,
      ny1: y1 / h
    };
  }
  return {
    nx0: (x0 - gx0) / w,
    ny0: (y0 - gy0) / h,
    nx1: (x1 - gx0) / w,
    ny1: (y1 - gy0) / h
  };
}

function normRectFitScore(nr) {
  if (!nr) {
    return -1000;
  }
  if (!Number.isFinite(nr.nx0) || !Number.isFinite(nr.nx1) || !Number.isFinite(nr.ny0) || !Number.isFinite(nr.ny1)) {
    return -1000;
  }
  if (nr.nx1 <= nr.nx0 || nr.ny1 <= nr.ny0) {
    return -100;
  }
  const cx = (nr.nx0 + nr.nx1) / 2;
  const cy = (nr.ny0 + nr.ny1) / 2;
  let score = 0;
  if (cx >= -0.2 && cx <= 1.2 && cy >= -0.2 && cy <= 1.2) {
    score += 4;
  }
  if (nr.nx0 >= -0.15 && nr.nx1 <= 1.15 && nr.ny0 >= -0.15 && nr.ny1 <= 1.15) {
    score += 3;
  }
  if (nr.nx0 >= -0.02 && nr.nx1 <= 1.02 && nr.ny0 >= -0.02 && nr.ny1 <= 1.02) {
    score += 2;
  }
  return score;
}

function deriveNormalizedRectsFromLegacy() {
  const pageBuckets = {};
  const pageModes = {};
  let i;
  let j;
  let seg;
  let rect;
  let p;
  let key;
  let geom;
  let rows;
  let spreadScore;
  let localScore;
  let nr;

  for (i = 0; i < state.segments.length; i += 1) {
    seg = state.segments[i];
    if (!seg || !Array.isArray(seg.line_rects) || seg.line_rects.length === 0) {
      continue;
    }
    if (Array.isArray(seg.line_rects_norm) && seg.line_rects_norm.length > 0) {
      continue;
    }
    for (j = 0; j < seg.line_rects.length; j += 1) {
      rect = seg.line_rects[j];
      p = Number(rect.page_index);
      if (!isFiniteNumber(p)) {
        continue;
      }
      key = String(p);
      if (!pageBuckets[key]) {
        pageBuckets[key] = [];
      }
      pageBuckets[key].push(rect);
    }
  }

  Object.keys(pageBuckets).forEach(k => {
    geom = state.pageGeometryByIndex[Number(k)];
    if (!geom) {
      pageModes[k] = "spread";
      return;
    }
    rows = pageBuckets[k];
    spreadScore = 0;
    localScore = 0;
    for (i = 0; i < rows.length; i += 1) {
      spreadScore += normRectFitScore(rectToNormByMode(rows[i], geom, "spread"));
      localScore += normRectFitScore(rectToNormByMode(rows[i], geom, "local"));
    }
    pageModes[k] = localScore > spreadScore + 1 ? "local" : "spread";
  });

  for (i = 0; i < state.segments.length; i += 1) {
    seg = state.segments[i];
    if (!seg || !Array.isArray(seg.line_rects) || seg.line_rects.length === 0) {
      continue;
    }
    if (Array.isArray(seg.line_rects_norm) && seg.line_rects_norm.length > 0) {
      continue;
    }
    seg.line_rects_norm = [];
    for (j = 0; j < seg.line_rects.length; j += 1) {
      rect = seg.line_rects[j];
      p = Number(rect.page_index);
      if (!isFiniteNumber(p)) {
        continue;
      }
      geom = state.pageGeometryByIndex[p];
      if (!geom) {
        continue;
      }
      key = String(p);
      nr = rectToNormByMode(rect, geom, pageModes[key] || "spread");
      if (!nr) {
        continue;
      }
      const nx0 = clamp(Math.min(nr.nx0, nr.nx1), 0, 1);
      const nx1 = clamp(Math.max(nr.nx0, nr.nx1), 0, 1);
      const ny0 = clamp(Math.min(nr.ny0, nr.ny1), 0, 1);
      const ny1 = clamp(Math.max(nr.ny0, nr.ny1), 0, 1);
      if (nx1 - nx0 < 0.0001 || ny1 - ny0 < 0.0001) {
        continue;
      }
      seg.line_rects_norm.push({
        page_index: p,
        nx0: nx0,
        ny0: ny0,
        nx1: nx1,
        ny1: ny1
      });
    }
  }
}

function hasPdfJs() {
  return typeof window.pdfjsLib !== "undefined" && !!window.pdfjsLib;
}

function configurePdfJsWorker() {
  if (!hasPdfJs()) {
    return;
  }
  // `file://` context often blocks cross-origin workers. Use fake worker by default.
  if (location.protocol === "file:") {
    window.pdfjsLib.disableWorker = true;
    return;
  }
  if (window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    return;
  }

  // Strict offline mode: local worker path only.
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "./vendor/pdf.worker.min.js";
}

async function loadPdfDocument(file) {
  if (!file) {
    state.pdfDoc = null;
    state.pdfViewBox = null;
    clearPdfCanvas();
    return;
  }
  if (!hasPdfJs()) {
    throw new Error("PDF.js library is not loaded. Missing local file: translator_app/vendor/pdf.min.js");
  }

  configurePdfJsWorker();
  const arrayBuffer = await readArrayBuffer(file);
  const loadingTask = window.pdfjsLib.getDocument({
    data: arrayBuffer,
    useSystemFonts: true
  });
  state.pdfDoc = await loadingTask.promise;
  state.pdfViewBox = null;
}

function clearPdfCanvas() {
  const canvas = els.pdfCanvas;
  const ctx = canvas.getContext("2d");
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.width = "0px";
  canvas.style.height = "0px";
  canvas.style.left = "0px";
  canvas.style.top = "0px";
  if (ctx) {
    ctx.clearRect(0, 0, 1, 1);
  }
  els.hotspotLayer.style.left = "0px";
  els.hotspotLayer.style.top = "0px";
  els.hotspotLayer.style.width = "100%";
  els.hotspotLayer.style.height = "100%";
  state.pdfViewBox = null;
}

function renderAll() {
  renderFilters();
  renderSegmentsPane();
  renderAiList();
  renderPageControls();
  renderPdf();
}

function renderFilters() {
  const currentPageFilter = state.pageFilter;
  const currentStyleFilter = state.styleFilter;
  const isCardMode = state.editorViewMode === "page_cards";
  const currentPage = isFiniteNumber(state.currentPage) ? String(Number(state.currentPage)) : "all";

  const pageOptions = ['<option value="all">All pages</option>']
    .concat(state.pages.map(p => `<option value="${p}">P${p + 1}</option>`));
  els.pageFilter.innerHTML = pageOptions.join("");
  if (isCardMode) {
    els.pageFilter.value = pageOptions.some(o => o.indexOf(`value="${currentPage}"`) >= 0)
      ? currentPage
      : "all";
  } else {
    els.pageFilter.value = pageOptions.some(o => o.indexOf(`value="${currentPageFilter}"`) >= 0)
      ? currentPageFilter
      : "all";
    state.pageFilter = els.pageFilter.value;
  }
  els.pageFilter.disabled = isCardMode;

  const styleOptions = ['<option value="all">All styles</option>']
    .concat(state.styles.map(s => `<option value="${escapeHtmlAttr(s)}">${escapeHtmlText(s)}</option>`));
  els.styleFilter.innerHTML = styleOptions.join("");
  els.styleFilter.value = styleOptions.some(o => o.indexOf(`value="${escapeHtmlAttr(currentStyleFilter)}"`) >= 0)
    ? currentStyleFilter
    : "all";
  state.styleFilter = els.styleFilter.value;
  renderTextFilterControls();
}

function getFilteredSegments() {
  const isCardMode = state.editorViewMode === "page_cards";
  const currentPage = Number(state.currentPage);
  return state.segments.filter(seg => {
    // Always hide control-only anchors: they have no visible/translatable
    // content and only clutter the editor and PDF overlay.
    if (seg.control_only) {
      return false;
    }
    if (state.filterHiddenObjects && !!seg.is_hidden_object) {
      return false;
    }
    if (state.filterEmptySource && !safeStr(seg.source_text)) {
      return false;
    }
    if (
      state.filterSimpleText &&
      (
        isWhitespaceOnlyText(seg.source_text) ||
        isPureNumberText(seg.source_text) ||
        isPurePunctuationText(seg.source_text)
      )
    ) {
      return false;
    }
    if (isCardMode) {
      if (isFiniteNumber(currentPage) && !seg.page_indexes.includes(currentPage)) {
        return false;
      }
    } else if (state.pageFilter !== "all") {
      const p = Number(state.pageFilter);
      if (!seg.page_indexes.includes(p)) {
        return false;
      }
    }
    if (state.styleFilter !== "all" && seg.paragraph_style !== state.styleFilter) {
      return false;
    }
    if (state.searchText) {
      const t = state.translationsByTid[seg.tid] || {};
      const sourceSearchText = isControlOnlySegment(seg)
        ? (sourceTextForUi(seg) + " " + safeStr(seg.source_text || ""))
        : safeStr(seg.source_text || "");
      const contextSearchText = segmentContextLabel(seg);
      const hay = [
        seg.tid,
        sourceSearchText,
        contextSearchText,
        t.target_text || "",
        seg.paragraph_style
      ].join(" ").toLowerCase();
      if (hay.indexOf(state.searchText) < 0) {
        return false;
      }
    }
    return true;
  });
}

function renderSegmentsPane() {
  const items = getFilteredSegments();
  const isCardMode = state.editorViewMode === "page_cards";
  renderSegmentsSummary(items);
  els.cardsView.classList.toggle("hidden", !isCardMode);
  els.classicView.classList.toggle("hidden", isCardMode);
  if (isCardMode) {
    renderPageCards(items);
    renderManualCards();
  } else {
    renderSegmentsList(items);
    renderManualSegmentRows();
    renderEditor();
  }
}

function renderSegmentsSummary(items) {
  const doneCount = items.reduce((n, s) => {
    const row = state.translationsByTid[s.tid];
    return n + (isRowTranslatedLike(s, row) ? 1 : 0);
  }, 0);
  els.segmentsSummary.textContent = `Segments: ${items.length} | translated: ${doneCount}`;
}

function renderSegmentsSummaryFromCards() {
  const rows = els.cardsView ? els.cardsView.querySelectorAll(".segment-card") : [];
  const done = els.cardsView ? els.cardsView.querySelectorAll(".segment-card.done") : [];
  if (!rows || rows.length === 0) {
    renderSegmentsSummary(getFilteredSegments());
    return;
  }
  els.segmentsSummary.textContent = `Segments: ${rows.length} | translated: ${done.length}`;
}

function renderSegmentsList(items) {
  const rows = items || getFilteredSegments();

  if (rows.length === 0) {
    els.segmentList.innerHTML = '<div class="muted" style="padding:10px;">No segment matches filters.</div>';
    return;
  }

  const html = rows.map(seg => {
    const tr = state.translationsByTid[seg.tid] || {};
    const isControlOnly = isControlOnlySegment(seg);
    const selected = seg.tid === state.selectedTid;
    const done = isRowTranslatedLike(seg, tr);
    const statusClass = statusClassForRow(seg, tr);
    const statusLabel = displayStatusText(seg, tr);
    const page = seg.page_indexes.length > 0 ? ("P" + (seg.page_indexes[0] + 1)) : "P?";
    const contextLabel = segmentContextLabel(seg);
    const sourceDisplay = oneLine(sourceTextForUi(seg));
    const targetDisplay = isControlOnly ? "Auto preserved (locked)" : oneLine(tr.target_text || "");
    // Phase 8B/8C: render source-side emphasis as styled spans when the
    // segment carries `format_snapshot.emphasis_runs`. Fallback to plain
    // escaped text when EmphasisOverlay isn't available or no runs.
    const sourceRuns  = (seg.format_snapshot && seg.format_snapshot.emphasis_runs) || null;
    // #34: source-side hyperlinks from export. seg.source_links is an array
    // of { offset, length, url, name } — wrap matching ranges as anchors so
    // the translator sees which phrases are hyperlinks in the InDesign doc.
    const sourceLinks = seg.source_links || null;
    const hasAnyDeco  = (sourceRuns && sourceRuns.length) || (sourceLinks && sourceLinks.length);
    const sourceHtml  = hasAnyDeco && typeof EmphasisOverlay !== "undefined"
        ? (EmphasisOverlay.renderSourceDecoratedHtml
            ? EmphasisOverlay.renderSourceDecoratedHtml(sourceDisplay, sourceRuns, sourceLinks, seg.tid)
            : EmphasisOverlay.renderEmphasisHtml(sourceDisplay, sourceRuns, seg.tid))
        : escapeHtmlText(sourceDisplay);
    const empBadge = (sourceRuns && sourceRuns.length)
        ? ` <span class="emp-badge" title="Mixed-format paragraph: ${sourceRuns.length} emphasis run${sourceRuns.length === 1 ? "" : "s"}">✦${sourceRuns.length}</span>`
        : "";
    return `
      <div class="segment-row ${selected ? "selected" : ""} ${done ? "done" : ""} ${statusClass}${isControlOnly ? " system-anchor" : ""}" data-tid="${escapeHtmlAttr(seg.tid)}">
        <div class="row-meta">
          <span>${page} · ${escapeHtmlText(seg.paragraph_style || "[None]")}${contextLabel ? " · " + escapeHtmlText(contextLabel) : ""}${empBadge}</span>
          <span>${escapeHtmlText(statusLabel)}</span>
        </div>
        <div class="row-source">${sourceHtml}</div>
        <div class="row-target">${escapeHtmlText(targetDisplay)}</div>
      </div>`;
  }).join("");

  els.segmentList.innerHTML = html;
  els.segmentList.querySelectorAll(".segment-row").forEach(row => {
    row.addEventListener("click", () => {
      selectSegment(row.getAttribute("data-tid"), true);
    });
  });
}

function buildPageCardHtml(seg) {
  const tr = state.translationsByTid[seg.tid] || {};
  const isControlOnly = isControlOnlySegment(seg);
  const sourceLabel = sourceTextForUi(seg);
  const done = isRowTranslatedLike(seg, tr);
  const selected = seg.tid === state.selectedTid;
  const statusClass = statusClassForRow(seg, tr);
  const statusLabel = displayStatusText(seg, tr);
  const contextLabel = segmentContextLabel(seg);
  const canMergeNext = !isControlOnly && canMergeNextFromTid(seg.tid);
  const tailChain = getMergeTailChainForHead(seg.tid);
  const isMergeHead = !isControlOnly && tailChain.length > 0;
  const showReset = !isControlOnly && shouldShowResetForRow(seg, tr);
  const controlHintHtml = isControlOnly ? "" : buildControlHintHtml(seg, tr);
  const bulkImportBtnHtml = isControlOnly ? "" : `
      <div class="hover-wrap">
        <button type="button" class="chip-btn bulk-import-btn" data-bulk-import="${escapeHtmlAttr(seg.tid)}">Paste Fill</button>
        <div class="hover-tip">Paste multi-paragraph text and fill translations sequentially starting from this segment.</div>
      </div>`;
  const isSoftBreakHead = isMergeHead && !!seg.soft_break_group;
  const mergeBtnHtml = [
    isMergeHead ? `
      <div class="hover-wrap">
        <button type="button" class="chip-btn merge-btn" data-unmerge-head="${escapeHtmlAttr(seg.tid)}">Unmerge ${tailChain.length}</button>
        <div class="hover-tip">Restore merged tail rows to editable state.</div>
      </div>${isSoftBreakHead ? ' <span class="soft-break-badge">soft-break merged</span>' : ""}` : "",
    canMergeNext ? `
      <div class="hover-wrap">
        <button type="button" class="chip-btn merge-btn" data-merge-head="${escapeHtmlAttr(seg.tid)}">Merge Next</button>
        <div class="hover-tip">Because of source layout constraints, one sentence may be split into multiple paragraph rows. Merge the next contiguous row into this card; only this card stays editable.</div>
      </div>` : ""
  ].join("");
  const resetBtnHtml = `
    <div class="hover-wrap${showReset ? "" : " hidden"}" data-reset-wrap="${escapeHtmlAttr(seg.tid)}">
      <button type="button" class="chip-btn reset-btn" data-reset-row="${escapeHtmlAttr(seg.tid)}">Reset</button>
      <div class="hover-tip">Reset translation to todo. If control tokens exist, they are restored automatically.</div>
    </div>`;
  const statusPopoverHtml = buildStatusPopoverHtml(seg, tr);
  const targetDisabled = isRowSystemLocked(seg, tr);
  const targetReadonlyTip = isControlOnly
    ? (sourceLabel + " is preserved from source.")
    : (isMergeTailRow(tr)
        ? (seg.soft_break_group ? "Soft-break tail \u2014 edit the head card above." : "Merged tail \u2014 edit the head card.")
        : "Enter translation...");
  // Phase 8B/8C: render emphasis runs inline when present.
  const cardSourceRuns  = (seg.format_snapshot && seg.format_snapshot.emphasis_runs) || null;
  // #34: source-side hyperlinks
  const cardSourceLinks = seg.source_links || null;
  const cardCanRenderDecorated = ((cardSourceRuns && cardSourceRuns.length) || (cardSourceLinks && cardSourceLinks.length)) &&
      typeof EmphasisOverlay !== "undefined" && !isControlOnly &&
      typeof seg.source_text === "string";
  if (cardSourceRuns && cardSourceRuns.length && !window.__emphasisLogged) {
    console.log("[emphasis-overlay] active. First seg with runs:", seg.tid,
                "runs:", cardSourceRuns.length,
                "EmphasisOverlay loaded:", typeof EmphasisOverlay !== "undefined");
    window.__emphasisLogged = true;
  }
  const sourceHtml = isControlOnly
    ? '<span class="anchor-inline">' + escapeHtmlText(sourceLabel) + "</span>"
    : (cardCanRenderDecorated
        ? (EmphasisOverlay.renderSourceDecoratedHtml
            ? EmphasisOverlay.renderSourceDecoratedHtml(seg.source_text, cardSourceRuns, cardSourceLinks, seg.tid)
            : EmphasisOverlay.renderEmphasisHtml(seg.source_text, cardSourceRuns, seg.tid))
        : tokenAwareHtml(seg.source_text || ""));
  const systemNoteHtml = isControlOnly
    ? `<div class="system-lock-note">${escapeHtmlText(sourceLabel)} · locked</div>`
    : "";
  const contextHtml = contextLabel
    ? `<div class="segment-context-note">${escapeHtmlText(contextLabel)}</div>`
    : "";
  return `
    <article class="segment-card ${selected ? "selected" : ""} ${done ? "done" : ""} ${statusClass}${isControlOnly ? " system-anchor" : ""}" data-tid="${escapeHtmlAttr(seg.tid)}">
      <div class="card-top">
        <div class="card-actions">
          ${bulkImportBtnHtml}
          ${mergeBtnHtml}
          ${resetBtnHtml}
          <div class="status-wrap">
            <button type="button" class="status-chip ${statusClass}" data-status-chip="${escapeHtmlAttr(seg.tid)}">${escapeHtmlText(statusLabel)}</button>
            ${statusPopoverHtml}
          </div>
        </div>
      </div>
      ${contextHtml}
      ${systemNoteHtml}
      <div class="card-grid${isControlOnly ? " collapsed" : ""}">
        <div class="card-col">
          <div class="card-label">Source</div>
          <div class="card-source${isControlOnly ? " control-only" : ""}">${sourceHtml}</div>
        </div>
        <div class="card-col card-col-target${isControlOnly ? " hidden" : ""}">
          <div class="card-label">Target</div>
          <textarea class="card-target${tr.target_auto_prefill ? " auto-prefill" : ""}${targetDisabled ? " locked" : ""}" data-card-target="${escapeHtmlAttr(seg.tid)}" placeholder="${escapeHtmlAttr(targetReadonlyTip)}" ${targetDisabled ? "disabled" : ""}>${escapeHtmlText(tr.target_text || "")}</textarea>
        </div>
      </div>
      ${controlHintHtml}
    </article>
  `;
}

function initializeCardTargetTextarea(area) {
  const tid = area ? area.getAttribute("data-card-target") : "";
  const seg = tid ? state.segmentByTid[tid] : null;
  const row = tid ? state.translationsByTid[tid] : null;
  const isLocked = isRowSystemLocked(seg, row);
  if (!area) {
    return;
  }
  ensureTokenOverlayForTextarea(area);
  if (isLocked) {
    area.disabled = true;
    if (isControlOnlySegment(seg)) {
      area.title = safeStr(seg.control_only_label || "Control Anchor") + " is preserved from source.";
    } else {
      area.title = "Merged tail row. Edit translation in the head card.";
    }
    syncTokenOverlayForTextarea(area);
  } else {
    applyTargetInputVisualState(area, row);
  }
  autoResizeTextarea(area);
}

function initializePageCardDom(card) {
  const area = card ? card.querySelector(".card-target") : null;
  if (!card) {
    return;
  }
  if (area) {
    initializeCardTargetTextarea(area);
  }
  syncCardSourceTargetHeight(card);
}

function renderPageCards(items) {
  let rows = items || getFilteredSegments();
  let selectionChanged = false;

  if (rows.length === 0) {
    els.cardsView.innerHTML = '<div class="muted">No segment on current page under current filters.</div>';
    return;
  }

  ensureCardsViewEventBindings();

  if (!state.selectedManualHotspotId && !rows.some(seg => seg.tid === state.selectedTid)) {
    state.selectedTid = rows[0].tid;
    selectionChanged = true;
  }
  rows = items || getFilteredSegments();

  els.cardsView.innerHTML = rows.map(seg => buildPageCardHtml(seg)).join("");
  els.cardsView.querySelectorAll(".segment-card").forEach(card => {
    initializePageCardDom(card);
  });
  requestAnimationFrame(() => {
    els.cardsView.querySelectorAll(".segment-card").forEach(card => {
      syncCardSourceTargetHeight(card);
    });
  });

  if (selectionChanged) {
    renderHotspots();
  }
}

function ensureCardsViewEventBindings() {
  const downEventName = getPrimaryPointerDownEventName();
  if (!els.cardsView || els.cardsView.__cardsEventsBound) {
    return;
  }
  els.cardsView.__cardsEventsBound = true;
  els.cardsView.addEventListener(downEventName, onCardsViewPointerDown);
  els.cardsView.addEventListener("click", onCardsViewClick);
  els.cardsView.addEventListener("keydown", onCardsViewKeydown);
  els.cardsView.addEventListener("input", onCardsViewInput);
}

function onCardsViewPointerDown(ev) {
  const target = ev && ev.target ? ev.target : null;
  const card = closestCompat(target, ".segment-card");
  const tid = card ? card.getAttribute("data-tid") : "";
  if (!card || !tid) {
    return;
  }
  if (!isPrimaryPointerDownEvent(ev)) {
    return;
  }
  selectCardInCardsView(tid);
  if (closestCompat(target, ".card-target")) {
    return;
  }
  if (closestCompat(target, ".card-source")) {
    focusTargetForTidAfterSourceMouseup(tid, card);
    return;
  }
  if (closestCompat(target, "button, input, select, textarea, a, label")) {
    return;
  }
  if (ev && typeof ev.preventDefault === "function") {
    ev.preventDefault();
  }
  focusTargetForTid(tid);
}

function captureMergeRefreshContext(headTid) {
  const headSeg = state.segmentByTid[headTid];
  const prevSeg = getPreviousContiguousSegment(headSeg);
  const candidate = getMergeAppendCandidateForHead(headTid);
  return {
    previousTid: prevSeg ? prevSeg.tid : "",
    candidateTid: candidate ? candidate.tid : "",
    tails: getMergeTailChainForHead(headTid).slice()
  };
}

function collectMergeRefreshTids(headTid, beforeCtx) {
  const before = beforeCtx || {};
  const after = captureMergeRefreshContext(headTid);
  const tids = []
    .concat(headTid || "")
    .concat(before.previousTid || "")
    .concat(after.previousTid || "")
    .concat(before.candidateTid || "")
    .concat(after.candidateTid || "")
    .concat(before.tails || [])
    .concat(after.tails || []);
  return sortedUnique(tids.map(safeStr).filter(Boolean));
}

function refreshPageCardsByTidSet(tids) {
  const list = sortedUnique((tids || []).map(safeStr).filter(Boolean));
  const ownerMap = {};
  let replaced = 0;
  list.forEach(tid => {
    const seg = state.segmentByTid[tid];
    const card = findCardByTid(tid);
    const shell = document.createElement("div");
    let nextCard;
    if (!seg || !card) {
      return;
    }
    shell.innerHTML = buildPageCardHtml(seg);
    nextCard = shell.firstElementChild;
    if (!nextCard) {
      return;
    }
    card.replaceWith(nextCard);
    initializePageCardDom(nextCard);
    ownerMap[getHotspotOwnerTid(tid)] = true;
    replaced += 1;
  });
  if (replaced <= 0) {
    return false;
  }
  renderSegmentsSummaryFromCards();
  Object.keys(ownerMap).forEach(ownerTid => {
    if (ownerTid) {
      syncHotspotVisualForTid(ownerTid);
    }
  });
  return true;
}

function refreshCardsAfterMergeAction(headTid, beforeCtx) {
  if (state.editorViewMode !== "page_cards" || !!state.searchText) {
    return false;
  }
  return refreshPageCardsByTidSet(collectMergeRefreshTids(headTid, beforeCtx));
}

function onCardsViewClick(ev) {
  const target = ev && ev.target ? ev.target : null;
  let btn;
  let tid;
  let nextStatus;
  let headTid;
  let beforeCtx;
  if (!target) {
    return;
  }

  btn = closestCompat(target, "[data-status-set]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    tid = btn.getAttribute("data-status-tid");
    nextStatus = btn.getAttribute("data-status-set");
    if (!tid || !nextStatus || btn.disabled) {
      return;
    }
    if (!setRowStatus(tid, nextStatus)) {
      return;
    }
    if (!syncCardUiForTid(tid)) {
      renderSegmentsPane();
      renderHotspots();
    }
    return;
  }

  btn = closestCompat(target, "[data-bulk-import]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    tid = btn.getAttribute("data-bulk-import");
    if (tid) {
      showBulkImportModal(tid);
    }
    return;
  }

  btn = closestCompat(target, "[data-reset-row]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    tid = btn.getAttribute("data-reset-row");
    if (!tid) {
      return;
    }
    if (!resetTranslationForTid(tid)) {
      return;
    }
    if (!syncCardUiForTid(tid)) {
      renderSegmentsPane();
      renderHotspots();
    }
    return;
  }

  btn = closestCompat(target, "[data-jump-head]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    headTid = btn.getAttribute("data-jump-head");
    if (!headTid || !state.segmentByTid[headTid]) {
      return;
    }
    selectSegment(headTid, false, { scrollInPane: true });
    return;
  }

  btn = closestCompat(target, "[data-merge-head]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    tid = btn.getAttribute("data-merge-head");
    if (!tid) {
      return;
    }
    beforeCtx = captureMergeRefreshContext(tid);
    if (!mergeNextSegmentFromTid(tid)) {
      return;
    }
    if (!refreshCardsAfterMergeAction(tid, beforeCtx)) {
      renderSegmentsPane();
    }
    requestAnimationFrame(() => {
      renderHotspots();
    });
    return;
  }

  btn = closestCompat(target, "[data-unmerge-head]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    tid = btn.getAttribute("data-unmerge-head");
    if (!tid) {
      return;
    }
    beforeCtx = captureMergeRefreshContext(tid);
    if (!unmergeTailChainFromHead(tid)) {
      return;
    }
    if (!refreshCardsAfterMergeAction(tid, beforeCtx)) {
      renderSegmentsPane();
    }
    requestAnimationFrame(() => {
      renderHotspots();
    });
    return;
  }

  btn = closestCompat(target, "[data-token-restore]");
  if (btn) {
    ev.preventDefault();
    ev.stopPropagation();
    tid = btn.getAttribute("data-token-restore");
    if (!tid) {
      return;
    }
    if (!restoreMissingControlTokensForTid(tid)) {
      return;
    }
    if (!syncCardUiForTid(tid)) {
      renderSegmentsPane();
      renderHotspots();
    }
  }

  // Phase 8C-FP: clicking a source-side .emp span opens the format-paint
  // popover. Translator selects target textarea range, clicks "Apply",
  // diff is pushed into row.target_emphasis_runs.
  //
  // Two flavors of paintable spans share .emp visual highlight:
  //   - data-emp-idx → emphasis run (bold/italic/color/size diff) → emphasis
  //     paint via commitFormatPaint
  //   - data-link-idx → source-side hyperlink → link annotation paint via
  //     commitFormatPaintLink. We check the inner emp first (preferred when
  //     a link range overlaps an emphasis run; emp is the innermost wrap).
  var empSpan = closestCompat(target, ".emp");
  if (empSpan && empSpan.hasAttribute("data-emp-idx")) {
    ev.preventDefault();
    ev.stopPropagation();
    onEmphasisSpanClick(empSpan);
    return;
  }
  var linkSpan = closestCompat(target, "[data-link-idx]");
  if (linkSpan) {
    ev.preventDefault();
    ev.stopPropagation();
    onSourceLinkSpanClick(linkSpan);
    return;
  }
}

// ─── Phase 8C-FP: format-paint popover with armed mode ────────────
//
// User flow:
//   1. Click .emp span in source → popover opens with describeRun label
//      + "Apply" button.
//   2. Click "Apply" →
//      (a) if target textarea has a non-empty selection: paint immediately.
//      (b) if no selection: enter "armed" mode — popover stays, label
//          changes to "Painting [diff]… select target text". Cursor on
//          target textarea also changes (.fp-armed class).
//   3. In armed mode, the next selection (mouseup or shift+arrow) on the
//      target textarea applies the diff at the selected range and disarms.
//   4. Esc anywhere or clicking outside cancels.

var _empPopoverEl  = null;
var _empArmedTid   = null;
var _empArmedArea  = null;
var _empArmedSelectionHandler = null;
var _empArmedSelectionChangeHandler = null;

function closeEmpPopover() {
    if (_empPopoverEl && _empPopoverEl.parentNode) {
        _empPopoverEl.parentNode.removeChild(_empPopoverEl);
    }
    _empPopoverEl = null;
    disarmFormatPaint();
    document.querySelectorAll(".segment-card .emp.active, .row-source .emp.active")
        .forEach(function (e) { e.classList.remove("active"); });
}

function disarmFormatPaint() {
    if (_empArmedArea && _empArmedSelectionHandler) {
        _empArmedArea.removeEventListener("mouseup",   _empArmedSelectionHandler);
        _empArmedArea.removeEventListener("keyup",     _empArmedSelectionHandler);
        _empArmedArea.removeEventListener("touchend",  _empArmedSelectionHandler);
        if (_empArmedArea.__fpMouseDownHandler) {
            _empArmedArea.removeEventListener("mousedown", _empArmedArea.__fpMouseDownHandler);
            delete _empArmedArea.__fpMouseDownHandler;
        }
        _empArmedArea.classList.remove("fp-armed");
    }
    if (_empArmedSelectionChangeHandler) {
        document.removeEventListener("selectionchange", _empArmedSelectionChangeHandler);
    }
    _empArmedTid = null;
    _empArmedArea = null;
    _empArmedSelectionHandler = null;
    _empArmedSelectionChangeHandler = null;
}

function onDocumentClickToCloseEmpPopover(ev) {
    if (!_empPopoverEl && !_empArmedArea) return;
    var t = ev && ev.target;
    if (!t) return;
    if (_empPopoverEl && _empPopoverEl.contains(t)) return;
    if (closestCompat(t, ".emp[data-emp-idx]")) return;
    if (closestCompat(t, "[data-link-idx]")) return;
    // While armed, allow clicks on the armed textarea (the user is going
    // to select inside it). Outside clicks still cancel.
    if (_empArmedArea && (_empArmedArea === t || _empArmedArea.contains(t))) return;
    closeEmpPopover();
}

function onEmphasisSpanClick(spanEl) {
    var tid = spanEl.getAttribute("data-emp-tid");
    var idxStr = spanEl.getAttribute("data-emp-idx");
    if (!tid || idxStr === null) return;
    var idx = parseInt(idxStr, 10);
    var seg = state.segmentByTid[tid];
    if (!seg || !seg.format_snapshot || !Array.isArray(seg.format_snapshot.emphasis_runs)) return;
    var run = seg.format_snapshot.emphasis_runs[idx];
    if (!run || !run.diff) return;

    closeEmpPopover();
    document.querySelectorAll(".segment-card .emp.active, .row-source .emp.active")
        .forEach(function (e) { e.classList.remove("active"); });
    spanEl.classList.add("active");

    var label = (typeof EmphasisOverlay !== "undefined" && EmphasisOverlay.describeRun)
        ? EmphasisOverlay.describeRun(run) || "Emphasis"
        : "Emphasis";
    var slice = "";
    try { slice = String(seg.source_text || "").substring(run.start, run.end); } catch (e) {}

    var pop = document.createElement("div");
    pop.className = "emp-popover";
    pop.setAttribute("data-emp-popover-tid", tid);
    pop.innerHTML = renderEmpPopoverHtml(label, slice, false);
    document.body.appendChild(pop);
    _empPopoverEl = pop;

    var rect = spanEl.getBoundingClientRect();
    pop.style.left = Math.round(window.scrollX + rect.left) + "px";
    pop.style.top  = Math.round(window.scrollY + rect.bottom + 4) + "px";

    pop.addEventListener("click", function (ev) {
        var act = closestCompat(ev.target, "[data-emp-action]");
        if (!act) return;
        var which = act.getAttribute("data-emp-action");
        if (which === "close") {
            closeEmpPopover();
            return;
        }
        if (which === "apply") {
            handleApplyClick(tid, run, label, slice);
        }
    });
}

// #34 source-link format paint. Mirrors onEmphasisSpanClick but for the
// span.emp[data-link-idx] decorations produced by renderSourceDecoratedHtml:
// reads seg.source_links[idx], opens the same emp-popover, and on Apply
// pushes a link annotation (action:"link", url:link.url) into row.annotations
// — NOT into target_emphasis_runs, since the import pipeline already maps
// link annotations onto InDesign Hyperlink objects + _T_c_link underline.
function onSourceLinkSpanClick(spanEl) {
    var tid = spanEl.getAttribute("data-link-tid");
    var idxStr = spanEl.getAttribute("data-link-idx");
    if (!tid || idxStr === null) return;
    var idx = parseInt(idxStr, 10);
    var seg = state.segmentByTid[tid];
    if (!seg || !Array.isArray(seg.source_links)) return;
    var link = seg.source_links[idx];
    if (!link || !link.url) return;

    closeEmpPopover();
    document.querySelectorAll(".segment-card .emp.active, .row-source .emp.active")
        .forEach(function (e) { e.classList.remove("active"); });
    spanEl.classList.add("active");

    var label = "Link → " + link.url;
    var slice = "";
    try {
        var off = (typeof link.offset === "number") ? link.offset : 0;
        var ln  = (typeof link.length === "number") ? link.length : 0;
        slice = String(seg.source_text || "").substring(off, off + ln);
    } catch (e) {}

    var pop = document.createElement("div");
    pop.className = "emp-popover";
    pop.setAttribute("data-emp-popover-tid", tid);
    pop.innerHTML = renderEmpPopoverHtml(label, slice, false);
    document.body.appendChild(pop);
    _empPopoverEl = pop;

    var rect = spanEl.getBoundingClientRect();
    pop.style.left = Math.round(window.scrollX + rect.left) + "px";
    pop.style.top  = Math.round(window.scrollY + rect.bottom + 4) + "px";

    pop.addEventListener("click", function (ev) {
        var act = closestCompat(ev.target, "[data-emp-action]");
        if (!act) return;
        var which = act.getAttribute("data-emp-action");
        if (which === "close") {
            closeEmpPopover();
            return;
        }
        if (which === "apply") {
            handleApplyLinkClick(tid, link, label, slice);
        }
    });
}

function handleApplyLinkClick(tid, link, label, slice) {
    var card = els.cardsView ? els.cardsView.querySelector('.segment-card[data-tid="' + escapeCssAttr(tid) + '"]') : null;
    var area = card ? card.querySelector(".card-target") : null;
    if (!area) {
        console.warn("[format-paint-link] no target textarea for tid", tid);
        return;
    }
    var ss = area.selectionStart, se = area.selectionEnd;
    if (ss != null && se != null && ss !== se) {
        commitFormatPaintLink(tid, link, ss, se, area);
        closeEmpPopover();
        return;
    }
    armFormatPaint(tid, area, label, slice, function (s, e) {
        commitFormatPaintLink(tid, link, s, e, area);
    });
}

function commitFormatPaintLink(tid, link, ss, se, area) {
    var row = state.translationsByTid[tid];
    if (!row || !area) return;
    if (ss == null || se == null || ss === se) return;
    if (!link || !link.url) return;
    // #SEC-A: Reject script-protocol URLs even when they arrive via the
    // source-link paint flow. The source data (segments.json) can come from
    // anywhere — never trust its URLs without re-checking the protocol.
    if (!isSafeUrl(link.url)) {
      console.warn("[format-paint-link] refusing unsafe URL scheme:", link.url);
      return;
    }
    if (!Array.isArray(row.annotations)) row.annotations = [];

    var fullText = area.value || "";
    var text = fullText.substring(ss, se);
    if (!text) return;
    var ctx = buildAnnotationContext(fullText, ss, se - ss);
    var ann = {
        type: "format",
        action: "link",
        text: text,
        offset: ss,
        length: se - ss,
        url: String(link.url),
        context_before: ctx.context_before,
        context_after: ctx.context_after
    };
    row.annotations.push(ann);
    // Derive companion color from the source link's actual fill color (in
    // InDesign the linked text is typically styled blue / brand color via a
    // designer char style; emphasis_extractor captured that as a fillColor
    // diff on the overlapping emphasis run). Falls back to LINK_DEFAULT_COLOR
    // when the source has no color diff over the link range.
    var seg = state.segmentByTid[tid];
    var sourceColor = sourceColorForRange(seg, link.offset, link.length);
    addLinkCompanionAnnotations(row, area, ss, se - ss, sourceColor ? { color: sourceColor } : null);
    syncCardUiForTid(tid);
    console.log("[format-paint-link] committed", {
        tid: tid, start: ss, end: se, url: link.url, sourceColor: sourceColor || "(default)"
    });
}

// Convert an emphasis-extractor fillColor diff into "#RRGGBB" hex. Returns
// null when the diff carries no color signal. Mirrors the conversion that
// diffToAnnotationEntries does so source-derived colors and paint-derived
// colors land in the same hex space.
function fillColorToHex(fillColor) {
    if (!fillColor) return null;
    if (fillColor.values && fillColor.values.length >= 3) {
        var r = Math.max(0, Math.min(255, Math.round(fillColor.values[0])));
        var g = Math.max(0, Math.min(255, Math.round(fillColor.values[1])));
        var b = Math.max(0, Math.min(255, Math.round(fillColor.values[2])));
        return "#" + ("000000" + ((r << 16) | (g << 8) | b).toString(16)).slice(-6).toUpperCase();
    }
    if (fillColor.swatch) {
        var lc = String(fillColor.swatch).toLowerCase();
        var named = { red: "#C81E1E", blue: "#1950C8", green: "#1EA050",
                      yellow: "#DCB41E", cyan: "#00A0C8", magenta: "#C800A0",
                      black: "#000000", white: "#FFFFFF" };
        // #SEC-B: For unknown swatch names, RETURN NULL — never echo the
        // raw string. Previously this passed `fillColor.swatch` through,
        // which let segments.json inject arbitrary text into CSS context
        // via the color annotation (e.g., "red;background-image:url(...)").
        // Callers handle null by skipping the color or using a default.
        return named[lc] || null;
    }
    return null;
}

// #SEC-B: Color values land in `style="color:..."` inline CSS, so they must
// pass a strict syntactic check before rendering. Accept only hex (#rgb,
// #rrggbb, #rrggbbaa) — the only forms the toolbar and fillColorToHex
// produce. Anything else (named CSS colors, rgb()/hsl()/var(), or smuggled
// `;background-image:...`) is rejected to a safe default at render time.
function isSafeCssColor(c) {
  if (typeof c !== "string") return false;
  return /^#[0-9a-fA-F]{3,8}$/.test(c.trim());
}

// Scan a segment's source-side emphasis_runs for the first run that overlaps
// [offset, offset+length) and carries a fillColor diff, returning its hex.
// Used by commitFormatPaintLink so the companion color annotation matches
// the source link's actual color instead of a fixed default.
function sourceColorForRange(seg, offset, length) {
    if (!seg || !seg.format_snapshot || !Array.isArray(seg.format_snapshot.emphasis_runs)) return null;
    if (typeof offset !== "number" || typeof length !== "number" || length <= 0) return null;
    var rangeEnd = offset + length;
    var runs = seg.format_snapshot.emphasis_runs;
    for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        if (!r || !r.diff || !r.diff.fillColor) continue;
        var rs = typeof r.start === "number" ? r.start : 0;
        var re = typeof r.end === "number" ? r.end : rs;
        if (re <= offset || rs >= rangeEnd) continue;   // no overlap
        var hex = fillColorToHex(r.diff.fillColor);
        if (hex) return hex;
    }
    return null;
}

function renderEmpPopoverHtml(label, slice, armed) {
    var hint = armed
        ? '<div class="emp-popover-hint"><b>Painting…</b> select text in the target textarea below. Press Esc to cancel.</div>'
        : '<div class="emp-popover-hint">Click <b>Apply</b>, then select target text — or pre-select first.</div>';
    var applyLabel = armed ? "Cancel" : "Apply to target selection";
    var applyAction = armed ? "close" : "apply";
    return '<div class="emp-popover-label">Format paint' + (armed ? " — armed" : "") + '</div>' +
        '<div class="emp-popover-diff">' + escapeHtmlText(label) + '</div>' +
        (slice ? '<div class="emp-popover-hint">Source slice: "' + escapeHtmlText(slice.substring(0, 40)) + '"</div>' : "") +
        hint +
        '<div class="emp-popover-actions">' +
        '<button type="button" data-emp-action="' + applyAction + '">' + applyLabel + '</button>' +
        (armed ? "" : '<button type="button" class="secondary" data-emp-action="close">Close</button>') +
        '</div>';
}

function handleApplyClick(tid, run, label, slice) {
    var card = els.cardsView ? els.cardsView.querySelector('.segment-card[data-tid="' + escapeCssAttr(tid) + '"]') : null;
    var area = card ? card.querySelector(".card-target") : null;
    if (!area) {
        console.warn("[format-paint] no target textarea for tid", tid);
        return;
    }
    var ss = area.selectionStart, se = area.selectionEnd;
    // (a) Pre-selected range exists → paint immediately
    if (ss != null && se != null && ss !== se) {
        commitFormatPaint(tid, run, ss, se);
        closeEmpPopover();
        return;
    }
    // (b) No selection → arm
    armFormatPaint(tid, area, label, slice, function (s, e) {
        commitFormatPaint(tid, run, s, e);
    });
}

function armFormatPaint(tid, area, label, slice, commitFn) {
    disarmFormatPaint();
    _empArmedTid = tid;
    _empArmedArea = area;
    area.classList.add("fp-armed");
    area.focus();
    console.log("[format-paint] armed", { tid: tid, label: label });

    var lastApplied = false;
    // Track last NON-EMPTY selection seen on this textarea — used as
    // fallback when mouseup fires after browser has reset selection
    // (e.g. blur on focus shift). NOT used to commit by itself; commit
    // only happens on real release events.
    var lastValidSel = null;
    var dragInFlight = false;

    // selectionchange: pure observer — captures latest non-empty range.
    // Never commits directly (committing here would fire mid-drag at the
    // first 1-char selection, before user finishes their drag).
    _empArmedSelectionChangeHandler = function () {
        if (lastApplied || !_empArmedArea) return;
        if (document.activeElement !== _empArmedArea) return;
        var s = _empArmedArea.selectionStart;
        var e = _empArmedArea.selectionEnd;
        if (s != null && e != null && s !== e) {
            lastValidSel = { start: s, end: e };
        }
    };
    document.addEventListener("selectionchange", _empArmedSelectionChangeHandler);

    // Commit on real release: mouseup / keyup / touchend. By the time
    // release fires, the user has finished the drag — selection is final.
    var tryCommit = function (reason) {
        if (lastApplied || !_empArmedArea) return false;
        var s = _empArmedArea.selectionStart;
        var e = _empArmedArea.selectionEnd;
        // Some browsers blur the textarea on certain DOM events; fall back
        // to the last non-empty range we observed via selectionchange.
        if ((s == null || s === e) && lastValidSel) {
            s = lastValidSel.start; e = lastValidSel.end;
        }
        if (s == null || e == null || s === e) {
            console.log("[format-paint] " + reason + " — no selection (still armed)", {
                live: { ss: _empArmedArea.selectionStart, se: _empArmedArea.selectionEnd },
                tracked: lastValidSel
            });
            return false;
        }
        lastApplied = true;
        console.log("[format-paint] commit via " + reason, { tid: tid, start: s, end: e });
        commitFn(s, e);
        closeEmpPopover();
        return true;
    };

    _empArmedSelectionHandler = function (ev) {
        var t = (ev && ev.type) || "event";
        // Defer one tick so any post-mouseup selection updates land first.
        setTimeout(function () { tryCommit(t); }, 0);
    };
    area.addEventListener("mouseup",  _empArmedSelectionHandler);
    area.addEventListener("keyup",    _empArmedSelectionHandler);
    area.addEventListener("touchend", _empArmedSelectionHandler);

    // Mark drag in-flight so we know when user is mid-drag (avoids
    // committing prematurely if some other handler triggers commit).
    var onMD = function () { dragInFlight = true; };
    area.addEventListener("mousedown", onMD);
    // Save for cleanup
    area.__fpMouseDownHandler = onMD;

    if (_empPopoverEl) {
        _empPopoverEl.innerHTML = renderEmpPopoverHtml(label, slice, true);
    }
}

// Map an emphasis_extractor diff onto one or more existing annotation
// entries (`row.annotations[]`). The translator app already has a robust
// pipeline for annotations:
//   - buildAnnotatedHtml renders <b>/<i>/<sup>/<sub>/<u>/<s>/color/size spans
//     (used for hotspot text + PDF export)
//   - token-target-overlay shows blue-underline position markers in the
//     textarea
//   - annotation toolbar (B / I / superscript / color) lets translator
//     edit / delete the annotation
//   - resetTranslationForTid clears annotations[]
//
// By converting paint output into annotations[] we get all of the above
// for free, with one shared data model. Diff dimensions not natively
// supported (fontFamily / tracking / scale / skew) are dropped with a
// console warning — those rarely round-trip via translator UI anyway.
function diffToAnnotationEntries(diff, offset, length) {
    var anns = [];
    if (!diff || length <= 0) return anns;
    if (diff.fontStyle) {
        var fsLow = String(diff.fontStyle).toLowerCase();
        if (fsLow.indexOf("bold")   >= 0) anns.push({ type: "format", action: "bold",   offset: offset, length: length });
        if (fsLow.indexOf("italic") >= 0) anns.push({ type: "format", action: "italic", offset: offset, length: length });
    }
    if (diff.underline)     anns.push({ type: "format", action: "underline",     offset: offset, length: length });
    if (diff.strikeThrough) anns.push({ type: "format", action: "strikethrough", offset: offset, length: length });
    if (typeof diff.baseline_shift === "number") {
        if (diff.baseline_shift > 0) anns.push({ type: "format", action: "superscript", offset: offset, length: length });
        else if (diff.baseline_shift < 0) anns.push({ type: "format", action: "subscript", offset: offset, length: length });
    }
    if (diff.fillColor) {
        var hex = fillColorToHex(diff.fillColor);
        if (hex) anns.push({ type: "format", action: "color", offset: offset, length: length, color: hex });
    }
    if (typeof diff.fontSize === "number" && diff.fontSize > 0) {
        anns.push({ type: "format", action: "size", offset: offset, length: length, size: Number(diff.fontSize) });
    }
    if (diff.fontFamily) {
        // Translator app's font UI is fixed (NotoSansSC). Fontfamily diffs
        // are typically the source's Latin/CJK font split — meaningful at
        // import time (re-applied via _T_Latin_* GREP rules), not at the
        // textarea layer. Drop with a soft warning so we don't pollute
        // annotations[].
        if (typeof console !== "undefined" && console.debug) {
            console.debug("[format-paint] dropping fontFamily diff at " + offset + ".." + (offset + length) + ":", diff.fontFamily);
        }
    }
    return anns;
}

function commitFormatPaint(tid, run, ss, se) {
    var row = state.translationsByTid[tid];
    if (!row) return;
    if (!Array.isArray(row.annotations)) row.annotations = [];
    var newAnns = diffToAnnotationEntries(run.diff, ss, se - ss);
    if (newAnns.length === 0) {
        console.warn("[format-paint] diff produced 0 annotation entries — paint not committed", run.diff);
        return;
    }
    for (var i = 0; i < newAnns.length; i++) row.annotations.push(newAnns[i]);
    // Reflect on textarea: status, overlay, hotspot all routed through
    // syncCardUiForTid (it calls ensureTokenOverlayForTextarea +
    // syncTokenOverlayForTextarea which renders annotations into the
    // overlay; updateHotspotText re-renders hotspot via buildAnnotatedHtml).
    syncCardUiForTid(tid);
    console.log("[format-paint] committed " + newAnns.length + " annotation(s)", { tid: tid, start: ss, end: se, anns: newAnns });
}

function onCardsViewKeydown(ev) {
  const area = closestCompat(ev && ev.target ? ev.target : null, ".card-target");
  if (!area || !ev || ev.key !== "Enter") {
    return;
  }
  if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) {
    return;
  }
  ev.preventDefault();
  moveSelectionByDelta(1, true);
}

function onCardsViewInput(ev) {
  const area = closestCompat(ev && ev.target ? ev.target : null, ".card-target");
  const tid = area ? area.getAttribute("data-card-target") : "";
  const row = tid ? state.translationsByTid[tid] : null;
  const seg = tid ? state.segmentByTid[tid] : null;
  const card = area ? closestCompat(area, ".segment-card") : null;
  if (!area || !row || isRowSystemLocked(seg, row)) {
    return;
  }
  updateTargetText(tid, area.value, { fromUser: true });
  if (area.value !== row.target_text) {
    area.value = row.target_text;
  }
  applyTargetInputVisualState(area, row);
  autoResizeTextarea(area);
  if (card) {
    syncCardStatusUi(card, seg, row);
    syncCardSourceTargetHeight(card);
  }
  renderSegmentsSummaryFromCards();
  if (seg) {
    syncHotspotVisualForTid(seg.tid);
    updateHotspotText(seg.tid);
  }
}

function findCardByTid(tid) {
  const tidStr = safeStr(tid);
  if (!tidStr || !els.cardsView) {
    return null;
  }
  return els.cardsView.querySelector('.segment-card[data-tid="' + escapeCssAttr(tidStr) + '"]');
}

function syncHotspotSelectionForTidChange(prevTid, nextTid) {
  const prevOwnerTid = getHotspotOwnerTid(prevTid);
  const nextOwnerTid = getHotspotOwnerTid(nextTid);
  if (prevOwnerTid) {
    syncHotspotVisualForTid(prevOwnerTid);
  }
  if (nextOwnerTid && nextOwnerTid !== prevOwnerTid) {
    syncHotspotVisualForTid(nextOwnerTid);
  }
}

function syncCardSelectionForTidChange(prevTid, nextTid) {
  const prevTidStr = safeStr(prevTid);
  const nextTidStr = safeStr(nextTid);
  const selectedCard = findCardByTid(nextTidStr);
  let prevCard;
  let staleSelectedCard;
  if (!nextTidStr || !selectedCard) {
    return false;
  }
  if (prevTidStr && prevTidStr !== nextTidStr) {
    prevCard = findCardByTid(prevTidStr);
    if (prevCard) {
      prevCard.classList.remove("selected");
    }
  }
  staleSelectedCard = els.cardsView.querySelector(".segment-card.selected");
  if (staleSelectedCard && staleSelectedCard !== selectedCard) {
    staleSelectedCard.classList.remove("selected");
  }
  selectedCard.classList.add("selected");
  syncHotspotSelectionForTidChange(prevTidStr, nextTidStr);
  return true;
}

function selectCardInCardsView(tid) {
  const prevTid = state.selectedTid;
  if (!tid || !state.segmentByTid[tid]) {
    return;
  }
  if (prevTid === tid) {
    return;
  }
  state.selectedTid = tid;
  if (syncCardSelectionForTidChange(prevTid, tid)) {
    return;
  }
  renderSegmentsPane();
  syncHotspotSelectionForTidChange(prevTid, state.selectedTid);
}

function selectSegment(tid, focusPage, options) {
  const opts = options || {};
  const prevTid = state.selectedTid;
  if (!tid || !state.segmentByTid[tid]) {
    return;
  }
  // Clear manual hotspot selection when selecting a normal segment
  if (state.selectedManualHotspotId) {
    state.selectedManualHotspotId = null;
    renderManualHotspotsVisual();
  }
  if (!focusPage && state.editorViewMode === "page_cards" && prevTid === tid) {
    if (opts.scrollInPane) {
      scrollSelectedSegmentIntoPaneIfNeeded();
    }
    return;
  }
  state.selectedTid = tid;
  if (focusPage) {
    const seg = state.segmentByTid[tid];
    if (seg.page_indexes.length > 0) {
      state.currentPage = seg.page_indexes[0];
      renderPdf();
      renderPageControls();
    }
  }
  if (!focusPage &&
      state.editorViewMode === "page_cards" &&
      syncCardSelectionForTidChange(prevTid, tid)) {
    if (opts.scrollInPane) {
      scrollSelectedSegmentIntoPaneIfNeeded();
    }
    return;
  }
  renderSegmentsPane();
  if (opts.scrollInPane) {
    scrollSelectedSegmentIntoPaneIfNeeded();
  }
  if (!focusPage) {
    syncHotspotSelectionForTidChange(prevTid, state.selectedTid);
  }
}

function getHotspotOwnerTid(tid) {
  const row = state.translationsByTid[tid];
  const headTid = safeStr(row && row.merge_head_tid);
  if (row && isMergeTailRow(row) && headTid && state.segmentByTid[headTid]) {
    return headTid;
  }
  return safeStr(tid);
}

function isSameHotspotGroupTid(a, b) {
  if (!a || !b) {
    return false;
  }
  return getHotspotOwnerTid(a) === getHotspotOwnerTid(b);
}

function getPrimaryPointerDownEventName() {
  return (typeof window !== "undefined" && typeof window.PointerEvent === "function")
    ? "pointerdown"
    : "mousedown";
}

function isPrimaryPointerDownEvent(ev) {
  if (!ev) {
    return true;
  }
  if (ev.type === "mousedown") {
    return !(typeof ev.button === "number" && ev.button !== 0);
  }
  if (ev.type === "pointerdown") {
    if (ev.pointerType === "mouse") {
      return !(typeof ev.button === "number" && ev.button !== 0);
    }
    return true;
  }
  return true;
}

function closestCompat(node, selector) {
  let cur = node;
  if (!selector || !cur) {
    return null;
  }
  if (cur.nodeType !== 1) {
    cur = cur.parentElement;
  }
  while (cur) {
    if (matchesSelectorCompat(cur, selector)) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

function matchesSelectorCompat(el, selector) {
  const node = el;
  const fn = node && (
    node.matches ||
    node.msMatchesSelector ||
    node.webkitMatchesSelector ||
    node.mozMatchesSelector
  );
  let all;
  let i;
  if (!node || node.nodeType !== 1 || !selector) {
    return false;
  }
  if (fn) {
    return !!fn.call(node, selector);
  }
  all = (node.ownerDocument || document).querySelectorAll(selector);
  for (i = 0; i < all.length; i += 1) {
    if (all[i] === node) {
      return true;
    }
  }
  return false;
}

function focusTargetForTid(tid) {
  const targetTid = safeStr(tid);
  let area;
  if (!targetTid) {
    return false;
  }
  if (state.editorViewMode === "page_cards") {
    area = els.cardsView.querySelector('.card-target[data-card-target="' + escapeCssAttr(targetTid) + '"]');
    if (!area || area.disabled) {
      return false;
    }
    area.focus();
    if (typeof area.setSelectionRange === "function") {
      area.setSelectionRange(area.value.length, area.value.length);
    }
    return true;
  }
  if (state.selectedTid !== targetTid || !els.targetInput || els.targetInput.disabled) {
    return false;
  }
  els.targetInput.focus();
  if (typeof els.targetInput.setSelectionRange === "function") {
    els.targetInput.setSelectionRange(els.targetInput.value.length, els.targetInput.value.length);
  }
  return true;
}

function focusTargetForTidAfterSourceMouseup(tid, cardEl) {
  const targetTid = safeStr(tid);
  function onMouseUp() {
    window.removeEventListener("mouseup", onMouseUp, true);
    if (hasSourceTextSelection(cardEl)) {
      return;
    }
    focusTargetForTid(targetTid);
  }
  if (!targetTid) {
    return;
  }
  window.addEventListener("mouseup", onMouseUp, true);
}

function hasSourceTextSelection(cardEl) {
  const sourceEl = cardEl && typeof cardEl.querySelector === "function"
    ? cardEl.querySelector(".card-source")
    : null;
  let sel;
  let i;
  let range;
  if (!sourceEl || !window.getSelection) {
    return false;
  }
  sel = window.getSelection();
  if (!sel || sel.rangeCount <= 0 || sel.isCollapsed) {
    return false;
  }
  for (i = 0; i < sel.rangeCount; i += 1) {
    range = sel.getRangeAt(i);
    if (!range || range.collapsed) {
      continue;
    }
    if (isNodeInside(sourceEl, range.startContainer) ||
        isNodeInside(sourceEl, range.endContainer) ||
        isNodeInside(sourceEl, range.commonAncestorContainer)) {
      return true;
    }
  }
  return false;
}

function isNodeInside(container, node) {
  let cur = node;
  if (!container || !cur) {
    return false;
  }
  if (cur === container) {
    return true;
  }
  if (cur.nodeType !== 1) {
    cur = cur.parentNode;
  }
  return !!(cur && container.contains(cur));
}

function moveSelectionByDelta(delta, focusTarget) {
  const rows = getFilteredSegments();
  const currentTid = state.selectedTid;
  const dir = Number(delta) >= 0 ? 1 : -1;
  let idx;
  let nextIdx;
  let nextTid;
  if (!rows || rows.length === 0) {
    return false;
  }
  idx = rows.findIndex(seg => seg && seg.tid === currentTid);
  if (idx < 0) {
    idx = 0;
  }
  nextIdx = clamp(idx + dir, 0, rows.length - 1);
  nextTid = rows[nextIdx] && rows[nextIdx].tid ? rows[nextIdx].tid : "";
  if (!nextTid || nextTid === currentTid) {
    return false;
  }
  selectSegment(nextTid, false, { scrollInPane: true });
  if (focusTarget) {
    if (!focusTargetForTid(nextTid)) {
      requestAnimationFrame(() => {
        focusTargetForTid(nextTid);
      });
    }
  }
  return true;
}

function scrollSelectedSegmentIntoPaneIfNeeded() {
  const tid = state.selectedTid;
  const isCardMode = state.editorViewMode === "page_cards";
  const container = isCardMode ? els.cardsView : els.segmentList;
  let selector;
  let item;
  if (!tid || !container) {
    return;
  }
  selector = isCardMode
    ? '.segment-card[data-tid="' + escapeCssAttr(tid) + '"]'
    : '.segment-row[data-tid="' + escapeCssAttr(tid) + '"]';
  item = container.querySelector(selector);
  if (!item) {
    return;
  }
  requestAnimationFrame(() => {
    smartScrollItemIntoContainer(container, item);
  });
}

function smartScrollItemIntoContainer(container, item) {
  const containerRect = container.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const viewTop = container.scrollTop;
  const itemTop = viewTop + (itemRect.top - containerRect.top);
  const itemHeight = Math.max(1, itemRect.height);
  let targetTop;
  let maxTop;

  if (itemHeight >= container.clientHeight) {
    targetTop = itemTop;
  } else {
    targetTop = itemTop - ((container.clientHeight - itemHeight) / 2);
  }
  maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  targetTop = clamp(targetTop, 0, maxTop);
  if (Math.abs(targetTop - viewTop) < 1) {
    return;
  }
  container.scrollTop = targetTop;
}

function renderEditor() {
  // If a manual hotspot is selected, show its fields in the editor
  var mhId = state.selectedManualHotspotId;
  var mhItem = mhId ? state.manualHotspotById[mhId] : null;
  if (mhItem) {
    els.editorEmpty.classList.add("hidden");
    els.editorFields.classList.remove("hidden");
    els.tidInput.value = mhItem.id;
    els.sourceInput.value = safeStr(mhItem.source_text);
    els.sourceInput.readOnly = false;
    els.targetInput.value = safeStr(mhItem.target_text);
    els.targetInput.disabled = false;
    els.targetInput.title = "";
    els.targetInput.classList.remove("has-control", "auto-prefill", "locked");
    els.statusInput.value = safeStr(mhItem.status) || "todo";
    els.statusInput.disabled = false;
    els.notesInput.value = safeStr(mhItem.notes);
    return;
  }

  const tid = state.selectedTid;
  const seg = tid ? state.segmentByTid[tid] : null;
  let isLocked;
  if (!seg) {
    els.editorEmpty.classList.remove("hidden");
    els.editorFields.classList.add("hidden");
    return;
  }

  const tr = state.translationsByTid[tid] || {
    target_text: "",
    status: "todo",
    notes: ""
  };

  els.editorEmpty.classList.add("hidden");
  els.editorFields.classList.remove("hidden");
  els.tidInput.value = tid;
  els.sourceInput.value = sourceTextForUi(seg);
  els.sourceInput.readOnly = true;
  ensureTokenOverlayForTextarea(els.sourceInput);
  els.targetInput.value = tr.target_text || "";
  applyTargetInputVisualState(els.targetInput, tr);
  els.targetInput.classList.remove("has-control");
  els.statusInput.value = safeStatus(tr.status);
  els.notesInput.value = tr.notes || "";
  isLocked = isRowSystemLocked(seg, tr);
  els.targetInput.disabled = isLocked;
  els.statusInput.disabled = isLocked;
  if (isControlOnlySegment(seg)) {
    els.targetInput.title = safeStr(seg.control_only_label || "Control Anchor") + " is preserved from source.";
  } else if (isMergeTailRow(tr)) {
    els.targetInput.title = "Merged tail row. Edit translation in the head card.";
  } else {
    els.targetInput.title = "";
  }
  ensureTokenOverlayForTextarea(els.targetInput);
}

function onSourceInput() {
  var mhId = state.selectedManualHotspotId;
  if (mhId && state.manualHotspotById[mhId]) {
    updateManualHotspot(mhId, { source_text: els.sourceInput.value });
  }
}

function onTargetInput() {
  // Handle manual hotspot target editing in classic view
  var mhId = state.selectedManualHotspotId;
  if (mhId && state.manualHotspotById[mhId]) {
    updateManualHotspot(mhId, { target_text: els.targetInput.value });
    updateManualHotspotOverlayText(mhId);
    return;
  }
  const tid = state.selectedTid;
  let row;
  let seg;
  if (!tid || !state.translationsByTid[tid]) {
    return;
  }
  row = state.translationsByTid[tid];
  seg = state.segmentByTid[tid];
  if (isRowSystemLocked(seg, row)) {
    return;
  }
  updateTargetText(tid, els.targetInput.value, { fromUser: true });
  row = state.translationsByTid[tid];
  if (els.targetInput.value !== row.target_text) {
    els.targetInput.value = row.target_text;
  }
  applyTargetInputVisualState(els.targetInput, row);
  syncTokenOverlayForTextarea(els.targetInput);
  els.statusInput.value = safeStatus(row.status);
  const items = getFilteredSegments();
  renderSegmentsSummary(items);
  if (state.editorViewMode === "classic") {
    renderSegmentsList(items);
  } else {
    renderPageCards(items);
  }
  updateHotspotText(tid);
}

function onTargetKeydown(ev) {
  if (!ev || ev.key !== "Enter") {
    return;
  }
  if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) {
    return;
  }
  ev.preventDefault();
  moveSelectionByDelta(1, true);
}

function updateTargetText(tid, value, options) {
  const opts = options || {};
  let row;
  let seg;
  let prefill;
  if (!tid || !state.translationsByTid[tid]) {
    return;
  }
  row = state.translationsByTid[tid];
  seg = state.segmentByTid[tid];
  if (isRowSystemLocked(seg, row)) {
    return;
  }
  row.target_text = safeStr(value);
  if (opts.fromUser) {
    row.target_auto_prefill = false;
  }
  if (hasEffectiveTargetText(row.target_text)) {
    if (row.status === "todo") {
      row.status = "translated";
    }
    if (row.status === "reviewed" && !canSetReviewedStatus(seg, row)) {
      row.status = "translated";
    }
    // Phase 8C scaffolding: auto-suggest target_emphasis_runs from source's
    // format_snapshot.emphasis_runs via heuristic alignment. Only fires when:
    //   - source segment has emphasis (otherwise no-op)
    //   - row doesn't already have explicit target_emphasis_runs (don't
    //     overwrite translator's manual adjustments)
    //   - EmphasisOverlay module is loaded
    // Translator can still drag/edit later; this is a starting suggestion.
    if (typeof EmphasisOverlay !== "undefined" &&
        seg && seg.format_snapshot && seg.format_snapshot.emphasis_runs &&
        seg.format_snapshot.emphasis_runs.length > 0 &&
        !row.target_emphasis_runs_user_set) {
      try {
        var suggestion = EmphasisOverlay.suggestTargetEmphasisRuns(
          safeStr(seg.source_text),
          seg.format_snapshot.emphasis_runs,
          row.target_text
        );
        row.target_emphasis_runs = suggestion.runs;
        row.target_emphasis_runs_stats = suggestion.stats;
        row.target_emphasis_runs_auto = true;
      } catch (eEmphasis) {
        // Non-fatal; translator can still edit text without emphasis info.
      }
    }
  } else {
    if (row.status !== "skip") {
      row.status = "todo";
    }
    // Empty target → drop auto-suggested emphasis (will re-suggest when
    // user types something).
    if (row.target_emphasis_runs_auto) {
      delete row.target_emphasis_runs;
      delete row.target_emphasis_runs_stats;
      delete row.target_emphasis_runs_auto;
    }
    prefill = buildDefaultControlPrefillText(seg && seg.source_text);
    if (prefill) {
      row.target_text = prefill;
      row.target_auto_prefill = true;
    }
  }
}

function autoResizeTextarea(area) {
  if (!area) {
    return;
  }
  const card = closestCompat(area, ".segment-card");
  if (card) {
    syncCardSourceTargetHeight(card);
    return;
  }
  const minHeight = 96;
  area.style.height = "auto";
  area.style.height = px(Math.max(minHeight, area.scrollHeight));
  syncTokenOverlayForTextarea(area);
}

function syncCardSourceTargetHeight(card) {
  const source = card ? card.querySelector(".card-source") : null;
  const target = card ? card.querySelector(".card-target") : null;
  if (!source || !target) {
    return;
  }
  source.style.minHeight = "";
  target.style.height = "auto";
  const sourceHeight = source.scrollHeight;
  const targetHeight = target.scrollHeight;
  const maxHeight = Math.max(sourceHeight, targetHeight);
  source.style.minHeight = px(maxHeight);
  target.style.height = px(maxHeight);
  syncTokenOverlayForTextarea(target);
}

function escapeCssAttr(value) {
  const s = safeStr(value);
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}

function onStatusChange() {
  // Handle manual hotspot status change in classic view
  var mhId = state.selectedManualHotspotId;
  if (mhId && state.manualHotspotById[mhId]) {
    updateManualHotspot(mhId, { status: els.statusInput.value });
    renderHotspots();
    return;
  }
  const tid = state.selectedTid;
  let row;
  let applied;
  if (!tid || !state.translationsByTid[tid]) {
    return;
  }
  row = state.translationsByTid[tid];
  applied = setRowStatus(tid, safeStatus(els.statusInput.value));
  if (!applied) {
    els.statusInput.value = safeStatus(row.status);
    return;
  }
  row = state.translationsByTid[tid];
  applyTargetInputVisualState(els.targetInput, row);
  if (state.editorViewMode === "page_cards") {
    if (!syncCardUiForTid(tid)) {
      renderSegmentsPane();
      renderHotspots();
    }
  } else {
    renderSegmentsList(getFilteredSegments());
  }
}

function onNotesInput() {
  // Handle manual hotspot notes in classic view
  var mhId = state.selectedManualHotspotId;
  if (mhId && state.manualHotspotById[mhId]) {
    updateManualHotspot(mhId, { notes: els.notesInput.value });
    return;
  }
  const tid = state.selectedTid;
  if (!tid || !state.translationsByTid[tid]) {
    return;
  }
  state.translationsByTid[tid].notes = els.notesInput.value;
}

function renderPdf() {
  void renderPdfAsync();
}

async function renderPdfAsync() {
  const renderSeq = ++state.pdfRenderSeq;
  if (!state.pdfDoc) {
    clearPdfCanvas();
    els.hotspotLayer.innerHTML = "";
    return;
  }
  if (!isFiniteNumber(state.currentPage)) {
    clearPdfCanvas();
    els.hotspotLayer.innerHTML = "";
    return;
  }

  const pageNumber = Number(state.currentPage) + 1;
  if (pageNumber < 1 || pageNumber > state.pdfDoc.numPages) {
    clearPdfCanvas();
    els.hotspotLayer.innerHTML = "";
    return;
  }

  let page;
  try {
    page = await state.pdfDoc.getPage(pageNumber);
  } catch (err) {
    if (renderSeq === state.pdfRenderSeq) {
      clearPdfCanvas();
      els.hotspotLayer.innerHTML = "";
    }
    return;
  }

  if (renderSeq !== state.pdfRenderSeq) {
    return;
  }

  const canvas = els.pdfCanvas;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    clearPdfCanvas();
    els.hotspotLayer.innerHTML = "";
    return;
  }
  const stageW = Math.max(1, els.pdfStage.clientWidth);
  const stageH = Math.max(1, els.pdfStage.clientHeight);
  const viewportAt1 = page.getViewport({ scale: 1 });
  let cssScale = Math.min(stageW / viewportAt1.width, stageH / viewportAt1.height);
  const zoomScale = state.zoomPercent / 100;
  if (!Number.isFinite(cssScale) || cssScale <= 0) {
    cssScale = 1;
  }
  cssScale = cssScale * (Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1);
  const viewport = page.getViewport({ scale: cssScale });
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const viewLeft = viewport.width <= stageW ? (stageW - viewport.width) / 2 : 0;
  const viewTop = viewport.height <= stageH ? (stageH - viewport.height) / 2 : 0;

  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.width = px(viewport.width);
  canvas.style.height = px(viewport.height);
  canvas.style.left = px(viewLeft);
  canvas.style.top = px(viewTop);

  els.hotspotLayer.style.left = px(viewLeft);
  els.hotspotLayer.style.top = px(viewTop);
  els.hotspotLayer.style.width = px(viewport.width);
  els.hotspotLayer.style.height = px(viewport.height);

  if (ctx && ctx.setTransform) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (ctx) {
    ctx.fillStyle = "#f0ede8";
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  }

  try {
    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;
  } catch (err2) {
    if (renderSeq === state.pdfRenderSeq) {
      clearPdfCanvas();
      els.hotspotLayer.innerHTML = "";
    }
    return;
  }

  if (renderSeq !== state.pdfRenderSeq) {
    return;
  }

  state.pdfViewBox = {
    left: viewLeft,
    top: viewTop,
    width: viewport.width,
    height: viewport.height
  };
  // Phase 7-SC: store CSS-px-per-source-pt scale so fitHotspotTextViaDOM can
  // convert preview's CSS-px box dimensions back to source pt before calling
  // measureTextLayoutViaDOM. PDF passes pt directly; preview must match the
  // SAME pt input or measurements diverge.
  // CRITICAL: pdf.js viewport bakes in a 96/72 DPI conversion. At scale 1,
  // viewport.width = page_pt × 96/72. At our cssScale, viewport.width =
  // page_pt × 96/72 × cssScale. So 1 source pt = (96/72 × cssScale) CSS px.
  // Forgetting the 96/72 factor over-estimates Preview boxW_pt by 1.333×,
  // which lets the measurement element fit a larger fontSize than PDF gets.
  state.cssPxPerPt = cssScale * (96 / 72);
  renderHotspots();
}

function renderPageControls() {
  const pages = state.pages;
  if (pages.length === 0) {
    els.pageLabel.textContent = "Page - / -";
    els.prevPageBtn.disabled = true;
    els.nextPageBtn.disabled = true;
    return;
  }
  if (!isFiniteNumber(state.currentPage) || pages.indexOf(state.currentPage) < 0) {
    state.currentPage = pages[0];
  }
  const idx = pages.indexOf(state.currentPage);
  els.pageLabel.textContent =
    `Page ${state.currentPage + 1} / ${pages[pages.length - 1] + 1}`;
  els.prevPageBtn.disabled = idx <= 0;
  els.nextPageBtn.disabled = idx >= pages.length - 1;
}

function shiftPage(delta) {
  const pages = state.pages;
  if (pages.length === 0) {
    return;
  }
  const idx = pages.indexOf(state.currentPage);
  if (idx < 0) {
    state.currentPage = pages[0];
  } else {
    const next = Math.max(0, Math.min(pages.length - 1, idx + delta));
    state.currentPage = pages[next];
  }
  renderPdf();
  renderPageControls();
  renderFilters();
  renderSegmentsPane();
}

function getAiItemByTaskId(taskId) {
  const wanted = safeStr(taskId);
  if (!wanted) {
    return null;
  }
  return state.aiItems.find(it => safeStr(it && it.task_id) === wanted) || null;
}

function findAiItemElement(taskId) {
  const taskIdStr = safeStr(taskId);
  if (!taskIdStr || !els.aiList) {
    return null;
  }
  return els.aiList.querySelector('.ai-item[data-task-id="' + escapeCssAttr(taskIdStr) + '"]');
}

function selectAiItem(taskId, focusPage, options) {
  const taskIdStr = safeStr(taskId);
  const item = getAiItemByTaskId(taskIdStr);
  const opts = options || {};
  const pageIndex = Number(item && item.page_index);
  if (!item) {
    return;
  }
  state.selectedAiTaskId = taskIdStr;
  if (focusPage && isFiniteNumber(pageIndex)) {
    state.currentPage = pageIndex;
    renderPdf();
    renderPageControls();
    renderFilters();
    renderSegmentsPane();
  } else {
    renderHotspots();
  }
  renderAiList();
  if (opts.scrollInPane) {
    const el = findAiItemElement(taskIdStr);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }
}

function collectPageRectRows(page) {
  const rows = [];
  state.segments.forEach(seg => {
    // Skip control-only anchors from PDF overlay hotspots.
    if (seg.control_only) {
      return;
    }
    let hasNorm = false;
    seg.line_rects_norm.forEach(rect => {
      if (rect.page_index !== page) {
        return;
      }
      hasNorm = true;
      rows.push({ tid: seg.tid, norm_rect: rect });
    });
    if (hasNorm) {
      return;
    }
    seg.line_rects.forEach(rect => {
      if (rect.page_index !== page) {
        return;
      }
      rows.push({ tid: seg.tid, rect: rect });
    });
  });
  return rows;
}

function boundsFromRectRows(rectRows) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let i;
  let rx0;
  let rx1;
  let ry0;
  let ry1;

  for (i = 0; i < rectRows.length; i += 1) {
    if (!rectRows[i] || !rectRows[i].rect) {
      continue;
    }
    rx0 = Math.min(rectRows[i].rect.x0, rectRows[i].rect.x1);
    rx1 = Math.max(rectRows[i].rect.x0, rectRows[i].rect.x1);
    ry0 = Math.min(rectRows[i].rect.y0, rectRows[i].rect.y1);
    ry1 = Math.max(rectRows[i].rect.y0, rectRows[i].rect.y1);
    if (!Number.isFinite(rx0) || !Number.isFinite(rx1) || !Number.isFinite(ry0) || !Number.isFinite(ry1)) {
      continue;
    }
    minX = Math.min(minX, rx0);
    minY = Math.min(minY, ry0);
    maxX = Math.max(maxX, rx1);
    maxY = Math.max(maxY, ry1);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return {
    x0: minX,
    y0: minY,
    x1: maxX,
    y1: maxY
  };
}

function pageGeomToLocal(pageGeom) {
  if (!pageGeom) {
    return null;
  }
  return {
    x0: 0,
    y0: 0,
    x1: Math.max(1, Math.abs(pageGeom.x1 - pageGeom.x0)),
    y1: Math.max(1, Math.abs(pageGeom.y1 - pageGeom.y0))
  };
}

function rectCenterInGeom(rect, geom) {
  var rx0 = Math.min(rect.x0, rect.x1);
  var rx1 = Math.max(rect.x0, rect.x1);
  var ry0 = Math.min(rect.y0, rect.y1);
  var ry1 = Math.max(rect.y0, rect.y1);
  var cx = (rx0 + rx1) / 2;
  var cy = (ry0 + ry1) / 2;
  var gx0 = Math.min(geom.x0, geom.x1);
  var gx1 = Math.max(geom.x0, geom.x1);
  var gy0 = Math.min(geom.y0, geom.y1);
  var gy1 = Math.max(geom.y0, geom.y1);
  var pad = 1;

  return cx >= gx0 - pad && cx <= gx1 + pad && cy >= gy0 - pad && cy <= gy1 + pad;
}

function rectCenterInsideRatio(rectRows, geom) {
  var inside = 0;
  var i;
  if (!geom || !rectRows || rectRows.length === 0) {
    return 0;
  }
  for (i = 0; i < rectRows.length; i += 1) {
    if (rectCenterInGeom(rectRows[i].rect, geom)) {
      inside += 1;
    }
  }
  return inside / rectRows.length;
}

function normalizePageGeomForRects(pageGeom, rectRows) {
  var local;
  var rawRatio;
  var localRatio;
  if (!pageGeom) {
    return { geom: null, mode: "none" };
  }
  local = pageGeomToLocal(pageGeom);
  rawRatio = rectCenterInsideRatio(rectRows, pageGeom);
  localRatio = rectCenterInsideRatio(rectRows, local);

  // If local coords explain rect centers much better, exported page geometry
  // likely used spread offsets while line rects are page-local.
  if (localRatio >= 0.75 && localRatio >= rawRatio + 0.30) {
    return { geom: local, mode: "page-local" };
  }
  return { geom: pageGeom, mode: "page" };
}

function resolveHotspotDomain(pageGeom, contentBounds, rectCount) {
  let pageW;
  let pageH;
  let contentW;
  let contentH;
  let widthRatio;
  let heightRatio;
  let pageCx;
  let pageCy;
  let contentCx;
  let contentCy;
  let centerDx;
  let centerDy;
  let looksShrunkCentered;

  if (!pageGeom) {
    return contentBounds;
  }
  if (!contentBounds) {
    return pageGeom;
  }

  pageW = Math.max(1, Math.abs(pageGeom.x1 - pageGeom.x0));
  pageH = Math.max(1, Math.abs(pageGeom.y1 - pageGeom.y0));
  contentW = Math.max(1, Math.abs(contentBounds.x1 - contentBounds.x0));
  contentH = Math.max(1, Math.abs(contentBounds.y1 - contentBounds.y0));
  widthRatio = contentW / pageW;
  heightRatio = contentH / pageH;

  pageCx = (pageGeom.x0 + pageGeom.x1) / 2;
  pageCy = (pageGeom.y0 + pageGeom.y1) / 2;
  contentCx = (contentBounds.x0 + contentBounds.x1) / 2;
  contentCy = (contentBounds.y0 + contentBounds.y1) / 2;
  centerDx = Math.abs(contentCx - pageCx) / pageW;
  centerDy = Math.abs(contentCy - pageCy) / pageH;

  // Heuristic for the "all hotspots shrunk to center" case.
  looksShrunkCentered =
    rectCount >= 6 &&
    widthRatio < 0.62 &&
    heightRatio < 0.62 &&
    centerDx < 0.22 &&
    centerDy < 0.22;

  if (looksShrunkCentered) {
    return contentBounds;
  }
  return pageGeom;
}

function applyHotspotDebugTransform(left, top, right, bottom, viewBox) {
  let outLeft = left;
  let outTop = top;
  let outRight = right;
  let outBottom = bottom;

  outLeft = clamp(outLeft, 0, viewBox.width);
  outRight = clamp(outRight, 0, viewBox.width);
  outTop = clamp(outTop, 0, viewBox.height);
  outBottom = clamp(outBottom, 0, viewBox.height);
  if (outRight <= outLeft || outBottom <= outTop) {
    return null;
  }
  return {
    left: outLeft,
    top: outTop,
    right: outRight,
    bottom: outBottom
  };
}

function appendHotspotDiv(row, box) {
  const pad = 2;
  const ownerTid = getHotspotOwnerTid(row && row.tid);
  const tr = row && row.tid ? state.translationsByTid[row.tid] : null;
  const seg = row && row.tid ? state.segmentByTid[row.tid] : null;
  const statusClass = statusClassForRow(seg, tr);
  const downEventName = getPrimaryPointerDownEventName();
  const div = document.createElement("div");
  div.className = "hotspot " + statusClass + (isSameHotspotGroupTid(row.tid, state.selectedTid) ? " selected" : "");
  div.setAttribute("data-hotspot-owner", ownerTid);
  div.style.left = px(Math.max(0, box.left - pad));
  div.style.top = px(Math.max(0, box.top - pad));
  div.style.width = px(Math.max(1, (box.right - box.left) + (pad * 2)));
  div.style.height = px(Math.max(1, (box.bottom - box.top) + (pad * 2)));
  div.title = row.tid;
  // Prefer the paragraph's actual pointSize over the line_rect height, which
  // uses ascent+descent and exceeds pointSize for many fonts.
  let srcLineH = box.singleLineH;
  let _minLrH = 0, _scaleRatio = 1, _hasPointSize = false;
  if (seg && typeof seg.point_size === "number" && seg.point_size > 0 &&
      Array.isArray(seg.line_rects) && seg.line_rects.length > 0) {
    for (let lri = 0; lri < seg.line_rects.length; lri++) {
      const lh = Math.abs(seg.line_rects[lri].y1 - seg.line_rects[lri].y0);
      if (lh > 0 && (_minLrH === 0 || lh < _minLrH)) _minLrH = lh;
    }
    if (_minLrH > 0) {
      _scaleRatio = seg.point_size / _minLrH;
      srcLineH = box.singleLineH * _scaleRatio;
      _hasPointSize = true;
    }
  }
  if (srcLineH > 0) div.setAttribute("data-src-line-h", String(srcLineH));
  // Phase 5A: per-segment line-height from source leading. Inline style overrides
  // the CSS fallback (1.2) so each hotspot renders at its paragraph's actual
  // leading. Value is a unitless multiplier.
  const _lineHMult = resolveLeadingMultiplier(seg);
  const _leadingSrc = leadingSource(seg);
  if (state.fontDebug) {
    logFontSizeDebug({
      src: "hotspot_build",
      tid: row.tid,
      hasPointSize: _hasPointSize,
      point_size_pt: seg && typeof seg.point_size === "number" ? seg.point_size : null,
      leading_source: _leadingSrc,
      leading_mult: +_lineHMult.toFixed(3),
      leading_pt: seg && typeof seg.leading_pt === "number" ? seg.leading_pt : null,
      leading_ratio: seg && typeof seg.leading_ratio === "number" ? seg.leading_ratio : null,
      minLrH_pt: +_minLrH.toFixed(2),
      scaleRatio: +_scaleRatio.toFixed(3),
      boxSingleLineH_cssPx: +box.singleLineH.toFixed(2),
      finalSrcLineH_cssPx: +srcLineH.toFixed(2),
      lineRectCount: seg && Array.isArray(seg.line_rects) ? seg.line_rects.length : 0
    });
  }
  const content = hotspotTextContent(ownerTid);
  if (content.hasText) {
    const textEl = document.createElement("span");
    textEl.className = "hotspot-text";
    // Phase 5A: per-hotspot line-height overrides CSS fallback
    textEl.style.lineHeight = String(_lineHMult);
    if (content.isHtml) {
      textEl.innerHTML = content.html;
    } else {
      textEl.textContent = content.text;
    }
    div.appendChild(textEl);
    div.classList.add("has-text");
  }
  div.addEventListener(downEventName, (ev) => {
    const ownerTid = getHotspotOwnerTid(row.tid);
    if (!isPrimaryPointerDownEvent(ev)) {
      return;
    }
    if (ev && typeof ev.preventDefault === "function") {
      ev.preventDefault();
    }
    if (ev && typeof ev.stopPropagation === "function") {
      ev.stopPropagation();
    }
    setActiveTab("segments");
    selectSegment(ownerTid, false, { scrollInPane: true });
    if (!focusTargetForTid(ownerTid)) {
      requestAnimationFrame(() => {
        focusTargetForTid(ownerTid);
      });
    }
  });
  els.hotspotLayer.appendChild(div);
}

function mergeHotspotBoxByTid(mergedByTid, mergedOrder, row, box) {
  const ownerTid = row && row.tid ? getHotspotOwnerTid(String(row.tid)) : "";
  let m;
  if (!ownerTid || !box) {
    return;
  }
  var lineH = Math.abs(box.bottom - box.top);
  m = mergedByTid[ownerTid];
  if (!m) {
    mergedByTid[ownerTid] = {
      tid: ownerTid,
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      singleLineH: lineH
    };
    mergedOrder.push(ownerTid);
    return;
  }
  m.left = Math.min(m.left, box.left);
  m.top = Math.min(m.top, box.top);
  m.right = Math.max(m.right, box.right);
  m.bottom = Math.max(m.bottom, box.bottom);
  if (lineH > 0 && (m.singleLineH <= 0 || lineH < m.singleLineH)) m.singleLineH = lineH;
}

function appendAiHotspotDiv(item, box) {
  const pad = 2;
  const taskId = safeStr(item && item.task_id);
  const assetName = safeStr(item && item.asset_name);
  const downEventName = getPrimaryPointerDownEventName();
  const div = document.createElement("div");
  div.className = "hotspot ai-hotspot" + (taskId && taskId === state.selectedAiTaskId ? " selected" : "");
  div.setAttribute("data-ai-task-id", taskId);
  div.style.left = px(Math.max(0, box.left - pad));
  div.style.top = px(Math.max(0, box.top - pad));
  div.style.width = px(Math.max(1, (box.right - box.left) + (pad * 2)));
  div.style.height = px(Math.max(1, (box.bottom - box.top) + (pad * 2)));
  div.title = assetName || taskId || "AI handoff";
  div.addEventListener(downEventName, (ev) => {
    if (!isPrimaryPointerDownEvent(ev)) {
      return;
    }
    if (ev && typeof ev.preventDefault === "function") {
      ev.preventDefault();
    }
    if (ev && typeof ev.stopPropagation === "function") {
      ev.stopPropagation();
    }
    setActiveTab("ai");
    selectAiItem(taskId, false, { scrollInPane: true });
  });
  els.hotspotLayer.appendChild(div);
}

function renderAiHotspots(page, viewBox) {
  let i;
  let item;
  let nr;
  let nx0;
  let nx1;
  let ny0;
  let ny1;
  let box;
  for (i = 0; i < state.aiItems.length; i += 1) {
    item = state.aiItems[i];
    if (!item || Number(item.page_index) !== page || !item.placed_bounds_norm) {
      continue;
    }
    nr = item.placed_bounds_norm;
    nx0 = clamp(Math.min(toNumber(nr.nx0), toNumber(nr.nx1)), 0, 1);
    nx1 = clamp(Math.max(toNumber(nr.nx0), toNumber(nr.nx1)), 0, 1);
    ny0 = clamp(Math.min(toNumber(nr.ny0), toNumber(nr.ny1)), 0, 1);
    ny1 = clamp(Math.max(toNumber(nr.ny0), toNumber(nr.ny1)), 0, 1);
    if (!Number.isFinite(nx0) || !Number.isFinite(nx1) || !Number.isFinite(ny0) || !Number.isFinite(ny1)) {
      continue;
    }
    box = applyHotspotDebugTransform(
      nx0 * viewBox.width,
      ny0 * viewBox.height,
      nx1 * viewBox.width,
      ny1 * viewBox.height,
      viewBox
    );
    if (!box) {
      continue;
    }
    appendAiHotspotDiv(item, box);
  }
}

function renderHotspots() {
  const page = state.currentPage;
  let normRows;
  let legacyRows;
  let mergedByTid;
  let mergedOrder;
  let i;
  let row;
  let box;
  els.hotspotLayer.innerHTML = "";
  if (!isFiniteNumber(page)) {
    return;
  }
  const viewBox = state.pdfViewBox;
  if (!viewBox) {
    return;
  }
  const rectRows = collectPageRectRows(page);

  normRows = [];
  legacyRows = [];
  mergedByTid = {};
  mergedOrder = [];
  for (i = 0; i < rectRows.length; i += 1) {
    row = rectRows[i];
    if (row && row.norm_rect) {
      normRows.push(row);
    } else if (row && row.rect) {
      legacyRows.push(row);
    }
  }

  if (normRows.length > 0) {
    for (i = 0; i < normRows.length; i += 1) {
      row = normRows[i];
      const nr = row.norm_rect;
      if (!nr) {
        continue;
      }
      const nx0 = clamp(Math.min(nr.nx0, nr.nx1), 0, 1);
      const nx1 = clamp(Math.max(nr.nx0, nr.nx1), 0, 1);
      const ny0 = clamp(Math.min(nr.ny0, nr.ny1), 0, 1);
      const ny1 = clamp(Math.max(nr.ny0, nr.ny1), 0, 1);
      if (!Number.isFinite(nx0) || !Number.isFinite(nx1) || !Number.isFinite(ny0) || !Number.isFinite(ny1)) {
        continue;
      }
      box = applyHotspotDebugTransform(
        nx0 * viewBox.width,
        ny0 * viewBox.height,
        nx1 * viewBox.width,
        ny1 * viewBox.height,
        viewBox
      );
      if (!box) {
        continue;
      }
      mergeHotspotBoxByTid(mergedByTid, mergedOrder, row, box);
    }
  }

  if (legacyRows.length > 0) {
    const pageGeom = state.pageGeometryByIndex[page];
    const normPage = normalizePageGeomForRects(pageGeom, legacyRows);
    const normalizedPageGeom = normPage.geom;
    const contentBounds = boundsFromRectRows(legacyRows);
    const geom = resolveHotspotDomain(normalizedPageGeom, contentBounds, legacyRows.length);
    const pageW = geom ? Math.max(1, Math.abs(geom.x1 - geom.x0)) : 0;
    const pageH = geom ? Math.max(1, Math.abs(geom.y1 - geom.y0)) : 0;

    for (i = 0; i < legacyRows.length; i += 1) {
      row = legacyRows[i];
      if (!geom || !row || !row.rect) {
        continue;
      }
    const rx0 = Math.min(row.rect.x0, row.rect.x1);
    const rx1 = Math.max(row.rect.x0, row.rect.x1);
    const ry0 = Math.min(row.rect.y0, row.rect.y1);
    const ry1 = Math.max(row.rect.y0, row.rect.y1);
    if (!Number.isFinite(rx0) || !Number.isFinite(rx1) || !Number.isFinite(ry0) || !Number.isFinite(ry1)) {
        continue;
    }

      box = applyHotspotDebugTransform(
        ((rx0 - geom.x0) / pageW) * viewBox.width,
        ((ry0 - geom.y0) / pageH) * viewBox.height,
        ((rx1 - geom.x0) / pageW) * viewBox.width,
        ((ry1 - geom.y0) / pageH) * viewBox.height,
        viewBox
      );
      if (!box) {
        continue;
      }
      mergeHotspotBoxByTid(mergedByTid, mergedOrder, row, box);
    }
  }
  for (i = 0; i < mergedOrder.length; i += 1) {
    row = mergedByTid[mergedOrder[i]];
    appendHotspotDiv(row, row);
  }
  renderAiHotspots(page, viewBox);
  renderManualHotspots(page, viewBox);
  // Phase 7-SC: fit overlay text via DOM measurement module (with Phase 5
  // fallback inside). Async; we don't await — by next frame fonts are
  // typically ready and measurements complete before user notices.
  requestAnimationFrame(() => {
    els.hotspotLayer.querySelectorAll(".hotspot-text").forEach(fitHotspotTextViaDOM);
  });
  renderPageControls();
}

function renderAiList() {
  els.aiSummary.textContent = `AI handoff rows: ${state.aiItems.length}`;
  if (state.aiItems.length === 0) {
    els.aiList.innerHTML = '<div class="muted" style="padding:10px;">No AI handoff rows marked in this package.</div>';
    return;
  }

  const html = state.aiItems.map((it, idx) => `
    <div class="ai-item${safeStr(it.task_id) === state.selectedAiTaskId ? " selected" : ""}" data-index="${idx}" data-task-id="${escapeHtmlText(it.task_id)}">
      <div class="ai-top">
        <span>${escapeHtmlText(it.task_id)} · P${escapeHtmlText(it.page || "?")}</span>
        <span>${escapeHtmlText(it.link_state || "")}</span>
      </div>
      <div class="ai-asset">${escapeHtmlText(it.asset_name || "(no asset name)")}</div>
      <div class="ai-source">${escapeHtmlText(oneLine(it.recoverability || ""))}</div>
      <div class="ai-source">${escapeHtmlText(oneLine(it.source_text || "[MANUAL_CAPTURE]"))}</div>
      <textarea class="ai-target" data-target-index="${idx}" placeholder="Manual target text...">${escapeHtmlText(it.target_text || "")}</textarea>
    </div>
  `).join("");

  els.aiList.innerHTML = html;
  els.aiList.querySelectorAll(".ai-item").forEach(row => {
    row.addEventListener("click", (ev) => {
      const taskId = row.getAttribute("data-task-id");
      if (!taskId) {
        return;
      }
      if (ev && ev.target && typeof ev.target.closest === "function" && ev.target.closest("textarea.ai-target")) {
        return;
      }
      setActiveTab("ai");
      selectAiItem(taskId, true, { scrollInPane: true });
    });
  });
  els.aiList.querySelectorAll("textarea.ai-target").forEach(area => {
    area.addEventListener("input", () => {
      const idx = Number(area.getAttribute("data-target-index"));
      if (!isFiniteNumber(idx) || !state.aiItems[idx]) {
        return;
      }
      state.aiItems[idx].target_text = area.value;
      state.aiItems[idx].status = area.value.trim() ? "translated_manual" : "todo_manual";
    });
  });
}

function onSaveAll() {
  try {
    const out = buildTranslationsOutput();
    const translations = out.payload;
    const qcText = buildControlTokenQaText(out.qa_rows);
    const aiText = buildAiHandoffText();
    var p1 = downloadFile("translations.json", JSON.stringify(translations, null, 2), "application/json;charset=utf-8");
    var p2 = downloadFile("translation_qc_report.txt", qcText, "text/plain;charset=utf-8");
    var p3 = downloadFile("ai_manual_handoff.txt", aiText, "text/plain;charset=utf-8");
    els.saveAllBtn.disabled = true;
    Promise.all([p1, p2, p3]).then(function (results) {
      var allServer = results.every(function (r) { return r === "server"; });
      var allBrowser = results.every(function (r) { return r === "browser"; });
      var saveMode;
      if (allServer) {
        saveMode = "Written to: " + localServer.packageDirPath;
      } else if (allBrowser) {
        saveMode = "Downloaded to browser";
      } else {
        saveMode = "Partially written to disk; some files fell back to browser download";
      }
      alert("Saved outputs (" + saveMode + "):\n- translations.json\n- translation_qc_report.txt\n- ai_manual_handoff.txt");
    }).catch(function (err) {
      console.error(err);
      alert("Save failed: " + err.message);
    }).then(function () {
      els.saveAllBtn.disabled = false;
    });
  } catch (err) {
    console.error(err);
    alert("Save failed: " + err.message);
    els.saveAllBtn.disabled = false;
  }
}

function installDevTranslateBridge() {
  if (typeof window === "undefined") {
    return;
  }
  window.TranslatorAppDevBridge = {
    version: "2026-02-24",
    isPackageLoaded: () => state.segments.length > 0,
    getPackageName: () => safeStr(state.packageName),
    getStatusText: () => safeStr(els.packageStatus && els.packageStatus.textContent),
    setStatusText: (text) => {
      if (!els.packageStatus) {
        return;
      }
      els.packageStatus.textContent = safeStr(text);
    },
    getRows: () => getDevTranslateRows(),
    applyRows: (rows, options) => applyDevTranslateRows(rows, options),
    refresh: () => refreshUiAfterDevTranslate()
  };
}

// For merge_head rows (manual merge OR soft-break merged), build the
// FULL merged source so the translation provider sees the whole grouped
// content — not just the head segment. Tails are locked and filtered out
// by dev_translate.filterCandidates, so they never get sent individually.
//
// The merge UX intent is "treat as one continuous text", so we join with
// a SPACE (not "\n"). Two reasons:
//   1. Google preserves "\n" in its output, which would write a forced
//      line break into the InDesign paragraph after writeback — user
//      wants a single line ("一段文本而不是多段文本").
//   2. Space gives Google enough word-boundary signal to translate the
//      pieces as one phrase yet keeps the result on a single line.
//
// The matching InDesign writeback expects `head.target_text` to be the
// FULL merged translation; v2 pipeline writes that into the paragraph and
// (with v2 Fix #4) skips merge_tail rows so the original tail source
// can't reappear.
function buildMergedSourceForTranslation(headSeg, headTid) {
  const headSource = safeStr(headSeg && headSeg.source_text);
  if (!headTid || typeof getMergeTailChainForHead !== "function") {
    return headSource;
  }
  const tailTids = getMergeTailChainForHead(headTid);
  if (!tailTids || tailTids.length === 0) {
    return headSource;
  }
  const parts = [headSource];
  for (let i = 0; i < tailTids.length; i += 1) {
    const tailSeg = state.segmentByTid[tailTids[i]];
    if (tailSeg) {
      parts.push(safeStr(tailSeg.source_text));
    }
  }
  return parts.join(" ");
}

function getDevTranslateRows() {
  return state.segments.map(seg => {
    const tid = safeStr(seg && seg.tid);
    const row = state.translationsByTid[tid] || null;
    let sourceText = safeStr(seg && seg.source_text);
    // Detect merge head: row exists, is NOT a tail itself, and has tails.
    const isMergeHead = !!(row && !isMergeTailRow(row) && hasMergeTailChildren(tid));
    if (isMergeHead) {
      sourceText = buildMergedSourceForTranslation(seg, tid);
    }
    return {
      tid: tid,
      source_text: sourceText,
      target_text: safeStr(row && row.target_text),
      status: safeStatus(row && row.status),
      display_status: displayStatusText(seg, row),
      paragraph_style: safeStr(seg && seg.paragraph_style),
      segment_kind: safeSegmentKind(seg && seg.segment_kind),
      page_index: Array.isArray(seg && seg.page_indexes) && seg.page_indexes.length > 0
        ? Number(seg.page_indexes[0])
        : -1,
      is_simple_text: !!(
        isWhitespaceOnlyText(sourceText) ||
        isPureNumberText(sourceText) ||
        isPurePunctuationText(sourceText)
      ),
      translatable: !isControlOnlySegment(seg),
      locked: !!(row && isRowSystemLocked(seg, row))
    };
  });
}

function applyDevTranslateRows(rows, options) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = options || {};
  const overwriteExisting = !!opts.overwriteExisting;
  const desiredStatus = safeStatus(opts.status || "translated");
  let i;
  let item;
  let tid;
  let target;
  let row;
  let seg;
  const stats = {
    requested: list.length,
    updated: 0,
    skipped_missing: 0,
    skipped_locked: 0,
    skipped_existing: 0,
    skipped_empty: 0
  };

  for (i = 0; i < list.length; i += 1) {
    item = list[i];
    tid = safeStr(item && item.tid);
    target = safeStr(item && item.target_text);
    row = state.translationsByTid[tid];
    seg = state.segmentByTid[tid];

    if (!tid || !row || !seg) {
      stats.skipped_missing += 1;
      continue;
    }
    if (isRowSystemLocked(seg, row)) {
      stats.skipped_locked += 1;
      continue;
    }
    if (!overwriteExisting && hasEffectiveTargetText(row.target_text)) {
      stats.skipped_existing += 1;
      continue;
    }
    if (!hasEffectiveTargetText(target)) {
      stats.skipped_empty += 1;
      continue;
    }

    // Defensive: for merge_head rows (manual or soft-break merged), force
    // the auto-translated target onto a single line. Even if the source
    // was joined with "\n" or Google preserved an internal newline, the
    // merge UX expects "一段文本而不是多段文本" — collapse all newlines
    // (LF, CR, U+2028 LINE SEPARATOR) into spaces.
    if (hasMergeTailChildren(tid)) {
      target = target.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
    }

    updateTargetText(tid, target, { fromUser: true });
    row = state.translationsByTid[tid];
    if (desiredStatus === "translated" || desiredStatus === "reviewed" || desiredStatus === "todo" || desiredStatus === "skip") {
      setRowStatus(tid, desiredStatus);
    }
    if (row) {
      row.target_auto_prefill = false;
    }
    stats.updated += 1;
  }

  if (opts.render !== false) {
    refreshUiAfterDevTranslate();
  }

  return stats;
}

function refreshUiAfterDevTranslate() {
  renderSegmentsPane();
  renderHotspots();
}

function buildTranslationsOutput() {
  const qaRows = [];
  const mergeHeadReady = {};
  Object.keys(state.translationsByTid).forEach(tid => {
    const row = state.translationsByTid[tid];
    const st = safeStatus(row && row.status);
    mergeHeadReady[tid] =
      !!row &&
      !isMergeTailRow(row) &&
      hasEffectiveTargetText(row.target_text) &&
      (st === "translated" || st === "reviewed");
  });
  const rows = state.segments.map(seg => {
    const tr = state.translationsByTid[seg.tid] || {};
    const isControlOnly = isControlOnlySegment(seg);
    const visibleTarget = safeStr(tr.target_text);
    const effectiveEmpty = isEffectiveEmptyTargetText(visibleTarget);
    const isTail = isMergeTailRow(tr);
    const tailHeadTid = safeStr(tr.merge_head_tid);
    const tailHeadReady = !!mergeHeadReady[tailHeadTid];
    const targetText = (effectiveEmpty || isTail || isControlOnly) ? "" : fromVisibleControlTokens(visibleTarget);
    const qa = (effectiveEmpty || isTail || isControlOnly) ? null : validateControlTokens(seg, visibleTarget);
    let outputStatus = safeStatus(tr.status);
    let outputMergeHeadTid = "";

    if (isControlOnly) {
      outputStatus = "skip";
    }
    if (isTail && !tailHeadReady) {
      outputStatus = "todo";
    }
    if (effectiveEmpty && outputStatus !== "skip" && outputStatus !== "merge_tail") {
      outputStatus = "todo";
    }
    if (outputStatus === "merge_tail" && tailHeadReady) {
      outputMergeHeadTid = tailHeadTid;
    }
    if (qa) {
      qaRows.push(qa);
    }
    const outRow = {
      tid: seg.tid,
      source_text: safeStr(seg.source_text_raw || seg.source_text || ""),
      target_text: targetText,
      status: outputStatus,
      merge_head_tid: outputMergeHeadTid,
      notes: safeStr(tr.notes)
    };
    if (tr.soft_break_unmerged) {
      outRow.soft_break_unmerged = true;
    }
    if (Array.isArray(tr.annotations) && tr.annotations.length > 0) {
      outRow.annotations = tr.annotations;
    }
    // Phase 8C: target_emphasis_runs persisted into translations.json for
    // import-side runMinimalApply to consume. Skipped for control-only /
    // empty-target rows since offsets won't align.
    if (Array.isArray(tr.target_emphasis_runs) && tr.target_emphasis_runs.length > 0
        && !isControlOnly && !effectiveEmpty && !isTail) {
      outRow.target_emphasis_runs = tr.target_emphasis_runs;
      if (tr.target_emphasis_runs_auto) outRow.target_emphasis_runs_auto = true;
    }
    return outRow;
  });
  const docName = safeStr(
    state.segmentsPayload &&
    state.segmentsPayload.document &&
    state.segmentsPayload.document.name
  );
  // Manual hotspots
  var mhOut = state.manualHotspots.map(function (it) {
    return {
      id: it.id,
      page_index: it.page_index,
      bounds_norm: {
        nx0: it.bounds_norm.nx0,
        ny0: it.bounds_norm.ny0,
        nx1: it.bounds_norm.nx1,
        ny1: it.bounds_norm.ny1
      },
      source_text: safeStr(it.source_text),
      target_text: safeStr(it.target_text),
      status: safeStr(it.status) || "todo",
      notes: safeStr(it.notes)
    };
  });

  return {
    payload: {
      schema_version: "translation-mvp-1",
      document_name: docName || state.packageName,
      // Per-package working state. Read on next package open to override
      // localStorage browser default — handoff-friendly so a QA reviewer
      // sees the same merge mode the original translator was using.
      card_options: {
        format_aware_soft_break_merge: !!state.formatAwareSoftBreakMerge
      },
      translations: rows,
      manual_hotspots: mhOut
    },
    qa_rows: qaRows
  };
}

function buildControlTokenQaText(qaRows) {
  const rows = Array.isArray(qaRows) ? qaRows : [];
  const lines = [];
  const now = new Date();
  const stamp = now.toISOString();

  lines.push("# control-token qc report");
  lines.push("generated_at\t" + stamp);
  lines.push("document_name\t" + safeStr(
    state.segmentsPayload &&
    state.segmentsPayload.document &&
    state.segmentsPayload.document.name
  ));
  lines.push("");

  if (rows.length === 0) {
    lines.push("status\tOK");
    lines.push("detail\tNo control token issues.");
    return lines.join("\n");
  }

  lines.push("status\tWARN");
  lines.push("issue_count\t" + String(rows.length));
  lines.push("");
  lines.push("tid\ttype\ttoken\trequired\tactual\tsource_preview\ttarget_preview");

  rows.forEach(row => {
    const issues = row && Array.isArray(row.issues) ? row.issues : [];
    if (issues.length === 0) {
      return;
    }
    issues.forEach(issue => {
      lines.push([
        tsvCell(row.tid),
        tsvCell(issue.type),
        tsvCell(issue.token),
        tsvCell(String(issue.required)),
        tsvCell(String(issue.actual)),
        tsvCell(oneLine(row.source_preview || "")),
        tsvCell(oneLine(row.target_preview || ""))
      ].join("\t"));
    });
  });

  return lines.join("\n");
}

function buildAiHandoffText() {
  const headers = [
    "task_id",
    "page",
    "page_index",
    "object_id",
    "graphic_id",
    "asset_name",
    "link_state",
    "link_status_raw",
    "link_needed_raw",
    "recoverability",
    "can_unembed",
    "link_path",
    "source_text",
    "target_text",
    "status",
    "note"
  ];
  const lines = [headers.join("\t")];
  state.aiItems.forEach(it => {
    lines.push([
      tsvCell(it.task_id),
      tsvCell(it.page),
      tsvCell(it.page_index),
      tsvCell(it.object_id),
      tsvCell(it.graphic_id),
      tsvCell(it.asset_name),
      tsvCell(it.link_state),
      tsvCell(it.link_status_raw),
      tsvCell(it.link_needed_raw),
      tsvCell(it.recoverability),
      tsvCell(String(!!it.can_unembed)),
      tsvCell(it.link_path),
      tsvCell(it.source_text || "[MANUAL_CAPTURE]"),
      tsvCell(it.target_text),
      tsvCell((it.target_text || "").trim() ? "translated_manual" : safeStr(it.status || "todo_manual")),
      tsvCell(it.note)
    ].join("\t"));
  });
  return lines.join("\n");
}

function downloadFile(filename, content, mimeType) {
  // When local server is available and we know the package dir, write directly.
  // Resolves to "server" on successful local write, "browser" on fallback.
  if (localServer.available && localServer.packageDirPath) {
    // #SEC9: Don't guess the path separator from the dir string. Send dir +
    // filename separately and let serve.js use path.join() (which knows the
    // platform). The legacy single-string form is gone — write-file accepts
    // {dir, name} as an alternative to {path} for client-supplied splits.
    return fetch(localServer.baseUrl + "/api/write-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: localServer.packageDirPath, name: filename, content: content })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) {
        console.log("[local-server] Written: " + (d.path || filename) + " (" + d.bytes + " bytes)");
        return "server";
      } else {
        console.error("[local-server] Write failed:", d);
        downloadFileFallback(filename, content, mimeType);
        return "browser";
      }
    }).catch(function (e) {
      console.error("[local-server] Write error:", e);
      downloadFileFallback(filename, content, mimeType);
      return "browser";
    });
  }
  downloadFileFallback(filename, content, mimeType);
  return Promise.resolve("browser");
}

function downloadFileFallback(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tsvCell(value) {
  return safeStr(value)
    .replace(/\t/g, " ")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\r/g, " ");
}

function safeStatus(status) {
  const s = safeStr(status).toLowerCase();
  if (s === "translated" || s === "reviewed" || s === "skip" || s === "todo" || s === "merge_tail") {
    return s;
  }
  return "todo";
}

function safeSegmentKind(kind) {
  const k = safeStr(kind).toLowerCase();
  if (k === "text" || k === "table_cell" || k === "table_anchor" || k === "control_anchor") {
    return k;
  }
  return "";
}

function safeTargetPolicy(policy) {
  const p = safeStr(policy).toLowerCase();
  if (p === "translate" || p === "preserve_source") {
    return p;
  }
  return "";
}

function safeEditorViewMode(mode) {
  const s = safeStr(mode).toLowerCase();
  if (s === "page_cards" || s === "classic") {
    return s;
  }
  return "page_cards";
}

function safeZoomPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return state && Number.isFinite(state.zoomPercent) ? state.zoomPercent : 100;
  }
  return clamp(Math.round(n), 25, 400);
}

function oneLine(text) {
  return safeStr(text).replace(/\s+/g, " ").trim();
}

function isWhitespaceCharCode(code) {
  return code === 9 || code === 10 || code === 13 || code === 32 || code === 160;
}

function isControlOnlyText(text) {
  const s = safeStr(text);
  let i;
  let code;
  let hasControl = false;
  for (i = 0; i < s.length; i += 1) {
    code = s.charCodeAt(i);
    if (isSpecialControlCharCode(code)) {
      hasControl = true;
      continue;
    }
    if (isWhitespaceCharCode(code)) {
      continue;
    }
    return false;
  }
  return hasControl;
}

function controlOnlyLabelForSourceText(text) {
  const tokens = extractVisibleControlTokens(text);
  if (tokens.length === 1 && tokens[0] === "[[CTRL_0016]]") {
    return "Table Anchor";
  }
  return "Control Anchor";
}

function isSystemAnchorSegment(seg) {
  return !!(
    seg &&
    (
      seg.translatable === false ||
      safeTargetPolicy(seg.target_policy) === "preserve_source" ||
      safeSegmentKind(seg.segment_kind) === "table_anchor" ||
      safeSegmentKind(seg.segment_kind) === "control_anchor"
    )
  );
}

function isControlOnlySegment(seg) {
  return isSystemAnchorSegment(seg) || !!(seg && seg.control_only);
}

function isRowSystemLocked(seg, row) {
  return isMergeTailRow(row) || isSystemAnchorSegment(seg);
}

function sourceTextForUi(seg) {
  if (!seg) {
    return "";
  }
  if (safeSegmentKind(seg.segment_kind) === "table_anchor") {
    return "Table Anchor";
  }
  if (safeSegmentKind(seg.segment_kind) === "control_anchor") {
    return "Control Anchor";
  }
  if (isSystemAnchorSegment(seg)) {
    return safeStr(seg.control_only_label || "Control Anchor");
  }
  return safeStr(seg.source_text || "");
}

function segmentContextLabel(seg) {
  const kind = safeSegmentKind(seg && seg.segment_kind);
  let tNum;
  let rowNum;
  let colNum;
  let paraIdx;
  let paraCount;
  if (kind !== "table_cell") {
    return "";
  }
  tNum = isFiniteNumber(seg && seg.table_index) ? (Number(seg.table_index) + 1) : null;
  rowNum = isFiniteNumber(seg && seg.cell_row) ? (Number(seg.cell_row) + 1) : null;
  colNum = isFiniteNumber(seg && seg.cell_col) ? (Number(seg.cell_col) + 1) : null;
  paraIdx = isFiniteNumber(seg && seg.cell_para_index) ? (Number(seg.cell_para_index) + 1) : null;
  paraCount = isFiniteNumber(seg && seg.cell_para_count) ? Number(seg.cell_para_count) : 0;

  if (tNum !== null && rowNum !== null && colNum !== null) {
    if (paraIdx !== null && paraCount > 1) {
      return "T" + String(tNum) + " R" + String(rowNum) + "C" + String(colNum) + " · P" + String(paraIdx) + "/" + String(paraCount);
    }
    return "T" + String(tNum) + " R" + String(rowNum) + "C" + String(colNum);
  }
  return "Table Cell";
}

function isMergeTailRow(row) {
  return !!(row && safeStatus(row.status) === "merge_tail");
}

function segmentHasControlTokens(seg) {
  const required = seg && seg.required_control_tokens;
  return !!(required && Object.keys(required).length > 0);
}

// SAFETY INVARIANT: merge_tail rows bypass the control-token check because
// isRowSystemLocked returns true for them. This is sound ONLY because the
// export path (see buildTranslationsPayload near line 4079) forces
// target_text = "" for any merge_tail row, regardless of what target_text
// the in-memory row carries. If that forcing is ever removed, this early-
// return becomes a hole — a tail row with arbitrary translator text would
// ship through the QA gate. Keep the export-side forcing and this bypass
// in sync; if either changes, audit the other.
function controlTokensAreValid(seg, row) {
  if (!seg || !row || isRowSystemLocked(seg, row)) {
    return true;
  }
  if (isEffectiveEmptyTargetText(row.target_text)) {
    return true;
  }
  return validateControlTokens(seg, row.target_text) === null;
}

function canSetReviewedStatus(seg, row) {
  if (!seg || !row || isRowSystemLocked(seg, row)) {
    return false;
  }
  if (!hasEffectiveTargetText(row.target_text)) {
    return false;
  }
  return controlTokensAreValid(seg, row);
}

function displayStatusText(seg, row) {
  if (isControlOnlySegment(seg)) {
    return "skip";
  }
  const status = safeStatus(row && row.status);
  if (status === "merge_tail") {
    return "merge_tail";
  }
  if ((status === "translated" || status === "reviewed") && !hasEffectiveTargetText(row && row.target_text)) {
    return "todo";
  }
  return status;
}

function statusClassFromStatus(status) {
  const s = safeStatus(status);
  if (s === "translated") {
    return "status-translated";
  }
  if (s === "reviewed") {
    return "status-reviewed";
  }
  if (s === "skip") {
    return "status-skip";
  }
  if (s === "merge_tail") {
    return "status-merge-tail";
  }
  return "status-todo";
}

function statusClassForRow(seg, row) {
  let cls = statusClassFromStatus(displayStatusText(seg, row));
  if (segmentHasControlTokens(seg)) {
    cls += " has-control";
  }
  if (!controlTokensAreValid(seg, row)) {
    cls += " token-warn";
  }
  return cls;
}

function isRowTranslatedLike(seg, row) {
  const status = displayStatusText(seg, row);
  if (status !== "translated" && status !== "reviewed") {
    return false;
  }
  return hasEffectiveTargetText(row && row.target_text);
}

function shouldShowResetForRow(seg, row) {
  if (!seg || !row || isRowSystemLocked(seg, row)) {
    return false;
  }
  if (safeStatus(row.status) === "reviewed") {
    return true;
  }
  return hasEffectiveTargetText(row.target_text);
}

function applyStatusClassTokens(el, statusClass) {
  const tokens = safeStr(statusClass).split(/\s+/).filter(Boolean);
  const classPool = [
    "status-todo",
    "status-translated",
    "status-reviewed",
    "status-skip",
    "status-merge-tail",
    "has-control",
    "token-warn"
  ];
  if (!el || !el.classList) {
    return;
  }
  classPool.forEach(cls => el.classList.remove(cls));
  tokens.forEach(cls => el.classList.add(cls));
}

function syncStatusPopoverForCard(card, seg, row) {
  const current = displayStatusText(seg, row);
  const isMergeHead = hasMergeTailChildren(seg && seg.tid);
  const isControlOnly = isControlOnlySegment(seg);
  if (!card || !row) {
    return;
  }
  card.querySelectorAll("[data-status-set]").forEach(btn => {
    const option = safeStr(btn.getAttribute("data-status-set"));
    const disabled =
      isControlOnly ||
      ((option === "todo" || option === "skip") && isMergeHead) ||
      (option === "translated" && !hasEffectiveTargetText(row.target_text)) ||
      (option === "reviewed" && !canSetReviewedStatus(seg, row));
    btn.disabled = !!disabled;
    btn.classList.toggle("active", current === option);
  });
}

function syncTokenHintForCard(card, seg, row) {
  let issue;
  let summary;
  let hasMissing;
  let hint;
  let summaryEl;
  let restoreBtn;
  if (!card || !seg || !row) {
    return;
  }
  hint = card.querySelector(".token-hint");
  if (!hint) {
    return;
  }
  issue = isEffectiveEmptyTargetText(row.target_text) ? null : validateControlTokens(seg, row.target_text);
  summary = issue ? formatControlTokenIssueSummary(issue) : "Control tokens present. Keep them in translation.";
  hasMissing = !!(issue && issue.issues && issue.issues.some(it => it && it.type === "missing_token"));
  hint.classList.toggle("warn", !!issue);
  hint.classList.toggle("ok", !issue);
  summaryEl = hint.querySelector("[data-token-summary]");
  if (summaryEl) {
    summaryEl.textContent = summary;
  }
  restoreBtn = hint.querySelector("[data-token-restore]");
  if (restoreBtn) {
    restoreBtn.classList.toggle("hidden", !hasMissing);
  }
}

function syncCardStatusUi(card, seg, row) {
  const statusClass = statusClassForRow(seg, row);
  const statusLabel = displayStatusText(seg, row);
  const showReset = shouldShowResetForRow(seg, row);
  const chip = card ? card.querySelector("[data-status-chip]") : null;
  const resetWrap = card ? card.querySelector("[data-reset-wrap]") : null;
  if (!card || !seg || !row) {
    return;
  }
  applyStatusClassTokens(card, statusClass);
  card.classList.toggle("done", isRowTranslatedLike(seg, row));
  if (chip) {
    chip.textContent = statusLabel;
    applyStatusClassTokens(chip, statusClass);
  }
  if (resetWrap) {
    resetWrap.classList.toggle("hidden", !showReset);
  }
  syncStatusPopoverForCard(card, seg, row);
  syncTokenHintForCard(card, seg, row);
}

function syncCardUiForTid(tid) {
  const tidStr = safeStr(tid);
  const seg = state.segmentByTid[tidStr];
  const row = state.translationsByTid[tidStr];
  const card = findCardByTid(tidStr);
  const area = card ? card.querySelector('.card-target[data-card-target="' + escapeCssAttr(tidStr) + '"]') : null;
  const isControlOnly = isControlOnlySegment(seg);
  const isLocked = isRowSystemLocked(seg, row);
  const tip = isControlOnly
    ? (safeStr(seg && seg.control_only_label || "Control Anchor") + " is preserved from source.")
    : "Merged tail row. Edit translation in the head card.";
  let requiresResize = false;
  if (!tidStr || !seg || !row || !card) {
    return false;
  }
  card.classList.toggle("system-anchor", isControlOnly);
  if (area) {
    if (area.value !== safeStr(row.target_text)) {
      area.value = safeStr(row.target_text);
      requiresResize = true;
    }
    if (area.disabled !== isLocked) {
      area.disabled = isLocked;
      requiresResize = true;
    }
    area.classList.toggle("locked", isLocked);
    area.placeholder = isControlOnly
      ? (safeStr(seg.control_only_label || "Control Anchor") + " is preserved from source.")
      : (isMergeTailRow(row)
          ? (seg && seg.soft_break_group ? "Soft-break tail \u2014 edit the head card above." : "Merged tail \u2014 edit the head card.")
          : "Enter translation...");
    area.title = isLocked ? tip : "";
    applyTargetInputVisualState(area, row);
    ensureTokenOverlayForTextarea(area);
    if (requiresResize) {
      autoResizeTextarea(area);
    } else {
      syncTokenOverlayForTextarea(area);
    }
  }
  syncCardStatusUi(card, seg, row);
  renderSegmentsSummaryFromCards();
  syncHotspotVisualForTid(tidStr);
  updateHotspotText(tidStr);
  return true;
}

function syncHotspotVisualForTid(tid) {
  const ownerTid = getHotspotOwnerTid(tid);
  const seg = state.segmentByTid[ownerTid];
  const row = state.translationsByTid[ownerTid];
  const statusClass = statusClassForRow(seg, row);
  els.hotspotLayer.querySelectorAll('[data-hotspot-owner="' + escapeCssAttr(ownerTid) + '"]').forEach(div => {
    applyStatusClassTokens(div, statusClass);
    div.classList.toggle("selected", isSameHotspotGroupTid(ownerTid, state.selectedTid));
  });
}

// ───────────────────────────────────────────────────────────────────────
// Phase 5A/5B — font-size and line-height convergence helpers
// ───────────────────────────────────────────────────────────────────────

// Shared fallback for per-line-height multiplier. Uses Noto Sans CJK's
// typoAscent (0.88) + typoDescent (0.32) = 1.2 so Preview and PDF converge
// on the SAME value when segments.json lacks leading_* fields (old packages).
const DEFAULT_LEADING_MULT = 1.2;

// Returns the per-line-height multiplier for a segment.
// Priority: explicit leading_pt (converted to ratio via point_size) →
// AUTO leading_ratio → DEFAULT_LEADING_MULT. Return value is unitless and
// used by both Preview (CSS `line-height`) and PDF (fitTextForPdf multiplier).
function resolveLeadingMultiplier(seg) {
  if (seg && typeof seg.leading_pt === "number" && seg.leading_pt > 0 &&
      typeof seg.point_size === "number" && seg.point_size > 0) {
    return seg.leading_pt / seg.point_size;
  }
  if (seg && typeof seg.leading_ratio === "number" && seg.leading_ratio > 0) {
    return seg.leading_ratio;
  }
  return DEFAULT_LEADING_MULT;
}

// Diagnostic source classifier for leading multiplier decisions.
function leadingSource(seg) {
  if (seg && typeof seg.leading_pt === "number" && seg.leading_pt > 0 &&
      typeof seg.point_size === "number" && seg.point_size > 0) return "explicit_pt";
  if (seg && typeof seg.leading_ratio === "number" && seg.leading_ratio > 0) return "auto_ratio";
  return "default";
}

// Phase 5 stub: always return ["NotoSansSC"]. Phase 6 will replace with a
// real FONT_REGISTRY lookup that maps target_lang → [primary, fallback...].
// The interface shape is stable so Phase 6 doesn't require call-site changes.
function familiesNeededForLang(targetLang) {
  // target_lang ignored in Phase 5 — only SC is embedded + validated.
  return ["NotoSansSC"];
}

/**
 * Preload the CJK fonts @font-face'd in styles.css so hotspot fit-measurements
 * use the real font (the same one jsPDF embeds). If preload happens after
 * initial render, re-run fitTextInBox on all hotspot texts to re-measure.
 */
function preloadHotspotFonts() {
  if (!document.fonts || typeof document.fonts.load !== "function") return;
  const targetLang = (state.segmentsPayload && state.segmentsPayload.document &&
                      state.segmentsPayload.document.target_lang) || "zh-CN";
  const families = familiesNeededForLang(targetLang);
  const promises = [];
  families.forEach(f => {
    promises.push(document.fonts.load('400 14px "' + f + '"'));
    promises.push(document.fonts.load('700 14px "' + f + '"'));
  });
  Promise.all(promises).then(() => {
    if (!els.hotspotLayer) return;
    // Phase 7-SC: re-fit via DOM measurement module (Phase 5 fallback inside).
    els.hotspotLayer.querySelectorAll(".hotspot-text").forEach(fitHotspotTextViaDOM);
  }).catch(() => { /* font load failure is non-fatal; fall back to sans-serif */ });
}

function fitTextInBox(el) {
  if (!el || !el.parentElement) return;
  const boxH = el.parentElement.clientHeight;
  const boxW = el.parentElement.clientWidth;
  if (boxH < 1 || boxW < 1) return;
  // Cap at source line height if available, otherwise fill the box.
  var srcLineH = parseFloat(el.parentElement.getAttribute("data-src-line-h"));
  let earlyExit = false;
  let finalFontSize;
  let hi = srcLineH > 0 ? Math.min(srcLineH, boxH) : boxH;
  let lo = 0.5, mid;
  el.style.fontSize = hi + "px";
  if (el.scrollHeight <= boxH + 1) {
    finalFontSize = hi;
    earlyExit = true;
  } else {
    while (hi - lo > 0.3) {
      mid = (lo + hi) / 2;
      el.style.fontSize = mid + "px";
      if (el.scrollHeight > boxH + 1) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    el.style.fontSize = lo + "px";
    finalFontSize = lo;
  }
  if (state.fontDebug) {
    const owner = el.parentElement.getAttribute("data-hotspot-owner") || "?";
    // Phase 5.7 data-collection: the inline style.lineHeight is the unitless
    // leading multiplier set by resolveLeadingMultiplier().
    const lineHMultCss = parseFloat(el.style.lineHeight) || 0;
    // True line count via Range.getClientRects() — one rect per rendered visual
    // line. Using scrollHeight here over-counts because .hotspot-text has
    // `position: absolute; inset: 0; overflow: hidden`, so scrollHeight equals
    // the parent's clientHeight even when text occupies only one line.
    let lineCount = 0;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      lineCount = range.getClientRects().length;
    } catch (e) {}
    logFontSizeDebug({
      src: "preview",
      tid: owner,
      text: (el.textContent || "").slice(0, 20),
      boxW: +boxW.toFixed(2),
      boxH: +boxH.toFixed(2),
      srcLineH: srcLineH > 0 ? +srcLineH.toFixed(2) : null,
      hi: +hi.toFixed(2),
      fontSize: +finalFontSize.toFixed(2),
      lineHMultCss: +lineHMultCss.toFixed(3),
      lineCount: lineCount,
      earlyExit: earlyExit,
      scrollHeight: el.scrollHeight
    });
  }
}

/**
 * Phase 7-SC: Preview-side font fitting via the same DOM measurement module
 * the PDF export uses. On skipped > 0 (rare, only when Range API can't measure
 * a grapheme), falls back to Phase 5's fitTextInBox so we never silently drop
 * characters from the preview.
 *
 * Async because measureTextLayoutViaDOM awaits document.fonts.ready.
 */
async function fitHotspotTextViaDOM(el) {
  if (!el || !el.parentElement) return;
  // Phase 7-SC Preview path is opt-in (off by default). The PDF side keeps
  // using Phase 7. Preview is parked on Phase 5 fitTextInBox until the
  // measurement-vs-render disagreement is fully sorted out, so we don't keep
  // regressing the visible webapp while iterating on PDF.
  // Re-enable in console with: state.phase7PreviewEnabled = true
  if (!state.phase7PreviewEnabled) {
    fitTextInBox(el);
    return;
  }
  if (!window.DomTextMeasure) {
    fitTextInBox(el);
    return;
  }
  const parent = el.parentElement;
  const boxH_cssPx = parent.clientHeight;
  const boxW_cssPx = parent.clientWidth;
  if (boxH_cssPx < 1 || boxW_cssPx < 1) return;

  const ownerTid = parent.getAttribute("data-hotspot-owner") || "";
  const seg = ownerTid && state.segmentByTid ? state.segmentByTid[ownerTid] : null;
  const lineHMult = resolveLeadingMultiplier(seg);
  const targetLang = (state.segmentsPayload && state.segmentsPayload.document &&
                      state.segmentsPayload.document.target_lang) || "zh-CN";
  const fontFamilyStack = window.DomTextMeasure.getFontFamilyStack(targetLang);

  // Phase 7-SC: Preview measures in CSS px (the unit it actually renders in).
  // PDF measures in pt. Each side matches its own rendering context.
  // Convergence between Preview and PDF is by SAME CHARS PER LINE
  // (proportional), not by identical numeric inputs:
  //   Preview chars/line = boxW_cssPx / fontSize_cssPx
  //                      = (boxW_pt × cssPxPerPt) / (fontSize_pt × cssPxPerPt)
  //                      = boxW_pt / fontSize_pt
  //                      = PDF chars/line  ✓
  // Earlier attempt (passing boxW_pt as if px) made measurement element
  // wider than actual rendering, causing measurement to wrap to fewer lines
  // than the real preview span — text then overflowed at render time.
  const cssPxPerPt = (state.cssPxPerPt && state.cssPxPerPt > 0) ? state.cssPxPerPt : (96 / 72);
  // maxFontSize: convert source point_size (pt) to CSS px equivalent.
  let maxFontSize_pt = 0;
  if (seg && typeof seg.point_size === "number" && seg.point_size > 0) {
    maxFontSize_pt = seg.point_size;
  } else if (seg && Array.isArray(seg.line_rects) && seg.line_rects.length > 0) {
    for (const lr of seg.line_rects) {
      const lh = Math.abs(lr.y1 - lr.y0);
      if (lh > 0 && (maxFontSize_pt === 0 || lh < maxFontSize_pt)) maxFontSize_pt = lh;
    }
  }
  // Pass everything in CSS px so measurement element matches real render width.
  const boxW_measure = boxW_cssPx;
  const boxH_measure = boxH_cssPx;
  // Phase 7-SC visual scale (TEMP placeholder; same as PDF call site).
  const cjkScale = (typeof state.cjkVisualScale === "number" && state.cjkVisualScale > 0) ? state.cjkVisualScale : 1;
  const maxFontSize_measure = (maxFontSize_pt > 0 ? maxFontSize_pt * cssPxPerPt : boxH_cssPx) * cjkScale;

  // Hide while measuring to avoid flash at wrong size.
  const prevVisibility = el.style.visibility;
  el.style.visibility = "hidden";
  try {
    const layout = await window.DomTextMeasure.measureTextLayoutViaDOM(
      el.textContent || "", boxW_measure, boxH_measure, lineHMult, maxFontSize_measure, fontFamilyStack, targetLang
    );
    if (layout.skipped > 0) {
      // Safety-valve fallback (do not delete fitTextInBox — see Phase 7 注意 3).
      if (!state.phase7SkippedSegments) state.phase7SkippedSegments = [];
      state.phase7SkippedSegments.push({
        tid: ownerTid, where: "preview", skipped: layout.skipped, sample: layout.skippedGraphemes
      });
      fitTextInBox(el);
    } else {
      // layout.fontSize is in CSS px (since we passed CSS px inputs); apply directly.
      el.style.fontFamily = fontFamilyStack;
      el.style.fontSize = layout.fontSize + "px";
      el.style.lineHeight = String(lineHMult);
      if (state.fontDebug) {
        // Compute pt-equivalent for cross-mode comparison with PDF's pt fontSize.
        const fontSize_pt_equiv = layout.fontSize / cssPxPerPt;
        logFontSizeDebug({
          src: "dom_measure",
          tid: ownerTid,
          where: "preview",
          text: (el.textContent || "").slice(0, 20),
          boxW_cssPx: +boxW_measure.toFixed(2),
          boxH_cssPx: +boxH_measure.toFixed(2),
          maxFontSize_cssPx: +maxFontSize_measure.toFixed(2),
          cjkVisualScale: +cjkScale.toFixed(3),
          cssPxPerPt: +cssPxPerPt.toFixed(3),
          fontSize_cssPx: +layout.fontSize.toFixed(2),
          fontSize_pt_equiv: +fontSize_pt_equiv.toFixed(2),
          ascentPt: +layout.ascentPt.toFixed(2),
          metricsSource: layout.metricsSource,
          lineCount: layout.lines.length,
          lineHMult: +lineHMult.toFixed(3)
        });
      }
    }
  } catch (e) {
    if (!state.phase7SkippedSegments) state.phase7SkippedSegments = [];
    state.phase7SkippedSegments.push({
      tid: ownerTid, where: "preview", error: e && e.message ? e.message : "unknown"
    });
    fitTextInBox(el);
  } finally {
    el.style.visibility = prevVisibility || "";
  }
}

/**
 * Diagnostic: log a font-size decision per hotspot. Toggle on via console:
 *   state.fontDebug = true
 * Then re-render (page change, reload package, export PDF).
 * Rows are also pushed to state.fontDebugLog for inspection/copy.
 */
function logFontSizeDebug(row) {
  if (!state.fontDebugLog) state.fontDebugLog = [];
  state.fontDebugLog.push(row);
  try { console.log("[fontDebug]", row); } catch (e) {}
}

/**
 * Build HTML string from target_text + format annotations.
 * All text is escaped; only our own tags are injected.
 * Returns plain escaped text when no format annotations apply.
 */
function buildAnnotatedHtml(text, annotations) {
  if (!text) return "";
  if (!Array.isArray(annotations) || annotations.length === 0) {
    return escapeHtmlText(text);
  }
  var formats = annotations.filter(function (a) {
    return a.type === "format" && typeof a.offset === "number" &&
      a.offset >= 0 && typeof a.length === "number" && a.length > 0 &&
      a.offset + a.length <= text.length;
  });
  if (formats.length === 0) return escapeHtmlText(text);

  // Collect unique boundary points
  var pointSet = {};
  pointSet[0] = true;
  pointSet[text.length] = true;
  formats.forEach(function (a) {
    pointSet[a.offset] = true;
    pointSet[a.offset + a.length] = true;
  });
  var points = Object.keys(pointSet).map(Number);
  points.sort(function (a, b) { return a - b; });

  var html = "";
  for (var i = 0; i < points.length - 1; i++) {
    var start = points[i];
    var end = points[i + 1];
    var chunk = escapeHtmlText(text.substring(start, end));

    // Wrap with tags for all active format annotations at this range
    for (var j = 0; j < formats.length; j++) {
      var a = formats[j];
      if (a.offset <= start && start < a.offset + a.length) {
        if (a.action === "bold")            chunk = "<b>" + chunk + "</b>";
        else if (a.action === "italic")     chunk = "<i>" + chunk + "</i>";
        else if (a.action === "superscript") chunk = "<sup>" + chunk + "</sup>";
        else if (a.action === "subscript")   chunk = "<sub>" + chunk + "</sub>";
        else if (a.action === "underline")   chunk = "<u>" + chunk + "</u>";
        else if (a.action === "strikethrough") chunk = "<s>" + chunk + "</s>";
        else if (a.action === "color" && a.color) {
          // #SEC-B: Validate the color value before splicing into inline
          // CSS. escapeHtmlAttr only handles HTML chars, not CSS syntax —
          // an attacker-controlled color like "red;background-image:url(
          // //x.evil/exfil)" would otherwise reach the CSS parser and leak
          // a DNS request. Drop the color span when not a strict hex form.
          if (isSafeCssColor(a.color)) {
            chunk = '<span style="color:' + escapeHtmlAttr(a.color) + '">' + chunk + "</span>";
          }
        }
        else if (a.action === "link" && a.url) {
          // #SEC-A: rel="noopener noreferrer" does NOT prevent the browser
          // from running href="javascript:...". The createAnnotation /
          // commitFormatPaintLink entry points already reject unsafe URLs,
          // but render-time is the last line of defense — legacy data
          // (older translations.json, hand-edited JSON, etc.) can still
          // carry one. Fall back to plain text (no anchor) when the URL
          // is not a safe protocol.
          if (isSafeUrl(a.url)) {
            chunk = '<a href="' + escapeHtmlAttr(a.url) +
                    '" target="_blank" rel="noopener noreferrer" class="ann-link" title="' + escapeHtmlAttr(a.url) + '">' +
                    chunk + '</a>';
          }
          // else: leave chunk as-is — the underline/color companion
          // annotations still render around it, but no <a> wrapper.
        }
        else if (a.action === "size" && a.size) {
          // #SEC-B: Number() coerces to a number, but NaN.toString() ===
          // "NaN" which would smuggle text into CSS. Guard with isFinite
          // + positive range; clamp to sane bounds while we're here.
          var sizePt = Number(a.size);
          if (Number.isFinite(sizePt) && sizePt > 0 && sizePt <= 999) {
            chunk = '<span style="font-size:' + sizePt + 'pt">' + chunk + "</span>";
          }
        }
      }
    }
    html += chunk;
  }
  return html;
}

function hotspotTextContent(tid) {
  const row = tid ? state.translationsByTid[tid] : null;
  if (!row) return { text: "", html: "", hasText: false, isHtml: false };
  // Don't show auto-prefilled source text as hotspot overlay.
  if (row.target_auto_prefill) return { text: "", html: "", hasText: false, isHtml: false };
  const target = safeStr(row.target_text);
  if (!target) return { text: "", html: "", hasText: false, isHtml: false };
  const annotations = Array.isArray(row.annotations) ? row.annotations : [];
  const hasFormats = annotations.some(function (a) { return a.type === "format"; });
  if (hasFormats) {
    return { text: target, html: buildAnnotatedHtml(target, annotations), hasText: true, isHtml: true };
  }
  return { text: target, html: "", hasText: true, isHtml: false };
}

function updateHotspotText(tid) {
  const ownerTid = getHotspotOwnerTid(tid);
  if (!ownerTid) return;
  const divs = els.hotspotLayer.querySelectorAll('[data-hotspot-owner="' + escapeCssAttr(ownerTid) + '"]');
  const content = hotspotTextContent(ownerTid);
  const seg = state.segmentByTid ? state.segmentByTid[ownerTid] : null;
  const lineHMult = resolveLeadingMultiplier(seg);
  divs.forEach(div => {
    let span = div.querySelector(".hotspot-text");
    if (content.hasText) {
      if (!span) {
        span = document.createElement("span");
        span.className = "hotspot-text";
        div.appendChild(span);
      }
      // Phase 5A: apply per-segment line-height (override CSS fallback)
      span.style.lineHeight = String(lineHMult);
      if (content.isHtml) {
        span.innerHTML = content.html;
      } else {
        // Always set textContent to clear any leftover innerHTML (e.g. after format removal)
        span.textContent = content.text;
      }
      div.classList.add("has-text");
      // Phase 7-SC: route through DOM measurement (Phase 5 fallback inside).
      fitHotspotTextViaDOM(span);
    } else {
      if (span) span.remove();
      div.classList.remove("has-text");
    }
  });
}

// ==================== Bulk Import (Paste Fill) ====================

/**
 * Return ordered list of writable TIDs starting from startTid (inclusive).
 * Skips control_only, merge_tail, and skip segments.
 */
function getWritableSegmentsFrom(startTid) {
  var found = false;
  var result = [];
  for (var i = 0; i < state.segments.length; i++) {
    var seg = state.segments[i];
    if (!found) {
      if (seg.tid === startTid) found = true;
      else continue;
    }
    if (isControlOnlySegment(seg)) continue;
    if (state.filterEmptySource && !safeStr(seg.source_text)) continue;
    var row = state.translationsByTid[seg.tid];
    if (isMergeTailRow(row)) continue;
    if (row && safeStatus(row.status) === "skip") continue;
    result.push(seg.tid);
  }
  return result;
}

function applyBulkImport(tidList, paragraphs) {
  var count = Math.min(tidList.length, paragraphs.length);
  for (var i = 0; i < count; i++) {
    var tid = tidList[i];
    var row = state.translationsByTid[tid];
    if (!row) continue;
    row.target_text = paragraphs[i];
    row.status = paragraphs[i].trim() ? "translated" : "todo";
    row.target_auto_prefill = false;
  }
  return count;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.substring(0, max - 1) + "\u2026";
}

function showBulkImportModal(startTid) {
  var existing = document.getElementById("bulkImportOverlay");
  if (existing) existing.remove();

  var writableTids = getWritableSegmentsFrom(startTid);
  // Pre-build source texts for preview.
  var sourceTexts = writableTids.map(function (tid) {
    var seg = state.segmentByTid[tid];
    return safeStr(seg && seg.source_text);
  });

  var overlay = document.createElement("div");
  overlay.id = "bulkImportOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);";

  var modal = document.createElement("div");
  modal.style.cssText = "background:var(--bg-primary,#fff);color:var(--text-primary,#222);border-radius:8px;padding:20px;width:700px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);";

  var title = document.createElement("div");
  title.style.cssText = "font-weight:600;font-size:15px;margin-bottom:8px;";
  title.textContent = "Paste Fill from \"" + startTid + "\"";

  var hint = document.createElement("div");
  hint.style.cssText = "font-size:12px;color:var(--text-muted,#888);margin-bottom:10px;";
  hint.textContent = "Paste multi-paragraph text below. Each line fills one segment sequentially. " + writableTids.length + " writable segments available.";

  var area = document.createElement("textarea");
  area.style.cssText = "min-height:120px;resize:vertical;font-size:13px;padding:8px;border:1px solid var(--border,#ccc);border-radius:4px;background:var(--bg-secondary,#f8f8f8);color:inherit;font-family:inherit;";
  area.placeholder = "Paste translated paragraphs here, one per line...";

  // Preview table container.
  var previewWrap = document.createElement("div");
  previewWrap.style.cssText = "margin-top:8px;max-height:220px;overflow-y:auto;border:1px solid var(--border,#ccc);border-radius:4px;font-size:12px;";

  var previewTable = document.createElement("table");
  previewTable.style.cssText = "width:100%;border-collapse:collapse;";

  // Table header.
  var thead = document.createElement("thead");
  thead.innerHTML = '<tr style="position:sticky;top:0;background:var(--bg-secondary,#f0f0f0);z-index:1;">' +
    '<th style="padding:4px 6px;text-align:left;width:30px;border-bottom:1px solid var(--border,#ccc);">#</th>' +
    '<th style="padding:4px 6px;text-align:left;width:45%;border-bottom:1px solid var(--border,#ccc);">Source</th>' +
    '<th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border,#ccc);">Target (pasted)</th>' +
    '</tr>';
  previewTable.appendChild(thead);

  var tbody = document.createElement("tbody");
  previewTable.appendChild(tbody);
  previewWrap.appendChild(previewTable);

  function rebuildPreview() {
    var lines = area.value.split("\n").filter(function (l) { return l.trim().length > 0; });
    var maxRows = Math.max(lines.length, Math.min(writableTids.length, lines.length + 3));
    var html = "";
    for (var i = 0; i < maxRows; i++) {
      var hasTarget = i < lines.length;
      var hasSeg = i < writableTids.length;
      var rowStyle, numStyle, srcText, tgtText;
      if (hasTarget && hasSeg) {
        // Matched — normal row.
        rowStyle = "";
        numStyle = "color:var(--text-primary,#222);";
        srcText = escapeHtmlText(sourceTexts[i]);
        tgtText = escapeHtmlText(lines[i]);
      } else if (hasTarget && !hasSeg) {
        // Overflow — will be skipped.
        rowStyle = "background:#fff0f0;";
        numStyle = "color:#c44;";
        srcText = '<span style="color:#c44;font-style:italic;">no segment</span>';
        tgtText = '<span style="color:#c44;">' + escapeHtmlText(lines[i]) + '</span>';
      } else {
        // Unfilled segment — show as available.
        rowStyle = "opacity:0.45;";
        numStyle = "";
        srcText = escapeHtmlText(sourceTexts[i]);
        tgtText = '<span style="font-style:italic;">—</span>';
      }
      html += '<tr style="border-bottom:1px solid var(--border,#eee);' + rowStyle + '">' +
        '<td style="padding:3px 6px;' + numStyle + '">' + (i + 1) + '</td>' +
        '<td style="padding:3px 6px;word-break:break-word;">' + srcText + '</td>' +
        '<td style="padding:3px 6px;word-break:break-word;">' + tgtText + '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
    // Update info line.
    var n = lines.length;
    var avail = writableTids.length;
    var filled = Math.min(n, avail);
    if (n === 0) {
      info.textContent = "0 paragraphs detected";
    } else if (n > avail) {
      info.textContent = n + " paragraphs \u2192 " + filled + " filled, " + (n - avail) + " skipped (not enough segments)";
      info.style.color = "#c44";
    } else {
      info.textContent = n + " paragraph" + (n !== 1 ? "s" : "") + " \u2192 fill " + n + " of " + avail + " segments";
      info.style.color = "var(--text-muted,#888)";
    }
  }

  var info = document.createElement("div");
  info.style.cssText = "font-size:12px;color:var(--text-muted,#888);margin-top:6px;";
  info.textContent = "0 paragraphs detected";

  area.addEventListener("input", rebuildPreview);

  var btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";

  var cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "btn";
  cancelBtn.onclick = function () { overlay.remove(); };

  var applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  applyBtn.className = "btn success";
  applyBtn.onclick = function () {
    var lines = area.value.split("\n").filter(function (l) { return l.trim().length > 0; });
    if (lines.length === 0) {
      alert("No paragraphs to import.");
      return;
    }
    var filled = applyBulkImport(writableTids, lines);
    overlay.remove();
    renderSegmentsPane();
    renderHotspots();
    alert("Filled " + filled + " segment" + (filled !== 1 ? "s" : "") + "." +
      (lines.length > writableTids.length ? " " + (lines.length - writableTids.length) + " paragraph(s) skipped (not enough segments)." : ""));
  };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(applyBtn);
  modal.appendChild(title);
  modal.appendChild(hint);
  modal.appendChild(area);
  modal.appendChild(previewWrap);
  modal.appendChild(info);
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) overlay.remove();
  });
  area.focus();
}

// ==================== Annotated PDF Export ====================

/**
 * Detect which CJK font file to load based on target language or content.
 * Returns { regular, bold } filenames under vendor/.
 */
function detectCjkFontFiles() {
  // Check segmentsPayload for target language hint.
  const doc = state.segmentsPayload && state.segmentsPayload.document;
  const lang = safeStr(doc && doc.target_lang).toLowerCase();
  if (lang.indexOf("zh-tw") >= 0 || lang.indexOf("zh-hant") >= 0 || lang.indexOf("tc") >= 0) {
    return { regular: "NotoSansTC-Regular.ttf", bold: "NotoSansTC-Bold.ttf", family: "NotoSansTC" };
  }
  // Default: Simplified Chinese (covers most CJK).
  return { regular: "NotoSansSC-Regular.ttf", bold: "NotoSansSC-Bold.ttf", family: "NotoSansSC" };
}

/**
 * Fetch a binary file as an ArrayBuffer. fetch() works over http(s), but is
 * blocked for local files on file:// in most browsers — fall back to XHR,
 * which some browsers still allow for same-origin file:// loads.
 */
function fetchBinary(url) {
  return fetch(url).then(
    (resp) => {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.arrayBuffer();
    },
    () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => {
        // file:// has status 0; http has 2xx
        if (xhr.response && (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300))) {
          resolve(xhr.response);
        } else {
          reject(new Error("XHR status " + xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error("XHR network error"));
      xhr.send();
    })
  );
}

/**
 * Load a TTF font and register it with jsPDF.
 * Prefers base64 pre-embedded via <script> tag (works under file://), falls
 * back to fetchBinary over the network when running via a local server.
 */
async function loadJsPdfFont(jspdf, filename, family, style) {
  let b64;
  let source;  // Phase 5B diagnostic: "embedded" vs "fetch"
  const embedded = window.__EMBEDDED_FONTS && window.__EMBEDDED_FONTS[filename];
  if (typeof embedded === "string" && embedded.length > 0) {
    b64 = embedded;
    source = "embedded";
  } else {
    let buf;
    try {
      buf = await fetchBinary("./vendor/" + filename);
    } catch (e) {
      throw new Error(
        "Font load failed: " + filename + " (" + e.message + "). " +
        "If opening index.html directly via file://, run 'node build_font_embed.js' " +
        "in vendor/ to pre-embed this font variant, or serve the app via 'node serve.js'."
      );
    }
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    b64 = btoa(binary);
    source = "fetch";
  }
  jspdf.addFileToVFS(filename, b64);
  jspdf.addFont(filename, family, style);
  // Phase 5.7 file:// assertion reads state.fontDebugLog: all loads must be
  // "embedded" when running via file://, since fetch() is blocked there.
  if (state.fontDebug) {
    logFontSizeDebug({
      src: "loadJsPdfFont",
      filename: filename,
      family: family,
      style: style,
      source: source
    });
  }
}

/**
 * Wrap text to fit within maxWidth (in PDF points).
 * Mirrors CSS `word-break: break-word` behavior: Latin wraps at spaces,
 * CJK wraps per character. jsPDF's splitTextToSize alone cannot reliably
 * break non-whitespace CJK strings, which causes incorrect line counts.
 * Returns array of line strings.
 */
function isCjkCharCode(code) {
  return (code >= 0x2E80 && code <= 0x9FFF) ||
    (code >= 0x3000 && code <= 0x303F) ||
    (code >= 0xFF00 && code <= 0xFFEF) ||
    (code >= 0xAC00 && code <= 0xD7AF);
}

function wrapTextForPdf(jspdf, text, maxWidth) {
  const lines = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split("\n");
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    if (!para) { lines.push(""); continue; }
    let current = "";
    let i = 0;
    while (i < para.length) {
      const code = para.charCodeAt(i);
      if (isCjkCharCode(code)) {
        const ch = para.charAt(i);
        const test = current + ch;
        if (jspdf.getTextWidth(test) > maxWidth && current.length > 0) {
          lines.push(current);
          current = ch;
        } else {
          current = test;
        }
        i++;
      } else {
        let j = i;
        while (j < para.length) {
          const cc = para.charCodeAt(j);
          if (isCjkCharCode(cc)) break;
          const cch = para.charAt(j);
          if (cch === " " || cch === "\t") { j++; break; }
          j++;
        }
        const word = para.substring(i, j);
        const test = current + word;
        if (jspdf.getTextWidth(test) > maxWidth && current.length > 0) {
          lines.push(current);
          current = word.replace(/^\s+/, "");
        } else {
          current = test;
        }
        i = j;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Find the largest font size where text fits in box (w x h) in PDF points.
 * If maxFontSize is given, use it as the upper bound instead of the box height.
 * lineHMult: per-line-height multiplier (Phase 5A); defaults to DEFAULT_LEADING_MULT.
 * Returns { fontSize, lines }.
 */
function fitTextForPdf(jspdf, text, w, h, fontFamily, fontStyle, maxFontSize, lineHMult) {
  // 1.2 (DEFAULT_LEADING_MULT) matches Noto Sans CJK's actual vertical extent
  // per line (typoAscent 0.88 + typoDescent 0.32). Overridable per-segment
  // via the lineHMult parameter so source paragraph leading is honored.
  const LINE_H_MULT = (typeof lineHMult === "number" && lineHMult > 0) ? lineHMult : DEFAULT_LEADING_MULT;
  jspdf.setFont(fontFamily, fontStyle);
  let hi = maxFontSize > 0 ? Math.min(maxFontSize, h) : h;
  let finalFontSize;
  let earlyExit = false;
  jspdf.setFontSize(hi);
  let lines = wrapTextForPdf(jspdf, text, w);
  if (lines.length * hi * LINE_H_MULT <= h + 0.1) {
    finalFontSize = hi;
    earlyExit = true;
  } else {
    // Binary-search down to fit lines*fontSize*LINE_H_MULT ≤ h.
    // Note: jsPDF's getTextWidth for CJK may differ slightly from browser measurement,
    // so PDF may converge at a fontSize slightly smaller than preview. Preview/PDF
    // numerical parity (via lineHMult) is still maintained; visual size parity is
    // bounded by font-metric measurement precision across rendering engines.
    let lo = 0.5, mid, totalH;
    while (hi - lo > 0.3) {
      mid = (lo + hi) / 2;
      jspdf.setFontSize(mid);
      lines = wrapTextForPdf(jspdf, text, w);
      totalH = lines.length * mid * LINE_H_MULT;
      if (totalH > h) { hi = mid; } else { lo = mid; }
    }
    jspdf.setFontSize(lo);
    lines = wrapTextForPdf(jspdf, text, w);
    finalFontSize = lo;
  }
  if (state.fontDebug) {
    logFontSizeDebug({
      src: "pdf",
      text: text.slice(0, 20),
      w: +w.toFixed(2),
      h: +h.toFixed(2),
      maxFontSize: maxFontSize > 0 ? +maxFontSize.toFixed(2) : null,
      lineHMult: +LINE_H_MULT.toFixed(3),
      fontSize: +finalFontSize.toFixed(2),
      earlyExit: earlyExit,
      lineCount: lines.length
    });
  }
  return { fontSize: finalFontSize, lines: lines };
}

/**
 * Collect hotspot rectangles with translations for a given page.
 * Returns array of { nx0, ny0, nx1, ny1, text } in normalized 0-1 coords.
 * Merges multiple rects per TID into bounding box.
 */
function collectPageAnnotations(pageIdx) {
  const byTid = {};
  const order = [];
  // Group by ownerTid (merge_head_tid for tail rows, else self) so PDF
  // hotspots match Preview's merged hotspot DIVs. Preview merges sub-segment
  // boxes via getHotspotOwnerTid + mergeHotspotBoxByTid; PDF must do the
  // same or each tail's narrow line_rects becomes a separate small box that
  // gets force-fit with the head's full text → pathological shrinkage.
  state.segments.forEach(seg => {
    if (seg.control_only) return;
    const tid = safeStr(seg.tid);
    const row = state.translationsByTid[tid];
    if (!row || row.target_auto_prefill) return; // skip auto-prefilled source copies
    const ownerTid = getHotspotOwnerTid(tid);
    const ownerRow = state.translationsByTid[ownerTid] || row;
    const ownerSeg = state.segmentByTid && state.segmentByTid[ownerTid] ? state.segmentByTid[ownerTid] : seg;
    // Owner row holds the merged target_text. Tail rows have no own translation.
    const text = safeStr(ownerRow.target_text);
    // Empty target_text: don't skip — preview draws an empty box for spacer
    // paragraphs (blank rows in source). Skipping in PDF would let source
    // English bleed through where preview shows a clean spacer, breaking
    // visual parity. Empty boxes get the same border + opaque white bg as
    // text-bearing boxes; we just skip the text rendering inside.
    // (Phase 5B preview/PDF parity fix, 2026-04-18)
    const rects = seg.line_rects_norm && seg.line_rects_norm.length > 0
      ? seg.line_rects_norm : null;
    if (!rects) return;
    // Prefer the owner paragraph's actual pointSize (captured in export) over
    // line_rect height. line_rects use ascent+descent which exceeds pointSize
    // for many fonts, making CJK overlays render too large.
    var srcFontSize = (typeof ownerSeg.point_size === "number" && ownerSeg.point_size > 0) ? ownerSeg.point_size : 0;
    var srcFontSizeSource = srcFontSize > 0 ? "point_size" : "";
    if (srcFontSize === 0) {
      var absRects = seg.line_rects && seg.line_rects.length > 0 ? seg.line_rects : null;
      if (absRects) {
        for (var ri = 0; ri < absRects.length; ri++) {
          if (absRects[ri].page_index !== pageIdx) continue;
          var lh = Math.abs(absRects[ri].y1 - absRects[ri].y0);
          if (lh > 0 && (srcFontSize === 0 || lh < srcFontSize)) srcFontSize = lh;
        }
      }
      srcFontSizeSource = srcFontSize > 0 ? "line_rect_height_fallback" : "none";
    }
    if (state.fontDebug) {
      logFontSizeDebug({
        src: "annotation",
        tid: tid,
        ownerTid: ownerTid,
        hasPointSize: typeof ownerSeg.point_size === "number" && ownerSeg.point_size > 0,
        point_size: typeof ownerSeg.point_size === "number" ? ownerSeg.point_size : null,
        // Phase 5A: leading fields presence + resolved multiplier
        leading_source: leadingSource(ownerSeg),
        leading_mult: +resolveLeadingMultiplier(ownerSeg).toFixed(3),
        leading_pt: typeof ownerSeg.leading_pt === "number" ? ownerSeg.leading_pt : null,
        leading_ratio: typeof ownerSeg.leading_ratio === "number" ? ownerSeg.leading_ratio : null,
        srcFontSize: +srcFontSize.toFixed(2),
        srcFontSizeSource: srcFontSizeSource,
        lineRectCount: Array.isArray(seg.line_rects) ? seg.line_rects.length : 0
      });
    }
    rects.forEach(r => {
      if (r.page_index !== pageIdx) return;
      const nx0 = Math.min(r.nx0, r.nx1);
      const nx1 = Math.max(r.nx0, r.nx1);
      const ny0 = Math.min(r.ny0, r.ny1);
      const ny1 = Math.max(r.ny0, r.ny1);
      if (!byTid[ownerTid]) {
        byTid[ownerTid] = {
          tid: ownerTid, nx0: nx0, ny0: ny0, nx1: nx1, ny1: ny1,
          text: text, srcFontSize: srcFontSize,
          formatAnnotations: ownerRow.annotations || [],
          // Phase 5A: attach owner seg so exportAnnotatedPdf can resolve
          // per-segment leading multiplier via resolveLeadingMultiplier().
          seg: ownerSeg
        };
        order.push(ownerTid);
      } else {
        const b = byTid[ownerTid];
        b.nx0 = Math.min(b.nx0, nx0);
        b.ny0 = Math.min(b.ny0, ny0);
        b.nx1 = Math.max(b.nx1, nx1);
        b.ny1 = Math.max(b.ny1, ny1);
      }
    });
  });
  // Include manual hotspots
  state.manualHotspots.forEach(function (item) {
    if (item.page_index !== pageIdx) return;
    var text = safeStr(item.target_text);
    if (!text) return;
    var b = item.bounds_norm;
    var key = "manual_" + item.id;
    if (!byTid[key]) {
      byTid[key] = { nx0: b.nx0, ny0: b.ny0, nx1: b.nx1, ny1: b.ny1, text: text };
      order.push(key);
    }
  });
  // Include AI handoff items
  state.aiItems.forEach(function (item) {
    if (!item || Number(item.page_index) !== pageIdx || !item.placed_bounds_norm) return;
    var text = safeStr(item.target_text);
    if (!text) return;
    var nr = item.placed_bounds_norm;
    var key = "ai_" + safeStr(item.task_id);
    if (!byTid[key]) {
      byTid[key] = {
        nx0: Math.min(toNumber(nr.nx0), toNumber(nr.nx1)),
        ny0: Math.min(toNumber(nr.ny0), toNumber(nr.ny1)),
        nx1: Math.max(toNumber(nr.nx0), toNumber(nr.nx1)),
        ny1: Math.max(toNumber(nr.ny0), toNumber(nr.ny1)),
        text: text
      };
      order.push(key);
    }
  });
  return order.map(tid => byTid[tid]);
}

/**
 * Export an annotated PDF: original pages + hotspot rects + translated text.
 * Uses jsPDF with real text objects (copyable/searchable).
 */
/**
 * Render text with format annotations into a jsPDF document.
 * Splits text by annotation boundaries and applies bold/color/superscript per segment.
 * Falls back to plain text if no format annotations exist.
 */
function renderAnnotatedTextForPdf(doc, lines, formatAnns, x, y, fontSize, lineH, maxY, fontFamily) {
  // Filter to valid format annotations
  var fmts = [];
  if (Array.isArray(formatAnns)) {
    for (var fi = 0; fi < formatAnns.length; fi++) {
      var fa = formatAnns[fi];
      if (fa && fa.type === "format" && typeof fa.offset === "number" && typeof fa.length === "number" && fa.length > 0) {
        fmts.push(fa);
      }
    }
  }

  // Baseline placement: jsPDF's doc.text(x,y) puts the baseline at y.
  // Place the first line's baseline at `y + typoAscent` so the glyph top sits
  // at y. Noto Sans CJK typoAscent = 0.88 × fontSize (from sTypoAscent in
  // OS/2 table). Combined with the 1.2 multiplier for line-height, the N-th
  // line's text extent ends at y + N × (fontSize × 1.2), matching the fit
  // check in fitTextForPdf.
  var ascentOffset = fontSize * 0.88;

  // If no format annotations, render plain
  if (fmts.length === 0) {
    doc.setFont(fontFamily, "normal");
    doc.setTextColor(0, 0, 0);
    for (var pl = 0; pl < lines.length; pl++) {
      var ply = y + ascentOffset + pl * lineH;
      if (ply > maxY) break;
      doc.text(lines[pl], x, ply);
    }
    return;
  }

  // Reconstruct full text from lines to map character offsets
  var fullText = lines.join("\n");
  var lineOffsets = []; // start offset of each line in fullText
  var off = 0;
  for (var lo = 0; lo < lines.length; lo++) {
    lineOffsets.push(off);
    off += lines[lo].length + 1; // +1 for \n
  }

  // For each line, render character segments with format switching.
  // See baseline placement note above.
  for (var li = 0; li < lines.length; li++) {
    var ly = y + ascentOffset + li * lineH;
    if (ly > maxY) break;
    var lineStart = lineOffsets[li];
    var lineText = lines[li];
    if (!lineText) continue;

    // Collect boundary points within this line
    var points = [0, lineText.length];
    for (var ai = 0; ai < fmts.length; ai++) {
      var aStart = fmts[ai].offset - lineStart;
      var aEnd = aStart + fmts[ai].length;
      if (aStart > 0 && aStart < lineText.length) points.push(aStart);
      if (aEnd > 0 && aEnd < lineText.length) points.push(aEnd);
    }
    points = points.filter(function (v, i, a) { return a.indexOf(v) === i; });
    points.sort(function (a, b) { return a - b; });

    var curX = x;
    for (var pi = 0; pi < points.length - 1; pi++) {
      var segStart = points[pi];
      var segEnd = points[pi + 1];
      var segText = lineText.substring(segStart, segEnd);
      if (!segText) continue;

      // Determine active formats at this segment
      var globalStart = lineStart + segStart;
      var isBold = false;
      var isSup = false;
      var colorHex = null;
      for (var fj = 0; fj < fmts.length; fj++) {
        var fmt = fmts[fj];
        if (fmt.offset <= globalStart && globalStart < fmt.offset + fmt.length) {
          if (fmt.action === "bold") isBold = true;
          else if (fmt.action === "superscript") isSup = true;
          else if (fmt.action === "color" && fmt.color) colorHex = fmt.color;
          // italic: skip (no font variant available)
        }
      }

      // Apply format
      doc.setFont(fontFamily, isBold ? "bold" : "normal");
      if (colorHex) {
        var r = parseInt(colorHex.substring(1, 3), 16) || 0;
        var g = parseInt(colorHex.substring(3, 5), 16) || 0;
        var b = parseInt(colorHex.substring(5, 7), 16) || 0;
        doc.setTextColor(r, g, b);
      } else {
        doc.setTextColor(0, 0, 0);
      }

      var segFontSize = fontSize;
      var segY = ly;
      if (isSup) {
        segFontSize = fontSize * 0.7;
        segY = ly - fontSize * 0.3;
      }
      doc.setFontSize(segFontSize);
      doc.text(segText, curX, segY);

      // Advance X by segment width
      curX += doc.getTextWidth(segText);

      // Restore font size for width measurement of next segment
      doc.setFontSize(fontSize);
    }

    // Reset for next line
    doc.setFont(fontFamily, "normal");
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(fontSize);
  }
}

/**
 * Phase 7-SC: render a measured layout (from window.DomTextMeasure) into jsPDF.
 *
 * Per-line: split by formatAnnotations into spans; each span's x comes from
 * the DOM-measured `line.charXs[]` (NOT doc.getTextWidth — that would re-
 * introduce the browser-vs-jsPDF measurement divergence Phase 7 exists to
 * fix). Inherits Phase 5's per-format handling: bold via setFont, color via
 * setTextColor, italic SKIPPED (no italic font variant), superscript via
 * fontSize*0.7 + baseline raise of fontSize*0.3.
 */
function renderLayoutLines(doc, layout, formatAnns, x, y, maxY, fontFamily) {
  // Filter once.
  const fmts = [];
  if (Array.isArray(formatAnns)) {
    for (let fi = 0; fi < formatAnns.length; fi++) {
      const fa = formatAnns[fi];
      if (fa && fa.type === "format" && typeof fa.offset === "number" &&
          typeof fa.length === "number" && fa.length > 0) {
        fmts.push(fa);
      }
    }
  }

  // Ascent for visual-top calculation. line.baseline = relTop + ascentPt,
  // so visualTopY = y + line.baseline - ascentPt = y + relTop.
  const ascentPt = (typeof layout.ascentPt === "number" && layout.ascentPt > 0) ? layout.ascentPt : layout.fontSize;
  for (let li = 0; li < layout.lines.length; li++) {
    const line = layout.lines[li];
    const baselineY = y + line.baseline;
    // Clip when the line's *visual top* falls outside the box. Earlier
    // `baselineY > maxY` was too strict: source line_rects often equal
    // point_size while canvas.fontBoundingBoxAscent is slightly larger, so a
    // legitimately-fitting one-line segment got rejected before any draw.
    // Allow the line as long as its glyph top is inside the box.
    const visualTopY = baselineY - ascentPt;
    if (visualTopY > maxY) break;

    if (fmts.length === 0) {
      // Fast path: plain line, single text() call.
      doc.setFont(fontFamily, "normal");
      doc.setFontSize(layout.fontSize);
      doc.setTextColor(0, 0, 0);
      doc.text(line.text, x + line.charXs[0], baselineY);
      continue;
    }

    // Build per-line spans by intersecting formatAnnotations with [line.start, line.end).
    // Each span has [graphemeStart, graphemeEnd) within the line's grapheme array
    // — but formatAnns offsets are in CODE-UNIT positions (UTF-16). We need to
    // map code-unit offsets to grapheme-cluster indices using the layout's
    // grapheme boundaries inferred from charXs. Since charXs is sized N+1 and
    // line.start/line.end are code-unit positions, we use a per-line offset map.
    //
    // Simplified approach (good enough for SC + Phase 5's existing format set):
    // - For each grapheme position (gi from 0..N), record its code-unit start
    //   relative to line.start. We can rebuild this by iterating graphemes of
    //   line.text via Intl.Segmenter (cheap; one-line scope).
    const lineGraphemes = window.DomTextMeasure.iterateGraphemes(line.text, "und");
    // graphemeCodeStarts[gi] = code-unit offset of grapheme gi within line.text.
    // Append line.text.length as the sentinel.
    const graphemeCodeStarts = new Array(lineGraphemes.length + 1);
    for (let gi = 0; gi < lineGraphemes.length; gi++) graphemeCodeStarts[gi] = lineGraphemes[gi].start;
    graphemeCodeStarts[lineGraphemes.length] = line.text.length;

    // For each grapheme index, compute active format flags by checking which
    // formatAnnotations cover its code-unit start (in original-text coords).
    const lineCodeStartInDoc = line.start;
    const spans = [];
    let curStartGi = 0;
    let curFmt = computeFmtAt(lineCodeStartInDoc + graphemeCodeStarts[0], fmts);
    for (let gi = 1; gi <= lineGraphemes.length; gi++) {
      const codeOffset = lineCodeStartInDoc + (gi < lineGraphemes.length ? graphemeCodeStarts[gi] : line.text.length);
      const nextFmt = (gi < lineGraphemes.length) ? computeFmtAt(codeOffset, fmts) : null;
      if (nextFmt === null || !sameFmt(curFmt, nextFmt)) {
        // Close span [curStartGi, gi)
        const startCode = graphemeCodeStarts[curStartGi];
        const endCode = graphemeCodeStarts[gi];
        const spanText = line.text.substring(startCode, endCode);
        if (spanText.length > 0) {
          spans.push({ startGi: curStartGi, endGi: gi, text: spanText, fmt: curFmt });
        }
        curStartGi = gi;
        curFmt = nextFmt;
      }
    }

    for (let si = 0; si < spans.length; si++) {
      const s = spans[si];
      // NOTE: italic format is dropped silently — the loaded CJK font
      // (NotoSansSC) ships with regular + bold only, no italic glyphs.
      // We still render the text in normal weight so the characters are
      // visible. (Earlier code did `continue;` here, which made any italic
      // span — including italic Latin in source becoming CJK in target —
      // disappear entirely from the PDF.)

      let segFontSize = layout.fontSize;
      let segBaselineY = baselineY;
      if (s.fmt && s.fmt.superscript) {
        segFontSize = layout.fontSize * 0.7;
        segBaselineY = baselineY - layout.fontSize * 0.3;
      }
      doc.setFont(fontFamily, (s.fmt && s.fmt.bold) ? "bold" : "normal");
      doc.setFontSize(segFontSize);
      if (s.fmt && s.fmt.colorRgb) {
        doc.setTextColor(s.fmt.colorRgb[0], s.fmt.colorRgb[1], s.fmt.colorRgb[2]);
      } else {
        doc.setTextColor(0, 0, 0);
      }
      // X from DOM-measured charXs[]; sentinel at index N keeps span boundary lookups in range.
      const xOffset = line.charXs[s.startGi];
      doc.text(s.text, x + xOffset, segBaselineY);
    }
  }
}

// Returns a flat fmt object { bold, italic, superscript, colorRgb } summarizing
// all format annotations active at code-unit position `pos`.
function computeFmtAt(pos, fmts) {
  const out = { bold: false, italic: false, superscript: false, colorRgb: null };
  for (let i = 0; i < fmts.length; i++) {
    const f = fmts[i];
    if (f.offset <= pos && pos < f.offset + f.length) {
      if (f.action === "bold") out.bold = true;
      else if (f.action === "italic") out.italic = true;
      else if (f.action === "superscript") out.superscript = true;
      else if (f.action === "color" && f.color) {
        const r = parseInt(f.color.substring(1, 3), 16) || 0;
        const g = parseInt(f.color.substring(3, 5), 16) || 0;
        const b = parseInt(f.color.substring(5, 7), 16) || 0;
        out.colorRgb = [r, g, b];
      }
    }
  }
  return out;
}

function sameFmt(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.bold !== b.bold || a.italic !== b.italic || a.superscript !== b.superscript) return false;
  const ac = a.colorRgb, bc = b.colorRgb;
  if ((!ac) !== (!bc)) return false;
  if (ac && bc && (ac[0] !== bc[0] || ac[1] !== bc[1] || ac[2] !== bc[2])) return false;
  return true;
}

async function exportAnnotatedPdf() {
  if (!state.pdfDoc) {
    alert("No PDF loaded.");
    return;
  }
  const btn = els.exportPdfBtn;
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const numPages = state.pdfDoc.numPages;
    // Render first page to determine PDF dimensions.
    const firstPage = await state.pdfDoc.getPage(1);
    const vp0 = firstPage.getViewport({ scale: 1 });
    const pdfW = vp0.width * 72 / 96; // convert px to pt (pdf.js uses 96 DPI, jsPDF uses 72 DPI)
    const pdfH = vp0.height * 72 / 96;
    const orientation = pdfW > pdfH ? "landscape" : "portrait";

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: orientation, unit: "pt", format: [pdfW, pdfH] });

    // Load CJK fonts (regular + bold for annotation rendering).
    const fontInfo = detectCjkFontFiles();
    btn.textContent = "Loading font...";
    await loadJsPdfFont(doc, fontInfo.regular, fontInfo.family, "normal");
    await loadJsPdfFont(doc, fontInfo.bold, fontInfo.family, "bold");

    const RENDER_SCALE = 2; // render at 2x for quality

    for (let p = 1; p <= numPages; p++) {
      btn.textContent = "Page " + p + "/" + numPages + "...";

      // Render page to canvas.
      const page = await state.pdfDoc.getPage(p);
      // Per-page dimensions: a multi-page PDF can have varying page sizes,
      // so derive pageW/pageH from THIS page's viewport, not page 1's.
      const vp1 = page.getViewport({ scale: 1 });
      const pageW = vp1.width * 72 / 96;
      const pageH = vp1.height * 72 / 96;
      const pageOrient = pageW > pageH ? "landscape" : "portrait";
      if (p > 1) doc.addPage([pageW, pageH], pageOrient);

      const vp = page.getViewport({ scale: RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // Add page image as background.
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      doc.addImage(imgData, "JPEG", 0, 0, pageW, pageH);

      if (state.fontDebug) {
        logFontSizeDebug({
          src: "pdf_page",
          page: p,
          pageW_pt: +pageW.toFixed(2),
          pageH_pt: +pageH.toFixed(2),
          orient: pageOrient
        });
      }

      // Draw hotspot annotations.
      const pageIdx = p - 1; // 0-based page index
      const annotations = collectPageAnnotations(pageIdx);
      const PAD = 0; // preview text area ~= hotspot box; no inner padding
      // Phase 7-SC: target_lang from segments payload (Phase 5 stub returns
      // SC-only stack regardless, but the param is forward-compatible).
      const targetLang = (state.segmentsPayload && state.segmentsPayload.document &&
                          state.segmentsPayload.document.target_lang) || "zh-CN";
      const fontFamilyStack = window.DomTextMeasure.getFontFamilyStack(targetLang);

      for (let a = 0; a < annotations.length; a++) {
        const ann = annotations[a];
        const x = ann.nx0 * pageW;
        const y = ann.ny0 * pageH;
        const w = (ann.nx1 - ann.nx0) * pageW;
        const h = (ann.ny1 - ann.ny0) * pageH;
        if (w < 1 || h < 1) continue;

        // White background with slight transparency.
        doc.setFillColor(255, 255, 255);
        doc.setGState(new window.jspdf.GState({ opacity: 0.88 }));
        doc.rect(x, y, w, h, "F");

        // Border.
        doc.setGState(new window.jspdf.GState({ opacity: 1 }));
        doc.setDrawColor(200, 160, 60);
        doc.setLineWidth(0.5);
        doc.rect(x, y, w, h, "S");

        // Text.
        const innerW = w - PAD * 2;
        const innerH = h - PAD * 2;
        if (innerW < 1 || innerH < 1) continue;

        // Phase 5A: per-segment leading multiplier (source leading → ratio)
        const annLineHMult = resolveLeadingMultiplier(ann.seg);
        // Phase 7-SC visual scale (TEMP placeholder, see state.cjkVisualScale).
        // CJK em-fill > Latin cap-height; multiply maxFontSize so CJK visible
        // height ≈ source Latin visible height.
        const cjkScale = (typeof state.cjkVisualScale === "number" && state.cjkVisualScale > 0) ? state.cjkVisualScale : 1;
        const annMaxFontSize = (ann.srcFontSize || 0) * cjkScale;

        // Phase 7-SC: try DOM-driven measurement first.
        // `effectiveFontSize` captures whichever path produced text (Phase 7
        // layout.fontSize OR Phase 5 fit.fontSize), so the comment-annotation
        // block below can compute its smaller font without depending on the
        // fallback's `fit` symbol (which only exists when Phase 7 failed).
        // Pre-bug: `fit` was referenced unconditionally outside the fallback
        // → ReferenceError when Phase 7 succeeds + comment annotations exist.
        let phase7Failed = false;
        let phase7SkipReason = null;
        let effectiveFontSize = ann.srcFontSize || 0;   // safe default
        if (window.DomTextMeasure && ann.text) {
          try {
            const layout = await window.DomTextMeasure.measureTextLayoutViaDOM(
              ann.text, innerW, innerH, annLineHMult, annMaxFontSize,
              fontFamilyStack, targetLang
            );
            if (layout.skipped > 0) {
              phase7Failed = true;
              phase7SkipReason = "skipped_graphemes";
              if (!state.phase7SkippedSegments) state.phase7SkippedSegments = [];
              state.phase7SkippedSegments.push({
                tid: ann.tid,
                skipped: layout.skipped,
                sample: layout.skippedGraphemes
              });
            } else {
              effectiveFontSize = layout.fontSize;
              if (state.fontDebug) {
                logFontSizeDebug({
                  src: "dom_measure",
                  tid: ann.tid,
                  where: "pdf",
                  text: ann.text.slice(0, 20),
                  // Phase 7-SC convergence: log inputs so we can compare with
                  // preview's same-tid call; identical inputs MUST yield
                  // identical fontSize.
                  innerW_pt: +innerW.toFixed(2),
                  innerH_pt: +innerH.toFixed(2),
                  maxFontSize_pt: +(ann.srcFontSize || 0).toFixed(2),
                  cjkVisualScale: +cjkScale.toFixed(3),
                  scaledMaxFontSize_pt: +annMaxFontSize.toFixed(2),
                  fontSize_pt: +layout.fontSize.toFixed(2),
                  ascentPt: +layout.ascentPt.toFixed(2),
                  metricsSource: layout.metricsSource,
                  lineCount: layout.lines.length,
                  lineHMult: +annLineHMult.toFixed(3)
                });
              }
              doc.setGState(new window.jspdf.GState({ opacity: 1 }));
              renderLayoutLines(doc, layout, ann.formatAnnotations, x + PAD, y + PAD, y + h, fontInfo.family);
            }
          } catch (e) {
            phase7Failed = true;
            phase7SkipReason = "exception:" + (e && e.message ? e.message : "unknown");
            if (!state.phase7SkippedSegments) state.phase7SkippedSegments = [];
            state.phase7SkippedSegments.push({ tid: ann.tid, skipped: -1, error: phase7SkipReason });
          }
        } else {
          // Module not loaded — fall back to Phase 5 path entirely.
          phase7Failed = true;
          phase7SkipReason = "module_missing";
        }

        if (phase7Failed) {
          // Safety-valve fallback: Phase 5 path (fitTextForPdf + renderAnnotatedTextForPdf).
          // PRESERVED INTENTIONALLY (do not delete — see task_plan.md Phase 7 注意 3).
          const fit = fitTextForPdf(doc, ann.text, innerW, innerH, fontInfo.family, "normal", ann.srcFontSize || 0, annLineHMult);
          doc.setFont(fontInfo.family, "normal");
          doc.setFontSize(fit.fontSize);
          doc.setTextColor(0, 0, 0);
          doc.setGState(new window.jspdf.GState({ opacity: 1 }));
          const lineH = fit.fontSize * annLineHMult;
          renderAnnotatedTextForPdf(doc, fit.lines, ann.formatAnnotations, x + PAD, y + PAD, fit.fontSize, lineH, y + h, fontInfo.family);
          effectiveFontSize = fit.fontSize;
        }

        // Comment annotations: dashed underline + footnote below hotspot
        var comments = [];
        if (Array.isArray(ann.formatAnnotations)) {
          for (var ci = 0; ci < ann.formatAnnotations.length; ci++) {
            if (ann.formatAnnotations[ci].type === "comment") {
              comments.push(ann.formatAnnotations[ci]);
            }
          }
        }
        if (comments.length > 0) {
          var commentFontSize = Math.max(4, effectiveFontSize * 0.6);
          var commentY = y + h + 2;
          doc.setFont(fontInfo.family, "normal");
          doc.setFontSize(commentFontSize);
          doc.setTextColor(120, 100, 60);
          for (var cci = 0; cci < comments.length; cci++) {
            var cText = safeStr(comments[cci].text);
            if (!cText) continue;
            doc.text("\u25B8 " + cText, x + PAD, commentY + (cci + 1) * (commentFontSize * 1.2));
          }
          doc.setTextColor(0, 0, 0);
        }
      }

      // Release canvas memory.
      canvas.width = 0;
      canvas.height = 0;
    }

    // Save.
    const docName = (state.segmentsPayload && state.segmentsPayload.document && state.segmentsPayload.document.name)
      ? state.segmentsPayload.document.name.replace(/\.[^.]+$/, "")
      : "annotated";
    const outName = docName + "_annotated.pdf";

    var finishExport = function () {
      btn.disabled = false;
      btn.textContent = origLabel;
    };

    if (localServer.available && localServer.packageDirPath) {
      // Save via local server — keep button disabled until write completes.
      const pdfBlob = doc.output("blob");
      const reader = new FileReader();
      reader.onerror = function () {
        doc.save(outName);
        alert("Local server write failed. Annotated PDF downloaded to browser instead.");
        finishExport();
      };
      reader.onload = function() {
        const base64 = reader.result.split(",")[1];
        const sep = localServer.packageDirPath.indexOf("\\") >= 0 ? "\\" : "/";
        const fullPath = localServer.packageDirPath + sep + outName;
        fetch(localServer.baseUrl + "/api/write-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: fullPath, content_base64: base64 })
        }).then(r => r.json()).then(d => {
          if (d && d.ok) {
            // Auto-open the saved PDF
            fetch(localServer.baseUrl + "/api/open-file", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: fullPath })
            }).catch(() => {});
          } else {
            doc.save(outName);
            alert("Local server write failed. Annotated PDF downloaded to browser instead.");
          }
        }).catch(() => {
          doc.save(outName);
          alert("Local server write failed. Annotated PDF downloaded to browser instead.");
        })
          .then(finishExport);
      };
      reader.readAsDataURL(pdfBlob);
    } else {
      doc.save(outName);
      finishExport();
    }

  } catch (err) {
    console.error("PDF export error:", err);
    alert("PDF export failed: " + err.message);
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

function buildStatusPopoverHtml(seg, row) {
  const tid = seg ? seg.tid : "";
  const status = safeStatus(row && row.status);
  const current = displayStatusText(seg, row);
  const statuses = ["todo", "translated", "reviewed", "skip"];
  const isMergeHead = hasMergeTailChildren(tid);
  const isControlOnly = isControlOnlySegment(seg);
  const lines = [];
  let option;
  let disabled;

  if (isControlOnly) {
    lines.push('<div class="status-note">' + escapeHtmlText(sourceTextForUi(seg)) + ' is non-translatable and preserved from source.</div>');
    return '<div class="status-popover">' + lines.join("") + "</div>";
  }

  if (status === "merge_tail") {
    lines.push('<div class="status-note">Merged tail row. Status is managed by merge action.</div>');
    if (row && row.merge_head_tid) {
      lines.push(
        '<button type="button" class="status-opt go-head" data-jump-head="' +
        escapeHtmlAttr(row.merge_head_tid) +
        '">Go Head</button>'
      );
    }
    return '<div class="status-popover">' + lines.join("") + "</div>";
  }

  lines.push('<div class="status-title">Set status</div>');
  for (let i = 0; i < statuses.length; i += 1) {
    option = statuses[i];
    disabled =
      ((option === "todo" || option === "skip") && isMergeHead) ||
      (option === "translated" && !hasEffectiveTargetText(row && row.target_text)) ||
      (option === "reviewed" && !canSetReviewedStatus(seg, row));
    lines.push(
      '<button type="button" class="status-opt ' + statusClassFromStatus(option) +
      (current === option ? " active" : "") + '" data-status-set="' + option +
      '" data-status-tid="' + escapeHtmlAttr(tid) + '"' + (disabled ? " disabled" : "") +
      '><span class="status-opt-main">' + escapeHtmlText(option) +
      '</span><span class="status-opt-desc">' + escapeHtmlText(statusDescription(option)) +
      "</span></button>"
    );
  }
  lines.push(
    '<div class="status-note">`reviewed` requires valid target text and control tokens.' +
    (isMergeHead ? " Merge heads cannot be set to `todo` or `skip`." : "") +
    "</div>"
  );
  return '<div class="status-popover">' + lines.join("") + "</div>";
}

async function onProgressInputChange(event) {
  const files = Array.from((event && event.target && event.target.files) || []);
  const file = files.length > 0 ? files[0] : null;
  const prevSelectedTid = state.selectedTid;
  let payload;
  let rows;
  if (event && event.target) {
    event.target.value = "";
  }
  if (!file) {
    return;
  }
  if (!state.segments || state.segments.length === 0) {
    alert("Open a package folder first, then load translations progress.");
    return;
  }
  if (!confirm("Load progress JSON and replace current in-memory translations?")) {
    return;
  }
  try {
    payload = await readJsonFile(file);
    rows = normalizeTranslationsPayload(payload);
    if (!rows || rows.length === 0) {
      throw new Error("No translations rows found");
    }
    state.translationsByTid = buildInitialTranslations(state.segments, payload, null);
    loadManualHotspotsFromPayload(payload);
    applyCardOptionsFromPayload(payload);
    autoMergeSoftBreakGroups();
    if (prevSelectedTid && state.segmentByTid[prevSelectedTid]) {
      state.selectedTid = prevSelectedTid;
    } else {
      state.selectedTid = state.segments.length > 0 ? state.segments[0].tid : null;
    }
    renderAll();
    els.packageStatus.textContent =
      `Loaded ${state.packageName} | segments=${state.segments.length} | ai_handoff=${state.aiItems.length} | progress=${safeStr(file.name)}`;
  } catch (err) {
    console.error(err);
    alert("Failed to load progress: " + err.message);
  }
}

function statusDescription(status) {
  const s = safeStatus(status);
  if (s === "translated") {
    return "Translation entered and ready for review.";
  }
  if (s === "reviewed") {
    return "Checked with control tokens valid.";
  }
  if (s === "skip") {
    return "Intentionally kept as source/no translation.";
  }
  return "Waiting for translation input.";
}

function setRowStatus(tid, status) {
  const row = state.translationsByTid[tid];
  const seg = state.segmentByTid[tid];
  const nextStatus = safeStatus(status);
  const isMergeHead = hasMergeTailChildren(tid);
  if (!row || !seg) {
    return false;
  }
  if (isControlOnlySegment(seg)) {
    row.status = "skip";
    return nextStatus === "skip";
  }
  if (isMergeTailRow(row) && nextStatus !== "merge_tail") {
    return false;
  }
  if (nextStatus === "merge_tail") {
    return false;
  }
  if (isMergeHead && (nextStatus === "todo" || nextStatus === "skip")) {
    return false;
  }
  if (nextStatus === "translated" && !hasEffectiveTargetText(row.target_text)) {
    return false;
  }
  if (nextStatus === "reviewed" && !canSetReviewedStatus(seg, row)) {
    return false;
  }
  row.status = nextStatus;
  return true;
}

function findSegmentByStoryParagraph(storyId, paragraphIndex) {
  const sid = Number(storyId);
  const pid = Number(paragraphIndex);
  let i;
  let seg;
  let first = null;
  if (!Number.isFinite(sid) || !Number.isFinite(pid) || pid < 0) {
    return null;
  }
  for (i = 0; i < state.segments.length; i += 1) {
    seg = state.segments[i];
    if (!seg) {
      continue;
    }
    if (Number(seg.story_id) === sid && Number(seg.paragraph_index) === pid) {
      // Prefer the segment with soft_break_index 0 (or no group) over
      // soft-break siblings that share the same paragraph_index.
      if (!seg.soft_break_group || seg.soft_break_index === 0) {
        return seg;
      }
      if (!first) {
        first = seg;
      }
    }
  }
  return first;
}

function getNextContiguousSegment(seg) {
  if (!seg) {
    return null;
  }
  // If seg belongs to a soft-break group, first try the next sibling
  // within the group (by soft_break_index).  Only jump to the next
  // real paragraph_index if no higher-index sibling exists.
  if (seg.soft_break_group) {
    const curIdx = seg.soft_break_index || 0;
    let nextSibling = null;
    let nextSiblingIdx = Number.MAX_VALUE;
    for (let i = 0; i < state.segments.length; i += 1) {
      const s = state.segments[i];
      if (s.soft_break_group === seg.soft_break_group) {
        const si = s.soft_break_index || 0;
        if (si > curIdx && si < nextSiblingIdx) {
          nextSibling = s;
          nextSiblingIdx = si;
        }
      }
    }
    if (nextSibling) {
      return nextSibling;
    }
    // No more siblings — jump to next real paragraph.
    return findSegmentByStoryParagraph(Number(seg.story_id), Number(seg.paragraph_index) + 1);
  }
  return findSegmentByStoryParagraph(Number(seg.story_id), Number(seg.paragraph_index) + 1);
}

function getPreviousContiguousSegment(seg) {
  if (!seg) {
    return null;
  }
  return findSegmentByStoryParagraph(Number(seg.story_id), Number(seg.paragraph_index) - 1);
}

function getMergeTailChainForHead(headTid) {
  const headSeg = state.segmentByTid[headTid];
  const tails = [];
  let expectedIndex;
  let nextSeg;
  let row;
  if (!headSeg) {
    return tails;
  }

  // Soft-break branch: first walk by soft_break_group + soft_break_index,
  // then continue into the normal paragraph_index+1 walk so that manually
  // merged real paragraphs beyond the group are also discovered.
  if (headSeg.soft_break_group) {
    const headIdx = headSeg.soft_break_index || 0;
    const group = headSeg.soft_break_group;
    // Collect siblings with higher soft_break_index, sorted ascending.
    const siblings = [];
    for (let i = 0; i < state.segments.length; i += 1) {
      const s = state.segments[i];
      if (s.soft_break_group === group && (s.soft_break_index || 0) > headIdx) {
        siblings.push(s);
      }
    }
    siblings.sort((a, b) => (a.soft_break_index || 0) - (b.soft_break_index || 0));
    for (let i = 0; i < siblings.length; i += 1) {
      row = state.translationsByTid[siblings[i].tid];
      if (!row || !isMergeTailRow(row) || safeStr(row.merge_head_tid) !== headTid) {
        break;
      }
      tails.push(siblings[i].tid);
    }
    // Fall through to normal branch to catch manually-merged paragraphs
    // beyond the soft-break group.
  }

  // Normal branch: walk by paragraph_index + 1 from the last tail (or head).
  if (tails.length > 0) {
    const lastTailSeg = state.segmentByTid[tails[tails.length - 1]];
    // getNextContiguousSegment already skips past soft-break siblings.
    const afterLast = getNextContiguousSegment(lastTailSeg || headSeg);
    expectedIndex = afterLast ? Number(afterLast.paragraph_index) : Number(headSeg.paragraph_index) + 1;
  } else {
    expectedIndex = Number(headSeg.paragraph_index) + 1;
  }
  while (true) {
    nextSeg = findSegmentByStoryParagraph(Number(headSeg.story_id), expectedIndex);
    if (!nextSeg) {
      break;
    }
    row = state.translationsByTid[nextSeg.tid];
    if (!row || !isMergeTailRow(row) || safeStr(row.merge_head_tid) !== headTid) {
      break;
    }
    tails.push(nextSeg.tid);
    expectedIndex += 1;
  }
  return tails;
}

function hasMergeTailChildren(headTid) {
  return getMergeTailChainForHead(headTid).length > 0;
}

function getMergeAppendCandidateForHead(headTid) {
  const headSeg = state.segmentByTid[headTid];
  const chain = getMergeTailChainForHead(headTid);
  const baseTid = chain.length > 0 ? chain[chain.length - 1] : headTid;
  const baseSeg = state.segmentByTid[baseTid] || headSeg;
  const candidate = getNextContiguousSegment(baseSeg);
  const candidateRow = candidate ? state.translationsByTid[candidate.tid] : null;
  if (!headSeg || !baseSeg || !candidate || !candidateRow) {
    return null;
  }
  if (isControlOnlySegment(headSeg) || isControlOnlySegment(candidate)) {
    return null;
  }
  if (isMergeTailRow(candidateRow)) {
    return null;
  }
  if (getMergeTailChainForHead(candidate.tid).length > 0) {
    return null;
  }
  return candidate;
}

function canMergeNextFromTid(tid) {
  const seg = state.segmentByTid[tid];
  const row = state.translationsByTid[tid];
  if (!seg || !row || isRowSystemLocked(seg, row)) {
    return false;
  }
  return !!getMergeAppendCandidateForHead(tid);
}

function appendMissingControlTokensToText(text, requiredCounts) {
  const required = requiredCounts || {};
  const actual = collectControlTokenCounts(text);
  const tokens = sortedUnique(Object.keys(required));
  let out = safeStr(text);
  let i;
  let token;
  let diff;
  for (i = 0; i < tokens.length; i += 1) {
    token = tokens[i];
    diff = Number(required[token] || 0) - Number(actual[token] || 0);
    if (diff <= 0) {
      continue;
    }
    while (diff > 0) {
      if (out && !/\s$/.test(out)) {
        out += " ";
      }
      out += token;
      diff -= 1;
    }
  }
  return out;
}

// Compute the EFFECTIVE format at the start of each soft-break sub-segment
// in a group. Each sub-segment's `format_snapshot` is a copy of the parent
// paragraph's snapshot (an export-side data quirk — sub-segments don't get
// their own clipped snapshot), but `format_snapshot.emphasis_runs[]` is
// keyed by GLOBAL parent offsets, so we can derive each sub-segment's
// real format by:
//   1) Computing each sub-segment's global start offset in the parent
//      paragraph (sum of preceding sub-seg lengths + soft-break separator
//      char(s) between them).
//   2) Walking the parent's emphasis_runs[] and finding the run covering
//      that global offset. If found → baseline overridden by that run's diff.
//      If not found → baseline applies as-is.
//
// Returns an array of {fontFamily, fontStyle, fontSize, fillColor}, one
// per member, in member order.
function computeSoftBreakGroupEffectiveFormats(members) {
  if (!Array.isArray(members) || members.length === 0) return [];
  var out = [];
  var globalStart = 0;
  for (var i = 0; i < members.length; i++) {
    var seg = members[i] || {};
    var fs2 = seg.format_snapshot || {};
    var baseline = fs2.baseline || {};
    var eff = {
      fontFamily: baseline.fontFamily,
      fontStyle:  baseline.fontStyle,
      fontSize:   baseline.fontSize,
      fillColor:  baseline.fillColor
    };
    var ers = Array.isArray(fs2.emphasis_runs) ? fs2.emphasis_runs : [];
    for (var j = 0; j < ers.length; j++) {
      var er = ers[j];
      if (!er || typeof er.start !== "number" || typeof er.end !== "number") continue;
      if (er.start <= globalStart && globalStart < er.end) {
        var diff = er.diff || {};
        if (diff.fontFamily) eff.fontFamily = diff.fontFamily;
        if (diff.fontStyle)  eff.fontStyle  = diff.fontStyle;
        if (diff.fontSize !== undefined && diff.fontSize !== null) eff.fontSize = diff.fontSize;
        if (diff.fillColor)  eff.fillColor  = diff.fillColor;
        break;
      }
    }
    out.push(eff);
    // Advance globalStart past this sub-seg + the soft-break separator char(s).
    globalStart += (seg.source_text || "").length;
    var sep = seg.soft_break_separators;
    var sepLen = 1;   // default:   forced line break = 1 char
    if (Array.isArray(sep) && sep.length > 0 && typeof sep[0] === "string") {
      sepLen = sep[0].length || 1;
    }
    globalStart += sepLen;
  }
  return out;
}

// Compare two effective format records under the FIXED dim set
// (fontFamily / fontStyle / fontSize ±0.5pt / fillColor) — same dims and
// tolerance as InDesign-side `splitSoftBreaksWithFormatChange._charFormatKey`.
function softBreakEffectiveFormatsMatch(a, b) {
  if (!a || !b) return true;   // missing → don't block merge
  if (safeStr(a.fontFamily) !== safeStr(b.fontFamily)) return false;
  if (safeStr(a.fontStyle)  !== safeStr(b.fontStyle))  return false;
  var sa = Number(a.fontSize) || 0;
  var sb = Number(b.fontSize) || 0;
  if (Math.abs(sa - sb) > 0.5) return false;
  // fillColor key: prefer .swatch (export schema), fallback .name; values is
  // CMYK tuple or RGB array — JSON.stringify is fine for shallow equality.
  var ca = a.fillColor
    ? (safeStr(a.fillColor.swatch || a.fillColor.name) + "|" + JSON.stringify(a.fillColor.values || a.fillColor.rgb || ""))
    : "";
  var cb = b.fillColor
    ? (safeStr(b.fillColor.swatch || b.fillColor.name) + "|" + JSON.stringify(b.fillColor.values || b.fillColor.rgb || ""))
    : "";
  if (ca !== cb) return false;
  return true;
}

// Group-level helper: returns true if every adjacent pair in the group
// has matching effective format under the fixed dim set.
function softBreakGroupAllAdjacentMatch(members) {
  if (!Array.isArray(members) || members.length < 2) return true;
  var effs = computeSoftBreakGroupEffectiveFormats(members);
  for (var i = 1; i < effs.length; i++) {
    if (!softBreakEffectiveFormatsMatch(effs[i - 1], effs[i])) return false;
  }
  return true;
}

// Walk every soft-break group; for any pair of adjacent members whose
// baselines don't match, returns the group descriptor so the caller can
// decide what to do (drive the "rule got tighter — unmerge incompatibles"
// or "preview impact for the confirmation dialog" use cases).
function findFormatIncompatibleSoftBreakGroups() {
  var groups = {};
  var i, seg, gid;
  for (i = 0; i < state.segments.length; i++) {
    seg = state.segments[i];
    gid = safeStr(seg.soft_break_group);
    if (!gid) continue;
    if (!groups[gid]) groups[gid] = [];
    groups[gid].push(seg);
  }
  var incompatible = [];
  for (gid in groups) {
    if (!groups.hasOwnProperty(gid)) continue;
    var members = groups[gid];
    if (members.length < 2) continue;
    members.sort(function (a, b) { return (a.soft_break_index || 0) - (b.soft_break_index || 0); });
    if (!softBreakGroupAllAdjacentMatch(members)) {
      incompatible.push({ groupTid: gid, members: members });
    }
  }
  return incompatible;
}

// Reverse of autoMergeSoftBreakGroups — for groups that have been merged
// (head exists with tails as merge_tail) but are no longer compatible
// under the current rule, restore the tails to their pre-merge state.
//
// Safety: we ONLY unmerge groups where every tail is still in pristine
// merge_tail state (status === "merge_tail" + merge_head_tid points to
// our head). If a tail has been touched (status changed, target edited),
// we skip the entire group to preserve translator work.
//
// Returns { unmerged: <count of groups>, skipped: <count of groups> }.
function autoUnmergeSoftBreakGroupsByFormat() {
  var stats = { unmerged: 0, skipped: 0 };
  if (!state.formatAwareSoftBreakMerge) return stats;
  var incompatible = findFormatIncompatibleSoftBreakGroups();
  for (var i = 0; i < incompatible.length; i++) {
    var members = incompatible[i].members;
    var headTid = members[0].tid;
    // Verify all tails are still pristine merge_tail under headTid.
    var allPristine = true;
    for (var j = 1; j < members.length; j++) {
      var tailRow = state.translationsByTid[members[j].tid];
      if (!tailRow) { allPristine = false; break; }
      if (safeStatus(tailRow.status) !== "merge_tail") { allPristine = false; break; }
      if (safeStr(tailRow.merge_head_tid) !== headTid) { allPristine = false; break; }
    }
    if (!allPristine) { stats.skipped++; continue; }
    // Restore each tail using the captured backup.
    for (var k = 1; k < members.length; k++) {
      var tr = state.translationsByTid[members[k].tid];
      tr.target_text = safeStr(tr.merge_tail_backup_target);
      tr.status      = safeStatus(tr.merge_tail_backup_status) || "todo";
      tr.merge_head_tid = "";
      delete tr.merge_tail_backup_target;
      delete tr.merge_tail_backup_status;
    }
    stats.unmerged++;
  }
  return stats;
}

// Apply per-package card_options from a translations payload to state.
// Returns true if the payload supplied an explicit value (caller may want
// to refresh UI after); false otherwise. localStorage is left untouched —
// it represents the user's BROWSER preference, not the per-package state,
// so per-package values just override at runtime without rewriting localStorage.
function applyCardOptionsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  var co = payload.card_options;
  if (!co || typeof co !== "object") return false;
  if (typeof co.format_aware_soft_break_merge === "boolean") {
    state.formatAwareSoftBreakMerge = !!co.format_aware_soft_break_merge;
    if (els.formatAwareSoftBreakMergeSwitch) {
      els.formatAwareSoftBreakMergeSwitch.checked = !!state.formatAwareSoftBreakMerge;
    }
    return true;
  }
  return false;
}

// ─── Merge-rule switch (Card Options panel) + confirmation dialog ─

// Predict the impact of flipping the rule, so the confirmation dialog
// can show the user how many groups will change.
//
// Going TIGHTER (currently OFF → turning ON):
//   - For every soft-break group that's currently merged but format-incompatible,
//     check if all tails are still in pristine merge_tail state. If yes → can unmerge.
//
// Going LOOSER (currently ON → turning OFF):
//   - For every soft-break group that's currently kept apart due to format
//     mismatch, check if all tails are pristine (todo + empty target). If yes → can merge.
function previewMergeRuleImpact(turningOn) {
  var willUnmerge = 0, willMerge = 0, skippedDirty = 0;

  // Build group → members map
  var groups = {};
  for (var i = 0; i < state.segments.length; i++) {
    var seg = state.segments[i];
    var gid = safeStr(seg.soft_break_group);
    if (!gid) continue;
    if (!groups[gid]) groups[gid] = [];
    groups[gid].push(seg);
  }

  for (var gid2 in groups) {
    if (!groups.hasOwnProperty(gid2)) continue;
    var members = groups[gid2];
    if (members.length < 2) continue;
    members.sort(function (a, b) { return (a.soft_break_index || 0) - (b.soft_break_index || 0); });

    var headTid = members[0].tid;
    var headRow = state.translationsByTid[headTid];
    if (!headRow) continue;

    // Format compatible under the NEW rule? (turningOn → check; turningOff → all groups become compatible)
    var compatibleNew = softBreakGroupAllAdjacentMatch(members);

    // Currently merged?
    var firstTail = state.translationsByTid[members[1].tid];
    var currentlyMerged = !!(firstTail && safeStatus(firstTail.status) === "merge_tail" && safeStr(firstTail.merge_head_tid) === headTid);

    if (turningOn) {
      // Rule becoming format-aware. If group is merged but new rule says incompatible → would unmerge.
      if (currentlyMerged && !compatibleNew) {
        // Check pristine merge_tail
        var allPristine = true;
        for (var t = 1; t < members.length; t++) {
          var tr = state.translationsByTid[members[t].tid];
          if (!tr || safeStatus(tr.status) !== "merge_tail" || safeStr(tr.merge_head_tid) !== headTid) {
            allPristine = false; break;
          }
        }
        if (allPristine) willUnmerge++; else skippedDirty++;
      }
    } else {
      // Rule becoming always-merge. If group is unmerged but pristine → would merge.
      if (!currentlyMerged) {
        var allPristineTodo = true;
        for (var t2 = 1; t2 < members.length; t2++) {
          var tr2 = state.translationsByTid[members[t2].tid];
          if (!tr2) { allPristineTodo = false; break; }
          if (safeStatus(tr2.status) !== "todo") { allPristineTodo = false; break; }
          if (hasEffectiveTargetText(tr2.target_text)) { allPristineTodo = false; break; }
          if (safeStr(tr2.merge_head_tid)) { allPristineTodo = false; break; }
          if (tr2.soft_break_unmerged) { allPristineTodo = false; break; }
        }
        // Only counts if it's a group that was previously skipped due to format-aware rule
        // (i.e., format-incompatible under the OLD rule — now will merge).
        // But under new rule (always-merge), all unmerged-pristine groups will merge.
        // Only highlight ones the OLD rule kept apart (format-incompatible).
        if (allPristineTodo && !compatibleNew) willMerge++;
        else if (!allPristineTodo && !compatibleNew) skippedDirty++;
      }
    }
  }
  return { willUnmerge: willUnmerge, willMerge: willMerge, skippedDirty: skippedDirty };
}

function onFormatAwareMergeSwitchChange(ev) {
  // The checkbox was just toggled; its current `checked` state is the user's
  // INTENT. Confirm via dialog before committing — if user cancels, restore
  // the checkbox to its previous (= state.formatAwareSoftBreakMerge) value.
  var sw = els.formatAwareSoftBreakMergeSwitch;
  if (!sw) return;
  var newValue = !!sw.checked;
  if (newValue === !!state.formatAwareSoftBreakMerge) return;   // no real change
  var impact = previewMergeRuleImpact(newValue);

  var msgLines = [];
  if (newValue) {
    msgLines.push("Switch to FORMAT-AWARE soft-break merge?");
    msgLines.push("");
    msgLines.push("Same-paragraph soft-break sub-segments will only auto-merge when font / weight / size / color on both sides match. Mismatched groups stay as independent cards (one translation slot per sub-segment).");
    msgLines.push("");
    msgLines.push("This applies to the InDesign-side import too — when designer enables the matching panel option, both ends agree on what counts as a 'format change' so the doc structure stays aligned.");
  } else {
    msgLines.push("Switch to ALWAYS-MERGE soft-break behavior?");
    msgLines.push("");
    msgLines.push("All same-paragraph soft-break sub-segments will be merged into one card regardless of format differences across the soft break.");
    msgLines.push("");
    msgLines.push("Use this if you don't care about preserving format-driven boundaries on the import side.");
  }
  msgLines.push("");
  msgLines.push("Impact:");
  if (newValue) {
    msgLines.push("  • " + impact.willUnmerge + " merged group(s) will be split into independent cards");
    if (impact.skippedDirty > 0) {
      msgLines.push("  • " + impact.skippedDirty + " merged group(s) keep current state (already edited — not auto-changed)");
    }
  } else {
    msgLines.push("  • " + impact.willMerge + " currently-separate group(s) will be merged");
    if (impact.skippedDirty > 0) {
      msgLines.push("  • " + impact.skippedDirty + " group(s) keep current state (already edited — not auto-changed)");
    }
  }
  msgLines.push("");
  msgLines.push("Saved: per-package on next 'Save Outputs' (translations.json card_options) + this browser as default for new packages.");
  msgLines.push("");
  msgLines.push("Continue?");

  var ok = confirm(msgLines.join("\n"));
  if (!ok) {
    // Revert the checkbox — user cancelled.
    sw.checked = !!state.formatAwareSoftBreakMerge;
    return;
  }

  state.formatAwareSoftBreakMerge = newValue;
  try { window.localStorage.setItem("formatAwareSoftBreakMerge", String(newValue)); } catch (_) {}

  // Re-run merge state to match new rule:
  //   1) tighten direction → unmerge format-incompatible groups
  //   2) loosen direction → merge previously kept-apart groups
  // Run both unconditionally; each is a no-op when not applicable.
  var unStats = autoUnmergeSoftBreakGroupsByFormat();
  autoMergeSoftBreakGroups();

  if (typeof renderAll === "function") renderAll();

  var summary = newValue
    ? ("Switched to format-aware merge. Unmerged " + unStats.unmerged + " group(s).")
    : ("Switched to always-merge. Merged " + impact.willMerge + " group(s).");
  if (impact.skippedDirty > 0 || unStats.skipped > 0) {
    summary += " " + (impact.skippedDirty + unStats.skipped) + " group(s) preserved due to existing edits.";
  }
  // Lightweight feedback — alert is fine for a one-shot config change.
  alert(summary);
}

// Auto-merge soft-break sub-segments on load.
// Only merges groups where ALL tails are pristine (todo + empty target + no
// merge_head_tid + no soft_break_unmerged flag).  If any tail has been
// translated, unmerged, or already linked, the entire group is skipped.
//
// When state.formatAwareSoftBreakMerge=true, an additional check runs:
// adjacent members must have matching baseline format (fontFamily /
// fontStyle / fontSize / fillColor); incompatible groups are left as
// independent cards. This mirrors the InDesign import flow's
// splitSoftBreaks preclean.
function autoMergeSoftBreakGroups() {
  const groups = {};
  let i, seg, groupTid, members, headTid, headRow, tailRow;
  let allPristine, j;

  // Collect groups keyed by soft_break_group, sorted by soft_break_index.
  for (i = 0; i < state.segments.length; i += 1) {
    seg = state.segments[i];
    groupTid = safeStr(seg.soft_break_group);
    if (!groupTid) {
      continue;
    }
    if (!groups[groupTid]) {
      groups[groupTid] = [];
    }
    groups[groupTid].push(seg);
  }

  for (groupTid in groups) {
    if (!groups.hasOwnProperty(groupTid)) {
      continue;
    }
    members = groups[groupTid];
    // Sort by soft_break_index ascending.
    members.sort(function (a, b) {
      return (a.soft_break_index || 0) - (b.soft_break_index || 0);
    });
    if (members.length < 2) {
      continue;
    }
    headTid = members[0].tid;
    headRow = state.translationsByTid[headTid];
    if (!headRow) {
      continue;
    }

    // Format gate (state.formatAwareSoftBreakMerge): adjacent members
    // must have matching effective format under the fixed dim set, else
    // skip merge for this entire group → tails stay as independent cards.
    // "Effective format" derives from emphasis_runs[] (parent-paragraph
    // global offsets) at each sub-segment's start, since baseline is
    // shared across sub-segments.
    if (state.formatAwareSoftBreakMerge) {
      if (!softBreakGroupAllAdjacentMatch(members)) continue;
    }

    // Check all tails are pristine.
    allPristine = true;
    for (j = 1; j < members.length; j += 1) {
      tailRow = state.translationsByTid[members[j].tid];
      if (!tailRow) {
        allPristine = false;
        break;
      }
      if (safeStatus(tailRow.status) !== "todo") {
        allPristine = false;
        break;
      }
      if (hasEffectiveTargetText(tailRow.target_text)) {
        allPristine = false;
        break;
      }
      if (safeStr(tailRow.merge_head_tid)) {
        allPristine = false;
        break;
      }
      if (tailRow.soft_break_unmerged) {
        allPristine = false;
        break;
      }
    }

    if (!allPristine) {
      continue;
    }

    // Merge: set tails as merge_tail with backup.
    for (j = 1; j < members.length; j += 1) {
      tailRow = state.translationsByTid[members[j].tid];
      tailRow.merge_tail_backup_target = safeStr(tailRow.target_text);
      tailRow.merge_tail_backup_status = safeStatus(tailRow.status);
      tailRow.merge_head_tid = headTid;
      tailRow.status = "merge_tail";
      tailRow.target_text = "";
    }
  }
}

function mergeNextSegmentFromTid(headTid) {
  const headRow = state.translationsByTid[headTid];
  const nextSeg = getMergeAppendCandidateForHead(headTid);
  const nextRow = nextSeg ? state.translationsByTid[nextSeg.tid] : null;
  let mergedTarget;
  const backupTarget = safeStr(nextRow && nextRow.target_text);
  const backupStatus = safeStatus(nextRow && nextRow.status);
  if (!canMergeNextFromTid(headTid) || !headRow || !nextRow || !nextSeg) {
    return false;
  }
  mergedTarget = safeStr(headRow.target_text);
  // Capture pre-merge head length BEFORE updateTargetText changes it
  var preMergeHeadLen = mergedTarget.length;
  if (hasEffectiveTargetText(backupTarget)) {
    if (mergedTarget && !/\n$/.test(mergedTarget)) {
      mergedTarget += "\n";
    }
    mergedTarget += backupTarget;
  }
  mergedTarget = appendMissingControlTokensToText(mergedTarget, nextSeg.required_control_tokens || {});
  updateTargetText(headTid, mergedTarget, { fromUser: true });

  nextRow.merge_tail_backup_target = backupTarget;
  nextRow.merge_tail_backup_status = backupStatus;
  // Phase 5: backup tail annotations, shift offsets, merge into head
  nextRow.merge_tail_backup_annotations = Array.isArray(nextRow.annotations)
    ? JSON.parse(JSON.stringify(nextRow.annotations)) : [];
  var headTextLen = preMergeHeadLen;
  if (Array.isArray(nextRow.annotations)) {
    var shiftedAnns = nextRow.annotations.map(function (a) {
      var c = {};
      for (var k in a) c[k] = a[k];
      // +1 for the \n separator added during merge
      c.offset = (typeof c.offset === "number" ? c.offset : 0) + headTextLen + (hasEffectiveTargetText(backupTarget) ? 1 : 0);
      return c;
    });
    headRow.annotations = (Array.isArray(headRow.annotations) ? headRow.annotations : []).concat(shiftedAnns);
  }
  nextRow.annotations = [];
  nextRow.target_text = "";
  nextRow.target_auto_prefill = false;
  nextRow.merge_head_tid = headTid;
  nextRow.status = "merge_tail";
  // Clear unmerge intent so auto-merge can fire again on future loads.
  if (nextRow.soft_break_unmerged) {
    nextRow.soft_break_unmerged = false;
  }
  return true;
}

function unmergeTailChainFromHead(headTid) {
  const headSeg = state.segmentByTid[headTid];
  const isSoftBreakGroup = !!(headSeg && headSeg.soft_break_group);
  const tails = getMergeTailChainForHead(headTid);
  let i;
  let tid;
  let row;
  let seg;
  let prefill;
  if (!tails || tails.length === 0) {
    return false;
  }
  for (i = 0; i < tails.length; i += 1) {
    tid = tails[i];
    row = state.translationsByTid[tid];
    seg = state.segmentByTid[tid];
    if (!row) {
      continue;
    }
    row.merge_head_tid = "";
    if (row.merge_tail_backup_target || row.merge_tail_backup_status) {
      row.target_text = row.merge_tail_backup_target;
      row.status = safeStatus(row.merge_tail_backup_status) || "todo";
      row.target_auto_prefill = false;
    } else {
      prefill = buildDefaultControlPrefillText(seg && seg.source_text);
      row.target_text = prefill;
      row.status = "todo";
      row.target_auto_prefill = prefill.length > 0;
    }
    // Phase 5: restore tail annotations from backup, clip head annotations
    if (Array.isArray(row.merge_tail_backup_annotations)) {
      row.annotations = row.merge_tail_backup_annotations;
    } else {
      row.annotations = [];
    }
    row.merge_tail_backup_annotations = undefined;
    row.merge_tail_backup_target = "";
    row.merge_tail_backup_status = "";
    // Persist unmerge intent for soft-break groups so auto-merge does not
    // re-merge on next load.
    if (isSoftBreakGroup) {
      row.soft_break_unmerged = true;
    }
    // Clip restored annotations to text bounds
    clipAnnotationsToText(row.annotations, safeStr(row.target_text).length, safeStr(row.target_text));
  }
  // Clip head annotations: remove any that now exceed head's text
  var headRow = state.translationsByTid[headTid];
  if (headRow && Array.isArray(headRow.annotations)) {
    clipAnnotationsToText(headRow.annotations, safeStr(headRow.target_text).length, safeStr(headRow.target_text));
  }
  return true;
}

function formatControlTokenIssueSummary(issue) {
  const issues = issue && Array.isArray(issue.issues) ? issue.issues : [];
  if (issues.length === 0) {
    return "Control tokens detected. Keep them in target text.";
  }
  return issues.slice(0, 2).map(it => {
    const kind = it.type === "missing_token" ? "Missing" : "Extra";
    return kind + " " + safeStr(it.token);
  }).join("; ");
}

function tokenAwareHtml(text) {
  const s = safeStr(text);
  const out = [];
  const re = /\{PAGE_CURRENT\}|\{PAGE_TOTAL\}|\[\[CTRL_[0-9A-Fa-f]{4}\]\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push(escapeHtmlText(s.slice(last, m.index)));
    out.push('<span class="token-inline">' + escapeHtmlText(m[0]) + "</span>");
    last = m.index + m[0].length;
  }
  out.push(escapeHtmlText(s.slice(last)));
  return out.join("");
}

/**
 * Build overlay HTML merging token highlights + annotation highlights.
 * Token markers get <span class="token-inline">, annotation ranges get
 * <span class="ann-fmt ann-{action}" data-ann-idx="N">.
 * When both overlap on the same character range, both spans are nested.
 */
function buildOverlayHtml(text, annotations) {
  var s = safeStr(text);
  if (!s) return "";

  // Filter to valid format annotations within text bounds
  var anns = [];
  if (Array.isArray(annotations)) {
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (a && typeof a.offset === "number" && a.offset >= 0 &&
          typeof a.length === "number" && a.length > 0 &&
          a.offset + a.length <= s.length) {
        anns.push({ idx: i, type: safeStr(a.type), action: safeStr(a.action), color: safeStr(a.color), start: a.offset, end: a.offset + a.length });
      }
    }
  }

  // Collect token ranges
  var tokens = [];
  var TOKEN_RE = /\{PAGE_CURRENT\}|\{PAGE_TOTAL\}|\[\[CTRL_[0-9A-Fa-f]{4}\]\]/g;
  var m;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }

  // If no annotations and no tokens, plain text
  if (anns.length === 0 && tokens.length === 0) return escapeHtmlText(s);

  // If no annotations, fall back to simple token rendering
  if (anns.length === 0) return tokenAwareHtml(s);

  // Collect all boundary points
  var pointSet = {};
  pointSet[0] = true;
  pointSet[s.length] = true;
  for (var ti = 0; ti < tokens.length; ti++) {
    pointSet[tokens[ti].start] = true;
    pointSet[tokens[ti].end] = true;
  }
  for (var ai = 0; ai < anns.length; ai++) {
    pointSet[anns[ai].start] = true;
    pointSet[anns[ai].end] = true;
  }
  var points = Object.keys(pointSet).map(Number);
  points.sort(function (a, b) { return a - b; });

  // Precompute annotation signature per chunk for continuity detection.
  // Signature = sorted list of type+action+color — if two adjacent chunks
  // have the same signature, their highlights visually merge (no gap).
  function chunkAnnSig(chunkStart, chunkEnd) {
    var parts = [];
    for (var si = 0; si < anns.length; si++) {
      if (anns[si].start <= chunkStart && chunkEnd <= anns[si].end) {
        parts.push(anns[si].type + ":" + anns[si].action + ":" + (anns[si].color || ""));
      }
    }
    return parts.sort().join("|");
  }

  var html = "";
  var prevSig = "";
  for (var p = 0; p < points.length - 1; p++) {
    var start = points[p];
    var end = points[p + 1];
    var chunk = escapeHtmlText(s.substring(start, end));

    // Check if this range falls inside a token
    var isToken = false;
    for (var tk = 0; tk < tokens.length; tk++) {
      if (tokens[tk].start <= start && end <= tokens[tk].end) {
        isToken = true;
        break;
      }
    }

    // Collect active annotations for this range, sorted for stable nesting
    var activeAnns = [];
    for (var aj = 0; aj < anns.length; aj++) {
      if (anns[aj].start <= start && end <= anns[aj].end) {
        activeAnns.push(anns[aj]);
      }
    }
    activeAnns.sort(function (a, b) {
      var spanA = a.end - a.start, spanB = b.end - b.start;
      if (spanA !== spanB) return spanA - spanB;
      var typeA = a.type === "format" ? 1 : 0;
      var typeB = b.type === "format" ? 1 : 0;
      if (typeA !== typeB) return typeA - typeB;
      return a.idx - b.idx;
    });

    // Determine continuity: merge visually only if adjacent chunks have
    // the exact same set of annotations (same count, types, actions, colors)
    var curSig = activeAnns.length > 0 ? chunkAnnSig(start, end) : "";
    var nextSig = (p + 1 < points.length - 1 && activeAnns.length > 0) ? chunkAnnSig(points[p + 1], points[p + 2]) : "";
    var contLeft = curSig && prevSig === curSig;
    var contRight = curSig && nextSig === curSig;

    // Wrap with annotation spans
    for (var w = 0; w < activeAnns.length; w++) {
      var ann = activeAnns[w];
      var contCls = "";
      if (contLeft) contCls += " ann-cont-left";
      if (contRight) contCls += " ann-cont-right";
      chunk = '<span class="ann-highlight' + contCls + '" data-ann-idx="' + ann.idx +
        '" data-ann-type="' + escapeHtmlAttr(ann.type) +
        '" data-ann-action="' + escapeHtmlAttr(ann.action) + '">' + chunk + '</span>';
    }
    prevSig = curSig;

    // Wrap with token span (outermost)
    if (isToken) {
      chunk = '<span class="token-inline">' + chunk + '</span>';
    }

    html += chunk;
  }
  return html;
}

// ── Phase 2: Annotation toolbar (create / edit / delete) ──

var _annToolbar = null;       // singleton DOM element
var _annToolbarArea = null;   // the textarea the toolbar is attached to
var _annToolbarMode = "";     // "create" | "edit"
var _annToolbarEditIdx = -1;  // index into row.annotations when editing
var _annToolbarSelStart = 0;  // saved selection at toolbar show time
var _annToolbarSelEnd = 0;

var ANN_TOOLBAR_COLORS = [
  "#ff0000", "#0066cc", "#008800", "#ff6600", "#9933cc", "#cc0066"
];

function getOrCreateAnnToolbar() {
  if (_annToolbar) return _annToolbar;
  var tb = document.createElement("div");
  tb.id = "annotation-toolbar";
  tb.className = "ann-toolbar hidden";
  tb.innerHTML =
    '<div class="ann-tb-buttons">' +
      '<button data-ann-action="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
      '<button data-ann-action="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
      '<button data-ann-action="underline" title="Underline (Ctrl+U)"><span style="text-decoration:underline;text-underline-offset:2px">U</span></button>' +
      '<button data-ann-action="superscript" title="Superscript"><span style="font-size:0.75em;vertical-align:super">x\u00b2</span></button>' +
      '<button data-ann-action="color" title="Color"><span class="ann-tb-color-swatch"></span>A</button>' +
      '<button data-ann-action="link" title="Hyperlink (Ctrl+K)"><span style="text-decoration:underline">\ud83d\udd17</span></button>' +
      '<button data-ann-action="comment" title="Comment">\ud83d\udcac</button>' +
      '<span class="ann-tb-sep"></span>' +
      '<button data-ann-action="delete" title="Remove annotation" class="ann-tb-delete hidden">\u2715</button>' +
    '</div>' +
    // Sub-panels render top-to-bottom in DOM order. Link panel sits directly
    // beneath the button row, color panel below it, comment panel last \u2014
    // matches the user's mental model of "primary input first, swatches
    // next". Multiple panels can be open simultaneously when more than one
    // annotation type covers the selection.
    '<div class="ann-tb-link-panel hidden">' +
      '<input class="ann-tb-link-url" type="url" placeholder="https://\u2026 (Enter to apply, empty + Enter to remove)" />' +
    '</div>' +
    '<div class="ann-tb-color-panel hidden">' +
      ANN_TOOLBAR_COLORS.map(function (c) {
        return '<button class="ann-tb-color-chip" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
      }).join("") +
      '<input class="ann-tb-color-custom" type="text" placeholder="#hex" maxlength="7" />' +
    '</div>' +
    '<div class="ann-tb-comment-panel hidden">' +
      '<textarea class="ann-tb-comment-input" rows="1" placeholder="Add comment\u2026"></textarea>' +
    '</div>';
  // Prevent blur on the target textarea when clicking toolbar buttons,
  // but allow focus on input/textarea elements within the toolbar itself
  tb.addEventListener("mousedown", function (e) {
    var tag = e.target.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
  });
  tb.addEventListener("click", onAnnToolbarClick);
  document.body.appendChild(tb);
  _annToolbar = tb;
  return tb;
}

// ── Phase 3: Offset adjustment on text edit ──

/**
 * Diff two strings to find the single edit range (prefix/suffix matching).
 * Returns { editOffset, deleteCount, insertCount }.
 */
function diffEditRange(oldText, newText) {
  if (oldText === newText) return { editOffset: 0, deleteCount: 0, insertCount: 0 };
  var minLen = Math.min(oldText.length, newText.length);
  var prefix = 0;
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;
  var suffixOld = oldText.length;
  var suffixNew = newText.length;
  while (suffixOld > prefix && suffixNew > prefix && oldText[suffixOld - 1] === newText[suffixNew - 1]) {
    suffixOld--;
    suffixNew--;
  }
  return {
    editOffset: prefix,
    deleteCount: suffixOld - prefix,
    insertCount: suffixNew - prefix
  };
}

/**
 * Adjust annotation offsets after a text edit.
 * Pure function — returns new array, does not mutate input.
 */
function adjustAnnotationOffsets(annotations, editOffset, deleteCount, insertCount, newText) {
  if (!Array.isArray(annotations) || annotations.length === 0) return [];
  var delta = insertCount - deleteCount;
  var editEnd = editOffset + deleteCount;
  var result = [];
  for (var i = 0; i < annotations.length; i++) {
    var a = {};
    for (var k in annotations[i]) a[k] = annotations[i][k];
    var annEnd = a.offset + a.length;

    if (a.offset >= editEnd) {
      // Edit before annotation → shift
      a.offset += delta;
    } else if (a.offset >= editOffset) {
      // Annotation start inside edit range
      if (annEnd <= editEnd) {
        // Fully covered → delete
        a.length = 0;
      } else {
        // Start eaten, tail survives
        var overlap = editEnd - a.offset;
        a.offset = editOffset + insertCount;
        a.length -= overlap;
      }
    } else if (annEnd > editOffset) {
      // Annotation spans edit point
      if (annEnd <= editEnd) {
        // Tail truncated
        a.length = editOffset - a.offset;
      } else {
        // Edit inside annotation
        a.length += delta;
      }
    }
    // else: edit after annotation → no change

    if (a.length > 0 && a.offset >= 0 && a.offset + a.length <= newText.length) {
      a.text = newText.substring(a.offset, a.offset + a.length);
      result.push(a);
    }
  }
  return result;
}

/**
 * Bind beforeinput/composition events for annotation offset tracking.
 * Must be called once per target textarea.
 */
function bindAnnOffsetTracking(area) {
  if (area.__annOffsetBound) return;
  area.__annOffsetBound = true;

  var composing = false;
  var oldText = area.value || "";

  // Keep oldText in sync — update after each adjustment cycle
  area.__annOldText = oldText;

  area.addEventListener("compositionstart", function () {
    composing = true;
    area.__annComposing = true;
    area.__annComposeOffset = area.selectionStart;
  });
  area.addEventListener("compositionend", function () {
    composing = false;
    area.__annComposing = false;
    // Trigger adjustment after IME commit
    adjustAfterEdit(area);
  });

  area.addEventListener("input", function () {
    if (composing) return; // Wait for compositionend
    adjustAfterEdit(area);
  });

  function adjustAfterEdit(area) {
    var tid = resolveTextareaTid(area);
    var row = tid && state.translationsByTid[tid];
    if (!row || !Array.isArray(row.annotations) || row.annotations.length === 0) {
      area.__annOldText = area.value || "";
      return;
    }
    var old = area.__annOldText || "";
    var cur = area.value || "";
    if (old === cur) return;
    var diff = diffEditRange(old, cur);
    row.annotations = adjustAnnotationOffsets(row.annotations, diff.editOffset, diff.deleteCount, diff.insertCount, cur);
    area.__annOldText = cur;
  }
}

/** Sync all visuals after any annotation change: overlay + hotspot preview. */
function syncAnnotationVisuals(area) {
  syncTokenOverlayForTextarea(area);
  var tid = resolveTextareaTid(area);
  if (tid) updateHotspotText(tid);
}

function resolveTextareaTid(area) {
  if (!area) return "";
  if (area.id === "targetInput") return safeStr(state.selectedTid);
  return safeStr(area.getAttribute && area.getAttribute("data-card-target"));
}

function showAnnToolbar(area, mode, editIdx) {
  var tb = getOrCreateAnnToolbar();
  _annToolbarArea = area;
  _annToolbarMode = mode;
  _annToolbarEditIdx = typeof editIdx === "number" ? editIdx : -1;
  _annToolbarSelStart = area.selectionStart;
  _annToolbarSelEnd = area.selectionEnd;

  // Position toolbar above textarea, horizontally centered
  // (estimateCaretXY mirror div is unreliable for CJK mixed text — see findings.md)
  var areaRect = area.getBoundingClientRect();
  tb.classList.remove("hidden");
  var tbWidth = tb.getBoundingClientRect().width || 200;
  var tbX = areaRect.left + (areaRect.width - tbWidth) / 2;
  tbX = Math.max(4, Math.min(tbX, window.innerWidth - tbWidth - 4));
  var tbBottom = window.innerHeight - areaRect.top + 4;
  tb.style.left = tbX + "px";
  tb.style.bottom = tbBottom + "px";
  tb.style.top = "auto";
  var tbRect = tb.getBoundingClientRect();
  if (tbRect.top < 4) {
    tb.style.bottom = "auto";
    tb.style.top = (areaRect.bottom + 4) + "px";
  }

  // Show/hide delete button based on mode
  var delBtn = tb.querySelector('[data-ann-action="delete"]');
  if (delBtn) delBtn.classList.toggle("hidden", mode !== "edit");

  // Highlight active format in edit mode
  updateAnnToolbarActiveState(area, editIdx);

  // Hide sub-panels first
  hideAnnSubPanels();

  // If a comment annotation covers the selection, auto-show comment input with existing text
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  if (row && Array.isArray(row.annotations) && mode === "edit") {
    var s = area.selectionStart, e = area.selectionEnd;
    var cov = findAnnotationsInRange(row.annotations, s, Math.max(e, s + 1));
    for (var ci = 0; ci < cov.length; ci++) {
      var ca = row.annotations[cov[ci]];
      if (ca.type === "comment") {
        var mp = tb.querySelector(".ann-tb-comment-panel");
        var ta = mp ? mp.querySelector(".ann-tb-comment-input") : null;
        if (mp && ta) {
          mp.classList.remove("hidden");
          ta.value = safeStr(ca.text);
          ta.__annCommentIdx = cov[ci];
          ta.onblur = function () { submitOrUpdateComment(ta); };
          ta.oninput = function () { autoSizeCommentInput(ta); };
          autoSizeCommentInput(ta);
        }
      }
      if (ca.type === "format" && ca.action === "color") {
        var cp = tb.querySelector(".ann-tb-color-panel");
        if (cp) {
          cp.classList.remove("hidden");
          syncColorChipSelection(safeStr(ca.color));
        }
      }
      if (ca.type === "format" && ca.action === "link") {
        // Auto-show link URL input when a link annotation covers selection —
        // mirrors color/comment auto-show above. No focus-steal: translator
        // is mid-selection in the textarea, so we just surface the value;
        // clicking the URL field or pressing Ctrl+K focuses it.
        showLinkPanel({ focus: false, existingLinkIdx: cov[ci], row: row });
      }
    }
  }
}

// Render the link URL panel pre-filled from an existing link annotation if
// one covers the current selection. Wires Enter/Escape/blur handlers in one
// place so the click-toggle path and the auto-show path stay in sync.
function showLinkPanel(opts) {
  if (!_annToolbar) return;
  var lp = _annToolbar.querySelector(".ann-tb-link-panel");
  if (!lp) return;
  lp.classList.remove("hidden");
  var urlInput = lp.querySelector(".ann-tb-link-url");
  if (!urlInput) return;

  var row = opts && opts.row;
  var existingLinkIdx = opts && typeof opts.existingLinkIdx === "number" ? opts.existingLinkIdx : -1;
  var existingUrl = (existingLinkIdx >= 0 && row && row.annotations && row.annotations[existingLinkIdx] && row.annotations[existingLinkIdx].url) || "";
  urlInput.value = existingUrl;

  if (opts && opts.focus) {
    // Defer focus so panel paint settles first; otherwise textarea blur
    // can re-hide the toolbar before focus lands.
    setTimeout(function () { urlInput.focus(); urlInput.select(); }, 0);
  }

  urlInput.onkeydown = function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      var val = urlInput.value.trim();
      updateActiveLinkAnnotation(val, existingLinkIdx);
      lp.classList.add("hidden");
    } else if (ev.key === "Escape") {
      lp.classList.add("hidden");
    }
  };
  urlInput.onblur = function () {
    // Auto-commit on blur (forgiving UX, matches color panel hex input).
    var val = urlInput.value.trim();
    if (val !== existingUrl) {
      updateActiveLinkAnnotation(val, existingLinkIdx);
    }
  };
}

function hideAnnToolbar() {
  if (_annToolbar) {
    // Flush any pending comment before tearing down
    var ta = _annToolbar.querySelector(".ann-tb-comment-input");
    if (ta && ta.onblur && _annToolbarArea) {
      submitOrUpdateComment(ta);
    }
    _annToolbar.classList.add("hidden");
    hideAnnSubPanels();
  }
  _annToolbarArea = null;
  _annToolbarMode = "";
  _annToolbarEditIdx = -1;
  _annToolbarSelStart = 0;
  _annToolbarSelEnd = 0;
}

function hideAnnSubPanels() {
  if (!_annToolbar) return;
  var cp = _annToolbar.querySelector(".ann-tb-color-panel");
  if (cp) {
    var hex = cp.querySelector(".ann-tb-color-custom");
    if (hex) { hex.value = ""; hex.onkeydown = null; hex.onblur = null; }
    var chips = cp.querySelectorAll(".ann-tb-color-chip");
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove("selected");
    cp.classList.add("hidden");
  }
  var mp = _annToolbar.querySelector(".ann-tb-comment-panel");
  if (mp) {
    var ta = mp.querySelector(".ann-tb-comment-input");
    if (ta) {
      ta.onblur = null; // detach to prevent ghost fires
      ta.oninput = null;
      ta.value = "";
      ta.__annCommentIdx = -1;
    }
    mp.classList.add("hidden");
  }
  // Link panel: detach handlers + clear value
  var lp = _annToolbar.querySelector(".ann-tb-link-panel");
  if (lp) {
    var li = lp.querySelector(".ann-tb-link-url");
    if (li) {
      li.onkeydown = null;
      li.onblur = null;
      li.value = "";
    }
    lp.classList.add("hidden");
  }
}

function updateAnnToolbarActiveState(area, editIdx) {
  if (!_annToolbar) return;
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  // Collect all active formats/types covering the selection or cursor
  var activeActions = {};
  if (row && Array.isArray(row.annotations)) {
    var start = area.selectionStart;
    var end = area.selectionEnd;
    if (start === end) end = start + 1; // cursor: check single position
    var covering = findAnnotationsInRange(row.annotations, start, end);
    for (var c = 0; c < covering.length; c++) {
      var ca = row.annotations[covering[c]];
      if (ca.type === "comment") activeActions["comment"] = true;
      else if (ca.action) activeActions[ca.action] = true;
    }
  }
  var btns = _annToolbar.querySelectorAll("[data-ann-action]");
  for (var i = 0; i < btns.length; i++) {
    var action = btns[i].getAttribute("data-ann-action");
    if (action === "delete") continue;
    btns[i].classList.toggle("active", !!activeActions[action]);
  }
}

/**
 * Estimate pixel position of a caret offset within a textarea.
 * Uses a hidden mirror div to measure text up to the caret.
 */
function estimateCaretXY(area, offset) {
  var mirror = document.getElementById("_ann_caret_mirror");
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.id = "_ann_caret_mirror";
    mirror.style.cssText = "position:absolute;visibility:hidden;white-space:pre-wrap;word-break:break-word;overflow:hidden;pointer-events:none;";
    document.body.appendChild(mirror);
  }
  var cs = window.getComputedStyle(area);
  mirror.style.font = cs.font;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.textAlign = cs.textAlign;
  mirror.style.textIndent = cs.textIndent;
  mirror.style.padding = cs.padding;
  mirror.style.border = cs.border;
  mirror.style.borderRadius = cs.borderRadius;
  mirror.style.boxSizing = cs.boxSizing;
  mirror.style.width = area.offsetWidth + "px"; // use actual rendered pixel width, not computed

  var text = area.value || "";
  var before = text.substring(0, offset);
  mirror.textContent = before;
  var span = document.createElement("span");
  span.textContent = text.substring(offset, offset + 1) || "\u200b";
  mirror.appendChild(span);

  var areaRect = area.getBoundingClientRect();
  var spanRect = span.getBoundingClientRect();
  var mirrorRect = mirror.getBoundingClientRect();
  mirror.textContent = "";

  return {
    x: Math.max(areaRect.left, Math.min(spanRect.left, areaRect.right - 10)),
    y: areaRect.top + (spanRect.top - mirrorRect.top) - area.scrollTop
  };
}

/** Clip annotations to text length — truncate or remove out-of-bounds. Mutates in place.
 *  fullText (optional): if provided, syncs a.text and rebuilds context. */
function clipAnnotationsToText(annotations, textLength, fullText) {
  if (!Array.isArray(annotations)) return;
  for (var i = annotations.length - 1; i >= 0; i--) {
    var a = annotations[i];
    if (typeof a.offset !== "number" || a.offset >= textLength || a.offset < 0) {
      annotations.splice(i, 1);
    } else if (a.offset + a.length > textLength) {
      a.length = textLength - a.offset;
      if (a.length <= 0) {
        annotations.splice(i, 1);
      } else if (fullText) {
        a.text = fullText.substring(a.offset, a.offset + a.length);
        var ctx = buildAnnotationContext(fullText, a.offset, a.length);
        a.context_before = ctx.context_before;
        a.context_after = ctx.context_after;
      }
    }
  }
}

/** Return index of the narrowest annotation covering offset (matches overlay innermost). */
function findAnnotationAtOffset(annotations, offset) {
  if (!Array.isArray(annotations)) return -1;
  var bestIdx = -1, bestLen = Infinity;
  for (var i = 0; i < annotations.length; i++) {
    var a = annotations[i];
    if (typeof a.offset === "number" && typeof a.length === "number" &&
        a.offset <= offset && offset < a.offset + a.length) {
      if (a.length < bestLen) {
        bestLen = a.length;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

/**
 * Merge adjacent or overlapping annotations with identical type+action+color.
 * Mutates the array in place.
 */
function mergeAdjacentAnnotations(annotations, fullText) {
  if (!Array.isArray(annotations) || annotations.length < 2) return;

  // Sort by offset so adjacent ones are next to each other
  annotations.sort(function (a, b) { return a.offset - b.offset; });

  var i = 0;
  while (i < annotations.length - 1) {
    var cur = annotations[i];
    var nxt = annotations[i + 1];
    // Same type + action + color → candidates for merge
    if (cur.type === nxt.type && cur.action === nxt.action &&
        (cur.color || "") === (nxt.color || "")) {
      var curEnd = cur.offset + cur.length;
      // Adjacent (touching) or overlapping
      if (curEnd >= nxt.offset) {
        var mergedEnd = Math.max(curEnd, nxt.offset + nxt.length);
        cur.length = mergedEnd - cur.offset;
        if (fullText) cur.text = fullText.substring(cur.offset, cur.offset + cur.length);
        annotations.splice(i + 1, 1);
        continue; // re-check current with next
      }
    }
    i++;
  }
}

/**
 * Build context_before/context_after for an annotation.
 * Starts with 10 chars, expands by 10 until the annotation text is unique
 * within targetText, or reaches maxCtx (50).
 */
function buildAnnotationContext(targetText, offset, length) {
  var text = targetText.substring(offset, offset + length);
  var ctxLen = 10;
  var maxCtx = 50;
  var before, after;
  while (ctxLen <= maxCtx) {
    before = targetText.substring(Math.max(0, offset - ctxLen), offset);
    after = targetText.substring(offset + length, offset + length + ctxLen);
    // Check uniqueness: count occurrences of text in targetText
    var needle = before + text + after;
    var count = 0, searchFrom = 0;
    while (true) {
      var pos = targetText.indexOf(needle, searchFrom);
      if (pos < 0) break;
      count++;
      if (count > 1) break;
      searchFrom = pos + 1;
    }
    if (count <= 1) break;
    ctxLen += 10;
  }
  return {
    context_before: targetText.substring(Math.max(0, offset - ctxLen), offset),
    context_after: targetText.substring(offset + length, offset + length + ctxLen)
  };
}

function createAnnotation(area, action, extra) {
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  if (!row) return;
  var start = area.selectionStart;
  var end = area.selectionEnd;
  if (start === end) return; // no selection
  var text = (area.value || "").substring(start, end);
  if (!text) return;

  if (!Array.isArray(row.annotations)) row.annotations = [];

  var ctx = buildAnnotationContext(area.value || "", start, end - start);
  var ann = {
    type: action === "comment" ? "comment" : "format",
    action: action === "comment" ? "" : action,
    text: text,
    offset: start,
    length: end - start,
    context_before: ctx.context_before,
    context_after: ctx.context_after
  };
  if (action === "color") {
    ann.color = (extra && extra.color) || ANN_TOOLBAR_COLORS[0];
  }
  if (action === "link") {
    ann.url = (extra && extra.url) || "";
    if (!ann.url) return;   // refuse empty URL — schema validator rejects
    if (!isSafeUrl(ann.url)) {
      console.warn("[annotation] refusing unsafe URL scheme:", ann.url);
      return;
    }
  }
  if (action === "comment") {
    ann.text = (extra && extra.comment) || text;
    ann.offset = start;
    ann.length = end - start;
  }
  row.annotations.push(ann);
  if (action === "link") {
    addLinkCompanionAnnotations(row, area, start, end - start);
  }
  syncAnnotationVisuals(area);
  refreshAnnToolbar();
}

// Default color applied alongside every link annotation. Picked from the
// existing toolbar palette so the chip lights up after creation and the
// translator can change/remove it via the regular color toolbar.
var LINK_DEFAULT_COLOR = "#0066cc";

// #SEC-A: Refuse javascript:, data:, vbscript:, etc. on link annotations.
// rel="noopener noreferrer" + target="_blank" do NOT block script-protocol
// navigation — clicking <a href="javascript:..."> still runs the URL in the
// current origin, which here is the local server with full filesystem API
// access. Allowlist exactly the protocols that make sense for a translation
// hyperlink: http/https and mailto. Relative URLs resolve against the
// current page so a translator-typed "/foo" also lands as http(s):.
function isSafeUrl(u) {
  if (typeof u !== "string" || !u) return false;
  try {
    var p = new URL(u, location.href).protocol;
    return p === "http:" || p === "https:" || p === "mailto:";
  } catch (e) { return false; }
}

// When the translator creates a link annotation (toolbar Ctrl+K, source-link
// paint, etc.), also push a regular `color` and `underline` annotation at the
// same range — UNLESS one already covers the exact same range. Result: the
// "blue + underlined" hyperlink look is composed from three independent
// annotations the translator can toggle/edit individually via the standard
// toolbar (U button, color chips), rather than baked into a single link
// entry with hidden styling.
//
// `opts.color` overrides LINK_DEFAULT_COLOR — source-link paint passes the
// color extracted from the source's emphasis run so painted links match the
// original document's link color (e.g., brand blue) instead of a fixed hex.
function addLinkCompanionAnnotations(row, area, offset, length, opts) {
  if (!row || !area || length <= 0) return;
  if (!Array.isArray(row.annotations)) row.annotations = [];
  var fullText = area.value || "";
  var text = fullText.substring(offset, offset + length);
  if (!text) return;

  var hasColor = false, hasUnderline = false;
  for (var i = 0; i < row.annotations.length; i++) {
    var a = row.annotations[i];
    if (!a || a.type !== "format") continue;
    if (a.offset !== offset || a.length !== length) continue;
    if (a.action === "color") hasColor = true;
    else if (a.action === "underline") hasUnderline = true;
  }
  if (hasColor && hasUnderline) return;

  var ctx = buildAnnotationContext(fullText, offset, length);
  var color = (opts && opts.color) || LINK_DEFAULT_COLOR;
  if (!hasColor) {
    row.annotations.push({
      type: "format",
      action: "color",
      text: text,
      offset: offset,
      length: length,
      color: color,
      context_before: ctx.context_before,
      context_after: ctx.context_after
    });
  }
  if (!hasUnderline) {
    row.annotations.push({
      type: "format",
      action: "underline",
      text: text,
      offset: offset,
      length: length,
      context_before: ctx.context_before,
      context_after: ctx.context_after
    });
  }
}

function deleteAnnotation(area, idx) {
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  if (!row || !Array.isArray(row.annotations) || idx < 0 || idx >= row.annotations.length) return;
  row.annotations.splice(idx, 1);
  syncAnnotationVisuals(area);
  refreshAnnToolbar();
}

/** Refresh toolbar active state after an annotation change without hiding it. */
function refreshAnnToolbar() {
  if (!_annToolbar || !_annToolbarArea) return;
  updateAnnToolbarActiveState(_annToolbarArea, _annToolbarEditIdx);
  // Update delete button visibility — show if any annotation covers selection
  var tid = resolveTextareaTid(_annToolbarArea);
  var row = tid && state.translationsByTid[tid];
  var s = _annToolbarSelStart, e = _annToolbarSelEnd;
  var hasAnn = row && Array.isArray(row.annotations) &&
    findAnnotationsInRange(row.annotations, s, Math.max(e, s + 1)).length > 0;
  var delBtn = _annToolbar.querySelector('[data-ann-action="delete"]');
  if (delBtn) delBtn.classList.toggle("hidden", !hasAnn);
  _annToolbarMode = hasAnn ? "edit" : "create";
}

/**
 * Remove an annotation from a sub-range, splitting if needed.
 * If selection covers the whole annotation → delete. Otherwise split.
 */
function removeAnnotationFromRange(area, annIdx, selStart, selEnd) {
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  if (!row || !row.annotations || !row.annotations[annIdx]) return;
  var ann = row.annotations[annIdx];
  var mStart = ann.offset;
  var mEnd = ann.offset + ann.length;
  var fullText = area.value || "";

  if (selStart <= mStart && selEnd >= mEnd) {
    row.annotations.splice(annIdx, 1);
  } else {
    var newAnns = [];
    if (mStart < selStart) {
      var left = {};
      for (var k in ann) left[k] = ann[k];
      left.offset = mStart;
      left.length = selStart - mStart;
      left.text = fullText.substring(left.offset, left.offset + left.length);
      var ctxL = buildAnnotationContext(fullText, left.offset, left.length);
      left.context_before = ctxL.context_before;
      left.context_after = ctxL.context_after;
      newAnns.push(left);
    }
    if (selEnd < mEnd) {
      var right = {};
      for (var k2 in ann) right[k2] = ann[k2];
      right.offset = selEnd;
      right.length = mEnd - selEnd;
      right.text = fullText.substring(right.offset, right.offset + right.length);
      var ctxR = buildAnnotationContext(fullText, right.offset, right.length);
      right.context_before = ctxR.context_before;
      right.context_after = ctxR.context_after;
      newAnns.push(right);
    }
    row.annotations.splice(annIdx, 1);
    for (var ni = 0; ni < newAnns.length; ni++) row.annotations.push(newAnns[ni]);
  }
  syncAnnotationVisuals(area);
  refreshAnnToolbar();
}

/** Update the color of the active color annotation covering the toolbar selection.
 *  If none exists, create one. If selection is a sub-range, split first. */
function updateActiveColorAnnotation(color) {
  if (!_annToolbarArea) return;
  var tid = resolveTextareaTid(_annToolbarArea);
  var row = tid && state.translationsByTid[tid];
  if (!row) return;
  if (!Array.isArray(row.annotations)) row.annotations = [];
  var s = _annToolbarSelStart, e = Math.max(_annToolbarSelEnd, _annToolbarSelStart + 1);
  var cov = findAnnotationsInRange(row.annotations, s, e);
  for (var i = 0; i < cov.length; i++) {
    var a = row.annotations[cov[i]];
    if (a.type === "format" && a.action === "color") {
      // If selection matches annotation exactly, just update color
      if (a.offset === s && a.offset + a.length === e) {
        a.color = color;
        syncAnnotationVisuals(_annToolbarArea);
        refreshAnnToolbar();
        return;
      }
      // Sub-range: remove old from selection range, then create new with chosen color
      removeAnnotationFromRange(_annToolbarArea, cov[i], s, e);
      _annToolbarArea.selectionStart = _annToolbarSelStart;
      _annToolbarArea.selectionEnd = _annToolbarSelEnd;
      createAnnotation(_annToolbarArea, "color", { color: color });
      return;
    }
  }
  // No color annotation found — create one
  _annToolbarArea.selectionStart = _annToolbarSelStart;
  _annToolbarArea.selectionEnd = _annToolbarSelEnd;
  createAnnotation(_annToolbarArea, "color", { color: color });
}

/**
 * Apply / update / remove a hyperlink annotation on the current
 * toolbar selection. Mirrors updateActiveColorAnnotation. Empty `url`
 * removes the link (so users can clear it without deleting the whole
 * annotation via the X button — the panel stays focused on link UX).
 */
function updateActiveLinkAnnotation(url, hintExistingIdx) {
  if (!_annToolbarArea) return;
  var tid = resolveTextareaTid(_annToolbarArea);
  var row = tid && state.translationsByTid[tid];
  if (!row) return;
  if (!Array.isArray(row.annotations)) row.annotations = [];
  var s = _annToolbarSelStart, e = Math.max(_annToolbarSelEnd, _annToolbarSelStart + 1);
  var cov = findAnnotationsInRange(row.annotations, s, e);
  // First try the hint, fall back to scan for type=format/action=link
  var existingIdx = -1;
  if (typeof hintExistingIdx === "number" && hintExistingIdx >= 0
      && row.annotations[hintExistingIdx]
      && row.annotations[hintExistingIdx].type === "format"
      && row.annotations[hintExistingIdx].action === "link") {
    existingIdx = hintExistingIdx;
  } else {
    for (var i = 0; i < cov.length; i++) {
      var a = row.annotations[cov[i]];
      if (a.type === "format" && a.action === "link") { existingIdx = cov[i]; break; }
    }
  }

  if (!url) {
    // Remove path: drop the existing link annotation if any.
    if (existingIdx >= 0) {
      removeAnnotationFromRange(_annToolbarArea, existingIdx, s, e);
      refreshAnnToolbar();
    }
    return;
  }

  if (existingIdx >= 0) {
    var ex = row.annotations[existingIdx];
    if (ex.offset === s && ex.offset + ex.length === e) {
      // Exact-range existing link → just update URL in place.
      ex.url = url;
      syncAnnotationVisuals(_annToolbarArea);
      refreshAnnToolbar();
      return;
    }
    // Sub-range or mismatch → remove old over selection, create new.
    removeAnnotationFromRange(_annToolbarArea, existingIdx, s, e);
  }
  _annToolbarArea.selectionStart = _annToolbarSelStart;
  _annToolbarArea.selectionEnd = _annToolbarSelEnd;
  createAnnotation(_annToolbarArea, "link", { url: url });
}

/** Highlight the selected color chip (radio behavior) and update swatch. */
function syncColorChipSelection(activeColor) {
  if (!_annToolbar) return;
  var chips = _annToolbar.querySelectorAll(".ann-tb-color-chip");
  var matchedChip = false;
  for (var i = 0; i < chips.length; i++) {
    var chipColor = chips[i].getAttribute("data-color");
    var match = !!activeColor && chipColor && chipColor.toLowerCase() === activeColor.toLowerCase();
    chips[i].classList.toggle("selected", match);
    if (match) matchedChip = true;
  }
  var swatch = _annToolbar.querySelector(".ann-tb-color-swatch");
  if (swatch && activeColor) swatch.style.background = activeColor;
  // Reflect the active color in the #hex text input — empty when none, full
  // hex when the color isn't one of the preset chip values (so paint-applied
  // custom RGB triplets like #C81E1E from FixtureRed swatch show in the
  // input ready for editing).
  var hexInput = _annToolbar.querySelector(".ann-tb-color-custom");
  if (hexInput) {
    hexInput.value = activeColor ? activeColor : "";
  }
}

function autoSizeCommentInput(ta) {
  if (!ta) return;
  ta.style.height = "1.6em";
  ta.style.height = Math.min(ta.scrollHeight, parseFloat(getComputedStyle(ta).maxHeight) || 999) + "px";
}

/** Auto-submit comment on blur: update existing, create new, or delete if empty.
 *  Also hides toolbar if focus left the toolbar entirely. */
function submitOrUpdateComment(ta) {
  if (!ta || !_annToolbarArea) return;
  // Detach handler immediately to prevent double-fire
  ta.onblur = null;
  ta.oninput = null;
  var val = ta.value.trim();
  var idx = ta.__annCommentIdx;
  var area = _annToolbarArea;
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  if (!row) return;

  if (typeof idx === "number" && idx >= 0 && row.annotations && row.annotations[idx]) {
    if (val) {
      row.annotations[idx].text = val;
    } else {
      row.annotations.splice(idx, 1);
    }
    syncAnnotationVisuals(area);
  } else if (val) {
    area.selectionStart = _annToolbarSelStart;
    area.selectionEnd = _annToolbarSelEnd;
    createAnnotation(area, "comment", { comment: val });
  }

  // Hide toolbar after comment submit — focus has left the toolbar
  setTimeout(function () {
    if (_annToolbar && !_annToolbar.contains(document.activeElement) &&
        document.activeElement !== _annToolbarArea) {
      hideAnnToolbar();
    }
  }, 50);
}

function onAnnToolbarClick(e) {
  // In edit mode with no user selection (cursor click), auto-select the
  // annotation's text range so the user can see what they're affecting.
  // If the user already has a selection (sub-range), preserve it.
  if (_annToolbarMode === "edit" && _annToolbarArea && _annToolbarEditIdx >= 0 &&
      _annToolbarSelStart === _annToolbarSelEnd) {
    var tidSel = resolveTextareaTid(_annToolbarArea);
    var rowSel = tidSel && state.translationsByTid[tidSel];
    if (rowSel && rowSel.annotations && rowSel.annotations[_annToolbarEditIdx]) {
      var annSel = rowSel.annotations[_annToolbarEditIdx];
      _annToolbarArea.selectionStart = annSel.offset;
      _annToolbarArea.selectionEnd = annSel.offset + annSel.length;
      _annToolbarSelStart = annSel.offset;
      _annToolbarSelEnd = annSel.offset + annSel.length;
    }
  }
  var btn = e.target.closest("[data-ann-action]");
  var colorChip = e.target.closest(".ann-tb-color-chip");

  // Color chip click — toggle: same color = remove (with split), different = update/create
  if (colorChip) {
    var color = colorChip.getAttribute("data-color");
    var tidChip = resolveTextareaTid(_annToolbarArea);
    var rowChip = tidChip && state.translationsByTid[tidChip];
    var removedColor = false;
    var s2 = _annToolbarSelStart, e2 = _annToolbarSelEnd;
    if (rowChip && Array.isArray(rowChip.annotations)) {
      var covChip = findAnnotationsInRange(rowChip.annotations, s2, Math.max(e2, s2 + 1));
      for (var chi = 0; chi < covChip.length; chi++) {
        var ca = rowChip.annotations[covChip[chi]];
        if (ca.type === "format" && ca.action === "color" && ca.color === color) {
          removeAnnotationFromRange(_annToolbarArea, covChip[chi], s2, Math.max(e2, s2 + 1));
          syncColorChipSelection("");
          removedColor = true;
          break;
        }
      }
    }
    if (!removedColor) {
      updateActiveColorAnnotation(color);
      syncColorChipSelection(color);
    }
    return;
  }

  if (!btn) return;
  var action = btn.getAttribute("data-ann-action");

  if (action === "delete") {
    if (_annToolbarMode === "edit" && _annToolbarArea) {
      var tidDel = resolveTextareaTid(_annToolbarArea);
      var rowDel = tidDel && state.translationsByTid[tidDel];
      if (rowDel && Array.isArray(rowDel.annotations)) {
        var s = _annToolbarArea.selectionStart, e = _annToolbarArea.selectionEnd;
        var indices = findAnnotationsInRange(rowDel.annotations, s, Math.max(e, s + 1));
        indices.sort(function (a, b) { return b - a; });
        for (var di = 0; di < indices.length; di++) {
          rowDel.annotations.splice(indices[di], 1);
        }
        syncAnnotationVisuals(_annToolbarArea);
      }
      refreshAnnToolbar();
    }
    return;
  }

  if (action === "color") {
    // Like comment: immediately create color annotation → show panel for changing
    var area = _annToolbarArea;
    if (!area) return;

    // Find existing color annotation in range
    var tidCol = resolveTextareaTid(area);
    var rowCol = tidCol && state.translationsByTid[tidCol];
    var existingColorIdx = -1;
    if (rowCol && Array.isArray(rowCol.annotations)) {
      var covCol = findAnnotationsInRange(rowCol.annotations, _annToolbarSelStart, Math.max(_annToolbarSelEnd, _annToolbarSelStart + 1));
      for (var cci = 0; cci < covCol.length; cci++) {
        if (rowCol.annotations[covCol[cci]].type === "format" && rowCol.annotations[covCol[cci]].action === "color") {
          existingColorIdx = covCol[cci];
          break;
        }
      }
    }

    // Don't auto-create — just show panel. Annotation created when user picks a color.

    // Show/toggle color panel
    var cp = _annToolbar.querySelector(".ann-tb-color-panel");
    if (cp) {
      cp.classList.toggle("hidden");
      // Clear hex input
      var customInput = cp.querySelector(".ann-tb-color-custom");
      if (customInput) {
        customInput.value = "";
        customInput.onkeydown = function (ev) {
          if (ev.key === "Enter") {
            var val = customInput.value.trim();
            // Accept with or without #
            if (/^[0-9a-fA-F]{3,6}$/.test(val)) val = "#" + val;
            if (/^#[0-9a-fA-F]{3,6}$/.test(val)) {
              updateActiveColorAnnotation(val);
              syncColorChipSelection(val);
              customInput.value = val;
            }
          }
        };
        customInput.onblur = function () {
          var val = customInput.value.trim();
          if (!val) return;
          if (/^[0-9a-fA-F]{3,6}$/.test(val)) val = "#" + val;
          if (/^#[0-9a-fA-F]{3,6}$/.test(val)) {
            updateActiveColorAnnotation(val);
            syncColorChipSelection(val);
          }
        };
      }
      // Highlight current color in chips
      var currentColor = "";
      if (rowCol && existingColorIdx >= 0 && rowCol.annotations[existingColorIdx]) {
        currentColor = rowCol.annotations[existingColorIdx].color || "";
      } else if (rowCol) {
        // Just created — find last color annotation
        for (var fi = rowCol.annotations.length - 1; fi >= 0; fi--) {
          if (rowCol.annotations[fi].action === "color") { currentColor = rowCol.annotations[fi].color || ""; break; }
        }
      }
      syncColorChipSelection(currentColor);
    }
    return;
  }

  if (action === "link") {
    // Show the URL panel (similar pattern to the color panel above).
    // Don't auto-create an annotation — only commit when the user
    // confirms a URL with Enter or blurs the field with a valid value.
    var areaLk = _annToolbarArea;
    if (!areaLk) return;

    var tidLk = resolveTextareaTid(areaLk);
    var rowLk = tidLk && state.translationsByTid[tidLk];
    var existingLinkIdx = -1;
    if (rowLk && Array.isArray(rowLk.annotations)) {
      var covLk = findAnnotationsInRange(rowLk.annotations, _annToolbarSelStart, Math.max(_annToolbarSelEnd, _annToolbarSelStart + 1));
      for (var lci = 0; lci < covLk.length; lci++) {
        var caL = rowLk.annotations[covLk[lci]];
        if (caL.type === "format" && caL.action === "link") { existingLinkIdx = covLk[lci]; break; }
      }
    }

    showLinkPanel({ focus: true, existingLinkIdx: existingLinkIdx, row: rowLk });
    return;
  }

  if (action === "comment") {
    // Immediately create comment annotation with empty text → shows highlight
    // User types in input; on blur, update text or delete if empty
    var area = _annToolbarArea;
    if (!area) return;
    area.selectionStart = _annToolbarSelStart;
    area.selectionEnd = _annToolbarSelEnd;
    createAnnotation(area, "comment", { comment: "" });
    // Find the just-created comment annotation index
    var tidCm = resolveTextareaTid(area);
    var rowCm = tidCm && state.translationsByTid[tidCm];
    var newIdx = -1;
    if (rowCm && Array.isArray(rowCm.annotations)) {
      for (var ci = rowCm.annotations.length - 1; ci >= 0; ci--) {
        if (rowCm.annotations[ci].type === "comment") { newIdx = ci; break; }
      }
    }
    var mp = _annToolbar.querySelector(".ann-tb-comment-panel");
    if (mp) {
      mp.classList.remove("hidden");
      var ta = mp.querySelector(".ann-tb-comment-input");
      if (ta) {
        ta.value = "";
        ta.__annCommentIdx = newIdx;
        ta.focus();
        ta.onblur = function () { submitOrUpdateComment(ta); };
        ta.oninput = function () { autoSizeCommentInput(ta); };
        autoSizeCommentInput(ta);
      }
    }
    return;
  }

  // Format actions: toggle the specific type — remove if exists, add if not.
  // Multiple formats can coexist on the same range.
  var tid2 = resolveTextareaTid(_annToolbarArea);
  var row2 = tid2 && state.translationsByTid[tid2];
  if (row2 && _annToolbarMode === "edit") {
    var start2 = _annToolbarArea.selectionStart;
    var end2 = _annToolbarArea.selectionEnd;
    // Find if this specific action/type already exists on the covering range
    var matchIdx2 = -1;
    var covering2 = findAnnotationsInRange(row2.annotations, start2, Math.max(end2, start2 + 1));
    for (var ci2 = 0; ci2 < covering2.length; ci2++) {
      var ca2 = row2.annotations[covering2[ci2]];
      if (action === "comment" ? ca2.type === "comment" : (ca2.type === "format" && ca2.action === action)) {
        matchIdx2 = covering2[ci2];
        break;
      }
    }
    if (matchIdx2 >= 0) {
      // Toggle off: remove from selection range (split if sub-range)
      removeAnnotationFromRange(_annToolbarArea, matchIdx2, start2, Math.max(end2, start2 + 1));
    } else {
      // Add new format annotation for the same range
      createAnnotation(_annToolbarArea, action);
    }
  } else {
    createAnnotation(_annToolbarArea, action);
  }
}

/**
 * Attach annotation toolbar listeners to a target textarea.
 * Called from ensureTokenOverlayForTextarea for target fields.
 */
function bindAnnToolbarEvents(area) {
  if (area.__annToolbarBound) return;
  area.__annToolbarBound = true;

  area.addEventListener("mouseup", function () {
    setTimeout(function () { onAnnSelectionChange(area); }, 0);
  });

  // Keyboard selection (Shift+Arrow, Ctrl+Shift+Arrow, etc.)
  area.addEventListener("keyup", function (e) {
    if (e.shiftKey || e.key === "Shift") {
      setTimeout(function () { onAnnSelectionChange(area); }, 0);
    }
  });

  // Phase 4: Ctrl+B / Ctrl+I / Ctrl+K shortcuts
  area.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    var action = "";
    if (e.key === "b" || e.key === "B") action = "bold";
    else if (e.key === "i" || e.key === "I") action = "italic";
    else if (e.key === "u" || e.key === "U") action = "underline";
    else if (e.key === "k" || e.key === "K") {
      // Ctrl+K → trigger link panel (same path as toolbar button click).
      // Don't run the toggle-by-shortcut logic below; URL needs explicit
      // input from the user.
      var startLk = area.selectionStart, endLk = area.selectionEnd;
      if (startLk === endLk) return;
      e.preventDefault();
      // Ensure toolbar is visible + selection synced; then synthesize a
      // click on the link button so we share the link-panel handler.
      _annToolbarSelStart = startLk;
      _annToolbarSelEnd = endLk;
      _annToolbarArea = area;
      var btnLk = _annToolbar && _annToolbar.querySelector('[data-ann-action="link"]');
      if (btnLk) btnLk.click();
      return;
    }
    if (!action) return;
    e.preventDefault();
    var start = area.selectionStart, end = area.selectionEnd;
    if (start === end) return; // no selection → no-op
    var tid = resolveTextareaTid(area);
    var row = tid && state.translationsByTid[tid];
    if (!row) return;
    // Check if selection exactly matches an existing annotation of same action → toggle off
    var matchIdx = -1;
    if (Array.isArray(row.annotations)) {
      for (var i = 0; i < row.annotations.length; i++) {
        var a = row.annotations[i];
        if (a.type === "format" && a.action === action && a.offset === start && a.length === end - start) {
          matchIdx = i;
          break;
        }
      }
    }
    if (matchIdx >= 0) {
      deleteAnnotation(area, matchIdx);
    } else {
      createAnnotation(area, action);
    }
  });

  area.addEventListener("blur", function (e) {
    // Don't hide if focus moved to toolbar itself
    setTimeout(function () {
      if (_annToolbar && _annToolbar.contains(document.activeElement)) return;
      hideAnnToolbar();
    }, 150);
  });
}

/** Find all annotation indices covering a given range [start, end). */
function findAnnotationsInRange(annotations, start, end) {
  var result = [];
  if (!Array.isArray(annotations)) return result;
  for (var i = 0; i < annotations.length; i++) {
    var a = annotations[i];
    if (typeof a.offset === "number" && typeof a.length === "number") {
      var aEnd = a.offset + a.length;
      // Annotation overlaps with [start, end)
      if (a.offset < end && aEnd > start) {
        result.push(i);
      }
    }
  }
  return result;
}

function onAnnSelectionChange(area) {
  var tid = resolveTextareaTid(area);
  var row = tid && state.translationsByTid[tid];
  if (!row) return;

  var start = area.selectionStart;
  var end = area.selectionEnd;

  if (start === end) {
    // No selection — check if cursor is inside an existing annotation
    var idx = findAnnotationAtOffset(row.annotations, start);
    if (idx >= 0) {
      showAnnToolbar(area, "edit", idx);
    } else {
      hideAnnToolbar();
    }
    return;
  }

  // Has selection — check if it falls inside/covers an existing annotation
  var covering = findAnnotationsInRange(row.annotations, start, end);
  if (covering.length > 0) {
    // Find the narrowest covering annotation for edit mode
    var bestIdx = covering[0], bestLen = Infinity;
    for (var ci = 0; ci < covering.length; ci++) {
      var ca = row.annotations[covering[ci]];
      if (ca.length < bestLen) { bestLen = ca.length; bestIdx = covering[ci]; }
    }
    showAnnToolbar(area, "edit", bestIdx);
  } else {
    showAnnToolbar(area, "create");
  }
}

function buildControlHintHtml(seg, row) {
  let issue;
  let summary;
  let hasMissing = false;
  const tid = seg ? seg.tid : "";
  if (!segmentHasControlTokens(seg) || !row || isMergeTailRow(row)) {
    return "";
  }
  issue = isEffectiveEmptyTargetText(row.target_text) ? null : validateControlTokens(seg, row.target_text);
  summary = issue ? formatControlTokenIssueSummary(issue) : "Control tokens present. Keep them in translation.";
  hasMissing = !!(issue && issue.issues && issue.issues.some(it => it && it.type === "missing_token"));
  return `
    <div class="token-hint ${issue ? "warn" : "ok"}">
      <div class="token-main">
        <span class="token-tag">Control tokens</span>
        <span class="token-text" data-token-summary="${escapeHtmlAttr(tid)}">${escapeHtmlText(summary)}</span>
        <button type="button" class="chip-btn tiny${hasMissing ? "" : " hidden"}" data-token-restore="${escapeHtmlAttr(tid)}">Restore Deleted</button>
        <span class="hover-wrap compact">
          <span class="help-dot">?</span>
          <span class="hover-tip">These markers carry layout semantics (for example page markers). Keep them in target text. Use restore buttons if deleted by mistake.</span>
        </span>
      </div>
    </div>`;
}

function restoreMissingControlTokensForTid(tid) {
  const seg = state.segmentByTid[tid];
  const row = state.translationsByTid[tid];
  let nextText;
  if (!seg || !row || isRowSystemLocked(seg, row)) {
    return false;
  }
  nextText = appendMissingControlTokensToText(row.target_text, seg.required_control_tokens || {});
  if (nextText === row.target_text) {
    return false;
  }
  updateTargetText(tid, nextText, { fromUser: true });
  return true;
}

function resetTranslationForTid(tid) {
  const seg = state.segmentByTid[tid];
  const row = state.translationsByTid[tid];
  const prefill = buildDefaultControlPrefillText(seg && seg.source_text);
  if (!seg || !row || isRowSystemLocked(seg, row)) {
    return false;
  }
  row.target_text = prefill;
  row.target_auto_prefill = prefill.length > 0;
  row.status = "todo";
  row.annotations = [];
  return true;
}

function applyTargetInputVisualState(input, row) {
  let tid = "";
  let seg = null;
  let statusClass = "status-todo";
  if (!input) {
    return;
  }
  if (typeof input.getAttribute === "function") {
    tid = safeStr(input.getAttribute("data-card-target"));
  }
  if (!tid && input.id === "targetInput") {
    tid = safeStr(state.selectedTid);
  }
  if (tid && state.segmentByTid[tid]) {
    seg = state.segmentByTid[tid];
  }
  statusClass = statusClassFromStatus(displayStatusText(seg, row));
  applyStatusClassTokens(input, statusClass);
  input.classList.toggle("auto-prefill", !!(row && row.target_auto_prefill));
}

function ensureTokenOverlayForTextarea(area) {
  let wrap;
  let overlay;
  let isTargetField;
  if (!area) {
    return null;
  }
  wrap = area.parentElement;
  if (!wrap || !wrap.classList || !wrap.classList.contains("token-target-wrap")) {
    wrap = document.createElement("div");
    wrap.className = "token-target-wrap";
    area.parentNode.insertBefore(wrap, area);
    wrap.appendChild(area);
  }
  overlay = wrap.querySelector(".token-target-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "token-target-overlay";
    overlay.setAttribute("aria-hidden", "true");
    wrap.insertBefore(overlay, area);
  }
  isTargetField = area.classList.contains("card-target") || area.id === "targetInput";
  wrap.classList.toggle("target-field", isTargetField);
  wrap.classList.toggle("source-field", !isTargetField);
  area.classList.add("token-highlight-input");
  if (!area.__tokenOverlayBound) {
    area.addEventListener("scroll", () => syncTokenOverlayForTextarea(area));
    area.__tokenOverlayBound = true;
  }
  // Bind annotation toolbar + offset tracking for target textareas
  if (isTargetField) {
    bindAnnToolbarEvents(area);
    bindAnnOffsetTracking(area);
  }
  syncTokenOverlayForTextarea(area);
  return wrap;
}

function syncTokenOverlayForTextarea(area) {
  let wrap;
  let overlay;
  let cs;
  let value;
  let locked;
  let autoPrefill;
  let hasToken;
  const TOKEN_MARKER_RE = /\{PAGE_(?:CURRENT|TOTAL)\}|\[\[CTRL_[0-9A-Fa-f]{4}\]\]/;
  if (!area || !area.parentElement) {
    return;
  }
  wrap = area.parentElement;
  if (!wrap.classList.contains("token-target-wrap")) {
    return;
  }
  overlay = wrap.querySelector(".token-target-overlay");
  if (!overlay) {
    return;
  }

  value = area.value || "";
  // Keep offset tracking baseline in sync with programmatic value changes,
  // but NOT during IME composition — compositionend needs the pre-composition
  // baseline to calculate the correct diff for offset adjustment.
  if (!area.__annComposing) {
    area.__annOldText = value;
  }
  locked = area.classList.contains("locked");
  autoPrefill = area.classList.contains("auto-prefill");

  if (!area.__tokenOverlayStyleApplied) {
    cs = window.getComputedStyle(area);
    overlay.style.padding = cs.padding;
    overlay.style.font = cs.font;
    overlay.style.lineHeight = cs.lineHeight;
    overlay.style.letterSpacing = cs.letterSpacing;
    overlay.style.textAlign = cs.textAlign;
    overlay.style.borderRadius = cs.borderRadius;
    overlay.style.whiteSpace = "pre-wrap";
    overlay.style.wordBreak = "break-word";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    // Match textarea border width so content area width is identical under border-box.
    // Use transparent border to preserve layout without adding visible border.
    overlay.style.borderWidth = cs.borderWidth;
    overlay.style.borderStyle = "solid";
    overlay.style.borderColor = "transparent";
    area.__tokenOverlayStyleApplied = true;
  }

  // Resolve tid → annotations for this textarea
  var tid = "";
  var annotations = null;
  if (area.id === "targetInput") {
    tid = safeStr(state.selectedTid);
  } else if (typeof area.getAttribute === "function") {
    tid = safeStr(area.getAttribute("data-card-target"));
  }
  if (tid && state.translationsByTid && state.translationsByTid[tid]) {
    var row = state.translationsByTid[tid];
    if (Array.isArray(row.annotations) && row.annotations.length > 0) {
      if (area.__annComposing) {
        // During IME composition: render with temporarily adjusted offsets.
        // The composition inserts text at __annComposeOffset; shift annotations
        // after that point by the current length delta so highlights stay aligned.
        var oldLen = (area.__annOldText || "").length;
        var curLen = value.length;
        var delta = curLen - oldLen;
        var compOff = area.__annComposeOffset || 0;
        annotations = row.annotations.map(function (a) {
          if (typeof a.offset !== "number") return a;
          var adj = {};
          for (var k in a) adj[k] = a[k];
          if (adj.offset >= compOff) {
            adj.offset += delta;
          } else if (adj.offset + adj.length > compOff) {
            adj.length += delta;
          }
          // Clamp to current text bounds
          if (adj.offset < 0) adj.offset = 0;
          if (adj.offset + adj.length > curLen) adj.length = curLen - adj.offset;
          if (adj.length <= 0) return null;
          return adj;
        }).filter(Boolean);
        if (annotations.length === 0) annotations = null;
      } else {
        annotations = row.annotations;
      }
    }
  }

  // Cache key includes annotations to detect changes
  var annKey = annotations ? JSON.stringify(annotations) : "";
  var cacheKey = value + "\x00" + annKey;

  if (area.__tokenOverlayCacheKey !== cacheKey) {
    if (!value) {
      overlay.innerHTML = "";
    } else if (annotations) {
      overlay.innerHTML = buildOverlayHtml(value, annotations);
    } else {
      hasToken = TOKEN_MARKER_RE.test(value);
      if (hasToken) {
        overlay.innerHTML = tokenAwareHtml(value);
      } else {
        overlay.textContent = value;
      }
    }
    area.__tokenOverlayCacheKey = cacheKey;
    area.__tokenOverlayLastValue = value;
  }

  overlay.scrollTop = area.scrollTop;
  overlay.scrollLeft = area.scrollLeft;
  if (area.__tokenOverlayLastLocked !== locked) {
    wrap.classList.toggle("locked", locked);
    area.__tokenOverlayLastLocked = locked;
  }
  if (area.__tokenOverlayLastAutoPrefill !== autoPrefill) {
    wrap.classList.toggle("auto-prefill", autoPrefill);
    area.__tokenOverlayLastAutoPrefill = autoPrefill;
  }
}

function extractVisibleControlTokens(text) {
  const visible = toVisibleControlTokens(text);
  const re = /\{PAGE_CURRENT\}|\{PAGE_TOTAL\}|\[\[CTRL_[0-9A-Fa-f]{4}\]\]/g;
  const out = [];
  let m;
  while ((m = re.exec(visible)) !== null) {
    out.push(m[0]);
  }
  return out;
}

function buildDefaultControlPrefillText(sourceText) {
  return extractVisibleControlTokens(sourceText).join("");
}

function stripVisibleControlTokens(text) {
  let normalized = toVisibleControlTokens(text);
  PAGE_CURRENT_TOKEN_RE.lastIndex = 0;
  PAGE_TOTAL_TOKEN_RE.lastIndex = 0;
  CONTROL_TOKEN_RE.lastIndex = 0;
  normalized = normalized.replace(PAGE_CURRENT_TOKEN_RE, "");
  normalized = normalized.replace(PAGE_TOTAL_TOKEN_RE, "");
  normalized = normalized.replace(CONTROL_TOKEN_RE, "");
  return normalized;
}

function isEffectiveEmptyTargetText(text) {
  return stripVisibleControlTokens(text).replace(/\s+/g, "").length === 0;
}

function hasEffectiveTargetText(text) {
  return !isEffectiveEmptyTargetText(text);
}

function isSpecialControlCharCode(code) {
  return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31);
}

function controlTokenForCode(code) {
  return "[[CTRL_" + Number(code).toString(16).toUpperCase().padStart(4, "0") + "]]";
}

function toVisibleControlTokens(text) {
  const s = safeStr(text);
  const out = [];
  let pageTokenCount = 0;
  let i;
  let code;
  for (i = 0; i < s.length; i += 1) {
    code = s.charCodeAt(i);
    if (isSpecialControlCharCode(code)) {
      if (code === 24 && pageTokenCount === 0) {
        out.push(PAGE_CURRENT_TOKEN);
        pageTokenCount += 1;
      } else if (code === 24 && pageTokenCount === 1) {
        out.push(PAGE_TOTAL_TOKEN);
        pageTokenCount += 1;
      } else {
        out.push(controlTokenForCode(code));
      }
    } else {
      out.push(s.charAt(i));
    }
  }
  return out.join("");
}

function fromVisibleControlTokens(text) {
  let normalized = toVisibleControlTokens(text);
  PAGE_CURRENT_TOKEN_RE.lastIndex = 0;
  PAGE_TOTAL_TOKEN_RE.lastIndex = 0;
  normalized = normalized.replace(PAGE_CURRENT_TOKEN_RE, "[[CTRL_0018]]");
  normalized = normalized.replace(PAGE_TOTAL_TOKEN_RE, "[[CTRL_0018]]");
  CONTROL_TOKEN_RE.lastIndex = 0;
  return normalized.replace(CONTROL_TOKEN_RE, function (_, hex) {
    const code = parseInt(hex, 16);
    if (!Number.isFinite(code) || code < 0 || code > 65535) {
      return "";
    }
    return String.fromCharCode(code);
  });
}

function collectControlTokenCounts(text) {
  const counts = {};
  let m;
  const visible = toVisibleControlTokens(text);
  PAGE_CURRENT_TOKEN_RE.lastIndex = 0;
  PAGE_TOTAL_TOKEN_RE.lastIndex = 0;
  if (PAGE_CURRENT_TOKEN_RE.test(visible)) {
    PAGE_CURRENT_TOKEN_RE.lastIndex = 0;
    counts[PAGE_CURRENT_TOKEN] = (visible.match(PAGE_CURRENT_TOKEN_RE) || []).length;
  }
  if (PAGE_TOTAL_TOKEN_RE.test(visible)) {
    PAGE_TOTAL_TOKEN_RE.lastIndex = 0;
    counts[PAGE_TOTAL_TOKEN] = (visible.match(PAGE_TOTAL_TOKEN_RE) || []).length;
  }
  CONTROL_TOKEN_RE.lastIndex = 0;
  while ((m = CONTROL_TOKEN_RE.exec(visible)) !== null) {
    const token = "[[CTRL_" + String(m[1]).toUpperCase().padStart(4, "0") + "]]";
    counts[token] = (counts[token] || 0) + 1;
  }
  return counts;
}

function validateControlTokens(seg, targetText) {
  const required = (seg && seg.required_control_tokens) ? seg.required_control_tokens : {};
  const actual = collectControlTokenCounts(targetText);
  const tokens = sortedUnique(Object.keys(required).concat(Object.keys(actual)));
  const issues = [];
  let i;
  let token;
  let reqCount;
  let gotCount;

  for (i = 0; i < tokens.length; i += 1) {
    token = tokens[i];
    reqCount = Number(required[token] || 0);
    gotCount = Number(actual[token] || 0);
    if (reqCount === gotCount) {
      continue;
    }
    issues.push({
      type: gotCount < reqCount ? "missing_token" : "extra_token",
      token: token,
      required: reqCount,
      actual: gotCount
    });
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    tid: safeStr(seg && seg.tid),
    source_preview: safeStr(seg && seg.source_text),
    target_preview: safeStr(targetText),
    issues: issues
  };
}

function isWhitespaceOnlyText(text) {
  return safeStr(text).trim().length === 0;
}

function isPureNumberText(text) {
  const raw = safeStr(text).trim();
  if (!raw) {
    return false;
  }
  const t = normalizeNumberLikeText(raw);
  return /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)%?$/.test(t);
}

function isPurePunctuationText(text) {
  const t = safeStr(text).replace(/\s+/g, "");
  if (!t) {
    return false;
  }
  return /^[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u2000-\u206F\u3000-\u303F\uFF00-\uFF65]+$/.test(t);
}

function normalizeNumberLikeText(text) {
  return safeStr(text)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248))
    .replace(/[＋]/g, "+")
    .replace(/[－]/g, "-")
    .replace(/[％]/g, "%")
    .replace(/[．。]/g, ".")
    .replace(/[，]/g, ",")
    .replace(/\s+/g, "");
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v);
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function px(v) {
  return Math.round(v * 1000) / 1000 + "px";
}

function sortedUnique(arr) {
  return Array.from(new Set(arr)).sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") {
      return a - b;
    }
    return String(a).localeCompare(String(b));
  });
}

// #SEC5: Escape ALL five HTML-significant characters here so this is safe in
// either text *or* attribute context. The earlier split (escapeHtmlText for
// text, escapeHtmlAttr layering "→&quot; on top) created a foot-gun: a
// future PR could call escapeHtmlText for an attribute insertion and silently
// introduce XSS. The perf hit of two extra replaces is negligible; the
// reduced cognitive load is worth more.
function escapeHtmlText(s) {
  return safeStr(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Retained as an alias for code that wants to express "this is attribute
// context" at the call site. escapeHtmlText is now equally safe; this
// alias documents intent without changing behavior.
function escapeHtmlAttr(s) {
  return escapeHtmlText(s);
}

function inferPackageRoot(files) {
  if (!files || files.length === 0) {
    return "";
  }
  const p = safeStr(files[0].webkitRelativePath || files[0].name);
  if (!p) {
    return "";
  }
  const idx = p.indexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

function findFile(files, filename) {
  const name = filename.toLowerCase();
  return files.find(f => safeStr(f.name).toLowerCase() === name) || null;
}

async function readJsonFile(file) {
  const text = await readText(file);
  const fileName = safeStr(file && file.name) || "json file";
  let repaired;
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    repaired = escapeControlCharsInJsonStrings(text);
    if (repaired !== text) {
      try {
        console.warn("Recovered invalid JSON control chars in " + fileName);
        return JSON.parse(repaired);
      } catch (parseErr2) {
        throw new Error("Invalid JSON in " + fileName + ": " + parseErr2.message);
      }
    }
    throw new Error("Invalid JSON in " + fileName + ": " + parseErr.message);
  }
}

function escapeControlCharsInJsonStrings(text) {
  const out = [];
  let inString = false;
  let escaping = false;
  let changed = false;
  let i;
  let ch;
  let code;

  for (i = 0; i < text.length; i += 1) {
    ch = text.charAt(i);
    code = text.charCodeAt(i);

    if (!inString) {
      out.push(ch);
      if (ch === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaping) {
      out.push(ch);
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      out.push(ch);
      escaping = true;
      continue;
    }

    if (ch === "\"") {
      out.push(ch);
      inString = false;
      continue;
    }

    if (code >= 0 && code <= 31) {
      changed = true;
      if (code === 8) {
        out.push("\\b");
      } else if (code === 9) {
        out.push("\\t");
      } else if (code === 10) {
        out.push("\\n");
      } else if (code === 12) {
        out.push("\\f");
      } else if (code === 13) {
        out.push("\\r");
      } else {
        out.push("\\u" + code.toString(16).padStart(4, "0"));
      }
      continue;
    }

    out.push(ch);
  }

  return changed ? out.join("") : text;
}

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsText(file, "utf-8");
  });
}

function readArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsArrayBuffer(file);
  });
}

async function cleanupPdfDocument() {
  state.pdfRenderSeq += 1;
  if (state.pdfDoc && typeof state.pdfDoc.destroy === "function") {
    try {
      await state.pdfDoc.destroy();
    } catch (e) {}
  }
  state.pdfDoc = null;
  state.pdfFile = null;
  state.pdfViewBox = null;
  clearPdfCanvas();
}

// ══════════════════════════════════════════════════════════════════════
// ── Manual Hotspot CRUD helpers ──
// ══════════════════════════════════════════════════════════════════════

function generateManualHotspotId() {
  state._mhCounter += 1;
  return "mh_" + Date.now() + "_" + String(state._mhCounter).padStart(3, "0");
}

function addManualHotspot(pageIndex, boundsNorm) {
  const id = generateManualHotspotId();
  const item = {
    id: id,
    page_index: pageIndex,
    bounds_norm: {
      nx0: clamp(Math.min(boundsNorm.nx0, boundsNorm.nx1), 0, 1),
      ny0: clamp(Math.min(boundsNorm.ny0, boundsNorm.ny1), 0, 1),
      nx1: clamp(Math.max(boundsNorm.nx0, boundsNorm.nx1), 0, 1),
      ny1: clamp(Math.max(boundsNorm.ny0, boundsNorm.ny1), 0, 1)
    },
    source_text: "",
    target_text: "",
    status: "todo",
    notes: ""
  };
  state.manualHotspots.push(item);
  state.manualHotspotById[id] = item;
  return item;
}

function updateManualHotspot(id, updates) {
  const item = state.manualHotspotById[id];
  if (!item) return null;
  Object.keys(updates).forEach(function (k) {
    if (k !== "id") item[k] = updates[k];
  });
  return item;
}

function deleteManualHotspot(id) {
  const idx = state.manualHotspots.findIndex(function (it) { return it.id === id; });
  if (idx >= 0) state.manualHotspots.splice(idx, 1);
  delete state.manualHotspotById[id];
  if (state.selectedManualHotspotId === id) state.selectedManualHotspotId = null;
}

function getManualHotspotsForPage(pageIndex) {
  return state.manualHotspots.filter(function (it) { return it.page_index === pageIndex; });
}

function rebuildManualHotspotIndex() {
  state.manualHotspotById = {};
  state.manualHotspots.forEach(function (it) { state.manualHotspotById[it.id] = it; });
}

function loadManualHotspotsFromPayload(payload) {
  var arr = payload && Array.isArray(payload.manual_hotspots) ? payload.manual_hotspots : [];
  state.manualHotspots = [];
  state.manualHotspotById = {};
  state.selectedManualHotspotId = null;
  for (var i = 0; i < arr.length; i += 1) {
    var it = arr[i];
    if (!it || !it.id || !it.bounds_norm) continue;
    var b = it.bounds_norm;
    if (!isFiniteNumber(b.nx0) || !isFiniteNumber(b.ny0) || !isFiniteNumber(b.nx1) || !isFiniteNumber(b.ny1)) continue;
    var item = {
      id: String(it.id),
      page_index: isFiniteNumber(it.page_index) ? Number(it.page_index) : 0,
      bounds_norm: {
        nx0: clamp(Math.min(toNumber(b.nx0), toNumber(b.nx1)), 0, 1),
        ny0: clamp(Math.min(toNumber(b.ny0), toNumber(b.ny1)), 0, 1),
        nx1: clamp(Math.max(toNumber(b.nx0), toNumber(b.nx1)), 0, 1),
        ny1: clamp(Math.max(toNumber(b.ny0), toNumber(b.ny1)), 0, 1)
      },
      source_text: safeStr(it.source_text),
      target_text: safeStr(it.target_text),
      status: safeStr(it.status) || "todo",
      notes: safeStr(it.notes)
    };
    if (!state.manualHotspotById[item.id]) {
      state.manualHotspots.push(item);
      state.manualHotspotById[item.id] = item;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// ── Draw Mode ──
// ══════════════════════════════════════════════════════════════════════

function initDrawMode() {
  var preview = null;

  function getLayerNormCoords(ev) {
    var rect = els.hotspotLayer.getBoundingClientRect();
    var vb = state.pdfViewBox;
    if (!vb || !vb.width || !vb.height) return null;
    return {
      nx: clamp((ev.clientX - rect.left) / vb.width, 0, 1),
      ny: clamp((ev.clientY - rect.top) / vb.height, 0, 1)
    };
  }

  els.hotspotLayer.addEventListener("mousedown", function (ev) {
    if (!state.drawMode) return;
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    var c = getLayerNormCoords(ev);
    if (!c) return;
    state.drawStart = c;
    preview = document.createElement("div");
    preview.className = "draw-preview";
    var vb = state.pdfViewBox;
    preview.style.left = px(c.nx * vb.width);
    preview.style.top = px(c.ny * vb.height);
    preview.style.width = "0px";
    preview.style.height = "0px";
    els.hotspotLayer.appendChild(preview);
  });

  document.addEventListener("mousemove", function (ev) {
    if (!state.drawMode || !state.drawStart || !preview) return;
    var c = getLayerNormCoords(ev);
    if (!c) return;
    var vb = state.pdfViewBox;
    var x0 = Math.min(state.drawStart.nx, c.nx);
    var y0 = Math.min(state.drawStart.ny, c.ny);
    var x1 = Math.max(state.drawStart.nx, c.nx);
    var y1 = Math.max(state.drawStart.ny, c.ny);
    preview.style.left = px(x0 * vb.width);
    preview.style.top = px(y0 * vb.height);
    preview.style.width = px((x1 - x0) * vb.width);
    preview.style.height = px((y1 - y0) * vb.height);
  });

  document.addEventListener("mouseup", function (ev) {
    if (!state.drawMode || !state.drawStart) return;
    var c = getLayerNormCoords(ev);
    if (preview && preview.parentNode) preview.parentNode.removeChild(preview);
    preview = null;
    if (!c) { state.drawStart = null; return; }
    var vb = state.pdfViewBox;
    var nx0 = Math.min(state.drawStart.nx, c.nx);
    var ny0 = Math.min(state.drawStart.ny, c.ny);
    var nx1 = Math.max(state.drawStart.nx, c.nx);
    var ny1 = Math.max(state.drawStart.ny, c.ny);
    state.drawStart = null;
    // Min size check (10px equivalent in normalized)
    var minW = vb ? 10 / vb.width : 0.02;
    var minH = vb ? 10 / vb.height : 0.02;
    if ((nx1 - nx0) < minW || (ny1 - ny0) < minH) {
      return; // too small, discard
    }
    var item = addManualHotspot(state.currentPage, { nx0: nx0, ny0: ny0, nx1: nx1, ny1: ny1 });
    setDrawMode(false);
    selectManualHotspot(item.id);
    renderHotspots();
    renderSegmentsPane();
    scrollManualCardIntoView(item.id);
  });

  document.addEventListener("keydown", function (ev) {
    if (state.drawMode && ev.key === "Escape") {
      if (preview && preview.parentNode) preview.parentNode.removeChild(preview);
      preview = null;
      state.drawStart = null;
      setDrawMode(false);
      return;
    }
    // Delete manual hotspot
    if (state.selectedManualHotspotId && (ev.key === "Delete" || ev.key === "Backspace")) {
      var tag = ev.target && ev.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      ev.preventDefault();
      deleteManualHotspot(state.selectedManualHotspotId);
      renderHotspots();
      renderSegmentsPane();
    }
  });
}

function toggleDrawMode() {
  setDrawMode(!state.drawMode);
}

function setDrawMode(on) {
  state.drawMode = !!on;
  state.drawStart = null;
  if (els.drawHotspotBtn) {
    els.drawHotspotBtn.classList.toggle("draw-active", state.drawMode);
  }
  els.hotspotLayer.classList.toggle("draw-mode", state.drawMode);
}

// ══════════════════════════════════════════════════════════════════════
// ── Manual Hotspot Rendering ──
// ══════════════════════════════════════════════════════════════════════

function renderManualHotspots(page, viewBox) {
  if (!viewBox) return;
  var items = getManualHotspotsForPage(page);
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    var b = item.bounds_norm;
    if (!b) continue;
    var box = {
      left: b.nx0 * viewBox.width,
      top: b.ny0 * viewBox.height,
      right: b.nx1 * viewBox.width,
      bottom: b.ny1 * viewBox.height
    };
    appendManualHotspotDiv(item, box);
  }
}

function manualHotspotStatusClass(item) {
  var st = safeStr(item && item.status);
  if (st === "translated") return "status-translated";
  if (st === "reviewed") return "status-reviewed";
  if (st === "skip") return "status-skip";
  return "status-todo";
}

function appendManualHotspotDiv(item, box) {
  var pad = 2;
  var id = item.id;
  var selected = (id === state.selectedManualHotspotId);
  var div = document.createElement("div");
  div.className = "hotspot manual-hotspot " + manualHotspotStatusClass(item) + (selected ? " selected" : "");
  div.setAttribute("data-mh-id", id);
  div.style.left = px(Math.max(0, box.left - pad));
  div.style.top = px(Math.max(0, box.top - pad));
  div.style.width = px(Math.max(1, (box.right - box.left) + pad * 2));
  div.style.height = px(Math.max(1, (box.bottom - box.top) + pad * 2));
  div.title = "Manual: " + id;

  // Text overlay
  var text = safeStr(item.target_text);
  if (text) {
    var textEl = document.createElement("span");
    textEl.className = "hotspot-text";
    textEl.textContent = text;
    div.appendChild(textEl);
    div.classList.add("has-text");
  }

  // Resize handles (4 corners)
  var handles = ["nw", "ne", "sw", "se"];
  for (var h = 0; h < handles.length; h += 1) {
    var handle = document.createElement("div");
    handle.className = "resize-handle rh-" + handles[h];
    handle.setAttribute("data-handle", handles[h]);
    div.appendChild(handle);
  }

  // --- Events ---
  var downEventName = getPrimaryPointerDownEventName();

  // Resize handle mousedown
  div.querySelectorAll(".resize-handle").forEach(function (hel) {
    hel.addEventListener(downEventName, function (ev) {
      if (!isPrimaryPointerDownEvent(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      var handleDir = hel.getAttribute("data-handle");
      state.resizingHotspot = { id: id, handle: handleDir, origBounds: cloneBounds(item.bounds_norm) };
      selectManualHotspot(id);
      renderSegmentsPane();
    });
  });

  // Move (click on body, not on handle) — uses drag threshold to distinguish click vs drag
  div.addEventListener(downEventName, function (ev) {
    if (!isPrimaryPointerDownEvent(ev)) return;
    if (ev.target && ev.target.classList && ev.target.classList.contains("resize-handle")) return;
    ev.preventDefault();
    ev.stopPropagation();
    selectManualHotspot(id);
    // Prepare potential drag (actual drag starts after threshold in mousemove)
    var vb = state.pdfViewBox;
    var layerRect = els.hotspotLayer.getBoundingClientRect();
    if (vb) {
      var mouseNx = clamp((ev.clientX - layerRect.left) / vb.width, 0, 1);
      var mouseNy = clamp((ev.clientY - layerRect.top) / vb.height, 0, 1);
      state.draggingHotspot = {
        id: id,
        offsetNx: mouseNx - item.bounds_norm.nx0,
        offsetNy: mouseNy - item.bounds_norm.ny0,
        origBounds: cloneBounds(item.bounds_norm)
      };
    }
    // Update selection visually without rebuilding DOM
    els.hotspotLayer.querySelectorAll(".hotspot.selected").forEach(function (el) {
      el.classList.remove("selected");
    });
    div.classList.add("selected");
    renderSegmentsPane();
    scrollManualCardIntoView(id);
  });

  els.hotspotLayer.appendChild(div);
}

function cloneBounds(b) {
  return { nx0: b.nx0, ny0: b.ny0, nx1: b.nx1, ny1: b.ny1 };
}

// ══════════════════════════════════════════════════════════════════════
// ── Manual Hotspot Move & Resize (document-level handlers) ──
// ══════════════════════════════════════════════════════════════════════

(function initManualHotspotDragResize() {
  function getLayerNorm(ev) {
    var rect = els.hotspotLayer.getBoundingClientRect();
    var vb = state.pdfViewBox;
    if (!vb || !vb.width || !vb.height) return null;
    return {
      nx: clamp((ev.clientX - rect.left) / vb.width, 0, 1),
      ny: clamp((ev.clientY - rect.top) / vb.height, 0, 1)
    };
  }

  var usePointer = (typeof window !== "undefined" && typeof window.PointerEvent === "function");
  var moveEvt = usePointer ? "pointermove" : "mousemove";
  var upEvt = usePointer ? "pointerup" : "mouseup";

  document.addEventListener(moveEvt, function (ev) {
    // --- Dragging (move) ---
    if (state.draggingHotspot) {
      var d = state.draggingHotspot;
      var item = state.manualHotspotById[d.id];
      if (!item) return;
      var c = getLayerNorm(ev);
      if (!c) return;
      var w = d.origBounds.nx1 - d.origBounds.nx0;
      var h = d.origBounds.ny1 - d.origBounds.ny0;
      var newX0 = clamp(c.nx - d.offsetNx, 0, 1 - w);
      var newY0 = clamp(c.ny - d.offsetNy, 0, 1 - h);
      item.bounds_norm.nx0 = newX0;
      item.bounds_norm.ny0 = newY0;
      item.bounds_norm.nx1 = newX0 + w;
      item.bounds_norm.ny1 = newY0 + h;
      // Live update DOM position
      var div = els.hotspotLayer.querySelector('[data-mh-id="' + d.id + '"]');
      var vb = state.pdfViewBox;
      if (div && vb) {
        div.style.left = px(newX0 * vb.width - 2);
        div.style.top = px(newY0 * vb.height - 2);
      }
      return;
    }
    // --- Resizing ---
    if (state.resizingHotspot) {
      var r = state.resizingHotspot;
      var item2 = state.manualHotspotById[r.id];
      if (!item2) return;
      var c2 = getLayerNorm(ev);
      if (!c2) return;
      var MIN_DIM = 0.01;
      var b = item2.bounds_norm;
      if (r.handle === "se") {
        b.nx1 = Math.max(b.nx0 + MIN_DIM, c2.nx);
        b.ny1 = Math.max(b.ny0 + MIN_DIM, c2.ny);
      } else if (r.handle === "sw") {
        b.nx0 = Math.min(b.nx1 - MIN_DIM, c2.nx);
        b.ny1 = Math.max(b.ny0 + MIN_DIM, c2.ny);
      } else if (r.handle === "ne") {
        b.nx1 = Math.max(b.nx0 + MIN_DIM, c2.nx);
        b.ny0 = Math.min(b.ny1 - MIN_DIM, c2.ny);
      } else if (r.handle === "nw") {
        b.nx0 = Math.min(b.nx1 - MIN_DIM, c2.nx);
        b.ny0 = Math.min(b.ny1 - MIN_DIM, c2.ny);
      }
      // Clamp
      b.nx0 = clamp(b.nx0, 0, 1);
      b.ny0 = clamp(b.ny0, 0, 1);
      b.nx1 = clamp(b.nx1, 0, 1);
      b.ny1 = clamp(b.ny1, 0, 1);
      // Live update
      var div2 = els.hotspotLayer.querySelector('[data-mh-id="' + r.id + '"]');
      var vb2 = state.pdfViewBox;
      if (div2 && vb2) {
        div2.style.left = px(b.nx0 * vb2.width - 2);
        div2.style.top = px(b.ny0 * vb2.height - 2);
        div2.style.width = px((b.nx1 - b.nx0) * vb2.width + 4);
        div2.style.height = px((b.ny1 - b.ny0) * vb2.height + 4);
      }
    }
  });

  document.addEventListener(upEvt, function () {
    if (state.draggingHotspot) {
      state.draggingHotspot = null;
      renderHotspots();
    }
    if (state.resizingHotspot) {
      state.resizingHotspot = null;
      renderHotspots();
    }
  });
})();

// ══════════════════════════════════════════════════════════════════════
// ── Manual Hotspot Rows (classic view) ──
// ══════════════════════════════════════════════════════════════════════

function renderManualSegmentRows() {
  var container = els.segmentList;
  if (!container) return;
  // Remove previous manual rows
  var oldDivider = container.querySelector(".manual-section-divider");
  if (oldDivider) {
    while (oldDivider.nextSibling) { oldDivider.nextSibling.remove(); }
    oldDivider.remove();
  }
  var items = getManualHotspotsForPage(state.currentPage);
  if (items.length === 0) return;

  var divider = document.createElement("div");
  divider.className = "manual-section-divider";
  divider.textContent = "Manual Hotspots (" + items.length + ")";
  container.appendChild(divider);

  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    var selected = (item.id === state.selectedManualHotspotId);
    var statusClass = manualHotspotStatusClass(item);
    var statusLabel = safeStr(item.status) || "todo";
    var page = "P" + (item.page_index + 1);
    var sourceDisplay = oneLine(safeStr(item.source_text)) || "(manual)";
    var targetDisplay = oneLine(safeStr(item.target_text)) || "";
    var row = document.createElement("div");
    row.className = "segment-row " + (selected ? "selected " : "") + statusClass;
    row.setAttribute("data-mh-row-id", item.id);
    row.innerHTML =
      '<div class="row-meta">' +
        '<span>' + escapeHtmlText(page) + ' \u00b7 Manual #' + (i + 1) + '</span>' +
        '<span>' + escapeHtmlText(statusLabel) + '</span>' +
      '</div>' +
      '<div class="row-source">' + escapeHtmlText(sourceDisplay) + '</div>' +
      '<div class="row-target">' + escapeHtmlText(targetDisplay) + '</div>';
    (function (id) {
      row.addEventListener("click", function () {
        selectManualHotspot(id);
        renderHotspots();
        renderSegmentsPane();
        scrollManualCardIntoView(id);
      });
    })(item.id);
    container.appendChild(row);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ── Manual Hotspot Cards (card view) ──
// ══════════════════════════════════════════════════════════════════════

function renderManualCards() {
  var container = els.cardsView;
  if (!container) return;
  // Remove previous manual card section
  var oldDivider = container.querySelector(".manual-section-divider");
  if (oldDivider) {
    // Remove divider and all subsequent .manual-card elements
    while (oldDivider.nextSibling) {
      oldDivider.nextSibling.remove();
    }
    oldDivider.remove();
  }
  var items = getManualHotspotsForPage(state.currentPage);
  if (items.length === 0) return;

  var divider = document.createElement("div");
  divider.className = "manual-section-divider";
  divider.textContent = "Manual Hotspots (" + items.length + ")";
  container.appendChild(divider);

  for (var i = 0; i < items.length; i += 1) {
    container.appendChild(buildManualCard(items[i], i));
  }
}

function buildManualCard(item, idx) {
  var selected = (item.id === state.selectedManualHotspotId);
  var statusLabel = safeStr(item.status) || "todo";
  var statusClass = manualHotspotStatusClass(item);
  var done = (statusLabel === "translated" || statusLabel === "reviewed");
  var card = document.createElement("article");
  card.className = "segment-card manual-card " + statusClass + (selected ? " selected" : "") + (done ? " done" : "");
  card.setAttribute("data-mh-card-id", item.id);

  card.innerHTML =
    '<div class="card-top">' +
      '<div class="card-actions">' +
        '<div class="hover-wrap">' +
          '<button type="button" class="manual-delete-btn chip-btn reset-btn" title="Delete this manual hotspot">&times; Delete</button>' +
        '</div>' +
        '<div class="status-wrap">' +
          '<button type="button" class="status-chip ' + statusClass + '" data-mh-status-chip="' + escapeHtmlAttr(item.id) + '">' + escapeHtmlText(statusLabel) + '</button>' +
          '<div class="status-popover">' +
            '<button type="button" class="status-option" data-mh-status-set="todo">todo</button>' +
            '<button type="button" class="status-option" data-mh-status-set="translated">translated</button>' +
            '<button type="button" class="status-option" data-mh-status-set="reviewed">reviewed</button>' +
            '<button type="button" class="status-option" data-mh-status-set="skip">skip</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="segment-context-note">Manual #' + (idx + 1) + ' \u00b7 P' + (item.page_index + 1) + '</div>' +
    '<div class="card-grid">' +
      '<div class="card-col">' +
        '<div class="card-label">Source</div>' +
        '<div class="card-source mh-source" contenteditable="true" data-placeholder="(optional reference text)">' + escapeHtmlText(safeStr(item.source_text)) + '</div>' +
      '</div>' +
      '<div class="card-col card-col-target">' +
        '<div class="card-label">Target</div>' +
        '<textarea class="mh-target card-target" placeholder="Enter translation...">' + escapeHtmlText(safeStr(item.target_text)) + '</textarea>' +
      '</div>' +
    '</div>';

  // Events
  var id = item.id;
  card.addEventListener("click", function (ev) {
    if (ev.target.closest(".manual-delete-btn") || ev.target.closest(".status-wrap") || ev.target.closest("textarea") || ev.target.closest("[contenteditable]")) return;
    selectManualHotspot(id);
    renderHotspots();
    renderSegmentsPane();
  });

  card.querySelector(".manual-delete-btn").addEventListener("click", function () {
    deleteManualHotspot(id);
    renderHotspots();
    renderSegmentsPane();
  });

  // Status popover options
  card.querySelectorAll("[data-mh-status-set]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      updateManualHotspot(id, { status: btn.getAttribute("data-mh-status-set") });
      renderHotspots();
      renderSegmentsPane();
    });
  });

  var sourceEl = card.querySelector(".mh-source");
  if (sourceEl) {
    sourceEl.addEventListener("input", function () {
      updateManualHotspot(id, { source_text: sourceEl.textContent });
    });
  }

  card.querySelector(".mh-target").addEventListener("input", function (ev) {
    updateManualHotspot(id, { target_text: ev.target.value });
    updateManualHotspotOverlayText(id);
  });

  // Auto-resize target textarea
  var targetArea = card.querySelector(".mh-target");
  if (targetArea) {
    autoResizeTextarea(targetArea);
  }

  return card;
}

function updateManualHotspotOverlayText(id) {
  var item = state.manualHotspotById[id];
  var div = els.hotspotLayer.querySelector('[data-mh-id="' + id + '"]');
  if (!div || !item) return;
  var existing = div.querySelector(".hotspot-text");
  var text = safeStr(item.target_text);
  if (!text) {
    if (existing) existing.remove();
    div.classList.remove("has-text");
    return;
  }
  if (!existing) {
    existing = document.createElement("span");
    existing.className = "hotspot-text";
    div.appendChild(existing);
    div.classList.add("has-text");
  }
  existing.textContent = text;
  // Phase 7-SC: route through DOM measurement (Phase 5 fallback inside).
  requestAnimationFrame(function () { fitHotspotTextViaDOM(existing); });
}

function renderManualHotspotsVisual() {
  els.hotspotLayer.querySelectorAll(".manual-hotspot").forEach(function (div) {
    var mhId = div.getAttribute("data-mh-id");
    div.classList.toggle("selected", mhId === state.selectedManualHotspotId);
  });
}

function selectManualHotspot(id) {
  var prevTid = state.selectedTid;
  state.selectedManualHotspotId = id;
  // Clear normal segment selection to ensure only one hotspot is focused
  if (prevTid) {
    state.selectedTid = null;
    syncHotspotSelectionForTidChange(prevTid, null);
  }
}

function scrollManualCardIntoView(id) {
  requestAnimationFrame(function () {
    var card = document.querySelector('[data-mh-card-id="' + id + '"]');
    if (card) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      var ta = card.querySelector(".mh-target");
      if (ta) ta.focus();
    }
  });
}

