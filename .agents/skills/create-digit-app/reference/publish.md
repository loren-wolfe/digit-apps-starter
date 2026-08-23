# Publish a Digit app (MCP)

Requires the org `CUSTOM_APPS` feature flag and `publish:app` permission. Digit MCP is
required for this workflow.

## Prerequisites

1. User has **created the app in Digit** (UI). Publishing never creates apps — there are
   no MCP tools to create, update, or delete apps.
2. You know the app `id` — resolve with MCP `apps`, or ask the user.
3. **Restore source:** if `.digit/in-app-agent` / `DIGIT_IN_APP_AGENT` / in-app
   instructions are present, skip download. Otherwise GET
   `currentPublish.downloadUrl` **before** editing (see below).
4. GraphQL operations checked against `graphql-schema://…` and `manifest.permissions`
   filled with **`key`** values from MCP **`appPermissions`**.
5. `app.zip` ready via `npm run pack` (`digit-app pack` from `@digit/lib-build`). Local
   `pack` only prepares the zip; MCP `publishApp` is what goes live.

There is no local Digit preview — pack + publish is the workflow.

## Workflow

External MCP once a publish exists: **download → edit → pack → publish**. Repeat
from download on the next external MCP session. Digit’s in-app agent skips
download and edits the installed `apps/<name>` tree.

```
1. apps                     → find appId
2. app                      → GET currentPublish.downloadUrl (skip if in-app marker)
3. generateAppUploadLink    → id, uploadUrl, uploadFields
4. HTTP POST zip to uploadUrl (multipart; NOT via MCP)
5. publishApp               → appId + appUploadLinkId
6. appPublish               → poll until succeeded | failed
```

### 1. Resolve app id

Call MCP `apps`. Match by `name`. Use the returned `id` as `appId`.

If the app does not exist, stop and ask the user to create it in Digit.

### 2. Restore the active published source (external MCP only)

**Both hosts have Digit MCP.** Detect in-app agent if **any** of these is true:
workspace file `.digit/in-app-agent`, env `DIGIT_IN_APP_AGENT` non-empty, or
instructions that you are Digit’s in-app agent. If none match, you are external
MCP — do not guess.

**External MCP:** Digit stores the live bundle; your workspace does not have it
until you fetch it. Call MCP `app` with the `id` from step 1 at the start of
every change session:

- `currentPublish.downloadUrl` — HTTP GET this URL (out-of-band; not via MCP) to
  download the **currently live** bundle, the same zip shape produced by
  `npm run pack`. Unpack `project/` over `apps/<name>`, then edit.
- If `currentPublish` is absent, there is no live bundle — scaffold from
  `apps/app` or `new-app` instead.

Do not rebuild from an example, and do not ask the user to paste or attach source
they saved earlier, while a download URL is available.

**In-app agent (marker present):** skip this step. Edit `apps/<name>` as
installed. Do not GET `downloadUrl` or replace `apps/`.

### 3. Generate upload link

Call MCP `generateAppUploadLink`. Save:

- `id` (this is both `appUploadLinkId` and later `appPublishId`)
- `uploadUrl`
- `uploadFields` — array of `{ key, value }`

### 4. Upload the zip (out-of-band)

MCP cannot carry binary bodies. POST multipart form-data:

1. Every `uploadFields` entry as a form field **first**
2. The zip as the final `file` field

Max **10MB**. If you cannot perform this HTTP request, stop and tell the user — do not call
`publishApp` against an empty upload.

```bash
# Pseudocode — expand uploadFields into -F key=value pairs, then -F file=@app.zip
curl -X POST "$UPLOAD_URL" \
  -F "key=...from uploadFields..." \
  -F "Content-Type=...from uploadFields..." \
  # ...all other uploadFields...
  -F "file=@app.zip"
```

Build the zip with `npm run pack` and upload **`app.zip` as produced**:

```
app.zip
├── manifest.json
├── frontend/
│   └── index.js
├── backend/                  # when manifest.backend is set
│   ├── index.js
│   └── migrations/
└── project/                  # required — source, SPEC, vendored @digit/lib-*
```

**Do not modify the zip after pack.** Digit deploys from `frontend/` / `backend/`;
`project/` must still be present in the published zip.

### 5. Publish

Call MCP `publishApp` with:

- `appId` — existing app id
- `appUploadLinkId` — `id` from step 3

Returns `state: queued` (or similar in-progress). Each upload publishes **once**; to retry,
start again at `generateAppUploadLink`.

### 6. Poll

Call MCP `appPublish` with:

- `appId`
- `appPublishId` — same id as `appUploadLinkId`

Poll until `state` is `succeeded` or `failed`. Intermediate states include `queued`,
`validating`, `deployingBackend`, `publishingBundle`. During `deployingBackend`, Digit
applies pending migrations — see [d1-migrations.md](d1-migrations.md). On failure, report
`error`, fix the bundle, and restart at step 3.

## Zip validation reminders

- `manifest.json` at the zip root and `frontend/index.js`
- When `manifest.backend` is set: `backend/index.js`
- `project/` with source, `SPEC.md`, and vendored `@digit/lib-*` (including `lib-build`)
- `manifest.permissions` are **`key`** values from **`appPermissions`**
