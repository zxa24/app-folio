"use strict";

// lib/zip_core.js — ZIP create/read built on fflate UMD (browser IIFE).
//
// Ported from indesign-toolkit/translation_mvp_uxp/lib/zip_core.js with the
// CommonJS `require()` shell replaced by browser globals. Same API surface:
//   ZipCore.createZip(entries, opts) -> Uint8Array
//   ZipCore.readZip(zipBytes, opts)  -> { "path": Uint8Array, ... }
//   ZipCore.sanitizeZipPath(name)    -> string | null
//   ZipCore.isLikelyAlreadyCompressed(name) -> boolean
//
// SECURITY: readZip enforces Zip Slip + size/count/ratio limits. Callers
// should still re-validate entry names before joining with a filesystem
// path at write-to-disk time.

(function () {
    var fflate = (typeof window !== "undefined" && window.fflate)
        ? window.fflate : null;
    if (!fflate) {
        throw new Error("zip_core.js: fflate is not loaded. Include vendor/fflate.umd.js before lib/zip_core.js.");
    }

    var DEFAULT_LEVEL = 6;

    var DEFAULT_LIMITS = {
        maxFileCount: 4096,
        maxTotalSize: 256 * 1024 * 1024,    // 256 MB total uncompressed
        maxEntrySize: 128 * 1024 * 1024,    // 128 MB per entry
        maxRatio: 100                       // uncompressed / compressed per entry
    };

    // Extensions whose contents are already compressed; deflating again
    // wastes CPU and usually grows the bytes. Stored (level: 0) instead.
    var STORE_ONLY_EXT = {
        "png": 1, "jpg": 1, "jpeg": 1, "gif": 1, "webp": 1, "heic": 1, "heif": 1,
        "avif": 1, "jp2": 1, "jxl": 1,
        "pdf": 1, "psd": 1, "ai": 1, "idml": 1,
        "mp3": 1, "mp4": 1, "m4a": 1, "m4v": 1, "mov": 1, "webm": 1,
        "zip": 1, "7z": 1, "rar": 1, "gz": 1, "bz2": 1, "xz": 1, "br": 1, "zst": 1,
        "docx": 1, "xlsx": 1, "pptx": 1, "odt": 1, "ods": 1, "odp": 1, "epub": 1
    };

    function isLikelyAlreadyCompressed(name) {
        if (!name) { return false; }
        var dot = name.lastIndexOf(".");
        if (dot < 0 || dot === name.length - 1) { return false; }
        var ext = name.substring(dot + 1).toLowerCase();
        return !!STORE_ONLY_EXT[ext];
    }

    function sanitizeZipPath(name) {
        if (typeof name !== "string" || name.length === 0) { return null; }
        if (name.indexOf("\0") >= 0) { return null; }

        var n = name.replace(/\\/g, "/");
        while (n.indexOf("./") === 0) { n = n.substring(2); }

        if (n.length === 0) { return null; }
        if (n.charAt(0) === "/") { return null; }
        if (/^[a-zA-Z]:/.test(n)) { return null; }
        if (n === ".." || n === ".") { return null; }

        var parts = n.split("/");
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (p === ".." || (i < parts.length - 1 && p === "")) {
                return null;
            }
        }
        return n;
    }

    function toU8(bytes) {
        if (bytes instanceof Uint8Array) { return bytes; }
        if (bytes instanceof ArrayBuffer) { return new Uint8Array(bytes); }
        if (bytes && bytes.buffer instanceof ArrayBuffer) {
            return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
        }
        if (typeof bytes === "string") { return fflate.strToU8(bytes); }
        throw new Error("zip_core: unsupported bytes type " + typeof bytes);
    }

    function createZip(entries, opts) {
        if (!entries || typeof entries !== "object") {
            throw new Error("zip_core.createZip: entries must be an object");
        }
        opts = opts || {};
        var defaultLevel = (typeof opts.level === "number") ? opts.level : DEFAULT_LEVEL;

        var input = {};
        var keys = Object.keys(entries);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var safeKey = sanitizeZipPath(k);
            if (!safeKey) {
                throw new Error("zip_core.createZip: unsafe entry name: " + k);
            }

            var raw = entries[k];
            var bytes, level;

            if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)
                    && !(raw instanceof ArrayBuffer) && "bytes" in raw) {
                bytes = toU8(raw.bytes);
                level = (typeof raw.level === "number") ? raw.level : null;
            } else {
                bytes = toU8(raw);
                level = null;
            }

            if (level === null) {
                level = isLikelyAlreadyCompressed(safeKey) ? 0 : defaultLevel;
            }

            input[safeKey] = [bytes, { level: level }];
        }

        return fflate.zipSync(input, { mtime: new Date() });
    }

    function readZip(zipBytes, opts) {
        var u8 = toU8(zipBytes);
        opts = opts || {};

        var maxFileCount = opts.maxFileCount || DEFAULT_LIMITS.maxFileCount;
        var maxTotalSize = opts.maxTotalSize || DEFAULT_LIMITS.maxTotalSize;
        var maxEntrySize = opts.maxEntrySize || DEFAULT_LIMITS.maxEntrySize;
        var maxRatio = opts.maxRatio || DEFAULT_LIMITS.maxRatio;

        if (u8.length < 22) {
            throw new Error("zip_core.readZip: input too short (" + u8.length + " bytes)");
        }
        var m0 = u8[0], m1 = u8[1], m2 = u8[2], m3 = u8[3];
        var isLocalHdr = (m0 === 0x50 && m1 === 0x4b && m2 === 0x03 && m3 === 0x04);
        var isEmptyZip = (m0 === 0x50 && m1 === 0x4b && m2 === 0x05 && m3 === 0x06);
        if (!isLocalHdr && !isEmptyZip) {
            throw new Error("zip_core.readZip: bad ZIP magic " + m0.toString(16)
                + " " + m1.toString(16) + " " + m2.toString(16) + " " + m3.toString(16));
        }

        var raw;
        try {
            raw = fflate.unzipSync(u8);
        } catch (e) {
            throw new Error("zip_core.readZip: fflate unzipSync failed: "
                + ((e && e.message) || String(e)));
        }

        var keys = Object.keys(raw);
        if (keys.length > maxFileCount) {
            throw new Error("zip_core.readZip: file count " + keys.length
                + " exceeds maxFileCount=" + maxFileCount);
        }

        var totalUncompressed = 0;
        for (var i = 0; i < keys.length; i++) {
            totalUncompressed += raw[keys[i]].length;
        }
        if (totalUncompressed > maxTotalSize) {
            throw new Error("zip_core.readZip: uncompressed total " + totalUncompressed
                + " exceeds maxTotalSize=" + maxTotalSize);
        }
        var ratio = u8.length > 0 ? (totalUncompressed / u8.length) : 0;
        if (ratio > maxRatio) {
            throw new Error("zip_core.readZip: compression ratio " + ratio.toFixed(1)
                + " exceeds maxRatio=" + maxRatio);
        }

        var out = {};
        for (var j = 0; j < keys.length; j++) {
            var name = keys[j];
            var safe = sanitizeZipPath(name);
            if (!safe) {
                throw new Error("zip_core.readZip: unsafe entry name in archive: " + name);
            }
            var bytes2 = raw[name];
            if (bytes2.length > maxEntrySize) {
                throw new Error("zip_core.readZip: entry " + safe + " size " + bytes2.length
                    + " exceeds maxEntrySize=" + maxEntrySize);
            }
            out[safe] = bytes2;
        }
        return out;
    }

    window.ZipCore = {
        createZip: createZip,
        readZip: readZip,
        sanitizeZipPath: sanitizeZipPath,
        isLikelyAlreadyCompressed: isLikelyAlreadyCompressed,
        DEFAULT_LIMITS: DEFAULT_LIMITS,
        STORE_ONLY_EXT: STORE_ONLY_EXT
    };
})();
