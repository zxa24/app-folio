"use strict";

(function () {
  const BRIDGE_KEY = "TranslatorAppDevBridge";
  const STORAGE_KEY = "translator_app.dev_translate_config";
  const PROVIDER_GOOGLE_WEB = "google_web";
  const PROVIDER_GOOGLE = "google_cloud";
  const PROVIDER_PROXY = "proxy";
  const PROVIDER_MOCK = "mock";
  const GOOGLE_WEB_CONCURRENCY = 5;
  const CONTROL_TOKEN_RE = /\{PAGE_CURRENT\}|\{PAGE_TOTAL\}|\[\[CTRL_[0-9A-Fa-f]{4}\]\]/g;
  const LANGUAGE_LABELS = {
    auto: "Auto",
    en: "English",
    "zh-cn": "Simplified Chinese",
    ja: "Japanese",
    ko: "Korean"
  };
  const LANGUAGE_SHORT_LABELS = {
    auto: "AUTO",
    en: "EN",
    "zh-cn": "中",
    ja: "JA",
    ko: "KO"
  };

  const DEFAULT_CONFIG = {
    provider: PROVIDER_GOOGLE_WEB,
    sourceLang: "en",
    targetLang: "zh-CN",
    batchSize: 20,
    requestDelayMs: 80,
    overwriteExisting: false,
    skipSimpleText: true,
    skipReviewed: true,
    apiKey: "",
    googleWebEndpoint: "https://translate.googleapis.com/translate_a/single",
    googleEndpoint: "https://translation.googleapis.com/language/translate/v2",
    proxyUrl: "http://127.0.0.1:8787/translate"
  };

  // #SEC4: Whitelist of host:port origins translate endpoints are allowed
  // to point at. localStorage is in-origin scriptable, so without this gate
  // any code with same-origin access can rewrite googleWebEndpoint/proxyUrl
  // to an exfil server and harvest every subsequent translation. Only
  // additions go through configureInteractively, which calls a confirm()
  // before persisting (see ensureEndpointAllowed below).
  const ENDPOINT_HOST_ALLOWLIST = [
    "translate.googleapis.com",
    "translation.googleapis.com",
    "127.0.0.1",
    "localhost"
  ];

  function isEndpointAllowed(rawUrl) {
    if (!rawUrl) return false;
    try {
      const u = new URL(rawUrl);
      if (ENDPOINT_HOST_ALLOWLIST.indexOf(u.hostname) >= 0) return true;
      // Loopback ranges 127.0.0.0/8 are accepted to cover odd host setups.
      if (/^127\./.test(u.hostname)) return true;
      return false;
    } catch (e) { return false; }
  }

  let running = false;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    initDropdownUI();
    syncButtonLabelFromConfig();
  }

  function initDropdownUI() {
    const btn = document.getElementById("autoTranslateBtn");
    const dropdown = document.getElementById("translateDropdown");
    const wrap = document.querySelector(".translate-dropdown-wrap");

    if (!btn || !dropdown || !wrap) {
      return;
    }

    function openDropdown() {
      dropdown.classList.remove("hidden");
      wrap.classList.add("open");
    }

    function closeDropdown() {
      dropdown.classList.add("hidden");
      wrap.classList.remove("open");
    }

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const isOpen = !dropdown.classList.contains("hidden");
      if (isOpen) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    dropdown.addEventListener("click", (ev) => {
      const option = ev.target.closest(".translate-option");
      if (!option) {
        return;
      }

      const direction = option.getAttribute("data-direction");
      const action = option.getAttribute("data-action");

      if (direction) {
        handleTranslateDirection(direction);
      } else if (action === "config") {
        configureInteractively();
      }

      closeDropdown();
    });

    document.addEventListener("click", (ev) => {
      if (!wrap.contains(ev.target)) {
        closeDropdown();
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        closeDropdown();
      }
    });
  }

  async function handleTranslateDirection(direction) {
    let cfg = loadConfig();

    cfg = applyQuickDirection(cfg, direction);
    if (!cfg) {
      return;
    }

    saveConfig(cfg);
    updateButtonLabelFromConfig(cfg);
    await runAutoTranslate();
  }

  function syncButtonLabelFromConfig() {
    updateButtonLabelFromConfig(loadConfig());
  }

  function applyQuickDirection(cfg, direction) {
    const next = normalizeConfig(cfg);
    if (direction === "en-zh") {
      next.sourceLang = "en";
      next.targetLang = "zh-CN";
      return next;
    }
    if (direction === "zh-en") {
      next.sourceLang = "zh-CN";
      next.targetLang = "en";
      return next;
    }
    // Traditional → Simplified (zh-TW → zh-CN). Google Translate
    // handles the cross-script conversion when language hints are
    // explicit on both ends; using "auto" for either side would let
    // Google fall back to the document's overall language guess and
    // skip the script transform on shorter strings.
    if (direction === "tw-cn" || direction === "tc-sc") {
      next.sourceLang = "zh-TW";
      next.targetLang = "zh-CN";
      return next;
    }
    if (direction === "cn-tw" || direction === "sc-tc") {
      next.sourceLang = "zh-CN";
      next.targetLang = "zh-TW";
      return next;
    }
    return null;
  }

  function updateButtonLabelFromConfig(cfg) {
    const label = document.getElementById("translateBtnLabel");
    if (!label) {
      return;
    }
    label.textContent = buildDirectionBadgeText(cfg);
  }

  function buildDirectionBadgeText(cfg) {
    const normalized = normalizeConfig(cfg);
    const source = languageShortLabel(normalized.sourceLang);
    const target = languageShortLabel(normalized.targetLang);
    if (!source || !target) {
      return "Auto Translate";
    }
    return source + " → " + target;
  }

  function buildDirectionSummaryText(cfg) {
    const normalized = normalizeConfig(cfg);
    return languageDisplayName(normalized.sourceLang) + " → " + languageDisplayName(normalized.targetLang);
  }

  function languageDisplayName(code) {
    const normalized = normalizeLangCode(code);
    return LANGUAGE_LABELS[normalized] || safeStr(code).trim() || "Unknown";
  }

  function languageShortLabel(code) {
    const normalized = normalizeLangCode(code);
    if (LANGUAGE_SHORT_LABELS[normalized]) {
      return LANGUAGE_SHORT_LABELS[normalized];
    }
    if (!normalized) {
      return "";
    }
    return normalized.toUpperCase();
  }

  function normalizeLangCode(code) {
    return safeStr(code).trim().toLowerCase();
  }

  function getProviderAdapter(providerKey) {
    if (providerKey === PROVIDER_GOOGLE_WEB) {
      return {
        prepareConfig: async (cfg) => cfg,
        translateBatch: async (texts, cfg) => await translateBatchViaGoogleWeb(texts, cfg)
      };
    }
    if (providerKey === PROVIDER_PROXY) {
      return {
        prepareConfig: async (cfg) => {
          if (!cfg.proxyUrl) {
            throw new Error("Proxy URL is empty. Click Advanced Settings to configure.");
          }
          return cfg;
        },
        translateBatch: async (texts, cfg) => await translateBatchViaProxy(texts, cfg)
      };
    }
    if (providerKey === PROVIDER_MOCK) {
      return {
        prepareConfig: async (cfg) => cfg,
        translateBatch: async (texts, cfg) => translateBatchViaMock(texts, cfg)
      };
    }
    return {
      prepareConfig: async (cfg) => {
        let next = normalizeConfig(cfg);
        if (!next.apiKey) {
          const key = window.prompt(
            "Enter Google Cloud Translation API key (dev only):",
            ""
          );
          if (!key) {
            throw new Error("Missing API key. Click Advanced Settings to configure.");
          }
          next = Object.assign({}, next, {
            apiKey: safeStr(key).trim()
          });
        }
        return next;
      },
      translateBatch: async (texts, cfg) => await translateBatchViaGoogle(texts, cfg)
    };
  }

  async function prepareProviderContext(cfg) {
    const normalized = normalizeConfig(cfg);
    const adapter = getProviderAdapter(normalized.provider);
    const preparedCfg = normalizeConfig(await adapter.prepareConfig(normalized));
    return {
      adapter: adapter,
      cfg: preparedCfg
    };
  }

  function getBridge() {
    if (typeof window === "undefined") {
      return null;
    }
    return window[BRIDGE_KEY] || null;
  }

  function loadConfig() {
    let cfg = Object.assign({}, DEFAULT_CONFIG);
    let raw = "";
    let parsed = null;

    try {
      raw = localStorage.getItem(STORAGE_KEY) || "";
    } catch (e) {}
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {}
    }
    if (parsed && typeof parsed === "object") {
      cfg = Object.assign(cfg, parsed);
    }
    if (window.DEV_TRANSLATE_CONFIG && typeof window.DEV_TRANSLATE_CONFIG === "object") {
      cfg = Object.assign(cfg, window.DEV_TRANSLATE_CONFIG);
    }
    return normalizeConfig(cfg);
  }

  function saveConfig(cfg) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeConfig(cfg)));
    } catch (e) {}
  }

  function normalizeConfig(cfg) {
    const out = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    out.provider = normalizeProvider(out.provider);
    out.sourceLang = safeStr(out.sourceLang || "en").trim() || "en";
    out.targetLang = safeStr(out.targetLang || "zh-CN").trim() || "zh-CN";
    out.batchSize = clampInt(out.batchSize, 1, 100, 20);
    out.requestDelayMs = clampInt(out.requestDelayMs, 0, 3000, 80);
    out.overwriteExisting = !!out.overwriteExisting;
    out.skipSimpleText = !!out.skipSimpleText;
    out.skipReviewed = !!out.skipReviewed;
    out.apiKey = safeStr(out.apiKey).trim();
    out.googleWebEndpoint = safeStr(out.googleWebEndpoint || DEFAULT_CONFIG.googleWebEndpoint).trim();
    out.googleEndpoint = safeStr(out.googleEndpoint || DEFAULT_CONFIG.googleEndpoint).trim();
    out.proxyUrl = safeStr(out.proxyUrl || DEFAULT_CONFIG.proxyUrl).trim();
    // #SEC4: Reject any persisted endpoint that points outside the host
    // allowlist. Falls back to the corresponding DEFAULT_CONFIG entry and
    // logs to the console so the silent reversion is visible during dev.
    if (!isEndpointAllowed(out.googleWebEndpoint)) {
      console.warn("[dev-translate] googleWebEndpoint not in allowlist, reverting:", out.googleWebEndpoint);
      out.googleWebEndpoint = DEFAULT_CONFIG.googleWebEndpoint;
    }
    if (!isEndpointAllowed(out.googleEndpoint)) {
      console.warn("[dev-translate] googleEndpoint not in allowlist, reverting:", out.googleEndpoint);
      out.googleEndpoint = DEFAULT_CONFIG.googleEndpoint;
    }
    if (!isEndpointAllowed(out.proxyUrl)) {
      console.warn("[dev-translate] proxyUrl not in allowlist, reverting:", out.proxyUrl);
      out.proxyUrl = DEFAULT_CONFIG.proxyUrl;
    }
    return out;
  }

  function normalizeProvider(v) {
    const s = safeStr(v).trim().toLowerCase();
    if (s === PROVIDER_GOOGLE_WEB || s === "google" || s === "google_web_gtx") {
      return PROVIDER_GOOGLE_WEB;
    }
    if (s === PROVIDER_PROXY) {
      return PROVIDER_PROXY;
    }
    if (s === PROVIDER_MOCK) {
      return PROVIDER_MOCK;
    }
    return DEFAULT_CONFIG.provider;
  }

  function configureInteractively() {
    let cfg = loadConfig();
    const providerInput = window.prompt(
      "Translation Provider:\n• google_web (free, no API key)\n• google_cloud (paid, requires API key)\n• proxy (custom server)\n• mock (testing only)",
      cfg.provider
    );
    if (providerInput === null) {
      return;
    }
    cfg.provider = normalizeProvider(providerInput);

    const sourceLangInput = window.prompt(
      "Source language:\n• en (English)\n• zh-CN (Simplified Chinese)\n• auto (auto-detect)",
      cfg.sourceLang
    );
    if (sourceLangInput === null) {
      return;
    }
    cfg.sourceLang = safeStr(sourceLangInput).trim() || cfg.sourceLang;

    const targetLangInput = window.prompt(
      "Target language:\n• zh-CN (Simplified Chinese)\n• en (English)\n• ja (Japanese)\n• ko (Korean)",
      cfg.targetLang
    );
    if (targetLangInput === null) {
      return;
    }
    cfg.targetLang = safeStr(targetLangInput).trim() || cfg.targetLang;

    if (cfg.provider === PROVIDER_GOOGLE) {
      const apiKeyInput = window.prompt(
        "Google Cloud Translation API key:\n(stored in localStorage for dev only)",
        cfg.apiKey
      );
      if (apiKeyInput === null) {
        return;
      }
      cfg.apiKey = safeStr(apiKeyInput).trim();
    } else if (cfg.provider === PROVIDER_GOOGLE_WEB) {
      const endpointInput = window.prompt(
        "Google web endpoint URL:",
        cfg.googleWebEndpoint
      );
      if (endpointInput === null) {
        return;
      }
      cfg.googleWebEndpoint = safeStr(endpointInput).trim() || DEFAULT_CONFIG.googleWebEndpoint;
    } else if (cfg.provider === PROVIDER_PROXY) {
      const proxyInput = window.prompt(
        "Proxy server URL:\n(e.g., http://127.0.0.1:8787/translate)",
        cfg.proxyUrl
      );
      if (proxyInput === null) {
        return;
      }
      cfg.proxyUrl = safeStr(proxyInput).trim() || DEFAULT_CONFIG.proxyUrl;
    }

    const batchInput = window.prompt(
      "Batch size (1-100):\nNumber of segments to process before optional delay",
      String(cfg.batchSize)
    );
    if (batchInput === null) {
      return;
    }
    cfg.batchSize = clampInt(batchInput, 1, 100, cfg.batchSize);

    const delayInput = window.prompt(
      "Request delay (0-3000 ms):\nDelay between batches to avoid rate limits",
      String(cfg.requestDelayMs)
    );
    if (delayInput === null) {
      return;
    }
    cfg.requestDelayMs = clampInt(delayInput, 0, 3000, cfg.requestDelayMs);

    cfg.overwriteExisting = window.confirm(
      "Overwrite existing translations?\n\nOK = Yes (replace all)\nCancel = No (skip existing)"
    );
    cfg.skipSimpleText = window.confirm(
      "Skip simple text segments?\n(numbers, punctuation, whitespace only)\n\nOK = Yes (skip)\nCancel = No (translate all)"
    );
    cfg.skipReviewed = window.confirm(
      "Skip reviewed segments?\n(segments marked as 'reviewed')\n\nOK = Yes (skip)\nCancel = No (translate all)"
    );

    cfg = normalizeConfig(cfg);
    saveConfig(cfg);
    updateButtonLabelFromConfig(cfg);

    alert(
      "Configuration saved!\n\n" +
      "Provider: " + cfg.provider + "\n" +
      "Direction: " + buildDirectionSummaryText(cfg) + "\n" +
      "Segments per cycle: " + String(cfg.batchSize) + "\n" +
      "Delay: " + String(cfg.requestDelayMs) + " ms\n" +
      "Overwrite: " + (cfg.overwriteExisting ? "Yes" : "No") + "\n" +
      "Skip simple: " + (cfg.skipSimpleText ? "Yes" : "No") + "\n" +
      "Skip reviewed: " + (cfg.skipReviewed ? "Yes" : "No")
    );
  }

  async function runAutoTranslate(opts) {
    const automation = opts || {};
    const silent = !!automation.silent;
    const bridge = getBridge();
    const btn = document.getElementById("autoTranslateBtn");
    const label = document.getElementById("translateBtnLabel");
    const originalLabel = label ? label.textContent : "";
    let provider;
    let cfg;
    let rows;
    let candidates;
    let statusBefore;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let i;
    let batch;
    let translatedBatch;
    let payload;
    let applyStats;
    let doneCount;
    let maskedList;
    let emphasisList;

    if (!bridge) {
      if (!silent) alert("Dev bridge not ready. Refresh page and retry.");
      return { ok: false, reason: "no_bridge" };
    }
    if (!bridge.isPackageLoaded()) {
      if (!silent) alert("Load a translation package first.");
      return { ok: false, reason: "no_package" };
    }
    if (running) {
      return { ok: false, reason: "already_running" };
    }

    try {
      provider = await prepareProviderContext(loadConfig());
    } catch (err) {
      if (!silent) alert(safeStr(err && err.message) || "Provider configuration is invalid.");
      return { ok: false, reason: "provider_config", error: safeStr(err && err.message) };
    }
    cfg = provider.cfg;
    if (automation.overwriteExisting !== undefined) {
      cfg.overwriteExisting = !!automation.overwriteExisting;
    }
    saveConfig(cfg);

    rows = Array.isArray(bridge.getRows()) ? bridge.getRows() : [];
    candidates = filterCandidates(rows, cfg);
    if (candidates.length === 0) {
      if (!silent) alert("No eligible segments to auto-translate under current config.");
      return { ok: true, candidates: 0, updated: 0, skipped: 0, failed: 0 };
    }

    if (!silent) {
      const directionLabel = buildDirectionSummaryText(cfg);
      if (!window.confirm(
        "Auto-translate " + String(candidates.length) + " segments?\n" +
        "Direction: " + directionLabel + "\n" +
        "Provider: " + cfg.provider
      )) {
        return { ok: false, reason: "user_cancelled" };
      }
    }

    running = true;
    statusBefore = safeStr(bridge.getStatusText());
    if (btn) {
      btn.disabled = true;
    }
    if (label) {
      label.textContent = "Translating...";
    }

    try {
      for (i = 0; i < candidates.length; i += cfg.batchSize) {
        batch = candidates.slice(i, i + cfg.batchSize);
        doneCount = Math.min(i + batch.length, candidates.length);
        bridge.setStatusText(
          "[AUTO] Translating " + String(doneCount) + "/" + String(candidates.length) + " ..."
        );

        // Stage 1: wrap source emphasis runs in marker pairs so Google's
        // translation preserves their position relative to the translated
        // text. Stage 2: mask control tokens on the marker-wrapped text
        // (control-token offsets shift because of the inserted markers,
        // but the masker re-derives them from the input string at call
        // time, so the order is safe). Stage 3: translate. Stage 4 (in
        // batchToPayload): restore control tokens, then decode emphasis
        // markers back into target_emphasis_runs.
        // Per-row diagnostic: row.source_emphasis_runs is undefined when
        // the bridge didn't pass it (older app.js / merge_head rows). Count
        // it so we can tell "bridge dropped the field" vs "data has no
        // emphasis" at a glance.
        const rowsWithRuns = batch.filter(row => Array.isArray(row.source_emphasis_runs) && row.source_emphasis_runs.length > 0).length;
        console.log("[emp-prsv] batch " + (Math.floor(i / cfg.batchSize) + 1) +
          ": " + rowsWithRuns + "/" + batch.length + " rows carry source_emphasis_runs");
        emphasisList = batch.map(row => encodeEmphasisForGoogle(
          safeStr(row.source_text),
          Array.isArray(row.source_emphasis_runs) ? row.source_emphasis_runs : null
        ));
        maskedList = emphasisList.map(it => maskControlTokens(it.text));
        translatedBatch = await provider.adapter.translateBatch(
          maskedList.map(it => it.masked),
          cfg
        );
        payload = batchToPayload(batch, maskedList, translatedBatch, emphasisList);
      // How many payload entries carry decoded target_emphasis_runs?
      const payloadWithRuns = payload.filter(p => Array.isArray(p.target_emphasis_runs) && p.target_emphasis_runs.length > 0).length;
      console.log("[emp-prsv] batch " + (Math.floor(i / cfg.batchSize) + 1) +
        ": " + payloadWithRuns + "/" + payload.length + " payload entries have target_emphasis_runs");

        applyStats = bridge.applyRows(payload, {
          overwriteExisting: cfg.overwriteExisting,
          status: "translated",
          render: false
        });
        totalUpdated += Number(applyStats && applyStats.updated) || 0;
        totalSkipped +=
          (Number(applyStats && applyStats.skipped_existing) || 0) +
          (Number(applyStats && applyStats.skipped_locked) || 0) +
          (Number(applyStats && applyStats.skipped_missing) || 0) +
          (Number(applyStats && applyStats.skipped_empty) || 0);
        totalFailed += Math.max(0, batch.length - payload.length);

        if (cfg.requestDelayMs > 0 && (i + cfg.batchSize) < candidates.length) {
          await sleep(cfg.requestDelayMs);
        }
      }

      bridge.refresh();
      bridge.setStatusText(
        "[AUTO] Translation complete: " + String(totalUpdated) + " updated, " +
        String(totalSkipped) + " skipped, " + String(totalFailed) + " failed"
      );
      if (!silent) {
        alert(
          "Auto-translation finished!\n\n" +
          "✓ Updated: " + String(totalUpdated) + "\n" +
          "○ Skipped: " + String(totalSkipped) + "\n" +
          "✗ Failed: " + String(totalFailed)
        );
      }
      if (statusBefore) {
        window.setTimeout(() => {
          const curBridge = getBridge();
          if (curBridge) {
            curBridge.setStatusText(statusBefore);
          }
        }, 4500);
      }
    } catch (err) {
      console.error(err);
      bridge.setStatusText("[AUTO] Translation failed: " + safeStr(err && err.message));
      if (!silent) {
        alert(
          "Auto-translation failed:\n\n" +
          safeStr(err && err.message) +
          "\n\nTip: Click Advanced Settings to configure provider."
        );
      }
      return { ok: false, reason: "translation_error", error: safeStr(err && err.message) };
    } finally {
      running = false;
      if (btn) {
        btn.disabled = false;
      }
      if (label) {
        label.textContent = originalLabel || "Auto Translate";
      }
    }
    return { ok: true, candidates: candidates.length, updated: totalUpdated, skipped: totalSkipped, failed: totalFailed };
  }

  // Public API for automation: lets app.js / Playwright drive a silent run
  // with a chosen direction (zh-en / en-zh) without confirm/alert dialogs.
  window.__devTranslateRun = async function (opts) {
    const o = opts || {};
    const direction = o.direction || "";
    // Delegate validation to applyQuickDirection so every direction code
    // it supports (zh-en, en-zh, tw-cn, tc-sc, cn-tw, sc-tc) flows through
    // the automation bridge. Previously this branch hard-coded the
    // English ↔ zh-CN pair, silently swallowing any TC/SC direction
    // and letting the run inherit whatever config the operator left
    // behind — usually the default en → zh-CN, which mistranslates
    // when the source is actually Traditional Chinese.
    if (direction) {
      const cfgNext = applyQuickDirection(loadConfig(), direction);
      // #SEC: An unrecognized direction must abort — silently falling
      // through to the stored config is dangerous when paired with
      // autoSave=1, since it would overwrite targets using the wrong
      // language pair. Empty/undefined direction still falls through
      // (that's the no-direction case).
      if (!cfgNext) {
        console.error("[dev-translate] unknown direction:", direction);
        return { ok: false, reason: "unknown_direction", direction: direction };
      }
      saveConfig(cfgNext);
      updateButtonLabelFromConfig(cfgNext);
    }
    return await runAutoTranslate({
      silent: o.silent !== false,
      overwriteExisting: o.overwriteExisting
    });
  };

  function batchToPayload(batch, maskedList, translatedBatch, emphasisList) {
    const out = [];
    let i;
    let translated;
    let restored;
    let decoded;
    let targetRuns;
    for (i = 0; i < batch.length; i += 1) {
      translated = safeStr(translatedBatch[i]);
      // Order: control-token restore FIRST (it operates on Google's marker
      // form `[[__TOK_N__]]` which never overlaps the emphasis `@%E<N>S#$`
      // syntax), then emphasis decode on the restored text. The reverse
      // order would mean control tokens still live inside whatever survived
      // of the emphasis markers, and the decoded run offsets would
      // double-count the masked token length.
      restored = restoreControlTokens(translated, maskedList[i].tokens);
      targetRuns = null;
      if (emphasisList && emphasisList[i] && emphasisList[i].sidecar) {
        decoded = decodeEmphasisFromGoogle(restored, emphasisList[i].sidecar);
        restored = decoded.text;
        if (decoded.runs.length > 0) {
          targetRuns = decoded.runs;
        }
      }
      if (!hasEffectiveText(restored)) {
        continue;
      }
      const entry = {
        tid: batch[i].tid,
        target_text: restored
      };
      if (targetRuns) {
        entry.target_emphasis_runs = targetRuns;
        // #MTCARRY option②: faithful is granted downstream ONLY when the marker
        // roundtrip was provably clean (decode verdict). A mangled roundtrip
        // still yields best-effort suggestion runs, but they stay gated by client
        // (no faithful) so a mis-placed run can never auto-apply.
        entry.target_emphasis_runs_clean = (decoded && decoded.clean === true);
      }
      out.push(entry);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Emphasis-run position preservation via marker pairs (no-API path).
  //
  // Background:
  //   Webapp ingests `format_snapshot.emphasis_runs` from the package —
  //   character ranges in source_text that the InDesign extractor flagged
  //   as bold / italic / underline / superscript / subscript / color /
  //   link / comment. When the operator auto-translates via the free
  //   Google Web endpoint (no API key, no HTML mode), the translation
  //   destroys those positions: the translated string is a different
  //   number of characters with different word order, so character
  //   offsets from the source no longer make sense.
  //
  // Strategy:
  //   For each run, wrap its source span with a unique start/end marker
  //   pair before sending to Google. Google's free endpoint preserves
  //   the `@%E<N>S#$` ASCII envelope (same shape Traduzir-paginas-web
  //   uses for glossary terms — empirically Google leaves it alone). On
  //   return, find each surviving pair, compute the cleaned-text offset
  //   between them, and reconstruct target_emphasis_runs from the sidecar
  //   metadata (action / color / etc.).
  //
  // Per cross-repo policy (CLAUDE.md "user 未手动标注 → pipeline 不沿用
  // 源格式"), every reconstructed run carries `_auto: true` so the
  // InDesign-side import skips it until translator manually confirms in
  // the webapp UI.
  //
  // Edge handling:
  //   - marker pair broken (Google dropped or reordered) → that run is
  //     dropped silently; other runs unaffected
  //   - zero-length span post-decode → dropped
  //   - nested runs → outer span around inner span; stack-based decode
  //     pairs them correctly
  //   - adjacent runs at same offset → close-before-open ordering in
  //     encode keeps nesting valid

  // Tolerant of whitespace Google free endpoint sometimes injects between
  // ASCII symbols (`@ %`, `# $`, even between letters and digits).
  // Tolerant of whitespace Google free endpoint sometimes injects between
  // ASCII symbols (`@ %`, `# $`, even between letters and digits).
  const EMP_MARKER_RE_PAIR = /@\s*%\s*E\s*(\d+)\s*([SE])\s*#\s*\$/g;
  // Webapp emphasis dimensions that warrant position preservation. Mirrors
  // EmphasisOverlay.WEBAPP_EMPHASIS_DIMS — properties that visually change
  // the text appearance and should be carried through translation. Tracking,
  // fontFamily, and similar invisible-to-translator dims are filtered out:
  // they wouldn't survive Google's reflow anyway and are handled
  // end-to-end by the InDesign-side pipeline.
  const EMP_VISIBLE_DIMS = ["fontStyle", "underline", "strikeThrough",
    "fillColor", "fontSize", "baseline_shift", "position"];

  function diffHasVisibleEmphasis(diff) {
    if (!diff) return false;
    for (let i = 0; i < EMP_VISIBLE_DIMS.length; i += 1) {
      const k = EMP_VISIBLE_DIMS[i];
      if (!Object.prototype.hasOwnProperty.call(diff, k)) continue;
      const v = diff[k];
      if (v === false || v === null || v === undefined) continue;
      // `position: "NORMAL"` is the default — not real emphasis
      if (k === "position" && v === "NORMAL") continue;
      return true;
    }
    return false;
  }

  function encodeEmphasisForGoogle(text, runs) {
    const empty = { text: safeStr(text), sidecar: {} };
    if (!Array.isArray(runs) || runs.length === 0) {
      if (Array.isArray(runs)) {
        // Logged so a fast operator can tell "runs were passed but length=0"
        // apart from "runs were undefined". Both produce no markers.
        console.log("[emp-prsv] encode skip: empty runs array");
      }
      return empty;
    }
    const src = safeStr(text);
    const srcLen = src.length;
    if (srcLen === 0) {
      return empty;
    }
    const inserts = [];
    const sidecar = {};
    let runIdNext = 1;
    let i;
    let r;
    let start;
    let end;
    for (i = 0; i < runs.length; i += 1) {
      r = runs[i];
      if (!r || !r.diff) continue;
      if (!diffHasVisibleEmphasis(r.diff)) continue;
      start = Number(r.start);
      end = Number(r.end);
      if (!isFinite(start) || !isFinite(end)) continue;
      if (start < 0) start = 0;
      if (end > srcLen) end = srcLen;
      if (end <= start) continue;
      // Stash the diff in the sidecar. (Source-span geometry is intentionally
      // NOT used for a length/fraction sanity check — that approach is
      // root-cause-blind; see decode's clean-roundtrip verdict, #MTCARRY option②.)
      sidecar[runIdNext] = { diff: r.diff };
      inserts.push({ pos: start, kind: "open", id: runIdNext });
      inserts.push({ pos: end, kind: "close", id: runIdNext });
      runIdNext += 1;
    }
    if (inserts.length === 0) {
      console.log("[emp-prsv] encode: " + runs.length + " runs in → 0 visible after filter (no markers)");
      return empty;
    }
    console.log("[emp-prsv] encode: " + runs.length + " runs in → " + (runIdNext - 1) + " visible runs marked");
    // Sort: position ASC; at same position, close events before open events
    // so existing run closes before a new run opens (prevents A's close
    // landing inside B's bracket when they share a boundary).
    inserts.sort(function (a, b) {
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.kind === b.kind) return 0;
      return a.kind === "close" ? -1 : 1;
    });
    // #MTCARRY option②: record the exact (id,kind) marker order encode emits.
    // decode certifies a "clean" roundtrip iff the surviving marker sequence
    // equals this string — the gate-exemption (`faithful`) is granted ONLY then.
    sidecar.__seq = inserts.map(function (x) {
      return String(x.id) + (x.kind === "open" ? "S" : "E");
    }).join(",");
    let out = "";
    let cursor = 0;
    let ins;
    let token;
    for (i = 0; i < inserts.length; i += 1) {
      ins = inserts[i];
      out += src.slice(cursor, ins.pos);
      token = ins.kind === "open"
        ? "@%E" + String(ins.id) + "S#$"
        : "@%E" + String(ins.id) + "E#$";
      out += token;
      cursor = ins.pos;
    }
    out += src.slice(cursor);
    return { text: out, sidecar: sidecar };
  }

  function decodeEmphasisFromGoogle(translated, sidecar) {
    const result = { text: safeStr(translated), runs: [] };
    if (!sidecar || typeof sidecar !== "object") {
      return result;
    }
    const t = safeStr(translated);
    if (t.length === 0) {
      return result;
    }
    const events = [];
    EMP_MARKER_RE_PAIR.lastIndex = 0;
    let m;
    while ((m = EMP_MARKER_RE_PAIR.exec(t)) !== null) {
      events.push({
        from: m.index,
        to: m.index + m[0].length,
        runId: Number(m[1]),
        kind: m[2] === "S" ? "open" : "close"
      });
    }
    if (events.length === 0) {
      const expected = Object.keys(sidecar).length;
      if (expected > 0) {
        console.log("[emp-prsv] decode: " + expected + " runs sent, 0 marker events in returned text (Google stripped them all)");
      }
      return result;
    }
    // Count only numeric run ids (sidecar also carries a reserved __seq key).
    const expectedRuns = Object.keys(sidecar).filter(function (k) { return /^[0-9]+$/.test(k); }).length;
    // #MTCARRY option②: a faithful grant requires a PROVABLY-CLEAN roundtrip.
    // "Clean" = the surviving (id,kind) marker sequence EXACTLY equals the order
    // encode emitted (sidecar.__seq). Any dropped/added marker, id swap,
    // interleave, or drift PAST another marker changes this sequence → not clean.
    // Post-hoc drift DETECTION was abandoned: it is structurally impossible to
    // tell a clean lone marker from one that drifted WITHIN its own gap (no
    // count/order/structure signal), so we do not try — we only certify the
    // cases we can PROVE clean, and withhold faithful otherwise (caller gates).
    const observedSeq = events.map(function (e) {
      return String(e.runId) + (e.kind === "open" ? "S" : "E");
    }).join(",");
    const clean = (typeof sidecar.__seq === "string" && observedSeq === sidecar.__seq);
    // Build cleaned text by stripping markers; remember each marker's
    // cleaned-text position so we can derive run offset/length.
    let cleaned = "";
    let lastEnd = 0;
    const evCleanedPos = new Array(events.length);
    let i;
    let ev;
    for (i = 0; i < events.length; i += 1) {
      ev = events[i];
      cleaned += t.slice(lastEnd, ev.from);
      evCleanedPos[i] = cleaned.length;
      lastEnd = ev.to;
    }
    cleaned += t.slice(lastEnd);
    // Pair open/close with a STRICT stack (LIFO) to PRODUCE best-effort runs
    // for the overlay suggestion. Safety of the gate-exemption does NOT rest on
    // this pairing — it rests on the `clean` verdict above: when not clean the
    // caller withholds `faithful`, so even a mis-paired suggestion run stays
    // gated by client (shown dashed, never auto-applied). A crossed structure
    // still drops all runs here (no point surfacing garbage suggestions); a
    // stray close is skipped; leftover opens are dropped.
    const stack = [];
    const runs = [];
    let cleanedPos;
    let meta;
    let corrupt = false;
    for (i = 0; i < events.length; i += 1) {
      ev = events[i];
      cleanedPos = evCleanedPos[i];
      if (ev.kind === "open") {
        stack.push({ runId: ev.runId, startPos: cleanedPos });
        continue;
      }
      // close
      if (stack.length === 0) {
        continue; // stray close (open was lost) → skip this one only
      }
      const top = stack[stack.length - 1];
      if (top.runId !== ev.runId) {
        corrupt = true; // crossed / corrupt structure → untrustworthy
        break;
      }
      stack.pop();
      const startPos = top.startPos;
      const endPos = cleanedPos;
      if (endPos <= startPos) continue; // zero-length → drop
      meta = sidecar[ev.runId];
      if (!meta || !meta.diff) continue;
      // Output shape matches format_snapshot.emphasis_runs: { start, end, diff }.
      // `_auto: true` so the downstream InDesign pipeline treats this as
      // unconfirmed until the translator (or the faithful gate) applies it.
      runs.push({ start: startPos, end: endPos, diff: meta.diff, _auto: true });
    }
    if (corrupt) {
      console.log("[emp-prsv] decode: crossed/corrupt marker structure — dropping " +
        "all runs for this segment (safe: no mis-placed emphasis)");
      result.text = cleaned;
      result.runs = [];
      result.clean = false;
      return result;
    }
    // Unmatched opens (Google dropped a close marker) → silently dropped.
    // Sort by start ASC for downstream stability.
    runs.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });
    if (expectedRuns > 0) {
      console.log("[emp-prsv] decode: " + runs.length + "/" + expectedRuns +
        " runs recovered, " + events.length + " marker events, clean=" + clean);
    }
    result.text = cleaned;
    result.runs = runs;
    result.clean = clean; // #MTCARRY option②: drives the faithful gate-exemption
    return result;
  }

  function filterCandidates(rows, cfg) {
    const out = [];
    let i;
    let row;
    let source;
    for (i = 0; i < rows.length; i += 1) {
      row = rows[i];
      if (!row || !row.tid) {
        continue;
      }
      if (row.locked || row.translatable === false) {
        continue;
      }
      source = safeStr(row.source_text);
      if (!hasEffectiveText(source)) {
        continue;
      }
      if (!cfg.overwriteExisting && hasEffectiveTranslation(row.target_text)) {
        continue;
      }
      if (cfg.skipReviewed && safeStr(row.display_status) === "reviewed") {
        continue;
      }
      if (cfg.skipSimpleText && !!row.is_simple_text) {
        continue;
      }
      out.push(row);
    }
    return out;
  }

  function hasEffectiveText(text) {
    return safeStr(text).trim().length > 0;
  }

  function hasEffectiveTranslation(text) {
    return safeStr(text).replace(CONTROL_TOKEN_RE, "").trim().length > 0;
  }

  function maskControlTokens(text) {
    const tokens = [];
    const masked = safeStr(text).replace(CONTROL_TOKEN_RE, m => {
      const idx = tokens.length;
      tokens.push(m);
      return "[[__TOK_" + String(idx) + "__]]";
    });
    return { masked: masked, tokens: tokens };
  }

  function restoreControlTokens(text, tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    return safeStr(text).replace(/\[\[__TOK_(\d+)__\]\]/g, (m, i) => {
      const idx = Number(i);
      return Number.isFinite(idx) && list[idx] ? list[idx] : m;
    });
  }

  async function translateBatchViaGoogle(texts, cfg) {
    const endpoint = safeStr(cfg.googleEndpoint || DEFAULT_CONFIG.googleEndpoint).trim();
    const apiKey = safeStr(cfg.apiKey).trim();
    const sourceLang = safeStr(cfg.sourceLang).trim();
    const targetLang = safeStr(cfg.targetLang).trim();
    const payload = {
      q: texts,
      target: targetLang,
      format: "text"
    };
    let url;
    let data;
    let list;

    if (!apiKey) {
      throw new Error("Google API key is empty.");
    }
    if (!endpoint) {
      throw new Error("Google endpoint is empty.");
    }
    if (!targetLang) {
      throw new Error("Target language is empty.");
    }
    if (sourceLang && sourceLang.toLowerCase() !== "auto") {
      payload.source = sourceLang;
    }

    url = endpoint + "?key=" + encodeURIComponent(apiKey);
    data = await postJson(url, payload, "Google translate");
    list = extractTranslationList(data);
    if (!list) {
      throw new Error("Google translate response missing translations array.");
    }

    return texts.map((_, i) => decodeHtmlEntities(safeStr(list[i] && list[i].translatedText)));
  }

  async function translateBatchViaGoogleWeb(texts, cfg) {
    var rawEndpoint = safeStr(cfg.googleWebEndpoint || DEFAULT_CONFIG.googleWebEndpoint).trim();
    // When local server is available, route through its CORS proxy
    var endpoint = rawEndpoint;
    if (typeof localServer !== "undefined" && localServer.available && rawEndpoint === DEFAULT_CONFIG.googleWebEndpoint) {
      endpoint = localServer.baseUrl + "/api/proxy-translate";
    }
    const sourceLang = safeStr(cfg.sourceLang || "auto").trim() || "auto";
    const targetLang = safeStr(cfg.targetLang).trim();

    if (!endpoint) {
      throw new Error("Google web endpoint is empty.");
    }
    if (!targetLang) {
      throw new Error("Target language is empty.");
    }
    return await mapWithConcurrency(texts, GOOGLE_WEB_CONCURRENCY, async (text) => {
      return await translateOneViaGoogleWeb(
        safeStr(text),
        sourceLang,
        targetLang,
        endpoint
      );
    });
  }

  async function translateOneViaGoogleWeb(text, sourceLang, targetLang, endpoint) {
    const url = endpoint +
      "?client=gtx" +
      "&sl=" + encodeURIComponent(sourceLang || "auto") +
      "&tl=" + encodeURIComponent(targetLang) +
      "&dt=t&dt=bd&dj=1&q=" + encodeURIComponent(text);
    let resp;
    let data;
    let errText;
    let sentences;

    resp = await fetch(url).catch(() => ({ ok: false, status: 0, statusText: "" }));
    if (!resp || !resp.ok) {
      if (resp && typeof resp.text === "function") {
        errText = await safeReadResponseText(resp);
      } else {
        errText = "";
      }
      throw new Error(
        "Google web translate HTTP " + String(resp && resp.status ? resp.status : 0) +
        (errText ? " | " + errText.slice(0, 240) : "")
      );
    }

    data = await resp.json();
    sentences = Array.isArray(data && data.sentences) ? data.sentences : [];
    if (sentences.length > 0) {
      return sentences.map(s => safeStr(s && s.trans)).join("");
    }
    return "";
  }

  async function translateBatchViaProxy(texts, cfg) {
    const url = safeStr(cfg.proxyUrl).trim();
    const sourceLang = safeStr(cfg.sourceLang).trim();
    const targetLang = safeStr(cfg.targetLang).trim();
    let data;
    let list;

    if (!url) {
      throw new Error("Proxy URL is empty.");
    }

    data = await postJson(url, {
      q: texts,
      source: sourceLang,
      target: targetLang,
      format: "text"
    }, "Proxy translate");
    list = extractTranslationList(data);
    if (Array.isArray(data && data.translations)) {
      return texts.map((_, i) => decodeHtmlEntities(safeStr(list[i])));
    }
    if (Array.isArray(list)) {
      return texts.map((_, i) => decodeHtmlEntities(safeStr(list[i] && list[i].translatedText)));
    }
    throw new Error("Proxy translate response format unsupported.");
  }

  function translateBatchViaMock(texts, cfg) {
    return texts.map(t => "[MOCK-" + cfg.targetLang + "] " + safeStr(t));
  }

  async function postJson(url, payload, errorLabel) {
    let resp;
    let errText;

    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      errText = await safeReadResponseText(resp);
      throw new Error(
        safeStr(errorLabel) + " HTTP " + String(resp.status) +
        (errText ? " | " + errText.slice(0, 240) : "")
      );
    }
    return await resp.json();
  }

  function extractTranslationList(data) {
    if (Array.isArray(data && data.translations)) {
      return data.translations;
    }
    if (data && data.data && Array.isArray(data.data.translations)) {
      return data.data.translations;
    }
    return null;
  }

  async function safeReadResponseText(resp) {
    try {
      return await resp.text();
    } catch (e) {
      return "";
    }
  }

  // #SEC11: Decode the small set of entities Google Translate emits in
  // response text. Earlier this used `textarea.innerHTML = ...` which is
  // safe (textarea is RCDATA, content never parses as HTML), but the
  // pattern is review-hostile — it looks like an innerHTML sink even though
  // it isn't, and an unfamiliar reviewer might "fix" it the wrong way.
  // Explicit replacements remove that footgun. Includes numeric entities
  // because some translations come back with "&#39;" etc.
  function decodeHtmlEntities(text) {
    return safeStr(text)
      .replace(/&#(\d+);/g, function (_, n) {
        const code = parseInt(n, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) {
        const code = parseInt(n, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");  // last so we don't double-decode
  }

  function clampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function sleep(ms) {
    return new Promise(resolve => {
      window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  async function mapWithConcurrency(items, limit, mapper) {
    const list = Array.isArray(items) ? items : [];
    const cap = Math.max(1, Number(limit) || 1);
    const out = new Array(list.length);
    let cursor = 0;

    async function worker() {
      let idx;
      while (true) {
        idx = cursor;
        cursor += 1;
        if (idx >= list.length) {
          return;
        }
        out[idx] = await mapper(list[idx], idx);
      }
    }

    const workers = [];
    let i;
    for (i = 0; i < Math.min(cap, list.length); i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return out;
  }

  function safeStr(v) {
    return v === undefined || v === null ? "" : String(v);
  }

  // Test-only hook: expose the pure emphasis codec so headless suites can
  // round-trip encode → (simulated Google mangling of the marker envelope) →
  // decode and prove the load-bearing safety property: a faithful carry either
  // lands on the span the surviving markers delimit, or is DROPPED — it is
  // never mis-placed onto unrelated text. This matters now that
  // target_emphasis_runs_faithful lets a codec carry bypass the client BRIDGE-39
  // gate (the gate used to be the catch-all net for any codec misalignment).
  // No production code reads this; it only adds a window property under test.
  if (typeof window !== "undefined") {
    window.__devTranslateInternals = {
      encodeEmphasisForGoogle: encodeEmphasisForGoogle,
      decodeEmphasisFromGoogle: decodeEmphasisFromGoogle
    };
  }
})();
