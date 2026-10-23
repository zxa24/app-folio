// check_schema_drift.js — paired-merge gate guard for the frozen
// project_meta require-graph (8D-ext-A1 G2).
//
// Re-hashes each file recorded in the IT frozen_manifest.json against BOTH
// (a) the app-folio canonical source and (b) the IT frozen copy, and fails
// if any three-way sha256 disagreement is found:
//   - canonical != manifest  -> canonical changed without re-running sync_frozen.js
//   - frozen    != manifest  -> a frozen copy was hand-edited
//   - canonical != frozen     -> the two repos have drifted (the silent
//                                cross-runtime CAS-corruption class — sha256_pure
//                                divergence here is P0, spec §6.3 / HANDOFF G1)
//
// Run at the paired-merge gate (arch's .scratch/merge-gate.sh). No CI runner
// is wired in A1; this is a manually-invoked gate. A3 mounts it in CI.
//
// Usage:
//   node tools/check_schema_drift.js [appRoot] [itRoot]
// Exit 0 = in sync; 1 = drift / missing file; 2 = setup error.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var FROZEN_DEST_ROOT = "translation_mvp_uxp/lib/vendor/project_meta";

// EOL-agnostic hash: the frozen require-graph is text whose runtime
// behavior is unaffected by CRLF vs LF (JS/JSON ignore \r). git autocrlf
// converts working-tree EOL per-checkout/per-platform, so a raw-byte sha256
// would false-fail on a fresh checkout / A3 Linux CI even with zero semantic
// drift. Normalize CRLF/CR -> LF before hashing so the guard catches real
// code divergence (the P0 sha256_pure case) and ignores EOL artifacts.
function normalizeEol(buf) {
    return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "latin1");
}
function sha256(buf) { return crypto.createHash("sha256").update(normalizeEol(buf)).digest("hex"); }

function resolveAppRoot(arg) {
    var root = arg || path.resolve(__dirname, "..");
    if (!fs.existsSync(path.join(root, "vendor", "project_meta.js"))) {
        throw new Error("appRoot does not look like app-folio: " + root);
    }
    return root;
}
function resolveItRoot(arg, appRoot) {
    var candidates = [];
    if (arg) candidates.push(arg);
    if (process.env.IT_REPO) candidates.push(process.env.IT_REPO);
    candidates.push(path.resolve(appRoot, "..", "indesign-toolkit-meta"));
    candidates.push(path.resolve(appRoot, "..", "indesign-toolkit"));
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] && fs.existsSync(path.join(candidates[i], "translation_mvp_uxp"))) return candidates[i];
    }
    throw new Error("could not resolve IT repo root (arg2 or IT_REPO). Tried: " + candidates.join(", "));
}

function main() {
    var appRoot = resolveAppRoot(process.argv[2]);
    var itRoot = resolveItRoot(process.argv[3], appRoot);
    var manifestPath = path.join(itRoot, FROZEN_DEST_ROOT, "frozen_manifest.json");
    if (!fs.existsSync(manifestPath)) {
        console.error("DRIFT-CHECK setup error: no frozen_manifest.json at " + manifestPath +
            " (run tools/sync_frozen.js first)");
        process.exit(2);
    }
    var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    var problems = [];
    var checked = 0;

    (manifest.files || []).forEach(function (rec) {
        var canonAbs = path.join(appRoot, rec.canonical);
        var frozenAbs = path.join(itRoot, rec.frozen);
        var canonHash = null, frozenHash = null;
        if (!fs.existsSync(canonAbs)) { problems.push("MISSING canonical: " + rec.canonical); }
        else canonHash = sha256(fs.readFileSync(canonAbs));
        if (!fs.existsSync(frozenAbs)) { problems.push("MISSING frozen: " + rec.frozen); }
        else frozenHash = sha256(fs.readFileSync(frozenAbs));

        if (canonHash && canonHash !== rec.sha256) {
            problems.push("CANONICAL changed (re-run sync_frozen.js): " + rec.canonical +
                "\n    manifest=" + rec.sha256.slice(0, 16) + " canonical=" + canonHash.slice(0, 16));
        }
        if (frozenHash && frozenHash !== rec.sha256) {
            problems.push("FROZEN hand-edited (restore via sync_frozen.js): " + rec.frozen +
                "\n    manifest=" + rec.sha256.slice(0, 16) + " frozen=" + frozenHash.slice(0, 16));
        }
        if (canonHash && frozenHash && canonHash !== frozenHash) {
            problems.push("CROSS-REPO DRIFT (P0 if sha256_pure/project_meta): " + rec.canonical +
                " != " + rec.frozen);
        }
        checked++;
    });

    // ── Completeness (codex-audit A1): a per-entry hash check cannot see a
    // require-graph member that was never added to ITEMS/manifest, nor a stale
    // orphan frozen file. Guard both — otherwise require-graph drift via
    // ADDITION bypasses this gate entirely (the cross-runtime-drift class G1
    // exists to prevent: e.g. project_meta.js starts require()-ing a new helper
    // that nobody added to ITEMS → IT runtime silently lacks it, gate stays green).
    var manifestFrozen = {};
    var manifestByBase = {};
    (manifest.files || []).forEach(function (rec) {
        manifestFrozen[rec.frozen] = true;
        manifestByBase[path.basename(rec.frozen)] = rec;
    });
    // (a) required-but-not-frozen: every relative require() in a frozen .js must
    //     resolve to a manifest entry.
    (manifest.files || []).forEach(function (rec) {
        if (!/\.js$/.test(rec.frozen)) return;
        var frozenAbs = path.join(itRoot, rec.frozen);
        if (!fs.existsSync(frozenAbs)) return;
        var src = fs.readFileSync(frozenAbs, "utf8");
        var re = /require\(\s*["']\.\/([^"']+?)["']\s*\)/g, m;
        while ((m = re.exec(src))) {
            var dep = m[1].replace(/\.js$/, "") + ".js";
            if (!manifestByBase[dep]) {
                problems.push("REQUIRED-BUT-NOT-FROZEN: " + rec.frozen + " require()s ./" + dep +
                    " — NOT in manifest (add to sync_frozen.js ITEMS; the IT runtime would silently lack it)");
            }
        }
    });
    // (b) orphan frozen files: any file under the frozen root not in the manifest
    //     (a stale generated file left after a rename/removal).
    var ALLOW_NON_MANIFEST = { "frozen_manifest.json": true, "FROZEN_README.md": true };
    (function scan(dir, relPrefix) {
        var entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        entries.forEach(function (ent) {
            var rel = (relPrefix ? relPrefix + "/" : "") + ent.name;
            if (ent.isDirectory()) { scan(path.join(dir, ent.name), rel); return; }
            if (ALLOW_NON_MANIFEST[ent.name]) return;
            var frozenRel = (FROZEN_DEST_ROOT + "/" + rel).replace(/\\/g, "/");
            if (!manifestFrozen[frozenRel]) {
                problems.push("ORPHAN-FROZEN: " + frozenRel + " is under the frozen root but NOT in the manifest (stale generated file? remove it or add to ITEMS)");
            }
        });
    })(path.join(itRoot, FROZEN_DEST_ROOT), "");

    // ── Embedded-schema drift (A3a'): vendor/project_meta_schema.js is a
    //    GENERATED JS wrapper of docs/schemas/project_meta.schema.json (the
    //    webapp runs under file:// and can't fetch the .json). Editing the
    //    canonical .json without re-running gen_schema_js.js leaves the webapp
    //    validating against a STALE schema. Catch it: order-insensitive deep
    //    compare of the embedded object against the canonical (reuse
    //    ProjectMeta._canonicalStringify so key order can't cause a false-fail).
    (function () {
        var canonJsonPath = path.join(appRoot, "docs", "schemas", "project_meta.schema.json");
        var embeddedJsPath = path.join(appRoot, "vendor", "project_meta_schema.js");
        if (!fs.existsSync(canonJsonPath)) { problems.push("MISSING canonical schema json: docs/schemas/project_meta.schema.json"); return; }
        if (!fs.existsSync(embeddedJsPath)) { problems.push("MISSING embedded schema js: vendor/project_meta_schema.js (run gen_schema_js.js)"); return; }
        var canonObj, embObj, PM;
        try { canonObj = JSON.parse(fs.readFileSync(canonJsonPath, "utf8")); }
        catch (e) { problems.push("canonical schema json unparseable: " + e.message); return; }
        try { embObj = require(embeddedJsPath); }
        catch (e) { problems.push("embedded schema js unloadable: " + e.message); return; }
        try { PM = require(path.join(appRoot, "vendor", "project_meta.js")); }
        catch (e) { problems.push("could not load project_meta.js for canonical compare: " + e.message); return; }
        if (PM._canonicalStringify(canonObj) !== PM._canonicalStringify(embObj)) {
            problems.push("EMBEDDED-SCHEMA STALE: vendor/project_meta_schema.js != docs/schemas/project_meta.schema.json" +
                " — run `node tools/gen_schema_js.js` and commit the regenerated wrapper");
        }
        checked++;
    })();

    if (problems.length) {
        console.error("DRIFT-CHECK FAIL (" + problems.length + " issue(s), " + checked + " files checked):");
        problems.forEach(function (p) { console.error("  - " + p); });
        console.error("\nFix: edit canonical in app-folio, run `node tools/sync_frozen.js <appRoot> <itRoot>`, commit both.");
        process.exit(1);
    }
    console.log("DRIFT-CHECK OK: " + checked + " frozen files in sync (canonical == frozen == manifest).");
    console.log("  source_commit=" + manifest.source_commit + " synced_at=" + manifest.synced_at);
}

try { main(); }
catch (e) { console.error("DRIFT-CHECK setup error: " + (e.message || e)); process.exit(2); }
