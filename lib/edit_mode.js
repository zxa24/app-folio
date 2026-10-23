// lib/edit_mode.js — webapp "edit mode" (edit the EXISTING text instead of retyping it).
//
// owner 2026-09-25/26 (indesign-toolkit TODO #6, task_plan #ac-import-hardening P2):
//   - revision rounds typed into an EMPTY target box ⇒ a merged soft-break card got
//     half a sentence and the import replaced the whole paragraph (IT TODO #106),
//     and the new text carried no emphasis ⇒ old bold stayed at old char offsets (#105).
//   - edit mode prefills each empty row with the paragraph's CURRENT text (a merged
//     card = head + all tails) together with its emphasis runs, and the runs follow
//     the text as the translator edits it (design-intent §5: format rides the text).
//   - seam between soft-break pieces: a space only when BOTH sides are non-CJK,
//     otherwise joined directly (owner「A好」; same rule as the CJK epic's Q3a).
//
// Pure functions only — app.js owns state. No backslashes in this file on purpose
// (two tooling paths in this repo have silently rewritten escapes); CJK is tested
// by numeric code-point ranges.
(function (root) {
  "use strict";

  var CJK_RANGES = [
    [0x3000, 0x303F], [0x3040, 0x309F], [0x30A0, 0x30FF], [0x3400, 0x4DBF],
    [0x4E00, 0x9FFF], [0xAC00, 0xD7AF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF]
  ];

  function isCJKCode(code) {
    for (var i = 0; i < CJK_RANGES.length; i++) {
      if (code >= CJK_RANGES[i][0] && code <= CJK_RANGES[i][1]) return true;
    }
    return false;
  }

  function isSpaceCode(code) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 160 || code === 0x3000;
  }

  // Separator between two soft-break pieces a | b.
  function seam(a, b) {
    var sa = String(a || ""), sb = String(b || "");
    if (!sa || !sb) return "";
    var ca = sa.charCodeAt(sa.length - 1), cb = sb.charCodeAt(0);
    if (isSpaceCode(ca) || isSpaceCode(cb)) return "";
    return (!isCJKCode(ca) && !isCJKCode(cb)) ? " " : "";
  }

  function _cloneRun(r) {
    var o = { start: r.start, end: r.end };
    if (r.diff && typeof r.diff === "object") {
      o.diff = {};
      for (var k in r.diff) if (Object.prototype.hasOwnProperty.call(r.diff, k)) o.diff[k] = r.diff[k];
    }
    return o;
  }

  // Which snapshot runs are EMPHASIS worth carrying. A snapshot run is any span that
  // differs from the paragraph style's baseline — including the body's own weight
  // when a brand rule set it locally (DocX-1 TC: baseline Regular, body text MHeiHK
  // Medium ⇒ runs with diff {fontStyle:"Medium"}) and Latin font splits (Dax Pro on
  // ";"). Carrying those made the import BOLD the body text (the CJK emphasis
  // applier picks the paired emphasis weight, not diff.fontStyle) — measured on a
  // copy 2026-09-26. Font splits are the import's script routing (GREP / byPair).
  var EMPHASIS_WEIGHT_RE = /bold|black|heavy|semi|demi|italic|oblique/i;
  function isEmphasisRun(r) {
    if (!r) return false;
    if (typeof r.charStyleHint === "string" && r.charStyleHint.indexOf("_T_c_emp") === 0) return true;
    var d = r.diff || {};
    if (typeof d.fontStyle === "string" && EMPHASIS_WEIGHT_RE.test(d.fontStyle)) return true;
    if (d.underline === true || d.strikeThrough === true) return true;
    if (d.fillColor) return true;
    if (typeof d.fontSize === "number") return true;
    if (typeof d.baseline_shift === "number" && d.baseline_shift !== 0) return true;
    if (typeof d.position === "string" && d.position !== "NORMAL") return true;
    return false;
  }

  function _validRuns(runs, len) {
    var out = [];
    (runs || []).forEach(function (r) {
      if (!r || typeof r.start !== "number" || typeof r.end !== "number") return;
      var s = Math.max(0, r.start), e = Math.min(len, r.end);
      if (e > s) { var c = _cloneRun(r); c.start = s; c.end = e; out.push(c); }
    });
    return out;
  }

  /**
   * Join pieces into one prefill.
   * @param pieces [{ text: rawSourceText, runs: [{start,end,diff}] in the piece's own coordinates }]
   * @param toVisible optional fn(raw) → text shown in the textarea (control tokens);
   *        run offsets are re-mapped through it (tokens are multi-character).
   * @returns { text, runs }   both in VISIBLE coordinates
   */
  function buildPrefill(pieces, toVisible) {
    var raw = "", runs = [];
    (pieces || []).forEach(function (p, i) {
      var t = String((p && p.text) || "");
      // p.sep overrides the soft-break seam (a manually merged NEXT paragraph is
      // joined with a newline, like mergeNextSegmentFromTid — audit 2026-09-26 #10).
      if (i > 0) raw += (p && typeof p.sep === "string") ? p.sep : seam(raw, t);
      var base = raw.length;
      _validRuns(((p && p.runs) || []).filter(isEmphasisRun), t.length).forEach(function (r) {
        r.start += base; r.end += base; runs.push(r);
      });
      raw += t;
    });
    if (typeof toVisible !== "function") return { text: raw, runs: runs };
    var vis = String(toVisible(raw));
    var map = function (idx) { return String(toVisible(raw.slice(0, idx))).length; };
    runs.forEach(function (r) { r.start = map(r.start); r.end = map(r.end); });
    return { text: vis, runs: _validRuns(runs, vis.length) };
  }

  /**
   * Move runs through one text edit — same rules as app.js adjustAnnotationOffsets:
   * edit before a run shifts it; typing inside a run grows it; typing exactly at a
   * run's start or end stays OUTSIDE it; deleted text takes its emphasis with it.
   */
  function adjustRuns(runs, editOffset, deleteCount, insertCount, newLength) {
    var delta = insertCount - deleteCount, editEnd = editOffset + deleteCount, out = [];
    (runs || []).forEach(function (r0) {
      var r = _cloneRun(r0), s = r.start, e = r.end;
      if (s >= editEnd) { s += delta; e += delta; }
      else if (s >= editOffset) {
        if (e <= editEnd) { e = s; }
        else { var ov = editEnd - s; s = editOffset + insertCount; e = s + (r.end - r.start - ov); }
      } else if (e > editOffset) {
        if (e <= editEnd) { e = editOffset; }
        else { e += delta; }
      }
      if (e > s && s >= 0 && e <= newLength) { r.start = s; r.end = e; out.push(r); }
    });
    return out;
  }

  /** Visible-coordinate runs → coordinates of fromVisible(text) (what export writes). */
  function runsToRaw(runs, visibleText, fromVisible) {
    if (typeof fromVisible !== "function") return _validRuns(runs, String(visibleText).length);
    var v = String(visibleText), rawLen = String(fromVisible(v)).length;
    var map = function (idx) { return String(fromVisible(v.slice(0, idx))).length; };
    return _validRuns((runs || []).map(function (r) {
      var c = _cloneRun(r); c.start = map(r.start); c.end = map(r.end); return c;
    }), rawLen);
  }

  /** Raw-coordinate runs (as exported / loaded from a package) → textarea coordinates. */
  function runsFromRaw(runs, rawText, toVisible) {
    var raw = String(rawText || "");
    if (typeof toVisible !== "function") return _validRuns(runs, raw.length);
    var visLen = String(toVisible(raw)).length;
    var map = function (idx) { return String(toVisible(raw.slice(0, idx))).length; };
    return _validRuns((runs || []).map(function (r) {
      var c = _cloneRun(r); c.start = map(r.start); c.end = map(r.end); return c;
    }), visLen);
  }

  // ── Toolbar integration (owner 2026-09-26: carried emphasis behaves like the
  //    normal select-text format toolbar) ─────────────────────────────────────
  var ITALIC_RE = /italic|oblique/i;
  var BOLD_RE = /bold|black|heavy|semi|demi/i;

  /** Toolbar actions a run shows as active: bold / italic / underline / superscript / color. */
  function runActions(r) {
    var d = (r && r.diff) || {}, out = {};
    if (typeof d.fontStyle === "string" && BOLD_RE.test(d.fontStyle)) out.bold = true;
    if (typeof d.fontStyle === "string" && ITALIC_RE.test(d.fontStyle)) out.italic = true;
    if (d.underline === true) out.underline = true;
    if (typeof d.position === "string" && d.position !== "NORMAL") out.superscript = true;
    if (d.fillColor) out.color = true;
    return out;
  }

  function _stripAction(diff, action) {
    var d = {};
    for (var k in diff) if (Object.prototype.hasOwnProperty.call(diff, k)) d[k] = diff[k];
    if (action === "bold" || action === "italic") {
      var re = action === "bold" ? BOLD_RE : ITALIC_RE;
      if (typeof d.fontStyle === "string" && re.test(d.fontStyle)) {
        delete d.fontStyle;
        // "Bold Italic" minus bold keeps italic (and vice versa)
        var keep = action === "bold" ? ITALIC_RE : BOLD_RE;
        if (keep.test(diff.fontStyle)) d.fontStyle = action === "bold" ? "Italic" : "Bold";
      }
    } else if (action === "underline") { delete d.underline; }
    else if (action === "superscript") { delete d.position; delete d.fontSize; delete d.baseline_shift; }
    else if (action === "color") { delete d.fillColor; }
    else if (action === "*") { d = {}; }
    return d;
  }

  /**
   * Remove one format (action) — or everything ("*") — from the runs inside [s, e).
   * Runs are split at s / e; the part inside loses the format and is dropped when
   * nothing emphatic is left (isEmphasisRun).
   */
  function removeAction(runs, action, s, e) {
    var out = [];
    (runs || []).forEach(function (r) {
      if (!r || r.end <= s || r.start >= e) { out.push(_cloneRun(r)); return; }
      if (r.start < s) { var a = _cloneRun(r); a.end = s; out.push(a); }
      var mid = _cloneRun(r); mid.start = Math.max(r.start, s); mid.end = Math.min(r.end, e);
      mid.diff = _stripAction(r.diff || {}, action);
      if (isEmphasisRun(mid)) out.push(mid);
      if (r.end > e) { var z = _cloneRun(r); z.start = e; out.push(z); }
    });
    return out.filter(function (r) { return r.end > r.start; });
  }

  /** Index of the run covering offset (narrowest), or -1. */
  function runAt(runs, offset) {
    var best = -1, bestLen = Infinity;
    (runs || []).forEach(function (r, i) {
      if (r && r.start <= offset && offset < r.end && (r.end - r.start) < bestLen) { best = i; bestLen = r.end - r.start; }
    });
    return best;
  }

  /** A prefilled row the translator has not touched. */
  // Untouched = same text AND no format change: an added annotation or an edited
  // carried emphasis is a change too, or its export would be dropped.
  function isUntouchedPrefill(row) {
    return !!row && typeof row.edit_prefill_text === "string" && row.target_text === row.edit_prefill_text
      && !(Array.isArray(row.annotations) && row.annotations.length > 0)
      && row.edit_runs_modified !== true;
  }

  var api = {
    isCJKCode: isCJKCode,
    isEmphasisRun: isEmphasisRun,
    seam: seam,
    buildPrefill: buildPrefill,
    adjustRuns: adjustRuns,
    runsToRaw: runsToRaw,
    runsFromRaw: runsFromRaw,
    isUntouchedPrefill: isUntouchedPrefill,
    runActions: runActions,
    removeAction: removeAction,
    runAt: runAt
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.EditMode = api;
})(typeof window !== "undefined" ? window : null);
