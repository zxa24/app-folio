// working_state_store.js — IndexedDB CAS store for webapp WORKING STATE.
//
// Purpose-built sibling to vendor/storage_browser.js. Persists the
// translator's in-progress edits (translationsByTid + manualHotspots +
// cardOptions, wrapped in the §3 payload) so they survive a browser
// refresh. Keyed by content-hash(segments.json) (package identity).
//
// ── Why a SEPARATE store (spec r2 §2, gate V1-2/V1-3) ─────────────────
// storage_browser.js is FROZEN (A1 conformance 17/17) and schema-coupled
// to ProjectMeta: it enforces a 64 KiB cap (the _meta.json contract, NOT a
// CAS requirement), created_at/project_id immutability, and schema-version
// downgrade refusal — all WRONG for working state (which routinely exceeds
// 64 KiB: ~650 B/segment → >100 segments overflows). Adding a store to its
// DB would need a DB_VERSION bump → VersionError vs the frozen v1. So this
// is its OWN DB (`webapp_working_state`), own DB_VERSION 1, own store, ZERO
// contact with project_meta_store. We REUSE storage_browser's pattern
// INSIGHT (one readwrite tx = ACID get→compare→put = race-tight CAS, no
// lockfile) but NOT its code — no fork of the frozen lib to drift.
//
// ── Canonical hashing (spec r3 改动1) ────────────────────────────────
// The CAS hash is over the KEY-SORTED canonical serialization, NOT raw
// JSON.stringify (insertion-order → equal data hashes differently → false
// casError). We REUSE ProjectMeta._canonicalStringify + SHA256Pure rather
// than reimplement a (possibly non-canonical) serializer. The stored value
// IS that canonical string, so read-side hash = hex(storedText) directly.
//
// ── No 64 KiB cap, no schema coupling ────────────────────────────────
// Working state has no size contract and is payload-agnostic here: the
// store never inspects the snapshot's internal shape (that's the caller's
// §3 payload concern). It only canonical-serializes, hashes, and persists.
//
// API:
//   read(key)                       → Promise<{ ok, exists, snapshot?, hash?, errors? }>
//   write(key, snapshot, expected)  → Promise<{ ok, written?, casError?, newHash?, errors? }>
//       expected: null/undefined/"absent" (create-only) | <64-hex> (CAS)
//   remove(key)                     → Promise<{ ok, errors? }>
//
// UMD: window.WorkingStateStore | module.exports.

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.WorkingStateStore = factory(root);
    }
}(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function (root) {
    "use strict";

    var DB_NAME = "webapp_working_state";   // OWN db — never project_meta_store
    var STORE = "working_state";
    var DB_VERSION = 1;

    // ── Injected deps (resolved lazily from globals; load-order forgiving) ──
    // index.html loads sha256_pure.js + project_meta.js BEFORE this file, but
    // we resolve at call-time so a reorder can't silently break hashing.
    function getSha() {
        var S = (root && root.SHA256Pure) ||
            (typeof SHA256Pure !== "undefined" ? SHA256Pure : null) ||
            (typeof require === "function" ? safeRequire("./sha256_pure.js") : null);
        if (!S || typeof S.hex !== "function") {
            throw new Error("WorkingStateStore: SHA256Pure not available");
        }
        return S;
    }
    function getCanon() {
        var PM = (root && root.ProjectMeta) ||
            (typeof ProjectMeta !== "undefined" ? ProjectMeta : null) ||
            (typeof require === "function" ? safeRequire("./project_meta.js") : null);
        if (!PM || typeof PM._canonicalStringify !== "function") {
            throw new Error("WorkingStateStore: ProjectMeta._canonicalStringify not available");
        }
        return PM._canonicalStringify;
    }
    function safeRequire(p) { try { return require(p); } catch (e) { return null; } }

    // Canonical text of a snapshot. JSON round-trip first to drop in-memory
    // cruft (undefined fields / functions) that canonicalStringify would
    // throw on — the snapshot is app-state (NOT a JSON.parse result), so it
    // CAN carry undefined. JSON.parse(JSON.stringify(x)) yields a pure-JSON
    // structure that canonicalStringify key-sorts deterministically.
    function canonicalText(snapshot) {
        var pure = JSON.parse(JSON.stringify(snapshot));
        return getCanon()(pure);   // key-sorted, recursive
    }
    function hashText(text) { return getSha().hex(text); }

    // ── IndexedDB plumbing (own DB; mirrors storage_browser's tx shape) ──
    function getIDB() {
        if (typeof indexedDB !== "undefined" && indexedDB) return indexedDB;
        if (typeof global !== "undefined" && global.indexedDB) return global.indexedDB;
        if (typeof self !== "undefined" && self.indexedDB) return self.indexedDB;
        throw new Error("indexedDB not available in this runtime");
    }
    function openDB() {
        return new Promise(function (resolve, reject) {
            var idb = getIDB();
            var req = idb.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (ev) {
                var db = ev.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE); // out-of-line keys (key passed explicitly)
                }
            };
            req.onsuccess = function (ev) { resolve(ev.target.result); };
            req.onerror = function (ev) { reject(ev.target.error || new Error("IDB open failed")); };
            req.onblocked = function () { reject(new Error("IDB open blocked")); };
        });
    }
    // Run work(store, done, fail) inside ONE tx; resolve on tx.oncomplete so
    // the write is durably committed before the caller proceeds (ACID commit
    // boundary). All of get+compare+put for one write() run in one readwrite
    // tx → race-tight CAS by construction (no lockfile, no torn window).
    function withTx(db, mode, work) {
        return new Promise(function (resolve, reject) {
            var tx;
            try { tx = db.transaction(STORE, mode); }
            catch (e) { reject(e); return; }
            var store = tx.objectStore(STORE);
            var captured, sawError = null;
            tx.oncomplete = function () { resolve(captured); };
            tx.onerror = function (ev) { reject(sawError || (ev && ev.target && ev.target.error) || tx.error || new Error("IDB tx error")); };
            tx.onabort = function (ev) { reject(sawError || (ev && ev.target && ev.target.error) || tx.error || new Error("IDB tx abort")); };
            try {
                work(store, function (v) { captured = v; }, function (err) { sawError = err; });
            } catch (e) {
                sawError = e;
                try { tx.abort(); } catch (e2) {}
                reject(e);
            }
        });
    }

    function invalidKey(key) { return key === undefined || key === null || key === ""; }

    // ── read ─────────────────────────────────────────────────────────
    function read(key) {
        if (invalidKey(key)) {
            return Promise.resolve({ ok: false, exists: false, errors: ["invalid key (undefined/null/empty)"] });
        }
        return openDB().then(function (db) {
            return withTx(db, "readonly", function (store, done, fail) {
                var req = store.get(key);
                req.onsuccess = function () {
                    var stored = req.result;
                    if (stored === undefined || stored === null) {
                        done({ ok: true, exists: false });
                        return;
                    }
                    if (typeof stored !== "string") {
                        done({ ok: false, exists: true, errors: ["stored value is not a string"] });
                        return;
                    }
                    var snap;
                    try { snap = JSON.parse(stored); }
                    catch (e) { done({ ok: false, exists: true, errors: ["stored value unparseable: " + e.message] }); return; }
                    done({ ok: true, exists: true, snapshot: snap, hash: hashText(stored) });
                };
                req.onerror = function () { fail(req.error || new Error("IDB get failed")); };
            });
        }).catch(function (e) {
            return { ok: false, exists: false, errors: ["IndexedDB error: " + (e && e.message ? e.message : String(e))] };
        });
    }

    // ── write (CAS) ──────────────────────────────────────────────────
    // expected == null/undefined/"absent" → create-only (casError if key exists).
    // expected == <hash> → compare stored hash; casError on mismatch/missing.
    function write(key, snapshot, expected) {
        if (invalidKey(key)) {
            return Promise.resolve({ ok: false, errors: ["invalid key (undefined/null/empty)"] });
        }
        var text, newHash;
        try {
            text = canonicalText(snapshot);
            newHash = hashText(text);
        } catch (e) {
            return Promise.resolve({ ok: false, errors: ["serialize/hash failed: " + (e && e.message ? e.message : String(e))] });
        }
        var createOnly = (expected === null || expected === undefined || expected === "absent");
        return openDB().then(function (db) {
            return withTx(db, "readwrite", function (store, done, fail) {
                var gReq = store.get(key);
                gReq.onsuccess = function () {
                    var stored = gReq.result;
                    var exists = (stored !== undefined && stored !== null);

                    if (createOnly) {
                        if (exists) {
                            done({ ok: false, casError: true, errors: ["key already exists (expected absent)"] });
                            return;
                        }
                    } else {
                        // CAS against a prior hash.
                        if (!exists) {
                            done({ ok: false, casError: true, errors: ["expected hash but key is missing"] });
                            return;
                        }
                        if (typeof stored !== "string") {
                            done({ ok: false, casError: true, errors: ["stored value is not a string"] });
                            return;
                        }
                        var curHash = hashText(stored);
                        if (curHash !== expected) {
                            done({ ok: false, casError: true, errors: ["CAS hash mismatch (another tab/window wrote since read)"] });
                            return;
                        }
                        // Semantic no-op: identical canonical content → skip the put.
                        if (curHash === newHash) {
                            done({ ok: true, written: false, newHash: newHash });
                            return;
                        }
                    }
                    var pReq = store.put(text, key);
                    pReq.onsuccess = function () { done({ ok: true, written: true, newHash: newHash }); };
                    pReq.onerror = function () { fail(pReq.error || new Error("IDB put failed")); };
                };
                gReq.onerror = function () { fail(gReq.error || new Error("IDB get failed")); };
            });
        }).catch(function (e) {
            return { ok: false, errors: ["IndexedDB error: " + (e && e.message ? e.message : String(e))] };
        });
    }

    // ── remove ───────────────────────────────────────────────────────
    function remove(key) {
        if (invalidKey(key)) {
            return Promise.resolve({ ok: false, errors: ["invalid key (undefined/null/empty)"] });
        }
        return openDB().then(function (db) {
            return withTx(db, "readwrite", function (store, done, fail) {
                var dReq = store.delete(key);
                dReq.onsuccess = function () { done({ ok: true }); };
                dReq.onerror = function () { fail(dReq.error || new Error("IDB delete failed")); };
            });
        }).catch(function (e) {
            return { ok: false, errors: ["IndexedDB error: " + (e && e.message ? e.message : String(e))] };
        });
    }

    // Public hash of any JSON-able value via the SAME canonical+sha the CAS
    // uses — callers hash segments.json (the key) and translations.json (the
    // reconcile base) with this so they're byte-comparable to stored hashes.
    function hashValue(obj) { return hashText(canonicalText(obj)); }

    return {
        read: read,
        write: write,
        remove: remove,
        hashValue: hashValue,
        _internal: { DB_NAME: DB_NAME, STORE: STORE, DB_VERSION: DB_VERSION,
            canonicalText: canonicalText, hashText: hashText }
    };
}));
