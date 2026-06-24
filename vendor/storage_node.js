// storage_node.js — Node fs storage adapter (test harness).
//
// All CAS / immutable / no-op detection happens UNDER LOCK inside this
// module so the project_meta core can stay storage-agnostic and the
// invariants are race-tight (codex r3 P1 b/c/d/e).
//
// readText(path) → Promise<{ ok, exists, text?, kind, errors? }>
//   kind: "file" | "missing" | "directory" | "permission" | "io-error"
//
// writeAtomic(path, plannedData, expected, helpers) → Promise<{
//   ok, written?, noop?, casError?, errors?
// }>
//   expected:
//     "absent"        — link-based atomic publication; fail if target exists
//     <64-char hex>   — under lock, re-read + helpers.contentHash(disk)
//                       must equal this; else casError
//     "reset"         — admin recovery from corrupt file: backup
//                       whatever's there + write fresh (bypass CAS /
//                       immutable / no-op checks); only invoked via
//                       Meta.reset() (codex r6 P2: token undocumented)
//   helpers: { now, contentHash, stripVolatile, parse, serialize,
//              currentSchemaVersion }
//
// Atomic publication for absent:
//   1. Write canonical JSON to <file>.tmp.<rand> via O_EXCL (the tmp
//      cannot be aliased; its name is unguessable)
//   2. fs.linkSync(tmp, target) — POSIX/Windows-NTFS atomic create-only;
//      fails with EEXIST if target appears between our lock check and
//      the link call
//   3. Unlink the tmp (the file content is still reachable via the
//      target hard link)
//   This eliminates the 0-byte visibility codex r3 P1 b reproduced.

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        var fs = require("fs");
        var path = require("path");
        var crypto = require("crypto");
        module.exports = factory(fs, path, crypto);
    }
}(this, function (fs, path, crypto) {
    "use strict";

    var STALE_LOCK_MS = 30000;
    var LOCK_RETRY_MAX = 50;
    var LOCK_RETRY_DELAY_MS = 50;
    var BACKUP_KEEP = 3;
    // Bounded input (codex r5 P1). Realistic _meta.json is < 1 KB; 64 KB is
    // generous. Adapter enforces before parse to bound SHA / JSON work.
    var MAX_BYTE_SIZE = 64 * 1024;

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function lockPath(p) { return p + ".lock"; }
    function tmpPath(p) { return p + ".tmp." + crypto.randomBytes(8).toString("hex"); }
    function newToken() { return crypto.randomBytes(16).toString("hex"); }

    function pidAlive(pid) {
        if (!pid || typeof pid !== "number") return false;
        try { process.kill(pid, 0); return true; }
        catch (e) {
            if (e.code === "ESRCH") return false;
            if (e.code === "EPERM") return true;
            return false;
        }
    }

    // Robust short-write loop. Codex r3 P2: prior code looped forever on
    // writeSync returning 0; now we treat that as fatal. fsync errors are
    // surfaced (not swallowed).
    function writeFullyAndClose(fd, text) {
        var buf = Buffer.from(text, "utf8");
        var off = 0;
        var stallGuard = 0;
        try {
            while (off < buf.length) {
                var n = fs.writeSync(fd, buf, off, buf.length - off);
                if (n <= 0) {
                    stallGuard++;
                    if (stallGuard > 3) {
                        throw new Error("writeSync returned 0 repeatedly (storage stuck)");
                    }
                    continue;
                }
                stallGuard = 0;
                off += n;
            }
            fs.fsyncSync(fd); // surface fsync errors
        } finally {
            try { fs.closeSync(fd); } catch (e) {}
        }
    }

    // Acquire returns { token, inode }. Inode is captured at acquire time
    // via fstat(open-fd); we then close the fd (Windows-friendly: holding
    // the fd open blocks unlink). At release time, stat the path; if its
    // inode === handle.inode, it's still the same file we created, so
    // unlink is safe. Otherwise another acquirer replaced the lock — we
    // do not unlink theirs (codex r4 P1 c).
    // Acquire returns:
    //   handle object on success
    //   null on EEXIST (lock held by another)
    //   { __lockError: <Error> } on non-EEXIST open failure (EACCES,
    //     ENOENT parent dir, etc.) — withLock unwraps to a result-object
    //     in writeAtomic (codex r6 P2: don't throw from public API path)
    function tryAcquireLock(p) {
        var token = newToken();
        var fd;
        try { fd = fs.openSync(lockPath(p), "wx"); }
        catch (e) {
            if (e.code === "EEXIST") return null;
            return { __lockError: e };
        }
        var inode;
        try {
            var buf = Buffer.from(JSON.stringify({ pid: process.pid, acquired_at: Date.now(), token: token }), "utf8");
            var off = 0;
            var stallGuard = 0;
            while (off < buf.length) {
                var n = fs.writeSync(fd, buf, off, buf.length - off);
                if (n <= 0) {
                    if (++stallGuard > 3) throw new Error("writeSync stalled");
                    continue;
                }
                off += n;
            }
            try { fs.fsyncSync(fd); } catch (eF) {}
            inode = fs.fstatSync(fd).ino;
        } catch (eW) {
            try { fs.closeSync(fd); } catch (e1) {}
            try { fs.unlinkSync(lockPath(p)); } catch (eU) {}
            return null;
        }
        // Close fd immediately so it's safe to unlink on Windows.
        try { fs.closeSync(fd); } catch (e1) {}
        return { token: token, inode: inode };
    }

    function readLockInfo(p) {
        var lp = lockPath(p);
        var st;
        try { st = fs.statSync(lp); } catch (e) { return null; }
        var contents = "";
        try { contents = fs.readFileSync(lp, "utf8"); } catch (e) {}
        var info = null;
        try { info = JSON.parse(contents); } catch (e) {}
        return { mtimeMs: st.mtimeMs, contents: contents, info: info };
    }

    // Stale reclaim: also inode-bound. Open the stale lock to capture an
    // fd + inode; verify content still matches snapshot1; verify path
    // still points to same inode; only then unlink. If anyone replaces
    // the lock during our wait, inode comparison aborts the reclaim
    // (codex r4 P1 c TOCTOU).
    async function reclaimIfStale(p) {
        var snap1 = readLockInfo(p);
        if (!snap1) return false;
        var ageMtime = Date.now() - snap1.mtimeMs;
        var ageContent = snap1.info && snap1.info.acquired_at ? Date.now() - snap1.info.acquired_at : ageMtime;
        if (Math.max(ageMtime, ageContent) <= STALE_LOCK_MS) return false;
        if (snap1.info && snap1.info.pid && pidAlive(snap1.info.pid)) return false;
        var lp = lockPath(p);
        var fd;
        try { fd = fs.openSync(lp, "r"); }
        catch (e) { return false; }
        var fdInode;
        try { fdInode = fs.fstatSync(fd).ino; }
        catch (e) { try { fs.closeSync(fd); } catch (e2) {} return false; }
        await sleep(20);
        var snap2 = readLockInfo(p);
        if (!snap2 || snap2.contents !== snap1.contents) {
            try { fs.closeSync(fd); } catch (e2) {}
            return false;
        }
        var curPathInode;
        try { curPathInode = fs.statSync(lp).ino; }
        catch (e) { try { fs.closeSync(fd); } catch (e2) {} return false; }
        if (curPathInode !== fdInode) {
            // Lock was replaced — leave the new owner alone
            try { fs.closeSync(fd); } catch (e2) {}
            return false;
        }
        try { fs.closeSync(fd); } catch (e2) {}
        try { fs.unlinkSync(lp); return true; }
        catch (e) { return false; }
    }

    // releaseLock: stat the path; if inode === handle.inode, the file at
    // the path is still the one we created at acquire. Then verify token
    // content matches (defense in depth) and unlink. If inode differs,
    // someone replaced the lock — do NOT unlink (would steal theirs).
    function releaseLock(p, lockHandle) {
        if (!lockHandle) return;
        var lp = lockPath(p);
        var pathStat;
        try { pathStat = fs.statSync(lp); }
        catch (e) { return; }
        if (pathStat.ino !== lockHandle.inode) return;
        // Verify token content too (defense in depth against rare cases
        // where inode is recycled within the same lockfile path during
        // a tight race)
        try {
            var contents = fs.readFileSync(lp, "utf8");
            var info = JSON.parse(contents);
            if (info.token !== lockHandle.token) return;
        } catch (eR) { /* corrupt but inode matched → still ours */ }
        try { fs.unlinkSync(lp); } catch (e) {}
    }

    // Symbolic sentinel returned by withLock when timeout. Caller (writeAtomic)
    // converts to { ok:false, errors:['lock timeout'] } so Meta.write() respects
    // the documented "always return result object, never reject" contract
    // (codex r5 P2).
    var LOCK_TIMEOUT_SENTINEL = { __lockTimeout: true };

    async function withLock(p, fn) {
        var handle = null;
        var lastErr = null;
        for (var i = 0; i < LOCK_RETRY_MAX; i++) {
            handle = tryAcquireLock(p);
            if (handle && !handle.__lockError) break;
            if (handle && handle.__lockError) {
                // Non-EEXIST error — surface immediately, no retry
                return { __lockError: handle.__lockError };
            }
            if (i === 3 || i === 10 || i === 25) await reclaimIfStale(p);
            await sleep(LOCK_RETRY_DELAY_MS);
        }
        if (!handle) return LOCK_TIMEOUT_SENTINEL;
        try { return await fn(); }
        finally { releaseLock(p, handle); }
    }

    // readText — codex r3 P2 lstatSync precedence: do lstat FIRST so
    // directory symlinks don't slip through; symlink is rejected before
    // any other classification.
    function readText(p) {
        return new Promise(function (resolve) {
            var lst;
            try { lst = fs.lstatSync(p); }
            catch (e) {
                if (e.code === "ENOENT") {
                    resolve({ ok: false, exists: false, kind: "missing", errors: [e.message] });
                    return;
                }
                if (e.code === "EACCES" || e.code === "EPERM") {
                    resolve({ ok: false, exists: true, kind: "permission", errors: [e.message] });
                    return;
                }
                resolve({ ok: false, exists: false, kind: "io-error", errors: [e.message] });
                return;
            }
            if (lst.isSymbolicLink()) {
                resolve({ ok: false, exists: true, kind: "io-error", errors: ["symlink rejected"] });
                return;
            }
            if (lst.isDirectory()) {
                resolve({ ok: false, exists: true, kind: "directory", errors: ["path is a directory"] });
                return;
            }
            if (!lst.isFile()) {
                resolve({ ok: false, exists: true, kind: "io-error", errors: ["not a regular file"] });
                return;
            }
            // Bounded input size (codex r5 P1: prevent OOM / pure-SHA blowup)
            if (lst.size > MAX_BYTE_SIZE) {
                resolve({ ok: false, exists: true, kind: "io-error",
                    errors: ["file exceeds " + MAX_BYTE_SIZE + " byte limit (" + lst.size + ")"] });
                return;
            }
            var openFd = null;
            try {
                openFd = fs.openSync(p, "r");
                var openIno;
                try { openIno = fs.fstatSync(openFd).ino; }
                catch (eF) { throw eF; }
                if (openIno !== lst.ino) {
                    resolve({ ok: false, exists: true, kind: "io-error",
                        errors: ["path swap detected between lstat and open"] });
                    return;
                }
                // Read all bytes into one buffer THEN decode (codex r5 P2:
                // per-chunk decode corrupts multi-byte UTF-8 at boundaries).
                var allBuf = Buffer.allocUnsafe(lst.size);
                var totalOff = 0;
                while (totalOff < lst.size) {
                    var nread = fs.readSync(openFd, allBuf, totalOff, lst.size - totalOff, totalOff);
                    if (nread <= 0) break;
                    totalOff += nread;
                }
                // Strict UTF-8 decode: TextDecoder { fatal: true } throws on
                // malformed sequences instead of silently substituting U+FFFD.
                // Codex r7 P2: silent substitution let corrupt files validate
                // as "normal" + persist the U+FFFD on next write.
                var text;
                try {
                    var td = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
                    text = td.decode(allBuf.slice(0, totalOff));
                } catch (eDec) {
                    resolve({ ok: false, exists: true, kind: "io-error",
                        errors: ["malformed UTF-8: " + eDec.message] });
                    return;
                }
                resolve({ ok: true, exists: true, kind: "file", text: text });
            } catch (e) {
                // Close fd on error path (codex r5 P2: prior code leaked fd)
                if (openFd !== null) {
                    try { fs.closeSync(openFd); } catch (e9) {}
                    openFd = null;
                }
                if (e.code === "EACCES" || e.code === "EPERM") {
                    resolve({ ok: false, exists: true, kind: "permission", errors: [e.message] });
                    return;
                }
                resolve({ ok: false, exists: true, kind: "io-error", errors: [e.message] });
                return;
            } finally {
                if (openFd !== null) {
                    try { fs.closeSync(openFd); } catch (e9) {}
                }
            }
        });
    }

    function rotateBackup(p, protectPath) {
        // Codex r6 P1 #2 + r7 P1: sort by mtime descending; ALWAYS protect
        // the just-created backup (protectPath). Codex r8 P1: compare via
        // path.resolve so non-normalized paths (sub\..\foo == foo) match.
        var dir = path.dirname(p);
        var base = path.basename(p);
        var entries;
        try { entries = fs.readdirSync(dir); } catch (e) { return; }
        var bakRe = new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            + "\\.bak\\.[0-9TZ\\-]+-[0-9a-f]{8}$");
        var protectResolved = null;
        if (protectPath) {
            try { protectResolved = path.resolve(protectPath); } catch (eR) { protectResolved = protectPath; }
        }
        var ours = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!bakRe.test(e)) continue;
            var fp = path.join(dir, e);
            var fpResolved;
            try { fpResolved = path.resolve(fp); } catch (eR) { fpResolved = fp; }
            if (protectResolved && fpResolved === protectResolved) continue;
            try {
                var st = fs.statSync(fp);
                ours.push({ path: fp, mtimeMs: st.mtimeMs });
            } catch (eS) {}
        }
        ours.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
        var keepOlder = Math.max(0, BACKUP_KEEP - 1);
        for (var j = keepOlder; j < ours.length; j++) {
            try { fs.unlinkSync(ours[j].path); } catch (eU) {}
        }
    }

    // writeAtomic: now does ALL invariant checks under lock so race
    // windows are closed (codex r3 P1 d/e). plannedData is the canonical
    // object WITHOUT updated_at (caller hasn't bumped yet); we read disk,
    // apply invariant checks, then decide no-op vs write under lock.
    async function writeAtomic(p, plannedData, expected, helpers) {
        if (!expected) {
            return { ok: false, errors: ["expected required"] };
        }
        if (!helpers || typeof helpers.now !== "function") {
            return { ok: false, errors: ["adapter helpers missing"] };
        }
        var result = await withLock(p, async function () {
            // Cheap pre-check: existence + non-regular reject + size cap.
            // Strict UTF-8 decode deferred to CAS branch only — reset()
            // explicitly recovers corrupt bytes (codex r14 P2: r14 decoded
            // upfront, blocking reset from doing its job).
            var diskExistsAtFirstCheck;
            try {
                var st = fs.lstatSync(p);
                if (st.isSymbolicLink()) {
                    return { ok: false, errors: ["target is a symlink"] };
                }
                if (st.isDirectory()) {
                    return { ok: false, errors: ["target is a directory"] };
                }
                if (!st.isFile()) {
                    return { ok: false, errors: ["target is not a regular file"] };
                }
                if (st.size > MAX_BYTE_SIZE) {
                    return { ok: false, errors: ["existing file exceeds " + MAX_BYTE_SIZE + " byte limit (" + st.size + ")"] };
                }
                diskExistsAtFirstCheck = true;
            } catch (eL) {
                if (eL.code === "ENOENT") {
                    diskExistsAtFirstCheck = false;
                } else {
                    return { ok: false, errors: [eL.message] };
                }
            }

            // ── expected:absent branch (atomic publication via link) ──
            if (expected === "absent") {
                if (diskExistsAtFirstCheck) {
                    return { ok: false, casError: true, errors: ["file already exists"] };
                }
                var nowStr = helpers.now();
                var text = helpers.serialize(_withUpdatedAt(plannedData, nowStr));
                var tmp = tmpPath(p);
                var fd;
                try { fd = fs.openSync(tmp, "wx"); }
                catch (e) { return { ok: false, errors: [e.message] }; }
                try { writeFullyAndClose(fd, text); }
                catch (eW) {
                    try { fs.unlinkSync(tmp); } catch (e2) {}
                    return { ok: false, errors: [eW.message] };
                }
                try {
                    fs.linkSync(tmp, p);
                } catch (eL) {
                    try { fs.unlinkSync(tmp); } catch (e2) {}
                    if (eL.code === "EEXIST") {
                        return { ok: false, casError: true, errors: ["file appeared during init"] };
                    }
                    return { ok: false, errors: [eL.message] };
                }
                try { fs.unlinkSync(tmp); } catch (e2) {}
                // Codex r4 P2: return updated_at on absent path too.
                return { ok: true, written: true, updated_at: nowStr };
            }

            // ── expected:reset branch (admin recovery for corrupt files) ──
            if (expected === "reset") {
                // Backup current content if any (parseable or not).
                // Codex r5 P1: must NOT swallow — silent backup failure
                // = data loss. Codex r7 P1: stamp backup mtime to now
                // (Windows copyFileSync preserves source mtime).
                if (diskExistsAtFirstCheck) {
                    var rts = new Date().toISOString().replace(/[:.]/g, "-");
                    var rsfx = crypto.randomBytes(4).toString("hex");
                    var rBakPath = p + ".bak." + rts + "-" + rsfx;
                    try { fs.copyFileSync(p, rBakPath); }
                    catch (e) { return { ok: false, errors: ["backup failed: " + e.message + " (refusing to overwrite without backup)"] }; }
                    try { var rNowD = new Date(); fs.utimesSync(rBakPath, rNowD, rNowD); } catch (eU) {}
                }
                var nowR = helpers.now();
                var textR = helpers.serialize(_withUpdatedAt(plannedData, nowR));
                var tmpR = tmpPath(p);
                var fdR;
                try { fdR = fs.openSync(tmpR, "wx"); }
                catch (e) { return { ok: false, errors: [e.message] }; }
                try { writeFullyAndClose(fdR, textR); fs.renameSync(tmpR, p); }
                catch (e) {
                    try { fs.unlinkSync(tmpR); } catch (e2) {}
                    return { ok: false, errors: [e.message] };
                }
                rotateBackup(p, diskExistsAtFirstCheck ? rBakPath : null);
                return { ok: true, written: true, updated_at: nowR, reset: true };
            }

            // ── expected:hash branch ──
            if (!diskExistsAtFirstCheck) {
                return { ok: false, casError: true, errors: ["expected hash but file is missing"] };
            }
            // Codex r14 P2: strict UTF-8 decode IN THE CAS BRANCH ONLY.
            // reset() bypasses this since corrupt files are exactly what
            // reset is for. absent doesn't read content. CAS needs to
            // decode → parse → hash; malformed UTF-8 here is treated as
            // unparseable disk content (caller can use reset to recover).
            var diskText;
            try {
                var rawBuf = fs.readFileSync(p);
                var dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
                diskText = dec.decode(rawBuf);
            } catch (eDec) {
                return { ok: false, casError: true, errors: ["malformed UTF-8 in existing target (use Meta.reset() to recover): " + eDec.message] };
            }
            var pp = helpers.parse(diskText);
            if (!pp.ok) {
                return { ok: false, casError: true, errors: ["disk content unparseable: " + pp.errors.join("; ")] };
            }
            var diskData = pp.data;
            var diskHash = helpers.contentHash(diskData);
            if (expected !== diskHash) {
                return { ok: false, casError: true, errors: ["CAS hash mismatch (disk changed since read)"] };
            }
            // Immutable invariants: created_at + project_id
            if (typeof diskData.created_at === "string"
                && typeof plannedData.created_at === "string"
                && diskData.created_at !== plannedData.created_at) {
                return { ok: false,
                    errors: [{ path: "/created_at", keyword: "immutable",
                        message: "created_at must not change" }] };
            }
            if (typeof diskData.project_id === "string"
                && typeof plannedData.project_id === "string"
                && diskData.project_id !== plannedData.project_id) {
                return { ok: false,
                    errors: [{ path: "/project_id", keyword: "immutable",
                        message: "project_id must not change" }] };
            }
            // Disk newer schema → refuse to downgrade
            if (typeof diskData.schema_version === "number"
                && typeof plannedData.schema_version === "number"
                && diskData.schema_version > plannedData.schema_version) {
                return { ok: false,
                    errors: [{ path: "/schema_version", keyword: "version",
                        message: "disk schema_version > incoming; refuse to downgrade" }] };
            }
            // Semantic no-op detection (under lock — codex r3 P1 d)
            var plannedHash = helpers.contentHash(plannedData);
            if (plannedHash === diskHash) {
                return { ok: true, written: false, noop: true, reason: "semantic-no-op" };
            }
            // Backup-before-replace.
            //   Codex r5 P1: failures must abort the write
            //   Codex r7 P1: Windows copyFileSync preserves SOURCE mtime,
            //     so the backup inherits the OLD time. Then mtime-based
            //     rotation can delete the fresh backup. Stamp the backup
            //     with current mtime explicitly via utimesSync.
            var ts = new Date().toISOString().replace(/[:.]/g, "-");
            var sfx = crypto.randomBytes(4).toString("hex");
            var bakPath = p + ".bak." + ts + "-" + sfx;
            try {
                fs.copyFileSync(p, bakPath);
            }
            catch (e) { return { ok: false, errors: ["backup failed: " + e.message + " (refusing to overwrite without backup)"] }; }
            // Stamp mtime — best-effort (codex r8 P2: utimes failure
            // shouldn't block write; path-protection already guarantees
            // the fresh backup isn't rotated out)
            try { var nowD = new Date(); fs.utimesSync(bakPath, nowD, nowD); } catch (eU) {}
            // Write tmp + rename
            var fullText = helpers.serialize(_withUpdatedAt(plannedData, helpers.now()));
            var tmp2 = tmpPath(p);
            var fd2;
            try { fd2 = fs.openSync(tmp2, "wx"); }
            catch (e) { return { ok: false, errors: [e.message] }; }
            try {
                writeFullyAndClose(fd2, fullText);
                fs.renameSync(tmp2, p);
            } catch (e) {
                try { fs.unlinkSync(tmp2); } catch (e2) {}
                return { ok: false, errors: [e.message] };
            }
            rotateBackup(p, bakPath);
            var written = helpers.parse(fullText);
            return { ok: true, written: true, updated_at: written.ok ? written.data.updated_at : undefined };
        });
        // Convert lock timeout sentinel to documented result-object form
        // (codex r5 P2: Meta.write() must return, not reject).
        if (result && result.__lockTimeout) {
            return { ok: false, errors: ["lock timeout: could not acquire " + p + ".lock within " + (LOCK_RETRY_MAX * LOCK_RETRY_DELAY_MS) + "ms"] };
        }
        if (result && result.__lockError) {
            return { ok: false, errors: ["lock acquire error: " + result.__lockError.message] };
        }
        return result;
    }

    function _withUpdatedAt(planned, nowStr) {
        var out = {};
        for (var k in planned) out[k] = planned[k];
        out.updated_at = nowStr;
        return out;
    }

    return {
        readText: readText,
        writeAtomic: writeAtomic,
        _internal: {
            tryAcquireLock: tryAcquireLock,
            releaseLock: releaseLock,
            reclaimIfStale: reclaimIfStale,
            pidAlive: pidAlive,
            STALE_LOCK_MS: STALE_LOCK_MS
        }
    };
}));
