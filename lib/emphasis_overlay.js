"use strict";

// translator_app/lib/emphasis_overlay.js
//
// Format-paint scaffolding for the translator app.
//
//   renderEmphasisHtml(text, runs)
//     Emit HTML with each emphasis run wrapped in a styled <span>. Used
//     to display source-side emphasis on the segments list / editor pane
//     so translators see *which* words are bolded / colored / underlined.
//
//   suggestTargetEmphasisRuns(sourceText, sourceRuns, targetText)
//     Heuristic alignment that projects source-side emphasis offsets
//     onto target text. Best-effort (translator can override). Strategy:
//       1. Exact-substring match for the emphasized source slice → use
//          its position(s) in target text
//       2. Word-boundary anchor match (case-insensitive) when exact fails
//       3. Proportional fallback based on character ratio
//
//   describeRun(run)
//     Short human-readable label of a run's diff dimensions
//     ("Bold", "Italic + underline", "Color #FF0000", ...).
//
// Pure module: no DOM dependencies. Used by app.js (browser context) AND
// by Node unit tests.

function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
}

function fillColorToCss(c) {
    if (!c) return null;
    if (c.values && c.values.length >= 3) {
        return "rgb(" + Math.round(c.values[0]) + "," +
                       Math.round(c.values[1]) + "," +
                       Math.round(c.values[2]) + ")";
    }
    if (c.swatch) {
        var lc = String(c.swatch).toLowerCase();
        var named = {
            red: "#c81e1e", blue: "#1950c8", green: "#1ea050",
            yellow: "#dcb41e", cyan: "#00a0c8", magenta: "#c800a0",
            black: "#000", white: "#fff"
        };
        return named[lc] || "currentColor";
    }
    return null;
}

function diffToCss(diff) {
    if (!diff) return "";
    var parts = [];
    if (diff.fontStyle) {
        var fs = String(diff.fontStyle).toLowerCase();
        if (fs.indexOf("bold") >= 0)   parts.push("font-weight:700");
        if (fs.indexOf("italic") >= 0) parts.push("font-style:italic");
    }
    if (diff.fontSize) parts.push("font-size:" + diff.fontSize + "pt");
    if (diff.underline && diff.strikeThrough) {
        parts.push("text-decoration:underline line-through");
    } else if (diff.underline) {
        parts.push("text-decoration:underline");
    } else if (diff.strikeThrough) {
        parts.push("text-decoration:line-through");
    }
    var col = fillColorToCss(diff.fillColor);
    if (col) parts.push("color:" + col);
    if (typeof diff.baseline_shift === "number" && diff.baseline_shift !== 0) {
        parts.push(diff.baseline_shift > 0 ? "vertical-align:super" : "vertical-align:sub");
    }
    return parts.join(";");
}

// Visible emphasis dimensions in the webapp. fontFamily is intentionally
// omitted — multi-script font assignment (CJK uses YaHei + Latin uses
// Arial) is solved end-to-end by Phase 8A scriptByFont detection at
// export and `_T_Latin_*` GREP rules at import. The translator types
// target text in NotoSansSC; per-character font isn't a manual paint
// concern.
var WEBAPP_EMPHASIS_DIMS = ["fontStyle", "underline", "strikeThrough",
    "fillColor", "fontSize", "baseline_shift"];

function _diffHasVisibleEmphasis(diff) {
    if (!diff) return false;
    for (var i = 0; i < WEBAPP_EMPHASIS_DIMS.length; i++) {
        var k = WEBAPP_EMPHASIS_DIMS[i];
        if (Object.prototype.hasOwnProperty.call(diff, k)) {
            var v = diff[k];
            // Skip falsy non-numeric (false bools, null colors) but keep numbers
            if (v === false || v === null || v === undefined) continue;
            // Truthy presence counts as visible emphasis
            return true;
        }
    }
    return false;
}

function describeRun(run) {
    if (!run || !run.diff) return "";
    var parts = [];
    var d = run.diff;
    if (d.fontStyle) {
        var fs = String(d.fontStyle).toLowerCase();
        if (fs.indexOf("bold") >= 0)   parts.push("Bold");
        if (fs.indexOf("italic") >= 0) parts.push("Italic");
    }
    if (d.underline)     parts.push("Underline");
    if (d.strikeThrough) parts.push("Strike");
    if (d.fillColor) {
        var c = d.fillColor;
        if (c.swatch) parts.push("Color " + c.swatch);
        else if (c.values && c.values.length >= 3) {
            var hex = ((Math.round(c.values[0]) << 16) | (Math.round(c.values[1]) << 8) | Math.round(c.values[2])).toString(16);
            while (hex.length < 6) hex = "0" + hex;
            parts.push("Color #" + hex.toUpperCase());
        } else parts.push("Color");
    }
    if (d.fontSize)   parts.push("Size " + d.fontSize + "pt");
    if (typeof d.baseline_shift === "number" && d.baseline_shift !== 0) {
        parts.push(d.baseline_shift > 0 ? "Superscript" : "Subscript");
    }
    // fontFamily intentionally omitted from human-readable label.
    return parts.join(" + ");
}

// renderEmphasisHtml — emit position markers only (no visual mimic).
//
// Each emphasis run is wrapped in `<span class="emp" data-emp-idx="N" ...>`
// with NO inline `style=` — the visual is just a yellow highlight + underline
// (CSS class `.emp`) signaling "this section has emphasis in source". The
// run's `diff` is encoded into data attrs so a click handler can read which
// formatting dimension to "paint" onto the target.
//
// Why no inline-styled mimic: the left PDF preview already shows the actual
// visual; replicating it in the source pane only diverges typography from
// target textarea, hampering side-by-side comparison. See
// docs/source_emphasis_rendering.md for full rationale.
//
// `tid` (optional) — segment tid; embedded as data-emp-tid so click
// handlers can resolve the segment without DOM walking.
function renderEmphasisHtml(text, runs, tid) {
    if (!text) return "";
    if (!runs || !runs.length) return escapeHtml(text);
    var len = text.length;
    // Pair runs with their original index so click handlers can look up
    // the live diff via state.segmentByTid[tid].format_snapshot.emphasis_runs[idx].
    // Skip runs whose ONLY emphasis dimension is fontFamily — those
    // represent multi-script font split (CJK YaHei vs Latin Arial)
    // which is handled end-to-end by Phase 8A scriptByFont GREP rules
    // at import. Webapp doesn't expose font as a paintable emphasis.
    var indexed = [];
    for (var i = 0; i < runs.length; i++) {
        if (!_diffHasVisibleEmphasis(runs[i] && runs[i].diff)) continue;
        indexed.push({ run: runs[i], idx: i });
    }
    if (indexed.length === 0) return escapeHtml(text);
    indexed.sort(function (a, b) { return (a.run.start || 0) - (b.run.start || 0); });
    var pos = 0, html = "";
    for (var j = 0; j < indexed.length; j++) {
        var r = indexed[j].run;
        var origIdx = indexed[j].idx;
        var s = Math.max(0, Math.min(len, r.start || 0));
        var e = Math.max(s, Math.min(len, r.end || s));
        if (s > pos) html += escapeHtml(text.substring(pos, s));
        var title = describeRun(r);
        html += '<span class="emp"' +
                ' data-emp-idx="' + origIdx + '"' +
                (tid ? ' data-emp-tid="' + escapeAttr(tid) + '"' : '') +
                (title ? ' title="' + escapeAttr(title) + '"' : "") +
                '>' + escapeHtml(text.substring(s, e)) + '</span>';
        pos = e;
    }
    if (pos < len) html += escapeHtml(text.substring(pos));
    return html;
}

// #34 source-side link rendering. Wraps any character range that
// `source_links[]` covers in `<a class="ann-link source-link"
// href="..." target="_blank">` so translators see at a glance which
// phrases are hyperlinks in the InDesign doc. Designed to compose
// with emphasis rendering above: layered render walks both decoration
// lists in one pass, emits emp-spans INSIDE link-anchors when they
// nest (the anchor's underline/color survives the inner span).
//
// Inputs:
//   text  — paragraph source string (unescaped)
//   runs  — emphasis_runs (same shape renderEmphasisHtml uses) or null
//   links — source_links[] = [{ offset, length, url, name }] or null
//   tid   — segment tid (forwarded to emp spans for click handlers)
//
// Output: HTML string with emp spans and/or link anchors interleaved.
// Returns escapeHtml(text) when both runs and links are empty.
function renderSourceDecoratedHtml(text, runs, links, tid) {
    if (!text) return "";
    var hasRuns  = !!(runs  && runs.length);
    var hasLinks = !!(links && links.length);
    if (!hasRuns && !hasLinks) return escapeHtml(text);
    // Fast path: no links → existing emphasis renderer
    if (!hasLinks) return renderEmphasisHtml(text, runs, tid);

    var len = text.length;
    // 1) Normalize emphasis decorations (skip invisible-only runs)
    var empDecs = [];
    if (hasRuns) {
        for (var i = 0; i < runs.length; i++) {
            var r = runs[i];
            if (!_diffHasVisibleEmphasis(r && r.diff)) continue;
            var s = Math.max(0, Math.min(len, r.start || 0));
            var e = Math.max(s, Math.min(len, r.end || s));
            if (e > s) empDecs.push({ start: s, end: e, run: r, origIdx: i });
        }
    }
    // 2) Normalize link decorations
    var linkDecs = [];
    for (var li = 0; li < links.length; li++) {
        var lk = links[li];
        if (!lk || typeof lk.offset !== "number" || typeof lk.length !== "number") continue;
        if (lk.length <= 0) continue;
        var ls = Math.max(0, Math.min(len, lk.offset));
        var le = Math.max(ls, Math.min(len, lk.offset + lk.length));
        if (le > ls && lk.url) linkDecs.push({ start: ls, end: le, url: String(lk.url), name: lk.name || "", origIdx: li });
    }
    if (empDecs.length === 0 && linkDecs.length === 0) return escapeHtml(text);

    // 3) Compute breakpoints (every start/end of every decoration + text bounds)
    var pointSet = Object.create(null);
    pointSet[0] = true; pointSet[len] = true;
    for (var p = 0; p < empDecs.length; p++) { pointSet[empDecs[p].start] = true; pointSet[empDecs[p].end] = true; }
    for (var q = 0; q < linkDecs.length; q++) { pointSet[linkDecs[q].start] = true; pointSet[linkDecs[q].end] = true; }
    var points = Object.keys(pointSet).map(Number).sort(function (a, b) { return a - b; });

    // 4) Walk text in sub-segments. For each sub-segment find active
    //    decorations; wrap emp INSIDE link (link is the outer anchor —
    //    matters because the anchor's text-decoration: underline is the
    //    primary visual signal; emp's yellow highlight should sit on top).
    var html = "";
    for (var pi = 0; pi < points.length - 1; pi++) {
        var ss = points[pi];
        var ee = points[pi + 1];
        if (ee <= ss) continue;
        var chunk = escapeHtml(text.substring(ss, ee));

        // Find active emphasis decoration(s) — apply innermost first.
        for (var ei = 0; ei < empDecs.length; ei++) {
            var ed = empDecs[ei];
            if (ed.start <= ss && ss < ed.end) {
                var title = describeRun(ed.run);
                chunk = '<span class="emp"' +
                        ' data-emp-idx="' + ed.origIdx + '"' +
                        (tid ? ' data-emp-tid="' + escapeAttr(tid) + '"' : '') +
                        (title ? ' title="' + escapeAttr(title) + '"' : "") +
                        '>' + chunk + '</span>';
            }
        }
        // Find active link decoration(s) — outermost. Render as an emp-style
        // span (yellow highlight via .emp) marked with data-link-idx so the
        // app.js click handler routes the click to the format-paint popover.
        // Source links are NOT real anchors — they're format-paintable
        // decorations (same UX as emphasis runs).
        for (var ki = 0; ki < linkDecs.length; ki++) {
            var ld = linkDecs[ki];
            if (ld.start <= ss && ss < ld.end) {
                chunk = '<span class="emp source-link-emp"' +
                        ' data-link-idx="' + ld.origIdx + '"' +
                        (tid ? ' data-link-tid="' + escapeAttr(tid) + '"' : '') +
                        ' title="' + escapeAttr(ld.url) + '">' +
                        chunk + '</span>';
            }
        }
        html += chunk;
    }
    return html;
}

// ─── Source → target alignment (heuristic) ────────────────────────

function indexOfWordBoundary(haystack, needle, startIdx) {
    var lc = String(haystack).toLowerCase();
    var n  = String(needle).toLowerCase();
    if (!n) return -1;
    var pos = startIdx || 0;
    while (pos < lc.length) {
        var hit = lc.indexOf(n, pos);
        if (hit < 0) return -1;
        var before = hit === 0 ? "" : lc.charAt(hit - 1);
        var after  = hit + n.length >= lc.length ? "" : lc.charAt(hit + n.length);
        var beforeOk = !before || /\W/.test(before);
        var afterOk  = !after  || /\W/.test(after);
        if (beforeOk && afterOk) return hit;
        pos = hit + 1;
    }
    return -1;
}

/**
 * Project source-side emphasis_runs onto target text using a 3-tier
 * heuristic:
 *
 *   1. exact case-sensitive substring match
 *   2. case-insensitive word-boundary match
 *   3. proportional fallback (start * targetLen/sourceLen, ditto end)
 *
 * @param {string} sourceText
 * @param {Array}  sourceRuns  format_snapshot.emphasis_runs
 * @param {string} targetText
 * @returns {Object} { runs: [{start, end, diff, confidence}], stats: {exact, word, proportional} }
 */
function suggestTargetEmphasisRuns(sourceText, sourceRuns, targetText) {
    var stats = { exact: 0, word: 0, proportional: 0, dropped: 0 };
    var out = [];
    if (!sourceRuns || !sourceRuns.length) return { runs: out, stats: stats };
    if (!targetText) {
        stats.dropped = sourceRuns.length;
        return { runs: out, stats: stats };
    }
    var sLen = String(sourceText).length;
    var tLen = String(targetText).length;
    var ratio = sLen > 0 ? (tLen / sLen) : 1;

    for (var i = 0; i < sourceRuns.length; i++) {
        var r = sourceRuns[i];
        if (!r || typeof r.start !== "number" || typeof r.end !== "number") continue;
        var slice = String(sourceText).substring(r.start, r.end);

        // Tier 1: exact substring
        var hit = -1, used = "exact";
        if (slice.length > 0) hit = String(targetText).indexOf(slice);

        // Tier 2: word-boundary (only when slice has a word character)
        if (hit < 0 && /\w/.test(slice)) {
            hit = indexOfWordBoundary(targetText, slice, 0);
            used = "word";
        }

        if (hit >= 0) {
            var lenInTarget = slice.length;
            // For word-boundary case, find the actual matched substring length in target
            if (used === "word") {
                var actual = String(targetText).substr(hit, slice.length);
                lenInTarget = actual.length;
                stats.word++;
            } else {
                stats.exact++;
            }
            out.push({
                start: hit,
                end:   hit + lenInTarget,
                diff:  r.diff,
                confidence: used === "exact" ? "high" : "medium"
            });
            continue;
        }

        // Tier 3: proportional fallback
        var pStart = Math.max(0, Math.min(tLen, Math.round(r.start * ratio)));
        var pEnd   = Math.max(pStart, Math.min(tLen, Math.round(r.end * ratio)));
        if (pEnd > pStart) {
            out.push({
                start: pStart,
                end:   pEnd,
                diff:  r.diff,
                confidence: "low"
            });
            stats.proportional++;
        } else {
            stats.dropped++;
        }
    }
    return { runs: out, stats: stats };
}

// ─── Module exports (CommonJS + browser global) ───────────────────

var moduleApi = {
    renderEmphasisHtml: renderEmphasisHtml,
    renderSourceDecoratedHtml: renderSourceDecoratedHtml,
    suggestTargetEmphasisRuns: suggestTargetEmphasisRuns,
    describeRun: describeRun,
    WEBAPP_EMPHASIS_DIMS: WEBAPP_EMPHASIS_DIMS,
    // exposed for tests
    _internal: {
        diffToCss: diffToCss,
        fillColorToCss: fillColorToCss,
        escapeHtml: escapeHtml,
        indexOfWordBoundary: indexOfWordBoundary,
        diffHasVisibleEmphasis: _diffHasVisibleEmphasis
    }
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = moduleApi;
}
if (typeof window !== "undefined") {
    window.EmphasisOverlay = moduleApi;
}
