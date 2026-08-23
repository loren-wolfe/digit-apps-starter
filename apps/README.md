# apps/

Digit apps live here, one folder per app. They are npm workspaces of this clone, which is
what lets `digit-app pack` find its build toolchain.

The curated starter archive includes `apps/app/`, a packable source scaffold generated
from the frontend-only `examples/hello-world`. Use that scaffold only when the app has
never been published. External MCP restoring a live app GETs `currentPublish.downloadUrl`
from MCP `app` and replaces `apps/app/` with that archive's `project/` tree. Digit’s
in-app agent (`.digit/in-app-agent` or `DIGIT_IN_APP_AGENT`) already has that tree
installed here — do not re-download.

```
npm run pack -w apps/app      # pack the starter archive's default app
npm run new-app -- my-app     # scaffold apps/my-app from examples/full-featured
npm run pack -w apps/my-app   # build frontend/ (+ backend/) and write app.zip
```

Keep `src/`, `manifest.json`, `SPEC.md`, and root config in this workspace. The built
`frontend/` / `backend/` folders and `app.zip` are gitignored. This upstream starter does
not accept PRs — local commits are optional for your own clone only.
