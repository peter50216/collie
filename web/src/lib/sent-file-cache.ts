import { fetchSentFile } from "@/lib/api";

// ── THE BYTES OF A SENT FILE, KEPT FOR THE PAGE (ADR 0175) ───────────────────────────────────────
//
// ONE OBJECT URL PER FILE, FOR THE PAGE, BOUNDED BY BYTES. A chat body mounts again on every pane
// switch, so a file the page already fetched is kept for the next mount. The table drops the oldest
// files once their sizes pass the budget, and revokes their URLs.

const BUDGET_BYTES = 256 * 1024 * 1024;

interface Held {
  url: string;
  bytes: number;
}

const held = new Map<string, Held>();
const pending = new Map<string, Promise<Held>>();

function keep(path: string, entry: Held): void {
  held.set(path, entry);
  let total = 0;
  for (const e of held.values()) total += e.bytes;
  for (const [key, e] of held) {
    if (total <= BUDGET_BYTES || key === path) break;
    held.delete(key);
    URL.revokeObjectURL(e.url);
    total -= e.bytes;
  }
}

/** The object URL of one sent file, fetched once for the page. Rejects when the bridge refuses. */
export function loadSentFile(path: string): Promise<Held> {
  const hit = held.get(path);
  if (hit !== undefined) return Promise.resolve(hit);
  const inFlight = pending.get(path);
  if (inFlight !== undefined) return inFlight;
  const next = fetchSentFile(path)
    .then((blob) => {
      const entry = { url: URL.createObjectURL(blob), bytes: blob.size };
      keep(path, entry);
      return entry;
    })
    .finally(() => pending.delete(path));
  pending.set(path, next);
  return next;
}

/** The object URL of a file this page already fetched, or `undefined`. */
export function heldSentFile(path: string): Held | undefined {
  return held.get(path);
}

/** Forget every file and revoke its URL. For tests: the table is module-scoped. */
export function __resetSentFiles(): void {
  for (const e of held.values()) URL.revokeObjectURL(e.url);
  held.clear();
  pending.clear();
}
