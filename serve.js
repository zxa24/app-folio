#!/usr/bin/env node
/**
 * Local dev server for Translator App
 * - Serves static files (HTML/CSS/JS)
 * - POST /api/write-file  — write content to a local path
 * - POST /api/open-file   — open a file with OS default app
 * - POST /api/read-dir    — list files in a directory
 * - POST /api/read-file   — read a file from disk
 * - GET  /api/ping        — health check (lets frontend detect local server)
 * - * /api/proxy-translate — forward Google Translate requests (bypass CORS)
 *
 * Usage:  node serve.js [port]
 *         Default port: 3000
 */

var http = require("http");
var fs = require("fs");
var path = require("path");
var https = require("https");
var url = require("url");
var childProcess = require("child_process");


var PORT = parseInt(process.argv[2], 10) || 3000;
var ROOT = path.resolve(__dirname);
var BIND_HOST = "127.0.0.1";   // loopback only — NEVER bind 0.0.0.0 / public

// Only allow CORS responses to be readable by pages served from our own
// origin. Browsers block cross-origin reads to other origins by default
// when this is restrictive (was previously '*' which is dangerous for a
// server that exposes file-system APIs).
var ALLOWED_ORIGINS = [
  "http://localhost:" + PORT,
  "http://127.0.0.1:" + PORT
];

// Filesystem APIs (write-file / read-file / read-dir / package-files /
// serve-file) accept arbitrary paths from the request. We restrict every
// request path to be either:
//   (a) inside ROOT (the webapp dir),
//   (b) inside an "approved" directory the user has explicitly opened via
//       /api/package-files this session.
// Without this gate, any program (or in-browser tab) that can connect to
// localhost:PORT could read/write the user's entire filesystem.
var APPROVED_DIRS = Object.create(null);

function approveDir(dirPath) {
  try {
    var resolved = path.resolve(dirPath);
    APPROVED_DIRS[resolved] = true;
  } catch (e) { /* ignore */ }
}

function isPathAllowed(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  var resolved;
  try { resolved = path.resolve(filePath); } catch (e) { return false; }
  if (resolved === ROOT) return true;
  if (resolved.indexOf(ROOT + path.sep) === 0) return true;
  for (var dir in APPROVED_DIRS) {
    if (resolved === dir) return true;
    if (resolved.indexOf(dir + path.sep) === 0) return true;
  }
  return false;
}

function rejectForbiddenPath(res, filePath) {
  jsonReply(res, 403, {
    error: "Path not allowed: " + filePath +
           " (must be under server root or an approved package directory)"
  });
}

// Single-folder runtime output convention: everything mutable lives under
// <repo>/.scratch/ so a single .gitignore entry covers it. The pre-2026-05-02
// .last_folder at repo root is migrated automatically on first read below.
var SCRATCH_DIR = path.join(ROOT, ".scratch");
var LAST_FOLDER_FILE = path.join(SCRATCH_DIR, "last_folder.txt");
var LEGACY_LAST_FOLDER_FILE = path.join(ROOT, ".last_folder");

function ensureScratchDir() {
  try {
    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  } catch (e) { /* best-effort */ }
}

function migrateLegacyLastFolder() {
  // One-shot migration: if old .last_folder exists at root and new one doesn't,
  // copy contents over and remove the legacy file. Idempotent.
  try {
    if (fs.existsSync(LEGACY_LAST_FOLDER_FILE) && !fs.existsSync(LAST_FOLDER_FILE)) {
      ensureScratchDir();
      var legacy = fs.readFileSync(LEGACY_LAST_FOLDER_FILE, "utf-8");
      fs.writeFileSync(LAST_FOLDER_FILE, legacy, "utf-8");
      try { fs.unlinkSync(LEGACY_LAST_FOLDER_FILE); } catch (e) {}
    }
  } catch (e) { /* best-effort */ }
}
migrateLegacyLastFolder();

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".pdf":  "application/pdf"
};

function cors(req, res) {
  // Only echo the Origin back if it's one of our allowed loopback origins.
  // Other origins get no Access-Control-Allow-Origin header → browser blocks
  // the response. Same-origin requests (no Origin header at all, or matching
  // Origin) work normally.
  var origin = req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) >= 0) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isOriginAllowed(req) {
  // For requests with an Origin header (browser-initiated), require a match.
  // Requests without Origin (curl, server-side fetches) are allowed because
  // the loopback bind already restricts them to local processes.
  var origin = req.headers && req.headers.origin;
  if (!origin) return true;
  return ALLOWED_ORIGINS.indexOf(origin) >= 0;
}

function jsonReply(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, cb) {
  var chunks = [];
  req.on("data", function (c) { chunks.push(c); });
  req.on("end", function () { cb(Buffer.concat(chunks).toString("utf-8")); });
}

// ── API handlers ──

function handlePing(req, res) {
  var lastFolder = "";
  try { lastFolder = fs.readFileSync(LAST_FOLDER_FILE, "utf-8").trim(); } catch (e) {}
  jsonReply(res, 200, { ok: true, server: "translator-app-local", lastFolder: lastFolder });
}

function handleWriteFile(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var filePath = parsed.path;
      var content = parsed.content;
      var contentBase64 = parsed.content_base64;
      if (!filePath || (typeof content !== "string" && typeof contentBase64 !== "string")) {
        jsonReply(res, 400, { error: "Missing path or content/content_base64" });
        return;
      }
      if (!isPathAllowed(filePath)) { rejectForbiddenPath(res, filePath); return; }
      // Ensure parent directory exists
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      var bytes;
      if (typeof contentBase64 === "string") {
        var buf = Buffer.from(contentBase64, "base64");
        fs.writeFileSync(filePath, buf);
        bytes = buf.length;
      } else {
        fs.writeFileSync(filePath, content, "utf-8");
        bytes = Buffer.byteLength(content, "utf-8");
      }
      jsonReply(res, 200, { ok: true, path: filePath, bytes: bytes });
    } catch (e) {
      jsonReply(res, 500, { error: e.message });
    }
  });
}

function handleOpenFile(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var filePath = parsed.path;
      if (!filePath) {
        jsonReply(res, 400, { error: "Missing path" });
        return;
      }
      if (!isPathAllowed(filePath)) { rejectForbiddenPath(res, filePath); return; }
      if (!fs.existsSync(filePath)) {
        jsonReply(res, 404, { error: "File not found: " + filePath });
        return;
      }
      // Platform-specific open command
      var cmd, args;
      if (process.platform === "win32") {
        cmd = "cmd";
        args = ["/c", "start", "", filePath];
      } else if (process.platform === "darwin") {
        cmd = "open";
        args = [filePath];
      } else {
        cmd = "xdg-open";
        args = [filePath];
      }
      childProcess.spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      jsonReply(res, 200, { ok: true, path: filePath });
    } catch (e) {
      jsonReply(res, 500, { error: e.message });
    }
  });
}

function handleReadFile(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var filePath = parsed.path;
      if (!filePath) {
        jsonReply(res, 400, { error: "Missing path" });
        return;
      }
      if (!isPathAllowed(filePath)) { rejectForbiddenPath(res, filePath); return; }
      if (!fs.existsSync(filePath)) {
        jsonReply(res, 404, { error: "File not found: " + filePath });
        return;
      }
      var content = fs.readFileSync(filePath, "utf-8");
      jsonReply(res, 200, { ok: true, content: content });
    } catch (e) {
      jsonReply(res, 500, { error: e.message });
    }
  });
}

function handleReadDir(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var dirPath = parsed.path;
      if (!dirPath) {
        jsonReply(res, 400, { error: "Missing path" });
        return;
      }
      if (!isPathAllowed(dirPath)) { rejectForbiddenPath(res, dirPath); return; }
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        jsonReply(res, 404, { error: "Directory not found: " + dirPath });
        return;
      }
      var entries = fs.readdirSync(dirPath).map(function (name) {
        var full = path.join(dirPath, name);
        var stat = fs.statSync(full);
        return { name: name, isDirectory: stat.isDirectory(), size: stat.size };
      });
      jsonReply(res, 200, { ok: true, entries: entries });
    } catch (e) {
      jsonReply(res, 500, { error: e.message });
    }
  });
}

function handleProxyTranslate(req, res) {
  var parsed = url.parse(req.url, true);
  var query = parsed.query;

  // Build the Google Translate URL
  var googleUrl = "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx" +
    "&sl=" + encodeURIComponent(query.sl || "auto") +
    "&tl=" + encodeURIComponent(query.tl || "en") +
    "&dt=t&dt=bd&dj=1" +
    "&q=" + encodeURIComponent(query.q || "");

  https.get(googleUrl, function (gRes) {
    var chunks = [];
    gRes.on("data", function (c) { chunks.push(c); });
    gRes.on("end", function () {
      var body = Buffer.concat(chunks);
      res.writeHead(gRes.statusCode, {
        "Content-Type": gRes.headers["content-type"] || "application/json"
      });
      res.end(body);
    });
  }).on("error", function (e) {
    jsonReply(res, 502, { error: "Proxy error: " + e.message });
  });
}

// ── Serve package folder files via server ──

function handlePackageFiles(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var dirPath = parsed.path;
      if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        jsonReply(res, 400, { error: "Invalid directory: " + dirPath });
        return;
      }
      // Approve this directory: subsequent file APIs (read-file / serve-file
      // / write-file etc.) targeting paths inside it will pass isPathAllowed.
      // The user has explicitly opened this folder, so we trust requests
      // touching files inside it.
      approveDir(dirPath);
      var results = [];
      var names = fs.readdirSync(dirPath);
      names.forEach(function (name) {
        var full = path.join(dirPath, name);
        var stat;
        try { stat = fs.statSync(full); } catch (e) { return; }
        if (!stat.isFile()) return;
        var ext = path.extname(name).toLowerCase();
        // Binary files (PDF etc.) — only send metadata, fetch separately
        if (ext === ".pdf") {
          results.push({ name: name, type: "binary", size: stat.size });
        } else if ([".json", ".txt", ".csv", ".tsv", ".xml", ".html", ".md"].indexOf(ext) >= 0) {
          var content = fs.readFileSync(full, "utf-8");
          results.push({ name: name, type: "text", data: content, size: stat.size });
        }
      });
      // Don't remember here — client calls /api/remember-folder after successful load
      jsonReply(res, 200, { ok: true, files: results });
    } catch (e) {
      jsonReply(res, 500, { error: e.message });
    }
  });
}

// Serve a single file from an approved package directory (for PDF streaming)
function handleServeFile(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var filePath = parsed.path;
      if (!filePath) {
        res.writeHead(400);
        res.end("Missing path");
        return;
      }
      if (!isPathAllowed(filePath)) {
        res.writeHead(403);
        res.end("Path not allowed");
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      var ext = path.extname(filePath).toLowerCase();
      var mime = MIME[ext] || "application/octet-stream";
      var stat = fs.statSync(filePath);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
}

// Remember folder after client confirms successful load
function handleRememberFolder(req, res) {
  readBody(req, function (raw) {
    try {
      var parsed = JSON.parse(raw);
      var dirPath = parsed.path;
      if (!dirPath) {
        jsonReply(res, 400, { error: "Missing path" });
        return;
      }
      // Approve + persist. Future file APIs hitting this folder will pass
      // isPathAllowed even after a server restart (next launch reads
      // LAST_FOLDER_FILE in handlePing — but approveDir only persists for
      // current process; restart re-approves on the first /api/package-files).
      approveDir(dirPath);
      ensureScratchDir();
      fs.writeFileSync(LAST_FOLDER_FILE, dirPath, "utf-8");
      jsonReply(res, 200, { ok: true });
    } catch (e) {
      jsonReply(res, 500, { error: e.message });
    }
  });
}

// ── Static file server ──

function serveStatic(req, res) {
  var parsed = url.parse(req.url);
  var reqPath = decodeURIComponent(parsed.pathname);
  if (reqPath === "/") reqPath = "/index.html";

  var filePath = path.join(ROOT, reqPath);

  // Security: prevent path traversal outside ROOT
  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end("Not found: " + reqPath);
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    // Force fresh JS / HTML / CSS during active development. Without this
    // browsers cache app.js hard, so newly-edited features (e.g. emphasis
    // overlay) silently keep using the old code on reload.
    var headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".js" || ext === ".html" || ext === ".css") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ── Router ──

var server = http.createServer(function (req, res) {
  cors(req, res);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  var pathname = url.parse(req.url).pathname;
  var isApi = pathname.indexOf("/api/") === 0;

  // For API endpoints, reject requests whose Origin (when present) is not
  // one of our loopback origins. Static asset requests (no /api/ prefix)
  // can come from anywhere — they're just files in ROOT.
  if (isApi && !isOriginAllowed(req)) {
    jsonReply(res, 403, { error: "Cross-origin API requests are not allowed" });
    return;
  }

  if (pathname === "/api/ping") return handlePing(req, res);
  if (pathname === "/api/write-file" && req.method === "POST") return handleWriteFile(req, res);
  if (pathname === "/api/open-file"  && req.method === "POST") return handleOpenFile(req, res);
  if (pathname === "/api/read-file"  && req.method === "POST") return handleReadFile(req, res);
  if (pathname === "/api/read-dir"   && req.method === "POST") return handleReadDir(req, res);
  // /api/pick-folder removed — browser prompt() used instead
  if (pathname === "/api/package-files"   && req.method === "POST") return handlePackageFiles(req, res);
  if (pathname === "/api/serve-file"     && req.method === "POST") return handleServeFile(req, res);
  if (pathname === "/api/remember-folder" && req.method === "POST") return handleRememberFolder(req, res);
  if (pathname === "/api/proxy-translate") return handleProxyTranslate(req, res);

  serveStatic(req, res);
});

// Bind to loopback only — never expose to LAN / internet. Combined with the
// origin/path restrictions above, this means filesystem APIs are reachable
// only by processes on the same machine, and only successfully consumable
// by pages served from this same server (browser CORS + Origin check).
server.listen(PORT, BIND_HOST, function () {
  console.log("");
  console.log("  Translator App Local Server");
  console.log("  ---------------------------");
  console.log("  URL:  http://" + BIND_HOST + ":" + PORT + "  (loopback only)");
  console.log("  Root: " + ROOT);
  console.log("");
  console.log("  API endpoints:");
  console.log("    GET  /api/ping             - health check");
  console.log("    POST /api/write-file        - write file (path must be under root or approved dir)");
  console.log("    POST /api/read-file         - read file (path must be under root or approved dir)");
  console.log("    POST /api/read-dir          - list directory (must be approved)");
  console.log("    GET  /api/proxy-translate   - Google Translate proxy");
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
