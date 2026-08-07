# superdoc-host

An isolated, single-purpose web app that hosts the [SuperDoc](https://github.com/superdoc/docx-editor)
`.docx` editor for [Deal Oracle](https://novadominion.com), embedded by the
Deal Oracle web app as a sandboxed inline iframe.

## Why this exists as its own repo

SuperDoc's Community edition is licensed **AGPL-3.0**. Deal Oracle keeps its
proprietary code cleanly separated by never importing SuperDoc into its own
bundles: instead, this app — unmodified SuperDoc plus the thin
`postMessage`/presigned-URL glue in `src/main.js` — runs as an independent
deployment on its own origin, and its **complete corresponding source is this
public repository, licensed AGPL-3.0** (see `LICENSE`). Anyone interacting
with the deployed editor is already looking at everything it is built from.

## What it does

- Receives a `load` message from its parent window carrying a short-lived
  presigned **GET** URL for the document and (optionally) a presigned **PUT**
  URL for saves. No credentials, tokens, or document storage live here.
- Renders the docx with SuperDoc (`documentMode: suggesting` by default, so
  edits are native Word tracked changes attributed to the configured user).
- On a `save` message, exports the edited `.docx` as a Blob and PUTs it to
  the presigned save URL, then reports `saved`.
- Accepts messages **only** from origins listed in
  `VITE_ALLOWED_PARENT_ORIGINS` and replies only to the engaged parent origin.

The full bridge protocol is documented at the top of `src/main.js`.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/
```

`VITE_ALLOWED_PARENT_ORIGINS` — comma-separated parent origins allowed to
drive the bridge (defaults to localhost:3000 + the Deal Oracle web origin).

## License

AGPL-3.0-only. SuperDoc is © Harbour Enterprises, Inc., used unmodified under
its AGPL-3.0 Community license.
