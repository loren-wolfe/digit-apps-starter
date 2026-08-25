# Iframe constraints

Digit apps run inside a **sandboxed iframe** in the Digit host. Design and implement
only what that environment allows. Do not add downloads, new tabs, browser dialogs,
device APIs, or anything that escapes the frame.

## Host iframe settings

These are the effective host attributes (do not assume looser permissions):

```
sandbox="allow-scripts allow-same-origin allow-forms"
```

Permissions Policy (`allow`) sets every listed feature to `'none'`:

accelerometer, autoplay, camera, clipboard-read, display-capture,
encrypted-media, fullscreen, gamepad, geolocation, gyroscope, magnetometer,
microphone, midi, payment, picture-in-picture, publickey-credentials-get,
screen-wake-lock, usb, xr-spatial-tracking.

`clipboard-write` is allowed: `navigator.clipboard.writeText` works inside a user
gesture (a click handler), so "Copy" buttons are fine. `clipboard-read` is not.

Everything else the sandbox can gate (downloads, popups, modals, top navigation,
etc.) is **off**. `allow-forms` only means React `onSubmit` handlers fire — a
native form submission (no `preventDefault`) navigates the frame to an error, so
always intercept and post JSON.

## Do not use (blocked)

| Pattern | Why |
| --- | --- |
| Direct file downloads (`<a download>`, blob download links) | No `allow-downloads` — use `DigitHost.download` (below) |
| `window.open`, `target="_blank"`, “Open in new tab” | No `allow-popups` |
| `alert` / `confirm` / `prompt` | No `allow-modals` |
| Native HTML form submission (no `preventDefault`) | Navigates the frame to a proxy error — always `onSubmit` + `preventDefault` + fetch/hooks |
| Navigating the parent Digit page (`top.location`, etc.) | No top-navigation flags |
| Fullscreen API | `fullscreen 'none'` |
| Reading the clipboard (`navigator.clipboard.read*`, paste APIs) | `clipboard-read 'none'` |
| Camera, mic, geolocation, USB, WebAuthn get, payment, PiP, wake lock, etc. | Permissions Policy `'none'` |
| Autoplay media | `autoplay 'none'` |

Do not build UI that depends on these working, and do not “fall back” to a blocked
API after a failed attempt.

## Do use (works in-frame)

- SPA navigation and in-iframe links (same document / React Router-style)
- MUI **Dialog**, Drawer, Menu, Popover, Snackbar — these are in-page overlays, not
  browser `window.alert`-style modals
- Digit proxies and hooks (`useDigitApiQuery`, `useBackendQuery`, …)
- Forms with `onSubmit` + `preventDefault`, posting JSON via fetch/hooks
- “Copy” buttons via `navigator.clipboard.writeText(...)` inside a click handler
- File exports via `DigitHost.download({ filename, contentType, data })` — the host
  page saves the file. `contentType` must be `text/csv`, `application/json`,
  `text/plain`, `application/pdf` or
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (.xlsx only —
  legacy `.xls` and macro-enabled types are refused);
  `data` is a string or `ArrayBuffer`/`Uint8Array`,
  10MB max; the matching extension is appended automatically. Throws with a reason
  on invalid input, so surface errors from it like any other failure

## Agent checklist

Before shipping UI:

1. File exports only via `DigitHost.download` — never `<a download>` / blob links
2. No new-tab / popup / `window.open` flows
3. No `alert` / `confirm` / `prompt` — use MUI Dialog / `AppErrorAlert` instead
4. No camera, mic, geo, clipboard-read, fullscreen, or other device APIs
5. Every form submit handler calls `preventDefault`
5. Keep all interaction inside the app iframe
