import { desktopCapturer, screen as electronScreen } from "electron";
import { execFile } from "node:child_process";
import sharp from "sharp";
import {
  mouse,
  keyboard,
  Point,
  Button,
  Key,
  getWindows,
  getActiveWindow,
} from "@nut-tree-fork/nut-js";

// Devil-native Computer Use engine. Drives the whole OS desktop (not just our
// in-app browser) so any model can take screenshots and synthesize real
// mouse/keyboard input — independent of OpenAI's desktop-only SkyComputerUse
// host (which the CLI app-server can't spawn). Screen capture = Electron
// desktopCapturer; input synthesis = nut.js (libnut). Windows-first: no signing
// or permission wall there; mac needs TCC + signing (handled later).
//
// Coordinate contract: the screenshot stitches ALL monitors into one image
// spanning the full virtual desktop. Pixel (0,0) of that image = virtual origin
// (minX,minY) in nut's physical-pixel space. Every coordinate the model sees
// (screenshot, list_windows) is reported relative to that image; click/move add
// the origin back before calling nut.setPosition. In the common single-monitor
// (or primary-at-0,0) case the origin is (0,0) and it's all identity.

// Snappy: kill nut's default per-action delays.
mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 3000;
keyboard.config.autoDelayMs = 1;

const MOD_ALIASES: Record<string, keyof typeof Key> = {
  ctrl: "LeftControl", control: "LeftControl",
  shift: "LeftShift",
  alt: "LeftAlt", option: "LeftAlt",
  cmd: "LeftSuper", win: "LeftSuper", super: "LeftSuper", meta: "LeftSuper",
};

// Common single-key aliases → nut Key names. Anything else tries a direct
// case-insensitive match against the Key enum (Enter, Tab, F5, A, Num0, ...).
const KEY_ALIASES: Record<string, keyof typeof Key> = {
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape",
  tab: "Tab", space: "Space", spacebar: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};

function resolveKey(token: string): number | undefined {
  const t = token.trim();
  if (!t) return undefined;
  const low = t.toLowerCase();
  const alias = MOD_ALIASES[low] ?? KEY_ALIASES[low];
  if (alias) return Key[alias] as unknown as number;
  // Direct enum name match, case-insensitive (e.g. "F5", "a", "Num1").
  const direct = Object.keys(Key).find((k) => isNaN(Number(k)) && k.toLowerCase() === low);
  if (direct) return Key[direct as keyof typeof Key] as unknown as number;
  // Single printable char that is a letter/digit.
  if (t.length === 1) {
    const up = t.toUpperCase();
    if (up in Key) return Key[up as keyof typeof Key] as unknown as number;
  }
  return undefined;
}

export type WindowInfo = { title: string; x: number; y: number; width: number; height: number; active: boolean };

// nut.js getTitle() reads window titles via the ANSI Win32 API, which mangles
// non-Latin titles (Korean shows as "����"). Enumerate via GetWindowTextW
// (UTF-16) instead so titles survive — critical for non-vision models that
// target windows by name. Coordinates come back in physical virtual-desktop px
// (same space as nut), matching GetWindowRect. Falls back to nut.js on failure.
const WIN_ENUM_PS = `
$code = @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class DevilWin{
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 public struct RECT{public int Left,Top,Right,Bottom;}
 public static List<object> List(){
  var fg=GetForegroundWindow();var o=new List<object>();
  EnumWindows((h,l)=>{
   if(!IsWindowVisible(h))return true;
   int len=GetWindowTextLength(h);if(len==0)return true;
   var sb=new StringBuilder(len+2);GetWindowTextW(h,sb,sb.Capacity);
   RECT r;if(!GetWindowRect(h,out r))return true;
   int w=r.Right-r.Left,ht=r.Bottom-r.Top;if(w<=0||ht<=0)return true;
   o.Add(new{title=sb.ToString(),x=r.Left,y=r.Top,w=w,h=ht,active=(h==fg)});
   return true;
  },IntPtr.Zero);
  return o;
 }
}
"@
Add-Type -TypeDefinition $code -ErrorAction Stop
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
[DevilWin]::List() | ConvertTo-Json -Compress
`;

// System-wide idle time (ms since last real mouse/keyboard input) via
// GetLastInputInfo. This is the only reliable signal for "is the user actively
// driving the machine right now" — the active-window title alone can't tell a
// running game from an idle one the user walked away from. computer_use steals
// the shared physical cursor, so the model must not synthesize input while the
// user is mid-action; idle time gates that decision.
const IDLE_PS = `
$code = @"
using System;using System.Runtime.InteropServices;
public class DevilIdle{
 [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
 [DllImport("kernel32.dll")] public static extern uint GetTickCount();
 public static uint IdleMs(){var l=new LASTINPUTINFO();l.cbSize=(uint)Marshal.SizeOf(l);GetLastInputInfo(ref l);return GetTickCount()-l.dwTime;}
}
"@
Add-Type -TypeDefinition $code -ErrorAction Stop
[DevilIdle]::IdleMs()
`;

// Below this many ms of idle, treat the user as actively using the machine and
// forbid computer_use input synthesis. 3s: long enough to ignore the tiny gap
// between two of the user's own actions, short enough that the model doesn't
// grab the cursor while the user is still working.
const USER_ACTIVE_IDLE_MS = 3000;

function getUserIdleMs(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", IDLE_PS],
      { encoding: "utf8", timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const ms = Number(String(stdout).trim());
        resolve(Number.isFinite(ms) ? ms : null);
      },
    );
  });
}

function enumWindowsWin32(): Promise<WindowInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_ENUM_PS],
      { encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const raw = JSON.parse(stdout.trim() || "[]");
          const arr = Array.isArray(raw) ? raw : [raw];
          resolve(arr.map((w: Record<string, unknown>) => ({
            title: String(w.title ?? ""),
            x: Number(w.x ?? 0), y: Number(w.y ?? 0),
            width: Number(w.w ?? 0), height: Number(w.h ?? 0),
            active: Boolean(w.active),
          })));
        } catch (e) { reject(e); }
      },
    );
  });
}

export class DesktopControlManager {
  // Virtual-desktop origin (physical px) of the most recent screenshot. Model
  // coordinates are relative to that screenshot; we add this back before driving
  // the real cursor. Refreshed on every screenshot.
  private origin = { x: 0, y: 0 };

  // Stitched screenshot of ALL monitors as one PNG data URL spanning the full
  // virtual desktop, plus a short text caption. The caption makes the response
  // degrade gracefully across model capabilities: a vision model uses the pixels
  // (caption is cheap context); a text-only model (image stripped or
  // vision-sidecar described) still learns the layout + active window and falls
  // back to computer_list_windows for coordinates.
  async screenshot(): Promise<{ dataUrl: string; caption: string }> {
    const displays = electronScreen.getAllDisplays().map((d) => ({
      id: String(d.id),
      x: Math.round(d.bounds.x * d.scaleFactor),
      y: Math.round(d.bounds.y * d.scaleFactor),
      w: Math.round(d.bounds.width * d.scaleFactor),
      h: Math.round(d.bounds.height * d.scaleFactor),
      primary: d.id === electronScreen.getPrimaryDisplay().id,
    }));
    const minX = Math.min(...displays.map((d) => d.x));
    const minY = Math.min(...displays.map((d) => d.y));
    const maxX = Math.max(...displays.map((d) => d.x + d.w));
    const maxY = Math.max(...displays.map((d) => d.y + d.h));
    const W = maxX - minX;
    const H = maxY - minY;
    this.origin = { x: minX, y: minY };

    const maxW = Math.max(...displays.map((d) => d.w));
    const maxH = Math.max(...displays.map((d) => d.h));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: maxW, height: maxH },
    });

    let dataUrl = "";
    try {
      const overlays: sharp.OverlayOptions[] = [];
      for (const d of displays) {
        const src = sources.find((s) => String(s.display_id) === d.id);
        if (!src || src.thumbnail.isEmpty()) continue;
        const buf = await sharp(src.thumbnail.toPNG()).resize(d.w, d.h, { fit: "fill" }).png().toBuffer();
        overlays.push({ input: buf, left: d.x - minX, top: d.y - minY });
      }
      const canvas = sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } });
      const out = await canvas.composite(overlays).png().toBuffer();
      dataUrl = `data:image/png;base64,${out.toString("base64")}`;
    } catch {
      // Fallback: primary display only, so a sharp failure never blinds the model.
      const primary = sources.find((s) => displays.find((d) => d.primary && d.id === String(s.display_id))) ?? sources[0];
      if (primary && !primary.thumbnail.isEmpty()) dataUrl = primary.thumbnail.toDataURL();
    }

    let active = "";
    let count = 0;
    let idleMs: number | null = null;
    // Windows enumeration and idle probe are independent PowerShell spawns; run
    // them in parallel so the caption's extra signal costs no serial latency.
    const [winsResult, idleResult] = await Promise.allSettled([this.listWindows(), getUserIdleMs()]);
    if (winsResult.status === "fulfilled") {
      count = winsResult.value.length;
      active = winsResult.value.find((win) => win.active)?.title ?? "";
    }
    if (idleResult.status === "fulfilled") idleMs = idleResult.value;
    // Bake the 3s threshold into the caption as a directive, not a raw number,
    // so the model acts on it regardless of whether it remembers the policy.
    let idlePhrase = "";
    if (idleMs !== null) {
      const idleSec = Math.floor(idleMs / 1000);
      idlePhrase = idleMs < USER_ACTIVE_IDLE_MS
        ? ` · 유저 입력중(유휴 ${idleMs}ms) — 실제 마우스/키보드 뺏지 말 것, 스크립트/API 경로 사용`
        : ` · 유저 유휴 ${idleSec}초(입력 없음) — 조작 전 1회 안내 후 진행 가능`;
    }
    const caption =
      `가상 데스크톱 ${W}x${H}, 모니터 ${displays.length}개 (좌표는 이 이미지 기준)` +
      (active ? ` · 활성 창: ${active}` : "") +
      (count ? ` · 열린 창 ${count}개 (정확한 위치는 computer_list_windows)` : "") +
      idlePhrase;
    return { dataUrl, caption };
  }

  async move(x: number, y: number): Promise<void> {
    await mouse.setPosition(new Point(this.origin.x + Math.round(x), this.origin.y + Math.round(y)));
  }

  async click(opts: { x?: number; y?: number; button?: string; double?: boolean }): Promise<boolean> {
    if (typeof opts.x === "number" && typeof opts.y === "number") {
      await mouse.setPosition(new Point(this.origin.x + Math.round(opts.x), this.origin.y + Math.round(opts.y)));
    }
    const button =
      opts.button === "right" ? Button.RIGHT : opts.button === "middle" ? Button.MIDDLE : Button.LEFT;
    if (opts.double) await mouse.doubleClick(button);
    else await mouse.click(button);
    return true;
  }

  async type(text: string): Promise<void> {
    if (text) await keyboard.type(text);
  }

  // Accepts "Enter", "ctrl+c", "ctrl+shift+t", "F5". Modifiers held while the
  // final key is pressed, then released in reverse.
  async key(combo: string): Promise<void> {
    const tokens = String(combo).split("+").map((t) => t.trim()).filter(Boolean);
    const codes = tokens.map(resolveKey);
    if (codes.some((c) => c === undefined)) throw new Error(`unknown key: ${combo}`);
    const keys = codes as number[];
    for (const k of keys) await keyboard.pressKey(k as unknown as Key);
    for (const k of [...keys].reverse()) await keyboard.releaseKey(k as unknown as Key);
  }

  async scroll(dy: number): Promise<void> {
    const amount = Math.abs(Math.round(dy));
    if (dy >= 0) await mouse.scrollDown(amount);
    else await mouse.scrollUp(amount);
  }

  async listWindows(): Promise<WindowInfo[]> {
    // Win32 UTF-16 enumeration first (correct non-Latin titles); coords reported
    // relative to the last screenshot's virtual origin so they line up with the
    // stitched image.
    try {
      const wins = await enumWindowsWin32();
      return wins.map((w) => ({ ...w, x: w.x - this.origin.x, y: w.y - this.origin.y }));
    } catch { /* fall back to nut.js below */ }
    const out: WindowInfo[] = [];
    let activeTitle = "";
    try { activeTitle = await (await getActiveWindow()).getTitle(); } catch { /* none */ }
    let wins: Awaited<ReturnType<typeof getWindows>> = [];
    try { wins = await getWindows(); } catch { return out; }
    for (const win of wins) {
      try {
        const title = await win.getTitle();
        if (!title) continue;
        const r = await win.getRegion();
        out.push({ title, x: r.left - this.origin.x, y: r.top - this.origin.y, width: r.width, height: r.height, active: title === activeTitle });
      } catch { /* skip windows we can't query */ }
    }
    return out;
  }
}
