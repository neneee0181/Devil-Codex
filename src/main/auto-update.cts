import { app, BrowserWindow, shell } from "electron";
import * as electronUpdater from "electron-updater";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// electron-updater is CommonJS with no default export, and `autoUpdater` is a
// lazy getter that instantiates the platform updater (needs the Electron app).
// Access it through a helper so it is only resolved after the app is ready.
function updater(): typeof electronUpdater.autoUpdater {
  return electronUpdater.autoUpdater;
}

const REPO = "neneee0181/Devil-Codex";

export type UpdateState =
  | { status: "available"; version: string }
  | { status: "none" }
  | { status: "downloading"; percent: number }
  | { status: "error"; message: string };

let latestVersion = "";
let latestUrl = "";
let latestMacZipUrl = ""; // direct download URL of the matching macOS .zip asset

// Compare dotted numeric versions ("0.1.2" > "0.1.1"). Non-numeric/extra parts
// are treated as 0 so a tag like "v0.2.0" beats "0.1.9".
function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map((n) => parseInt(n, 10) || 0);
  const l = local.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i += 1) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0);
  }
  return false;
}

interface ReleaseAsset { name: string; browser_download_url: string }

async function fetchLatestRelease(): Promise<{ version: string; url: string; macZip: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "devil-codex" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: string; html_url?: string; assets?: ReleaseAsset[] };
    const version = String(json.tag_name ?? "").replace(/^v/i, "");
    // Pick the macOS .zip matching this CPU (electron-builder ships a .zip the
    // app can swap in place; the .dmg needs mounting).
    const assets = json.assets ?? [];
    const macZip = assets.find((a) => a.name.endsWith(".zip") && a.name.includes(process.arch))?.browser_download_url
      ?? assets.find((a) => a.name.endsWith(".zip"))?.browser_download_url
      ?? "";
    return version ? { version, url: String(json.html_url ?? ""), macZip } : null;
  } catch {
    return null;
  }
}

async function checkLatest(): Promise<UpdateState> {
  const latest = await fetchLatestRelease();
  if (latest && isNewer(latest.version, app.getVersion())) {
    latestVersion = latest.version;
    latestUrl = latest.url;
    latestMacZipUrl = latest.macZip;
    return { status: "available", version: latest.version };
  }
  return { status: "none" };
}

// Update model: detection is a free GitHub API check on both platforms (no
// code signing needed). The renderer shows an "update" button when a newer
// release exists. Clicking it (installUpdate):
//   - Windows: electron-updater downloads + installs in place (works unsigned)
//   - macOS:   downloads the release .zip, strips quarantine, swaps the bundle
//              in place, and relaunches (installMacUpdate). Works unsigned; only
//              the very first install needs a one-time manual approval.
export function initAutoUpdate(getWindow: () => BrowserWindow | undefined): void {
  if (!app.isPackaged) return; // dev runs from source, nothing to update

  const au = updater();
  au.autoDownload = false;
  const send = (state: UpdateState) => getWindow()?.webContents.send("update:state", state);

  au.on("download-progress", (p) => send({ status: "downloading", percent: Math.round(p.percent) }));
  // isSilent=true → no installer wizard (one-click nsis), isForceRunAfter=true →
  // relaunch the app after installing, so Windows updates feel like macOS.
  au.on("update-downloaded", () => au.quitAndInstall(true, true));
  au.on("error", (err) => send({ status: "error", message: err?.message ?? String(err) }));

  const check = async () => send(await checkLatest());

  setTimeout(() => void check(), 8000);
  setInterval(() => void check(), 5 * 60 * 1000);
}

export async function checkForUpdatesNow(getWindow?: () => BrowserWindow | undefined): Promise<void> {
  if (!app.isPackaged) return;
  getWindow?.()?.webContents.send("update:state", await checkLatest());
}

export async function installUpdate(getWindow: () => BrowserWindow | undefined): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === "win32") {
    try {
      getWindow()?.webContents.send("update:state", { status: "downloading", percent: 0 } satisfies UpdateState);
      await updater().checkForUpdates();
      await updater().downloadUpdate(); // → "update-downloaded" → quitAndInstall
      return;
    } catch (err) {
      getWindow()?.webContents.send("update:state", {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies UpdateState);
    }
  }
  if (process.platform === "darwin") {
    try {
      await installMacUpdate(getWindow);
      return;
    } catch (err) {
      getWindow()?.webContents.send("update:state", {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies UpdateState);
      // fall through to opening the release page so the user can install manually
    }
  }
  // Fallback: open the release page for manual download.
  if (latestUrl) await shell.openExternal(latestUrl);
  else await shell.openExternal(`https://github.com/${REPO}/releases/latest`);
}

// macOS in-app update without a code-signing cert: download the release .zip,
// unzip it, strip quarantine, then hand a detached script that waits for this
// process to exit, swaps the new bundle into place, removes quarantine again,
// and relaunches. The first install is still manual (a quarantined app can't
// launch itself to fix it), but every update after that is one click.
async function installMacUpdate(getWindow: () => BrowserWindow | undefined): Promise<void> {
  if (!latestMacZipUrl) throw new Error("macOS 업데이트 자산(.zip)을 찾을 수 없습니다.");
  const send = (state: UpdateState) => getWindow()?.webContents.send("update:state", state);
  send({ status: "downloading", percent: 0 });

  // Current app bundle path: …/Devil Codex.app/Contents/MacOS/exe → up 3.
  const appBundle = join(app.getPath("exe"), "..", "..", "..");

  const res = await fetch(latestMacZipUrl, { headers: { "User-Agent": "devil-codex" } });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); received += value.length; if (total) send({ status: "downloading", percent: Math.round((received / total) * 100) }); }
  }

  const work = await mkdtemp(join(tmpdir(), "devil-update-"));
  const zipPath = join(work, "update.zip");
  await writeFile(zipPath, Buffer.concat(chunks));

  // Detached installer: unzip → strip quarantine → replace bundle → relaunch.
  const script = [
    `#!/bin/bash`,
    `set -e`,
    `sleep 1`,
    `ditto -x -k ${shq(zipPath)} ${shq(work)}`,
    `NEW=$(/usr/bin/find ${shq(work)} -maxdepth 1 -name "*.app" -print -quit)`,
    `if [ -z "$NEW" ]; then exit 1; fi`,
    `/usr/bin/xattr -dr com.apple.quarantine "$NEW" || true`,
    `/bin/rm -rf ${shq(appBundle)}`,
    `/usr/bin/ditto "$NEW" ${shq(appBundle)}`,
    `/usr/bin/xattr -dr com.apple.quarantine ${shq(appBundle)} || true`,
    `/usr/bin/open ${shq(appBundle)}`,
    `/bin/rm -rf ${shq(work)}`,
  ].join("\n");
  const scriptPath = join(work, "install.sh");
  await writeFile(scriptPath, script, { mode: 0o755 });

  const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => app.quit(), 300);
}

function shq(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
