/* wlg-bingo-app: S3 upload add-on for Conference Passport.
 * Built by build_webapp.py (it fills CONFIG and BLOB). Loaded after xlsx.full.min.js.
 * Needs window.passportExport(), added to index.html by patch_passport.py. */
(function () {
"use strict";

/* ============================ CONFIG (filled by build_webapp.py) ============================ */
var CONFIG = { bucket: "wlg-bingo-app", region: "eu-west-3" };
var BLOB = {"v": 1, "iter": 600000, "aad": "wlg-bingo-app:v1", "salt": "GCFVRk5wGcrOTI/jtszdIw==", "iv": "Hqf7mag5YsSg5/wq", "ct": "l20vJ2oya2HU6gX6XLLCOef+MTkgTRFt+KR4YAfJoUOgyWc4udFRrh34jpiZtX4DkApvZffO5MtxuhkAtFUndBcjnAXXrToU8HhGdNGMhwiKjavFisF8Kb9Fx07+WalICirFvqQbCtYgJn/LQ39F9LoP8A=="};

/* ============================ CORE START (unit-tested outside the browser) ============================ */
var enc = new TextEncoder();
var dec = new TextDecoder();

function b64decode(s) {
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

// RFC 3986 percent-encoding (what SigV4 requires)
function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); });
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hmacSha256(keyBytes, data) {
  var key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

// Blob format (written by build_webapp.py): PBKDF2-HMAC-SHA256 -> AES-256-GCM, AAD bound to the format tag.
async function decryptCredentials(blob, passphrase) {
  if (!blob || blob.v !== 1) throw new Error("Unsupported credential blob");
  var material = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  var key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64decode(blob.salt), iterations: blob.iter, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  var plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(blob.iv), additionalData: enc.encode(blob.aad) },
    key,
    b64decode(blob.ct)
  );
  return JSON.parse(dec.decode(plain));
}

// SigV4 query-string presign for a virtual-hosted-style S3 URL, unsigned payload, host as the only signed header.
async function presignS3Url(o) {
  var host = o.bucket + ".s3." + o.region + ".amazonaws.com";
  var amzDate = o.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  var day = amzDate.slice(0, 8);
  var scope = day + "/" + o.region + "/s3/aws4_request";
  var canonicalUri = "/" + o.key.split("/").map(rfc3986).join("/");
  var params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": o.accessKeyId + "/" + scope,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(o.expires),
    "X-Amz-SignedHeaders": "host"
  };
  var canonicalQuery = Object.keys(params).sort().map(function (k) { return rfc3986(k) + "=" + rfc3986(params[k]); }).join("&");
  var canonicalRequest = [o.method, canonicalUri, canonicalQuery, "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
  var stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  var k = await hmacSha256(enc.encode("AWS4" + o.secretAccessKey), day);
  k = await hmacSha256(k, o.region);
  k = await hmacSha256(k, "s3");
  k = await hmacSha256(k, "aws4_request");
  var signature = toHex(await hmacSha256(k, stringToSign));
  return "https://" + host + canonicalUri + "?" + canonicalQuery + "&X-Amz-Signature=" + signature;
}

function sanitizeSegment(s, max) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, max);
}

function buildKey(uploader, fileName, now, uuid) {
  var dot = fileName.lastIndexOf(".");
  var ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  var base = sanitizeSegment(dot > 0 ? fileName.slice(0, dot) : fileName, 100) || "file";
  var iso = now.toISOString(); // 2026-10-22T14:03:09.123Z
  var date = iso.slice(0, 10);
  var time = iso.slice(11, 19).replace(/:/g, "");
  return "uploads/" + date + "/" + (sanitizeSegment(uploader, 40) || "unknown") + "/" + time + "_" + uuid + "_" + base + "." + ext;
}
/* ============================ CORE END ============================ */

var MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
var URL_TTL_SECONDS = 300;
var IDLE_LOCK_MS = 15 * 60 * 1000;

var creds = null;
var idleTimer = null;
var busy = false;
var pendingPassword = null; // resolver of the open password dialog

function putBlob(url, blob, mime, onProgress) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      var code = /<Code>([^<]+)<\/Code>/.exec(xhr.responseText || "");
      reject(new Error("S3 returned " + xhr.status + (code ? " (" + code[1] + ")" : "")));
    };
    xhr.onerror = function () { reject(new Error("network error or blocked by the bucket CORS rule")); };
    xhr.send(blob);
  });
}

/* ============================ UI (reuses the page's own classes) ============================ */
function init() {
  var anchor = document.getElementById("sendNote") || document.getElementById("send");
  if (!anchor) return; // not the expected page

  var style = document.createElement("style");
  style.textContent =
    "#s3Pw{width:100%;font:inherit;font-size:15px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink)}" +
    "#s3Pw:focus-visible{outline:2px solid var(--blue);outline-offset:1px}" +
    "#s3Note.err{color:var(--hot);font-weight:600}#s3Note.ok{color:var(--doneline);font-weight:600}";
  document.head.appendChild(style);

  var box = document.createElement("div");
  box.innerHTML =
    '<div class="exp" style="margin-top:12px"><button class="b pri" id="s3Up" type="button">Upload Excel to S3</button></div>' +
    '<div class="note" id="s3Note" role="status" aria-live="polite">Uploads a snapshot of your whole card as an Excel file.</div>';
  anchor.parentNode.insertBefore(box, anchor.nextSibling);

  var dlg = document.createElement("div");
  dlg.innerHTML =
    '<div class="scrim" id="s3Scrim" hidden></div>' +
    '<div class="sheet" id="s3Sheet" hidden role="dialog" aria-modal="true" aria-labelledby="s3Title">' +
    '<h3 id="s3Title">Team password</h3>' +
    '<p class="lead">Needed once per session to upload to the team bucket.</p>' +
    '<div class="fld"><label for="s3Pw">Password</label><input type="password" id="s3Pw" autocomplete="current-password" spellcheck="false"></div>' +
    '<div class="sheetbtns"><button class="b pri" id="s3Ok" type="button">Unlock and upload</button><button class="b" id="s3Cancel" type="button">Cancel</button></div>' +
    '<div class="sheetwarn" id="s3Warn" hidden></div></div>';
  document.body.appendChild(dlg);

  var $ = function (id) { return document.getElementById(id); };

  function note(text, kind) {
    var n = $("s3Note");
    n.textContent = text;
    n.className = "note" + (kind ? " " + kind : "");
  }

  function armIdleLock() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { creds = null; }, IDLE_LOCK_MS);
  }

  function closeDialog(result) {
    $("s3Sheet").hidden = true;
    $("s3Scrim").hidden = true;
    $("s3Pw").value = "";
    $("s3Warn").hidden = true;
    var r = pendingPassword;
    pendingPassword = null;
    if (r) r(result);
  }

  function askPassword() {
    return new Promise(function (resolve) {
      pendingPassword = resolve;
      $("s3Sheet").hidden = false;
      $("s3Scrim").hidden = false;
      $("s3Pw").focus();
    });
  }

  async function tryUnlock() {
    var warn = $("s3Warn");
    var ok = $("s3Ok");
    ok.disabled = true;
    warn.hidden = true;
    try {
      creds = await decryptCredentials(BLOB, $("s3Pw").value);
      armIdleLock();
      closeDialog(true);
    } catch (err) {
      warn.textContent = err && err.name === "OperationError" ? "Wrong password." : "Could not unlock: " + (err && err.message);
      warn.hidden = false;
    } finally {
      ok.disabled = false;
    }
  }

  $("s3Ok").addEventListener("click", tryUnlock);
  $("s3Cancel").addEventListener("click", function () { closeDialog(false); });
  $("s3Scrim").addEventListener("click", function () { closeDialog(false); });
  $("s3Pw").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); tryUnlock(); } });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("s3Sheet").hidden) closeDialog(false); });

  $("s3Up").addEventListener("click", async function () {
    if (busy) return;
    var btn = $("s3Up");
    var exp = typeof window.passportExport === "function" ? window.passportExport() : null;
    if (!exp) return note("The page is missing the export hook. Run patch_passport.py on index.html.", "err");
    if (!exp.who) return note("Add your name at the top first, then upload.", "err");
    if (exp.empty) return note("Nothing to upload yet. Tick a square or add a contact first.", "err");
    if (!BLOB) return note("S3 upload is not configured: s3-upload.js was not built with credentials.", "err");
    if (!window.crypto || !crypto.subtle) return note("Open this page over https: the browser blocks encryption APIs otherwise.", "err");
    if (!navigator.onLine) return note("No connection. Try again when you are back online.", "err");

    busy = true;
    btn.disabled = true;
    try {
      if (!creds && !(await askPassword())) { note("Upload cancelled.", ""); return; }
      note("Uploading...", "");
      var now = new Date();
      var key = buildKey(exp.who, exp.filename, now, crypto.randomUUID().slice(0, 8));
      var url = await presignS3Url({
        method: "PUT",
        bucket: CONFIG.bucket,
        region: CONFIG.region,
        key: key,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        expires: URL_TTL_SECONDS,
        now: now
      });
      await putBlob(url, exp.blob, MIME_XLSX, function (f) { note("Uploading " + Math.round(f * 100) + "%", ""); });
      armIdleLock();
      note("Uploaded at " + now.toTimeString().slice(0, 5) + ". Each upload is a new snapshot of your card.", "ok");
    } catch (err) {
      note("Upload failed: " + (err && err.message), "err");
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
}

init();
})();
