/**
 * Public API for Digit custom apps.
 * Only import from this package root — other files are implementation details.
 */

// Theme
export { DigitThemeProvider } from "./theme"

// Host / proxy types (importing this package augments Window)
export type { DigitHost, DigitHostDownloadOptions, DigitHostSettings } from "./globals"
import "./globals"

// Errors
export { AppErrorAlert } from "./errors"
export type { AppError } from "./errors"

// Digit API + app backend (hooks only — imperative fetch helpers are internal)
export {
  useDigitApiQuery,
  useDigitApiMutation,
  useBackendQuery,
  useBackendMutation,
} from "./api"
export type { DigitResult } from "./api"
