#!/usr/bin/env node
// Render assets/icon.svg into platform icon assets:
//   build/icon.png  (1024, electron-builder source + Linux/window icon)
//   build/icon.icns (macOS, via iconutil)
//   build/icon.ico  (Windows, multi-size via sharp+ico packing)
const sharp = require("sharp");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const svg = path.join(root, "assets", "icon.svg");
const buildDir = path.join(root, "build");
const iconset = path.join(buildDir, "icon.iconset");

async function png(size, out) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  // Master PNG for electron-builder + window icon.
  await png(1024, path.join(buildDir, "icon.png"));

  // macOS .icns via iconutil (Retina pairs).
  const macSizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of macSizes) {
    const base = s === 1024 ? "icon_512x512@2x" : `icon_${s}x${s}`;
    await png(s, path.join(iconset, `${base}.png`));
    if (s <= 512) await png(s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
  }
  try {
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(buildDir, "icon.icns")]);
    console.log("icon.icns built");
  } catch (e) {
    console.warn("iconutil failed (mac only):", e.message);
  }

  // Windows .ico (16-256) packed manually from PNGs.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(
    icoSizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()),
  );
  fs.writeFileSync(path.join(buildDir, "icon.ico"), buildIco(buffers, icoSizes));
  console.log("icon.ico built");
  console.log("icons done →", buildDir);
}

// Minimal ICO container that embeds PNG-compressed entries (Vista+).
function buildIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  pngBuffers.forEach((buf, i) => {
    const s = sizes[i];
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...pngBuffers]);
}

main().catch((e) => { console.error(e); process.exit(1); });
