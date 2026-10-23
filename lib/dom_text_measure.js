/**
 * Phase 7-SC: DOM-driven PDF/Preview layout measurement.
 *
 * The browser is the single source of truth for fontSize, line breaks, baselines,
 * and per-grapheme x positions. Both Preview rendering and PDF export call this
 * same module so they cannot diverge by font-metric measurement differences
 * (the residual gap left by Phase 5).
 *
 * Public API (exposed on window.DomTextMeasure):
 *
 *   getFontFamilyStack(targetLang) → CSS font-family string
 *   measureTextLayoutViaDOM(text, boxWPt, boxHPt, lineHMult, maxFontSizePt,
 *                           fontFamilyStack, targetLang, options) → Promise<layout>
 *
 * Layout shape (see task_plan.md Phase 7.2):
 *   {
 *     fontSize: number,           // pt (= CSS px @ 1:1)
 *     ascentPt: number,           // canvas measureText().fontBoundingBoxAscent
 *     descentPt: number,
 *     metricsSource: "canvas" | "fallback",
 *     lines: [{
 *       text, start, end,         // grapheme cluster offsets in original text
 *       top, baseline,            // pt relative to element top
 *       charXs: number[]          // length = grapheme count + 1
 *                                 //   [0..N-1] = each grapheme's start x
 *                                 //   [N]      = sentinel = right edge of line
 *     }],
 *     skipped: number,            // > 0 → caller MUST fall back to Phase 5
 *     skippedGraphemes: [{ start, value }]  // first 10 for diagnostics
 *   }
 *
 * IMPORTANT contract: when `skipped > 0` the caller MUST fall back to the
 * Phase 5 path (fitTextForPdf / fitTextInBox) for that segment and record
 * the tid in `phase7_skipped_segments[]`. Silent rendering of a partial
 * lines[] would drop characters from PDF, violating the "PDF stays
 * selectable/searchable real text" guarantee.
 */

(function () {
  // ───────── singletons ─────────
  let _measureEl = null;
  function getMeasureElement() {
    if (!_measureEl) {
      _measureEl = document.createElement("div");
      _measureEl.id = "__dom_text_measure_el";
      _measureEl.style.cssText = [
        "position: absolute",
        "left: -100000px",
        "top: -100000px",
        "visibility: hidden",
        "pointer-events: none",
        "white-space: pre-wrap",
        "word-break: break-word",
        "padding: 0",
        "margin: 0",
        "border: 0",
        "box-sizing: content-box",
        "contain: layout style"
      ].join(";");
      document.body.appendChild(_measureEl);
    }
    return _measureEl;
  }

  let _measureCtx = null;
  function getMeasureCanvasCtx() {
    if (!_measureCtx) {
      _measureCtx = document.createElement("canvas").getContext("2d");
    }
    return _measureCtx;
  }

  // ───────── grapheme iteration ─────────
  // Yields { value, start, end } per grapheme cluster. Uses Intl.Segmenter
  // when available (Chromium 87+, Firefox 125+, Safari 14.1+) so combining
  // marks, surrogate pairs, ZWJ sequences, emoji, Thai/Arabic clusters stay
  // intact. Falls back to UTF-16 code units in older environments.
  function iterateGraphemes(text, locale) {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const seg = new Intl.Segmenter(locale || "und", { granularity: "grapheme" });
      const out = [];
      for (const s of seg.segment(text)) {
        out.push({ value: s.segment, start: s.index, end: s.index + s.segment.length });
      }
      return out;
    }
    const out = [];
    for (let i = 0; i < text.length; i++) {
      out.push({ value: text.charAt(i), start: i, end: i + 1 });
    }
    return out;
  }

  // ───────── line extraction via Range API ─────────
  function extractLinesWithLayoutViaRange(el, text, ascentPt, targetLang) {
    if (!text) {
      return {
        lines: [{ text: "", start: 0, end: 0, top: 0, baseline: ascentPt, charXs: [0, 0] }],
        skipped: 0,
        skippedGraphemes: []
      };
    }
    const textNode = el.firstChild;
    if (!textNode || textNode.nodeType !== 3 /* TEXT_NODE */) {
      return {
        lines: [{ text: text, start: 0, end: text.length, top: 0, baseline: ascentPt, charXs: [0, 0] }],
        skipped: 0,
        skippedGraphemes: []
      };
    }
    const range = document.createRange();
    const elRect = el.getBoundingClientRect();
    const lines = [];
    let currentLine = null;
    let currentLineTop = null;
    let skipped = 0;
    const skippedGraphemes = [];

    const graphemes = iterateGraphemes(text, targetLang);
    for (let gi = 0; gi < graphemes.length; gi++) {
      const g = graphemes[gi];
      try {
        range.setStart(textNode, g.start);
        range.setEnd(textNode, g.end);
      } catch (e) {
        skipped++;
        if (skippedGraphemes.length < 10) skippedGraphemes.push({ start: g.start, value: g.value });
        continue;
      }
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[rects.length - 1] : null;
      if (!r) {
        skipped++;
        if (skippedGraphemes.length < 10) skippedGraphemes.push({ start: g.start, value: g.value });
        continue;
      }
      const relTop = r.top - elRect.top;
      const relX = r.left - elRect.left;

      if (!currentLine || Math.abs(relTop - currentLineTop) > 1) {
        // Close previous line: push end-sentinel x = current grapheme's start
        // (the previous line ended right where this one starts, by browser
        // wrap definition).
        if (currentLine) {
          currentLine.charXs.push(relX);
          currentLine.text = text.substring(currentLine.start, g.start);
          currentLine.end = g.start;
          lines.push(currentLine);
        }
        currentLine = {
          start: g.start,
          end: g.end,
          top: relTop,
          baseline: relTop + ascentPt,
          charXs: [relX],
          text: ""
        };
        currentLineTop = relTop;
      } else {
        currentLine.charXs.push(relX);
        currentLine.end = g.end;
      }
    }
    if (currentLine) {
      // Last line's end-sentinel = right edge of the line content. Use Range
      // over the line and read its bounding box right.
      try {
        range.setStart(textNode, currentLine.start);
        range.setEnd(textNode, currentLine.end);
        const lineRect = range.getBoundingClientRect();
        currentLine.charXs.push(lineRect.right - elRect.left);
      } catch (e) {
        // Pathological — fall back to last grapheme x
        currentLine.charXs.push(currentLine.charXs[currentLine.charXs.length - 1]);
      }
      currentLine.text = text.substring(currentLine.start, currentLine.end);
      lines.push(currentLine);
    }
    return { lines, skipped, skippedGraphemes };
  }

  // ───────── main entry ─────────
  async function measureTextLayoutViaDOM(text, boxWPt, boxHPt, lineHMult,
                                          maxFontSizePt, fontFamilyStack,
                                          targetLang, options) {
    const opts = options || {};
    // CRITICAL for production: wait for fonts so canvas measureText returns
    // metrics from the real embedded font, not a fallback. Tests opt out
    // via { waitForFonts: false } to assert fallback path explicitly.
    const waitForFonts = opts.waitForFonts !== false;
    if (waitForFonts && document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { /* ignore */ }
    }

    const el = getMeasureElement();
    const family = fontFamilyStack || "sans-serif";
    el.style.fontFamily = family;
    el.style.lineHeight = String(lineHMult || 1.2);
    el.style.width = boxWPt + "px";
    el.textContent = text || "";

    // Binary-search shrink fontSize to fit boxHPt (mirrors Phase 5 fitTextInBox).
    let lo = 0.5, hi = (maxFontSizePt > 0 ? maxFontSizePt : boxHPt), mid;
    el.style.fontSize = hi + "px";
    if (el.scrollHeight > boxHPt + 1) {
      while (hi - lo > 0.3) {
        mid = (lo + hi) / 2;
        el.style.fontSize = mid + "px";
        if (el.scrollHeight > boxHPt + 1) hi = mid;
        else lo = mid;
      }
      el.style.fontSize = lo + "px";
    }
    const fontSize = parseFloat(el.style.fontSize);

    // Real font metrics from canvas. fontBoundingBoxAscent/Descent gives the
    // font's typoAscent/typoDescent at this fontSize — NOT the Phase 5
    // hardcoded 0.88/0.32. Falls back to those constants when the API isn't
    // implemented (very old browsers).
    let metricsSource = "canvas";
    let ascentPt;
    let descentPt;
    try {
      const ctx = getMeasureCanvasCtx();
      ctx.font = fontSize + "px " + family;
      const fm = ctx.measureText("M");
      ascentPt = fm.fontBoundingBoxAscent;
      descentPt = fm.fontBoundingBoxDescent;
      if (typeof ascentPt !== "number" || !isFinite(ascentPt) || ascentPt <= 0) {
        throw new Error("fontBoundingBoxAscent unavailable");
      }
    } catch (e) {
      ascentPt = fontSize * 0.88;
      descentPt = fontSize * 0.32;
      metricsSource = "fallback";
    }

    const extracted = extractLinesWithLayoutViaRange(el, text || "", ascentPt, targetLang);

    return {
      fontSize: fontSize,
      ascentPt: ascentPt,
      descentPt: descentPt,
      metricsSource: metricsSource,
      lines: extracted.lines,
      skipped: extracted.skipped,
      skippedGraphemes: extracted.skippedGraphemes
    };
  }

  // ───────── font-family stack helper ─────────
  // Returns the CSS font-family string that BOTH Preview and PDF render
  // through. Centralizing this is non-negotiable: if Preview, the measure
  // element, and the PDF call site picked different stacks, the browser's
  // glyph-routing fallback would land different graphemes on different
  // fonts, breaking the "single source of measurement" invariant.
  //
  // Phase 7-SC stage: returns SC-only stack regardless of targetLang
  // (Phase 5 contract — multi-language is Phase 6+7-Multi territory).
  // Keep the targetLang parameter for forward compatibility.
  function getFontFamilyStack(/* targetLang */) {
    return '"NotoSansSC", sans-serif';
  }

  // ───────── export ─────────
  window.DomTextMeasure = {
    getFontFamilyStack: getFontFamilyStack,
    measureTextLayoutViaDOM: measureTextLayoutViaDOM,
    // exposed for tests:
    iterateGraphemes: iterateGraphemes,
    extractLinesWithLayoutViaRange: extractLinesWithLayoutViaRange,
    getMeasureElement: getMeasureElement
  };
})();
