type HostInvoke = {
  invoke?: (method: string, params: Record<string, string>) => Promise<unknown> | void;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` looks like a real Digit record id — some lines fall back to a raw,
 * non-Digit identifier (e.g. an unresolved WooCommerce alias) that must not be linkified. */
export function isDigitId(id: string | null | undefined): id is string {
  return Boolean(id && UUID_RE.test(id));
}

function host(): HostInvoke | undefined {
  return window.DigitHost as HostInvoke | undefined;
}

/** Open a Digit record on its own page. Replaces the whole page, so this app is unmounted —
 * only call it from a user action, never on load. */
export function openRecord(to: 'salesOrder', id: string) {
  const invoke = host()?.invoke;
  if (!invoke) return;
  void invoke('navigate', { to, id });
}

/** Open an item in the host modal so this app stays mounted. */
export function openItem(id: string) {
  const invoke = host()?.invoke;
  if (!invoke) return;
  void invoke('openModal', { modal: 'item', id });
}
