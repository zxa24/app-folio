// local_prefs.js — browser-only convenience prefs (A3a', 2026-06-16).
//
// Thin keyed wrapper over localStorage with a KNOWN allowlist. Scope:
//   - theme_mode    : adopts the EXACT pre-existing key the index.html inline
//                     bootstrap + app.js theme code already use → zero migration.
//   - operator_name : auto-fills contributors.translator. One-time-consent UX
//                     lives in the panel, NOT here (this is pure storage).
//
// Boundary (deliberate): single-browser, NOT synced, NOT written into the
// package, NOT part of the freeze/drift gate. This is device-local UX memory;
// the package _meta (ProjectMeta) is the authoritative, travelling store. The
// only link is convenience: operator_name seeds the translator field, but the
// package _meta.contributors.translator is the source of truth for a package.
//
// Why an allowlist (not raw localStorage): a typo'd key silently no-ops, and
// clearAll() must touch ONLY our keys (unrelated app keys must survive).
//
// UMD: window.LocalPrefs | module.exports.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.LocalPrefs = factory();
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // Logical key → physical localStorage key.
    var KNOWN = {
        theme_mode:    "translator_app.theme_mode",
        operator_name: "translator_app.operator_name"
    };

    function physical(key) {
        return Object.prototype.hasOwnProperty.call(KNOWN, key) ? KNOWN[key] : null;
    }

    // get(key) → stored string, or null if unset / unknown key / storage blocked
    // (Safari private mode + quota states throw on access).
    function get(key) {
        var pk = physical(key);
        if (!pk) return null;
        try {
            var v = localStorage.getItem(pk);
            return (v === null || v === undefined) ? null : String(v);
        } catch (e) { return null; }
    }

    // set(key, value) → true on write, false on unknown key / storage blocked.
    // null/undefined value removes the key (so callers can clear via set(k, null)).
    function set(key, value) {
        var pk = physical(key);
        if (!pk) return false;
        try {
            if (value === null || value === undefined) { localStorage.removeItem(pk); return true; }
            localStorage.setItem(pk, String(value));
            return true;
        } catch (e) { return false; }
    }

    function remove(key) {
        var pk = physical(key);
        if (!pk) return false;
        try { localStorage.removeItem(pk); return true; } catch (e) { return false; }
    }

    // has(key) — true only if a non-empty value is stored.
    function has(key) {
        var v = get(key);
        return v !== null && v !== "";
    }

    // clearAll() — removes ONLY our known keys, never the whole localStorage.
    function clearAll() {
        var ok = true;
        var ks = Object.keys(KNOWN);
        for (var i = 0; i < ks.length; i++) {
            try { localStorage.removeItem(KNOWN[ks[i]]); } catch (e) { ok = false; }
        }
        return ok;
    }

    return {
        KNOWN: KNOWN,
        get: get,
        set: set,
        remove: remove,
        has: has,
        clearAll: clearAll
    };
}));
