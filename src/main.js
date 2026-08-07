// superdoc-host — isolated SuperDoc service for Deal Oracle.
//
// This app embeds UNMODIFIED SuperDoc (AGPL-3.0) and exposes it to a parent
// window through a strict postMessage bridge. It holds no credentials and
// stores nothing: document bytes arrive via a short-lived presigned GET URL,
// saves go to a short-lived presigned PUT URL, both minted by the parent's
// backend. The entire app (SuperDoc + this glue) is public AGPL source.
//
// Bridge protocol (all messages are {type: "superdoc-host:*", ...}):
//   host  -> parent  ready                        (host booted, awaiting load)
//   parent -> host   load {docUrl, saveUrl?, user?, mode?, fileName?}
//   host  -> parent  loaded {fileName}
//   host  -> parent  error {message}
//   parent -> host   save                         (export + PUT to saveUrl)
//   host  -> parent  saved {size}
//   parent -> host   set-mode {mode}              (editing|suggesting|viewing)
//   host  -> parent  dirty                        (first content change since load/save)
//
// Origin discipline: messages are accepted ONLY from origins in
// VITE_ALLOWED_PARENT_ORIGINS (comma-separated; dev default localhost:3000),
// and every outbound message targets the specific origin that sent `load`
// (until then, `ready` targets the allowlist entries, never "*").

import { SuperDoc } from "superdoc";
import "superdoc/style.css";

const DEFAULT_ALLOWED = "http://localhost:3000,https://deal-oracle-web.vercel.app";
const allowedOrigins = (import.meta.env.VITE_ALLOWED_PARENT_ORIGINS || DEFAULT_ALLOWED)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const statusEl = document.getElementById("status");
const MODES = new Set(["editing", "suggesting", "viewing"]);

let superdoc = null;
let parentOrigin = null;
let saveUrl = null;
let dirtySent = false;

function setStatus(text) {
  if (text === null) {
    statusEl.classList.add("hidden");
  } else {
    statusEl.classList.remove("hidden");
    statusEl.textContent = text;
  }
}

function send(message) {
  const targets = parentOrigin ? [parentOrigin] : allowedOrigins;
  for (const origin of targets) {
    window.parent.postMessage({ ...message, type: `superdoc-host:${message.type}` }, origin);
  }
}

function fail(message) {
  setStatus(message);
  send({ type: "error", message });
}

function markDirty() {
  if (dirtySent) return;
  dirtySent = true;
  send({ type: "dirty" });
}

async function handleLoad(data) {
  if (typeof data.docUrl !== "string" || !/^https:\/\//.test(data.docUrl)) {
    fail("load requires an https docUrl");
    return;
  }
  saveUrl = typeof data.saveUrl === "string" && /^https:\/\//.test(data.saveUrl) ? data.saveUrl : null;
  dirtySent = false;
  setStatus("Loading document…");

  if (superdoc) {
    try {
      superdoc.destroy?.();
    } catch {
      // A failed teardown must not block loading the next document.
    }
    superdoc = null;
    document.getElementById("editor").replaceChildren();
    document.getElementById("toolbar").replaceChildren();
  }

  const mode = MODES.has(data.mode) ? data.mode : "suggesting";
  const user =
    data.user && typeof data.user.name === "string"
      ? { name: data.user.name, email: typeof data.user.email === "string" ? data.user.email : undefined }
      : { name: "Deal Oracle" };

  try {
    superdoc = new SuperDoc({
      selector: "#editor",
      document: data.docUrl,
      documentMode: mode,
      user,
      contained: true,
      ui: { toolbar: { container: "#toolbar" } },
      onReady: () => {
        setStatus(null);
        send({ type: "loaded", fileName: typeof data.fileName === "string" ? data.fileName : "document.docx" });
      },
      onException: ({ error }) => {
        fail(`SuperDoc failed to load the document: ${error?.message ?? String(error)}`);
      },
      onEditorUpdate: markDirty,
    });
  } catch (error) {
    fail(`SuperDoc init failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSave() {
  if (!superdoc) {
    fail("save requested before a document was loaded");
    return;
  }
  if (!saveUrl) {
    fail("save requested but no saveUrl was provided at load time");
    return;
  }
  try {
    const blob = await superdoc.export({ triggerDownload: false });
    const response = await fetch(saveUrl, {
      method: "PUT",
      body: blob,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
    if (!response.ok) {
      fail(`save upload failed: HTTP ${response.status}`);
      return;
    }
    dirtySent = false;
    send({ type: "saved", size: blob.size });
  } catch (error) {
    fail(`save failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

window.addEventListener("message", (event) => {
  if (!allowedOrigins.includes(event.origin)) return;
  const data = event.data;
  if (!data || typeof data.type !== "string" || !data.type.startsWith("superdoc-host:")) return;
  if (parentOrigin === null) parentOrigin = event.origin;

  switch (data.type.slice("superdoc-host:".length)) {
    case "load":
      void handleLoad(data);
      break;
    case "save":
      void handleSave();
      break;
    case "set-mode": {
      if (superdoc && MODES.has(data.mode)) superdoc.setDocumentMode?.(data.mode);
      break;
    }
    default:
      break;
  }
});

send({ type: "ready" });
