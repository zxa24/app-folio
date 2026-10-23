// sync_frozen.js — one-way vendoring of the project_meta require-graph
// from app-folio (canonical) into indesign-toolkit (frozen copies).
//
// 8D-ext-A1 G1/G2. app-folio `vendor/` + `docs/schemas/` + `fixtures/` are
// the SINGLE source of truth; the IT copies under
// translation_mvp_uxp/lib/vendor/ are GENERATED artifacts — never edit them
// by hand. Edit canonical, re-run this, commit BOTH repos, and let the
// paired-merge gate run check_schema_drift.js.
//
// Frozen copies are written byte-for-byte from canonical (no in-file header).
// The drift gate compares an EOL-NORMALIZED sha256 (CRLF/LF differences from
// git autocrlf are ignored; any real content change is still caught) — so the
// on-disk copies are byte-identical at sync time and the guard enforces
// EOL-normalized identity thereafter. Provenance + the DO-NOT-EDIT notice live
// in the sidecar frozen_manifest.json + FROZEN_README.md, NOT in the files (an
// in-file header would change the hash and defeat the guard).
//
// Usage:
//   node tools/sync_frozen.js [appRoot] [itRoot]
//   - appRoot defaults to the repo containing this script (../ from tools/)
//   - itRoot  defaults to env IT_REPO, else a sibling guess
//     (../indesign-toolkit-meta then ../indesign-toolkit)
//
// Exit 0 on success; non-zero on any read/write/missing-root failure.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var cp = require("child_process");

// ── Frozen manifest: canonical (app-folio-relative) -> frozen (IT-relative).
// kind:"file" copies one file; kind:"glob-json" copies every *.json in srcDir.
// Dedicated namespace subdir — keeps the project_meta frozen set separate from
// IT's own pre-existing vendored libs (babel/react/fflate) that share lib/vendor/,
// so the drift gate's orphan check can own this whole subtree unambiguously.
var FROZEN_DEST_ROOT = "translation_mvp_uxp/lib/vendor/project_meta";
var ITEMS = [
    // runtime require-graph (UXP requires these at runtime)
    { kind: "file", src: "vendor/project_meta.js",                dst: FROZEN_DEST_ROOT + "/project_meta.js" },
    { kind: "file", src: "vendor/sha256_pure.js",                 dst: FROZEN_DEST_ROOT + "/sha256_pure.js" },
    { kind: "file", src: "vendor/bcp47_validate.js",              dst: FROZEN_DEST_ROOT + "/bcp47_validate.js" },
    { kind: "file", src: "vendor/json_schema_minimal.js",         dst: FROZEN_DEST_ROOT + "/json_schema_minimal.js" },
    { kind: "file", src: "vendor/path_resolver.js",               dst: FROZEN_DEST_ROOT + "/path_resolver.js" },
    // shared adapter conformance suite (storage_uxp must pass the same battery as storage_node)
    { kind: "file", src: "vendor/adapter_conformance.js",         dst: FROZEN_DEST_ROOT + "/adapter_conformance.js" },
    { kind: "file", src: "docs/schemas/project_meta.schema.json", dst: FROZEN_DEST_ROOT + "/project_meta.schema.json" },
    // frozen test assets (cross-repo fixture parity — spec §6.3)
    { kind: "glob-json", src: "fixtures/project_meta", dst: FROZEN_DEST_ROOT + "/fixtures/project_meta" },
    { kind: "glob-json", src: "fixtures/bcp47",        dst: FROZEN_DEST_ROOT + "/fixtures/bcp47" }
];

// EOL-agnostic hash — MUST match check_schema_drift.js's normalizeEol so the
// manifest hashes survive git autocrlf / cross-platform checkouts. EOL never
// affects the require-graph's runtime behavior; normalizing avoids a false
// drift BLOCK at the paired-merge gate on a fresh checkout / A3 Linux CI.
function normalizeEol(buf) {
    return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "latin1");
}
function sha256Norm(buf) {
    return crypto.createHash("sha256").update(normalizeEol(buf)).digest("hex");
}
function ensureDir(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function gitCommit(root) {
    try {
        return cp.execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
            .toString().trim();
    } catch (e) { return "unknown"; }
}
function isoNow() { return new Date().toISOString(); }

function resolveAppRoot(arg) {
    var root = arg || path.resolve(__dirname, "..");
    if (!fs.existsSync(path.join(root, "vendor", "project_meta.js"))) {
        throw new Error("appRoot does not look like app-folio (no vendor/project_meta.js): " + root);
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
        if (candidates[i] && fs.existsSync(path.join(candidates[i], "translation_mvp_uxp"))) {
            return candidates[i];
        }
    }
    throw new Error("could not resolve IT repo root (pass as arg2 or set IT_REPO). Tried: " + candidates.join(", "));
}

function copyOne(appRoot, itRoot, srcRel, dstRel, records) {
    var srcAbs = path.join(appRoot, srcRel);
    var dstAbs = path.join(itRoot, dstRel);
    if (!fs.existsSync(srcAbs)) throw new Error("missing canonical source: " + srcRel);
    ensureDir(path.dirname(dstAbs));
    var buf = fs.readFileSync(srcAbs);
    fs.writeFileSync(dstAbs, buf);
    records.push({
        canonical: srcRel.replace(/\\/g, "/"),
        frozen: dstRel.replace(/\\/g, "/"),
        sha256: sha256Norm(buf), // EOL-normalized (see normalizeEol)
        bytes: buf.length
    });
}

function main() {
    var appRoot = resolveAppRoot(process.argv[2]);
    var itRoot = resolveItRoot(process.argv[3], appRoot);
    console.log("appRoot: " + appRoot);
    console.log("itRoot : " + itRoot);

    var records = [];
    ITEMS.forEach(function (item) {
        if (item.kind === "file") {
            copyOne(appRoot, itRoot, item.src, item.dst, records);
        } else if (item.kind === "glob-json") {
            var srcDir = path.join(appRoot, item.src);
            var files = fs.readdirSync(srcDir).filter(function (f) { return /\.json$/.test(f); }).sort();
            files.forEach(function (f) {
                copyOne(appRoot, itRoot, item.src + "/" + f, item.dst + "/" + f, records);
            });
        }
    });

    var manifest = {
        _comment: "GENERATED by tools/sync_frozen.js — frozen copies of app-folio canonical files for the InDesign (UXP) runtime. DO NOT EDIT the frozen files or this manifest by hand. Edit canonical in app-folio, re-run sync_frozen.js, commit both repos. check_schema_drift.js verifies sha256 equality at the paired-merge gate.",
        source_repo: "app-folio",
        source_commit: gitCommit(appRoot),
        synced_at: isoNow(),
        frozen_dest_root: FROZEN_DEST_ROOT,
        files: records
    };
    var manifestAbs = path.join(itRoot, FROZEN_DEST_ROOT, "frozen_manifest.json");
    ensureDir(path.dirname(manifestAbs));
    fs.writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2) + "\n");

    var readmeAbs = path.join(itRoot, FROZEN_DEST_ROOT, "FROZEN_README.md");
    fs.writeFileSync(readmeAbs,
        "# FROZEN copies — DO NOT EDIT\n\n" +
        "These files are copies of app-folio canonical sources " +
        "(`vendor/` + `docs/schemas/` + `fixtures/`), written byte-for-byte at sync time " +
        "and guarded by an EOL-normalized sha256 (CRLF/LF ignored, real drift caught), " +
        "vendored here so the InDesign " +
        "UXP runtime can `require` the project_meta core lib + validators.\n\n" +
        "- **Single source of truth:** app-folio. Edit there, then run " +
        "`node tools/sync_frozen.js <appRoot> <itRoot>` and commit BOTH repos.\n" +
        "- **Provenance + hashes:** `frozen_manifest.json` (this dir).\n" +
        "- **Drift guard:** `tools/check_schema_drift.js` (app-folio) re-hashes " +
        "canonical vs these copies; run at the paired-merge gate (.scratch/merge-gate.sh). " +
        "A mismatch means canonical changed without re-sync, or a frozen file was hand-edited.\n");

    console.log("\nfroze " + records.length + " files -> " + path.join(itRoot, FROZEN_DEST_ROOT));
    console.log("manifest: " + manifestAbs);
    records.forEach(function (r) { console.log("  " + r.sha256.slice(0, 12) + "  " + r.frozen); });
}

try { main(); }
catch (e) { console.error("sync_frozen FAILED: " + (e.message || e)); process.exit(1); }
