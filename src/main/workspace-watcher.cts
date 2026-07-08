import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

// Directory names whose contents change constantly and are never shown in the
// workspace file tree; watching them only produces noise and wakeups.
const IGNORED = new Set([".git", "node_modules", "dist", "dist-electron", "dist-mobile"]);
const DEBOUNCE_MS = 150;

type Emit = (cwd: string) => void;

interface Entry {
  watcher: FSWatcher;
  refs: number;
  timer: NodeJS.Timeout | null;
}

// Ref-counted recursive fs watcher keyed by resolved workspace root. Multiple
// renderer panels can watch the same workspace; the underlying fs.watch is
// created once and torn down when the last subscriber leaves. Change bursts are
// debounced into a single "this workspace changed" ping — the renderer decides
// what to reload (open dirs / open file).
export class WorkspaceWatcher {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly emit: Emit) {}

  watch(cwd: string): void {
    const root = resolve(cwd);
    const existing = this.entries.get(root);
    if (existing) { existing.refs += 1; return; }
    let watcher: FSWatcher;
    try {
      watcher = watch(root, { recursive: true, persistent: false });
    } catch {
      // Recursive watch is unsupported on some platforms (e.g. Linux); fall back
      // to a non-recursive watch of the root so at least top-level changes show.
      try { watcher = watch(root, { persistent: false }); }
      catch { return; }
    }
    const entry: Entry = { watcher, refs: 1, timer: null };
    watcher.on("error", () => this.unwatch(cwd));
    watcher.on("change", (_type, filename) => {
      const name = typeof filename === "string" ? filename : filename?.toString();
      if (name && name.split(/[\\/]/).some((part) => IGNORED.has(part))) return;
      if (entry.timer) return;
      entry.timer = setTimeout(() => { entry.timer = null; this.emit(root); }, DEBOUNCE_MS);
    });
    this.entries.set(root, entry);
  }

  unwatch(cwd: string): void {
    const root = resolve(cwd);
    const entry = this.entries.get(root);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.entries.delete(root);
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.close();
    }
    this.entries.clear();
  }
}
