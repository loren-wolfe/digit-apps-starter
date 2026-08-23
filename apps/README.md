# apps/

Digit apps live here, one folder per app. They are npm workspaces of this clone, which is
what lets `digit-app pack` find its build toolchain.

The curated starter archive includes `apps/app/`, a packable source scaffold generated
from the frontend-only `examples/hello-world`. Use that for a new app. To change a
published app from a fresh MCP workspace, follow **update-digit-app** (replace
`apps/app/` with the live zip’s `project/` tree). Digit’s in-app agent already has
that tree here.

```
npm run pack -w apps/app      # pack the starter archive's default app
npm run new-app -- my-app     # scaffold apps/my-app from examples/full-featured
npm run pack -w apps/my-app   # build frontend/ (+ backend/) and write app.zip
```

Keep `src/`, `manifest.json`, `SPEC.md`, and root config in this workspace. The built
`frontend/` / `backend/` folders and `app.zip` are gitignored. This upstream starter does
not accept PRs — local commits are optional for your own clone only.
