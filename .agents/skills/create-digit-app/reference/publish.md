# Publish a Digit app (MCP)

Requires the org `CUSTOM_APPS` feature flag and `publish:app` permission. Digit MCP is
required for this workflow.

## Prerequisites

1. User has **created the app in Digit** (UI). Publishing never creates apps — there are
   no MCP tools to create, update, or delete apps.
2. You know the app `id` — resolve with MCP `apps`, or ask the user.
3. GraphQL operations checked against `graphql-schema://…` and `manifest.permissions`
   filled with **`key`** values from MCP **`appPermissions`**.
4. `app.zip` ready via `npm run pack` (`digit-app pack` from `@digit/lib-build`). Local
   `pack` only prepares the zip; MCP `publishApp` is what goes live.

There is no local Digit preview — pack + publish is the workflow.

To **change an already-published app from a fresh MCP workspace**, restore source
first with [update-digit-app](../../update-digit-app/SKILL.md), then continue
here. Digit’s in-app agent skips that restore (sandbox already has the tree).

## Workflow

```
1. apps                     → find appId
2. generateAppUploadLink    → id, uploadUrl, uploadFields
3. HTTP POST zip to uploadUrl (multipart; NOT via MCP)
4. publishApp               → appId + appUploadLinkId
5. appPublish               → poll until succeeded | failed
```

### 1. Resolve app id

Call MCP `apps`. Match by `name`. Use the returned `id` as `appId`.

If the app does not exist, stop and ask the user to create it in Digit.

### 2. Generate upload link

Call MCP `generateAppUploadLink`. Save:

- `id` (this is both `appUploadLinkId` and later `appPublishId`)
- `uploadUrl`
- `uploadFields` — array of `{ key, value }`

### 3. Upload the zip (out-of-band)

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

### 4. Publish

Call MCP `publishApp` with:

- `appId` — existing app id
- `appUploadLinkId` — `id` from step 2

Returns `state: queued` (or similar in-progress). Each upload publishes **once**; to retry,
start again at `generateAppUploadLink`.

### 5. Poll

Call MCP `appPublish` with:

- `appId`
- `appPublishId` — same id as `appUploadLinkId`

Poll until `state` is `succeeded` or `failed`. Intermediate states include `queued`,
`validating`, `deployingBackend`, `publishingBundle`. During `deployingBackend`, Digit
applies pending migrations — see [d1-migrations.md](d1-migrations.md). On failure, report
`error`, fix the bundle, and restart at step 2.

## Zip validation reminders

- `manifest.json` at the zip root and `frontend/index.js`
- When `manifest.backend` is set: `backend/index.js`
- `project/` with source, `SPEC.md`, and vendored `@digit/lib-*` (including `lib-build`)
- `manifest.permissions` are **`key`** values from **`appPermissions`**
