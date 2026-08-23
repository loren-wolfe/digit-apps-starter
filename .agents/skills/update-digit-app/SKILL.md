---
name: update-digit-app
description: >-
  Update, change, edit, modify, iterate on, improve, extend, or fix an
  existing published Digit custom app over Digit MCP. The workspace is
  fresh and does not contain the live source — you MUST call the MCP `app`
  tool, GET `currentPublish.downloadUrl`, and unpack `project/` over
  `apps/<name>` (usually `apps/app`) before any code changes, then follow
  create-digit-app to pack and republish. Use when the user mentions an
  existing Digit app, already published app, live app, current publish,
  download app source, `currentPublish`, or wants changes to an app they
  already shipped. Do not use to create a brand-new app (create-digit-app)
  or inside Digit’s in-app agent (source is already in the sandbox).
---

# Update Digit App (MCP)

**MCP hosts only** (Cursor and similar). Each session starts with a fresh starter
tree, not the live app. Digit is the source of truth: download the current
publish, then change it.

**Do not use this skill in Digit’s in-app agent.** That sandbox already has the
published (or first-time) source under `apps/<name>`. Follow
[create-digit-app](../create-digit-app/SKILL.md) on the tree that is already
there — do not GET `currentPublish.downloadUrl` or replace `apps/`.

Build rules (stack, iframe, manifest, permissions, pack, publish) are **not**
duplicated here. After restore, follow create-digit-app end-to-end.

## When to use

- The app **already has a successful publish**
- You are on **external Digit MCP** in a workspace that does **not** already
  contain that publish’s `project/` tree
- The user wants to change, extend, or fix the live app

If there is no publish yet, this skill does not apply — create-digit-app
(scaffold `apps/app` / `new-app`) is enough.

## Workflow

```
1. apps                         → find appId
2. app                          → currentPublish.downloadUrl
3. HTTP GET that URL            → unzip (out-of-band; not via MCP)
4. Replace apps/<name>          → zip’s project/ tree
5. Follow create-digit-app      → edit, SPEC, pack, publishApp
```

### 1. Resolve the app

Call MCP **`apps`**. Match by `name`. Use the returned `id`.

If the app does not exist, stop — publishing never creates apps. The user must
create it in the Digit UI first, then use create-digit-app.

### 2. Download the live bundle

Call MCP **`app`** with that id.

- If `currentPublish.downloadUrl` is set, HTTP **GET** it (out-of-band). This is
  the same zip shape `npm run pack` produces (`manifest.json`, `frontend/`,
  optional `backend/`, required `project/`). Details:
  [create-digit-app publish reference](../create-digit-app/reference/publish.md).
- If `currentPublish` is missing, there is no live bundle. Stop this skill and
  use create-digit-app from the starter scaffold. Do not invent another fetch
  path.

Do not ask the user for a copy they saved locally.

### 3. Unpack `project/` only

Replace `apps/<name>` (usually `apps/app`) entirely with the zip’s **`project/`**
tree — source, `manifest.json`, `SPEC.md`, vendored `@digit/lib-*`.

Do **not** copy zip-root `frontend/` / `backend/` into the workspace; those are
pack outputs. Keep the starter repo shell (`packages/`, `examples/`, root
`package.json`).

Then `npm install` from the repo root if needed so `file:` workspace links work.

### 4. Edit and republish

Follow [create-digit-app](../create-digit-app/SKILL.md) from implementation
through pack and publish. Update `SPEC.md` with the new prompts before pack.

The next **MCP** session that changes this app starts this skill again
(download first). Do not reuse a leftover local tree from an earlier session.

## Distribution

This skill is bundled with create-digit-app in the **Digit Apps** Claude
plugin. The in-app starter zip intentionally does not include it.

Claude users install the plugin once from the
`Digit-Technologies/digit-apps-starter` marketplace. Do not instruct users to
download or copy this skill manually.
