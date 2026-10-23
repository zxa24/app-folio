// version_store.js — version-compare lineage core (contract v1)
//
// SoT: audit-logs/version_compare_manifest_contract_v1.md (arch-owned wire
// format). This module implements the READ side (webapp) of that contract:
//   - §4  content_hash  — byte-exact, cross-repo-reproducible logical identity
//   - §2  manifest parse — shape validation, unknown fields tolerated (C1)
//   - §5  lineage rebuild + must-surface — parent chain → unique linear order,
//         never silently drop a version or reorder.
//
// Pure logic only: NO File/DOM/ZIP here. The storage shell (getVersions in
// app.js, A1) feeds this raw bytes + the parsed manifest object. That keeps
// the doc-library backend swap (A1) from touching this lineage core (AC4).
//
// UMD-ish: window.VersionStore in the browser, require() in Node tests. The
// SHA-256 primitive is the shared vendor/sha256_pure.js (byte-identity across
// UXP / Browser / Node — the whole reason that file is pure JS).

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../vendor/sha256_pure.js"));
  } else {
    root.VersionStore = factory(root.SHA256Pure);
  }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function (SHA) {
  "use strict";

  var MANIFEST_VERSION_SUPPORTED = 1;
  var LINEAGE_FORMAT_KNOWN = "single-file-carryforward-v1";

  // ── §4 content_hash ──────────────────────────────────────────────────────
  // content_hash = "sha256:" + hexlower(SHA256(
  //                    ascii(hexlower(SHA256(bytes_of segments.json)))
  //                    + ":" +
  //                    ascii(hexlower(SHA256(bytes_of translations.json)))))
  //
  // Both inputs are RAW file bytes (SHA.hexBytes, no utf8 re-encode) so BOM /
  // CRLF / non-UTF-8 hash exactly as written. The inner composition string is
  // pure ASCII (64 hex + ":" + 64 hex), so SHA.hex() (which utf8-encodes) is
  // byte-identical to ascii-encoding it. IT writes it, webapp recomputes it;
  // AC6 = recomputed ≠ declared ⇒ must-surface.
  function computeContentHash(segBytes, transBytes) {
    var hSeg = SHA.hexBytes(segBytes);
    var hTrans = SHA.hexBytes(transBytes);
    return "sha256:" + SHA.hex(hSeg + ":" + hTrans);
  }

  function isSha256Ref(v) {
    return typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
  }

  // ── §2 manifest parse ─────────────────────────────────────────────────────
  // Validates the wire shape WITHOUT throwing — problems become surfaced issues
  // (§5), never silent drops. Unknown top-level / per-version fields are kept
  // untouched (C1 forward-compat). Returns { ok, manifest, issues }.
  function parseManifest(obj) {
    var issues = [];
    function add(severity, code, message, detail) {
      issues.push({ severity: severity, code: code, message: message, detail: detail || null });
    }

    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      add("error", "MANIFEST_MALFORMED", "versions/manifest.json is not a JSON object.");
      return { ok: false, manifest: null, issues: issues };
    }

    var mv = obj.manifest_version;
    if (typeof mv !== "number" || !isFinite(mv)) {
      add("error", "MANIFEST_VERSION_MISSING", "manifest_version missing or not a number.");
    } else if (mv > MANIFEST_VERSION_SUPPORTED) {
      // §5: newer tool wrote this — do NOT silently downgrade-parse.
      add("error", "MANIFEST_VERSION_TOO_HIGH",
        "Package was exported by a newer tool (manifest_version " + mv +
        " > supported " + MANIFEST_VERSION_SUPPORTED + "). Update the app to read it.",
        { manifest_version: mv, supported: MANIFEST_VERSION_SUPPORTED });
    }

    // lineage_format is a forward-compat tag (C1): unknown value is tolerated
    // (info, not error) — doc-library later swaps the tag, not the semantics.
    if (obj.lineage_format && obj.lineage_format !== LINEAGE_FORMAT_KNOWN) {
      add("info", "LINEAGE_FORMAT_UNKNOWN",
        "Unrecognized lineage_format \"" + String(obj.lineage_format) + "\" — read with v1 semantics.",
        { lineage_format: obj.lineage_format });
    }

    if (!Array.isArray(obj.versions)) {
      add("error", "VERSIONS_MISSING", "manifest.versions[] missing or not an array.");
      return { ok: false, manifest: obj, issues: issues };
    }

    // Per-version shape checks — collect, don't abort. content_hash is the
    // identity/addressing key (§2); version_id is display/dir only.
    var seenHash = {};
    obj.versions.forEach(function (v, idx) {
      if (!v || typeof v !== "object") {
        add("error", "VERSION_MALFORMED", "versions[" + idx + "] is not an object.", { index: idx });
        return;
      }
      if (!isSha256Ref(v.content_hash)) {
        add("error", "VERSION_HASH_INVALID",
          "versions[" + idx + "].content_hash is not a valid \"sha256:<64hex>\" ref.",
          { index: idx, content_hash: v.content_hash });
      } else if (seenHash[v.content_hash]) {
        add("error", "VERSION_HASH_DUP",
          "Duplicate content_hash across versions (identity collision): " + v.content_hash,
          { index: idx, content_hash: v.content_hash });
      } else {
        seenHash[v.content_hash] = true;
      }
      if (v.parent !== null && !isSha256Ref(v.parent)) {
        add("error", "VERSION_PARENT_INVALID",
          "versions[" + idx + "].parent must be null or a \"sha256:<64hex>\" ref.",
          { index: idx, parent: v.parent });
      }
      if (typeof v.version_id !== "string" || v.version_id === "") {
        add("error", "VERSION_ID_MISSING", "versions[" + idx + "].version_id missing.", { index: idx });
      }
    });

    if (obj.tip !== undefined && obj.tip !== null && !isSha256Ref(obj.tip)) {
      add("error", "TIP_INVALID", "manifest.tip is not a valid \"sha256:<64hex>\" ref.", { tip: obj.tip });
    }

    var hasError = issues.some(function (i) { return i.severity === "error"; });
    return { ok: !hasError, manifest: obj, issues: issues };
  }

  // ── §5 lineage rebuild ─────────────────────────────────────────────────────
  // Derive the UNIQUE linear version order from explicit parent pointers
  // (charter §4: content-hash alone can false-merge → explicit parent required,
  // but parent lives in the manifest, not the frozen schema — D4). Surfaces:
  //   CHAIN_BROKEN (parent not in manifest) / CHAIN_CYCLE / ORDER_AMBIGUOUS
  //   (0 or >1 roots, or a fork = a version parents >1 child) / TIP_MISMATCH /
  //   BOOTSTRAP_ROOT_INCOMPLETE (root=null → history may not reach v1; AC2).
  // Returns { ok, order:[content_hash...], root, tip, issues }.
  function rebuildLineage(versions, declaredTip) {
    var issues = [];
    function add(severity, code, message, detail) {
      issues.push({ severity: severity, code: code, message: message, detail: detail || null });
    }

    versions = Array.isArray(versions) ? versions : [];
    var byHash = {};
    versions.forEach(function (v) {
      if (v && isSha256Ref(v.content_hash) && !byHash[v.content_hash]) byHash[v.content_hash] = v;
    });

    // Roots = parent null. Children map = parent -> [child hashes].
    var roots = [];
    var childrenOf = {};
    versions.forEach(function (v) {
      if (!v || !isSha256Ref(v.content_hash)) return;
      if (v.parent === null || v.parent === undefined) {
        roots.push(v.content_hash);
        return;
      }
      if (!byHash[v.parent]) {
        add("error", "CHAIN_BROKEN",
          "Version " + v.content_hash + " references parent " + v.parent + " that is not in the manifest.",
          { child: v.content_hash, parent: v.parent });
        return;
      }
      (childrenOf[v.parent] = childrenOf[v.parent] || []).push(v.content_hash);
    });

    if (roots.length === 0) {
      add("error", "ORDER_AMBIGUOUS",
        "No lineage root (no version with parent=null) — chain is broken or fully cyclic; cannot derive a version order.");
      return { ok: false, order: [], root: null, tip: null, issues: issues };
    }
    if (roots.length > 1) {
      add("error", "ORDER_AMBIGUOUS",
        "Multiple lineage roots (" + roots.length + ") — not a single linear history; cannot order versions.",
        { roots: roots });
      return { ok: false, order: [], root: null, tip: null, issues: issues };
    }

    // Walk root → tip; each node must have exactly one child (linear), else fork.
    var order = [];
    var visited = {};
    var cur = roots[0];
    var forked = false;
    while (cur) {
      if (visited[cur]) {
        add("error", "CHAIN_CYCLE", "Cycle detected in parent chain at " + cur + ".", { at: cur });
        return { ok: false, order: [], root: roots[0], tip: null, issues: issues };
      }
      visited[cur] = true;
      order.push(cur);
      var kids = childrenOf[cur] || [];
      if (kids.length > 1) {
        add("error", "ORDER_AMBIGUOUS",
          "Version " + cur + " has " + kids.length + " children (a fork) — history is not linear.",
          { at: cur, children: kids });
        forked = true;
        break;
      }
      cur = kids[0];
    }

    // Any version not reached by the walk = unreachable island (broken order).
    if (!forked) {
      var unreachable = versions.filter(function (v) {
        return v && isSha256Ref(v.content_hash) && !visited[v.content_hash];
      }).map(function (v) { return v.content_hash; });
      if (unreachable.length > 0) {
        add("error", "ORDER_AMBIGUOUS",
          unreachable.length + " version(s) are not reachable from the lineage root — order is ambiguous.",
          { unreachable: unreachable });
        return { ok: false, order: order, root: roots[0], tip: null, issues: issues };
      }
    }

    var tip = order.length ? order[order.length - 1] : null;

    // §5 tip consistency: declared tip must be the derived tip.
    if (declaredTip && isSha256Ref(declaredTip) && !forked && declaredTip !== tip) {
      add("error", "TIP_MISMATCH",
        "manifest.tip (" + declaredTip + ") is not the derived tip of the lineage (" + tip + ").",
        { declared: declaredTip, derived: tip });
    }

    // AC2: root is parent=null but earlier versions may have been skipped at
    // carry-forward (operator may not select every prior package). We cannot
    // prove completeness from the package alone → surface, never claim full history.
    if (order.length > 0) {
      add("info", "BOOTSTRAP_ROOT",
        "History in this package starts at the root version; earlier versions may not be included — comparisons cannot reach before it.",
        { root: roots[0] });
    }

    var hasError = issues.some(function (i) { return i.severity === "error"; });
    return { ok: !hasError && !forked, order: order, root: roots[0], tip: tip, issues: issues };
  }

  return {
    MANIFEST_VERSION_SUPPORTED: MANIFEST_VERSION_SUPPORTED,
    LINEAGE_FORMAT_KNOWN: LINEAGE_FORMAT_KNOWN,
    computeContentHash: computeContentHash,
    isSha256Ref: isSha256Ref,
    parseManifest: parseManifest,
    rebuildLineage: rebuildLineage
  };
}));
