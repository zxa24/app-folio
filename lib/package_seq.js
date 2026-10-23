// lib/package_seq.js — translation-package sequence prefix ("V01D_" / "V02T_") for the webapp.
//
// owner 2026-09-25 (indesign-toolkit task_plan.md#pkg-seq-prefix): every export —
// InDesign or webapp — carries ONE shared, increasing number plus a role letter:
// D = designer export (InDesign), T = translator export (webapp, this file).
// Interim design: the number lives ONLY in file / folder names.
//
// parseSeq / parseRole / formatPrefix / stripSeq / packageStem are byte-for-byte
// twins of indesign-toolkit translation_mvp_uxp/lib/package_seq.js — change both
// together (tests/package_seq.node.test.js asserts agreement).
(function (root) {
  "use strict";

  var PREFIX_RE = /^V(\d+)([DT])?_/;
  var TAIL_RE = /_(?:translation_package|translated)_\d{8}_\d{6}$/;

  function _lastSegment(name) {
    var s = String(name);
    var cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return cut >= 0 ? s.substring(cut + 1) : s;
  }

  function parseSeq(name) {
    if (name == null) return null;
    var m = PREFIX_RE.exec(_lastSegment(name));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isFinite(n) ? n : null;
  }

  function parseRole(name) {
    if (name == null) return null;
    var m = PREFIX_RE.exec(_lastSegment(name));
    return (m && m[2]) ? m[2] : null;
  }

  function formatPrefix(n, role) {
    var k = Math.max(1, Math.floor(Number(n) || 0));
    var r = (role === "D" || role === "T") ? role : "";
    return "V" + (k < 10 ? "0" + k : String(k)) + r + "_";
  }

  function stripSeq(name) {
    return String(name == null ? "" : name).replace(PREFIX_RE, "");
  }

  // "V01D_Doc_translation_package_20260925_133248_translated_20260925_141345.zip" → "Doc"
  function packageStem(name) {
    var s = stripSeq(_lastSegment(name == null ? "" : name).replace(/\.zip$/i, ""));
    var prev;
    do { prev = s; s = s.replace(TAIL_RE, ""); } while (s !== prev);
    return s || "package";
  }

  // ── IT TODO #122 (owner 2026-09-29): same side as the most recent package ⇒
  // same number, other side ⇒ +1; per target language; the round is recorded in
  // the package's own _package_seq.json (arch: not in the frozen _meta.json).
  // pickLatest / nextForRole / docIdentity / buildSidecar / parseSidecar are
  // twins of the IT copy (tests/package_seq.node.test.js asserts agreement).
  // The webapp has ONE package in hand (owner W1): the loaded package alone
  // decides. owner 2026-10-22 「编号仅在导出方变更时增加，其余的不变」: no batch
  // alignment anywhere (the 2026-09-29 one in the InDesign export is withdrawn) —
  // the number moves only when the exporting side changes, which W1 already is.
  // The `batch` field of _package_seq.json is carried through as a record only.

  function pickLatest(known) {
    var best = null;
    for (var i = 0; i < (known || []).length; i++) {
      var k = known[i];
      if (!k || !(Number(k.seq) >= 1)) continue;
      if (!best || k.seq > best.seq || (k.seq === best.seq && String(k.time || "") > String(best.time || ""))) best = k;
    }
    return best;
  }

  function nextForRole(latest, role) {
    if (!latest || !(Number(latest.seq) >= 1)) return 1;
    return Number(latest.seq) + (latest.role === role ? 0 : 1);
  }

  function docIdentity(stem) {
    return String(stem == null ? "" : stem).replace(/\.translated$/i, "");
  }

  var SIDECAR_NAME = "_package_seq.json";

  function buildSidecar(o) {
    o = o || {};
    return {
      schema: "package_seq/1",
      seq: Math.max(1, Math.floor(Number(o.seq) || 1)),
      role: (o.role === "D" || o.role === "T") ? o.role : null,
      target_language: o.targetLanguage ? String(o.targetLanguage) : null,
      batch: {
        folder: o.batchFolder ? String(o.batchFolder) : null,
        documents: (o.batchDocs || []).map(docIdentity).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).sort()
      },
      exported_at: o.exportedAt ? String(o.exportedAt) : null,
      exported_by: o.tool ? String(o.tool) : null
    };
  }

  // UTF-8 bytes → string without TextDecoder (UXP has none; twin of the IT copy).
  function utf8ToString(u8) {
    var out = "", i = 0, n = u8.length;
    while (i < n) {
      var c = u8[i++], cp;
      if (c < 0x80) cp = c;
      else if (c >= 0xC2 && c < 0xE0 && i < n) cp = ((c & 0x1F) << 6) | (u8[i++] & 0x3F);
      else if (c >= 0xE0 && c < 0xF0 && i + 1 < n) { cp = ((c & 0x0F) << 12) | ((u8[i] & 0x3F) << 6) | (u8[i + 1] & 0x3F); i += 2; }
      else if (c >= 0xF0 && c < 0xF5 && i + 2 < n) { cp = ((c & 0x07) << 18) | ((u8[i] & 0x3F) << 12) | ((u8[i + 1] & 0x3F) << 6) | (u8[i + 2] & 0x3F); i += 3; }
      else cp = 0xFFFD;
      if (cp > 0xFFFF) { cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }
      else out += String.fromCharCode(cp);
    }
    return out;
  }

  function parseSidecar(text) {
    var o;
    if (text && typeof text === "object" && typeof text.length === "number" && typeof text !== "string") {
      text = utf8ToString(text);
    }
    try { o = (typeof text === "string") ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!o || o.schema !== "package_seq/1" || !(Number(o.seq) >= 1)) return null;
    return {
      seq: Math.floor(Number(o.seq)),
      role: (o.role === "D" || o.role === "T") ? o.role : null,
      lang: o.target_language ? String(o.target_language) : null,
      time: (function () {
        var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(o.exported_at || ""));
        return m ? (m[1] + m[2] + m[3] + "_" + m[4] + m[5] + m[6]) : "";
      })()
    };
  }

  // Webapp only — an un-prefixed (old) package name read on its own (owner P2):
  // its exporter tails ARE its history, oldest first — "_translation_package_<ts>"
  // = a designer export, "_translated_<ts>" = a translator export; the round goes
  // up each time the side changes. "Doc_translation_package_…" → {1, D};
  // "Doc_translation_package_…_translated_…" → {2, T}. No tail → null.
  function roundsFromLegacyName(name) {
    var s = stripSeq(_lastSegment(name == null ? "" : name).replace(/\.zip$/i, ""));
    var roles = [];
    var m;
    while ((m = /_(translation_package|translated)_\d{8}_\d{6}$/.exec(s))) {
      roles.unshift(m[1] === "translated" ? "T" : "D");
      s = s.substring(0, m.index);
    }
    if (!roles.length) return null;
    var seq = 1;
    for (var i = 1; i < roles.length; i++) if (roles[i] !== roles[i - 1]) seq++;
    return { seq: seq, role: roles[roles.length - 1], time: "" };
  }

  // Webapp only (W1): what the loaded package says it is. Its own
  // _package_seq.json wins; else the prefixed name with the higher number (the
  // zip name, or the inner root folder — which keeps the DESIGNER's name inside a
  // translator zip); else the P2 reading of the old name. null = nothing known.
  function loadedPackageRound(sidecar, zipName, rootName) {
    if (sidecar && Number(sidecar.seq) >= 1) return { seq: sidecar.seq, role: sidecar.role, time: sidecar.time || "", from: "sidecar" };
    var zs = parseSeq(zipName), rs = parseSeq(rootName);
    if (zs != null || rs != null) {
      var useZip = (zs != null) && (rs == null || zs >= rs);
      var nm = useZip ? zipName : rootName;
      return { seq: useZip ? zs : rs, role: parseRole(nm), time: "", from: useZip ? "zip-name" : "root-name" };
    }
    var legacy = roundsFromLegacyName(zipName) || roundsFromLegacyName(rootName);
    if (legacy) { legacy.from = "legacy-name"; return legacy; }
    return null;
  }

  var api = {
    PREFIX_RE: PREFIX_RE,
    TAIL_RE: TAIL_RE,
    parseSeq: parseSeq,
    parseRole: parseRole,
    formatPrefix: formatPrefix,
    stripSeq: stripSeq,
    packageStem: packageStem,
    pickLatest: pickLatest,
    nextForRole: nextForRole,
    docIdentity: docIdentity,
    SIDECAR_NAME: SIDECAR_NAME,
    buildSidecar: buildSidecar,
    parseSidecar: parseSidecar,
    utf8ToString: utf8ToString,
    roundsFromLegacyName: roundsFromLegacyName,
    loadedPackageRound: loadedPackageRound,
    ROLE_DESIGNER: "D",
    ROLE_TRANSLATOR: "T"
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PackageSeq = api;
})(typeof window !== "undefined" ? window : null);
