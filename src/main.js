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
// Origin discipline: messages are accepted ONLY from the first-party origins
// baked in below plus any in VITE_ALLOWED_PARENT_ORIGINS (comma-separated),
// and every outbound message targets the specific origin that sent `load`
// (until then, `ready` targets the allowlist entries, never "*").

// ⚠️ PINNED TO SUPERDOC 1.x (the `legacy` dist-tag), NOT `latest`.
//
// superdoc@2.4.0 ships a rewritten v2 engine that RENDERS but does not EDIT.
// Probed live on 2026-08-07: it mounts a custom layered renderer
// (.superdoc__layers / .superdoc__document / .superdoc__selection-layer) with
// zero contenteditable nodes and zero ProseMirror nodes, and its Document API
// reports `mutation.operations: "MVP supports comments.create on body text
// only"`. The toolbar renders and export works, so it looks healthy — it just
// silently swallows every keystroke, which is exactly how it reached
// production here. 1.46.1 is the ProseMirror-based editor with real typing and
// track changes. Do not bump to 2.x until v2's capabilities report text
// mutation as available.
import { SuperDoc } from "superdoc";
import "superdoc/style.css";

// Every origin deal-oracle-web is actually served from. A Vercel production
// deployment carries THREE aliases — the bare project URL, the -novadominion
// one, and -git-main-novadominion — and a parent posting from an alias that
// isn't listed here gets its message dropped, so the viewer just silently
// never loads. These are baked in rather than env-only precisely because
// missing one is invisible until a human opens the wrong URL.
const DEFAULT_ALLOWED = [
  "http://localhost:3000",
  "https://deal-oracle-web.vercel.app",
  "https://deal-oracle-web-novadominion.vercel.app",
  "https://deal-oracle-web-git-main-novadominion.vercel.app",
  "https://deal-oracle-web-git-file-viewers-native-novadominion.vercel.app",
];
// VITE_ALLOWED_PARENT_ORIGINS ADDS origins (extra previews, a custom domain);
// it does not replace the first-party set above.
const allowedOrigins = [
  ...new Set(
    [...DEFAULT_ALLOWED, ...(import.meta.env.VITE_ALLOWED_PARENT_ORIGINS || "").split(",")]
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

const statusEl = document.getElementById("status");
const MODES = new Set(["editing", "suggesting", "viewing"]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
  const fileName = typeof data.fileName === "string" ? data.fileName : "document.docx";
  const user =
    data.user && typeof data.user.name === "string"
      ? { name: data.user.name, email: typeof data.user.email === "string" ? data.user.email : undefined }
      : { name: "Deal Oracle" };

  // Fetch the bytes here and hand SuperDoc a real File. Passing the presigned
  // URL directly makes SuperDoc do its own fetch-and-wrap, which fails with a
  // bare "Failed to create file object" that says nothing about whether the
  // download, the content type, or the filename was the problem. Doing it here
  // means a download failure reports its own HTTP status.
  let file;
  try {
    const response = await fetch(data.docUrl);
    if (!response.ok) {
      fail(`could not download the document: HTTP ${response.status}`);
      return;
    }
    file = new File([await response.blob()], fileName, { type: DOCX_MIME });
  } catch (error) {
    fail(`could not download the document: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    superdoc = new SuperDoc({
      selector: "#editor",
      document: file,
      documentMode: mode,
      // Permission axis, separate from documentMode. Without it the editor
      // renders but every mutation is refused.
      role: "editor",
      user,
      contained: true,
      toolbar: "#toolbar",
      onReady: () => {
        setStatus(null);
        send({ type: "loaded", fileName });
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
        "Content-Type": DOCX_MIME,
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
    case "debug": {
      // Read-only introspection of the editor's editability, so the parent can
      // tell "the document did not load" apart from "the document loaded but
      // refuses keystrokes" without cross-origin DOM access.
      const editor = superdoc?.activeEditor;
      // Getters on the editor can throw before the document settles; a debug
      // probe must never itself become the error being investigated.
      const safe = (fn) => {
        try {
          const v = fn();
          return typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : (v ?? null);
        } catch (e) {
          return `THREW: ${e?.message ?? String(e)}`;
        }
      };
      // Walk shadow roots too — a surface mounted in a shadow tree is invisible
      // to a plain document.querySelectorAll and would read as "not rendered".
      const countDeep = (selector) => {
        let n = 0;
        const walk = (root) => {
          n += root.querySelectorAll(selector).length;
          for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(document);
        return n;
      };
      const editorEl = document.getElementById("editor");
      send({
        type: "debug",
        info: {
          hasSuperdoc: Boolean(superdoc),
          documentMode: superdoc?.config?.documentMode ?? null,
          role: superdoc?.config?.role ?? null,
          hasActiveEditor: Boolean(editor),
          editorKeys: editor ? Object.keys(editor).slice(0, 40) : null,
          editorVersion: editor?.editorVersion ?? null,
          mutationReadiness: safe(() => editor?.documentMutationReadiness),
          apiUnavailableReason: safe(() => editor?.documentApiUnavailableReason),
          capabilities: safe(() => editor?.capabilities),
          optionKeys: editor?.options ? Object.keys(editor.options).slice(0, 60) : null,
          optionEditable: safe(() => editor?.options?.editable),
          optionMode: safe(() => editor?.options?.documentMode ?? editor?.options?.mode),
          hasMount: Boolean(editor?.mount),
          hasAuthoring: Boolean(editor?.authoring),
          hasEditCommands: Boolean(editor?.editCommands),
          editorIsEditable: editor?.isEditable ?? null,
          editorOptionsEditable: editor?.options?.editable ?? null,
          hasView: Boolean(editor?.view),
          viewEditable: editor?.view?.editable ?? null,
          viewDomTag: editor?.view?.dom?.tagName ?? null,
          viewDomContentEditable: editor?.view?.dom?.getAttribute?.("contenteditable") ?? null,
          viewDomConnected: editor?.view?.dom?.isConnected ?? null,
          contentEditableTrue: countDeep('[contenteditable="true"]'),
          proseMirrorNodes: countDeep(".ProseMirror"),
          shadowRoots: [...document.querySelectorAll("*")].filter((el) => el.shadowRoot).length,
          editorElChildren: editorEl?.children?.length ?? null,
          editorElHtml: (editorEl?.innerHTML ?? "").slice(0, 600),
          activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
        },
      });
      break;
    }
    default:
      break;
  }
});

send({ type: "ready" });
