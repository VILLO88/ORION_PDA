#!/usr/bin/env node
/**
 * Build macOS .icns from media/logo.png.
 *
 * Pipeline:
 *  1. Pad logo.png (1536×1024) into a square 1536×1536 (transparent
 *     background, centered).
 *  2. Resize to the 10 sizes Apple expects in an .iconset folder.
 *  3. Invoke `iconutil -c icns` to package into build/icon.icns.
 *
 * Also emits build/icon.png (512×512 padded square) for the linux build.
 *
 * Run with: `node scripts/build-mac-icon.mjs`
 * Requires: macOS (uses `iconutil`), plus jimp from package.json.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Jimp from "jimp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "media", "logo.png");
const BUILD = join(ROOT, "build");
const ICONSET = join(BUILD, "icon.iconset");

// Sizes required by `iconutil` for a complete .icns.
const ICON_SIZES = [
  { name: "icon_16x16.png",       size: 16  },
  { name: "icon_16x16@2x.png",    size: 32  },
  { name: "icon_32x32.png",       size: 32  },
  { name: "icon_32x32@2x.png",    size: 64  },
  { name: "icon_128x128.png",     size: 128 },
  { name: "icon_128x128@2x.png",  size: 256 },
  { name: "icon_256x256.png",     size: 256 },
  { name: "icon_256x256@2x.png",  size: 512 },
  { name: "icon_512x512.png",     size: 512 },
  { name: "icon_512x512@2x.png",  size: 1024},
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function main() {
  if (!existsSync(SRC)) {
    throw new Error(`Source logo not found at ${SRC}`);
  }

  console.log(`[icon] loading ${SRC}`);
  const src = await Jimp.read(SRC);
  const w = src.bitmap.width;
  const h = src.bitmap.height;
  const side = Math.max(w, h);

  // Create a square transparent canvas and composite the logo centered.
  console.log(`[icon] padding ${w}×${h} → ${side}×${side} (transparent)`);
  const canvas = new Jimp(side, side, 0x00000000);
  canvas.composite(src, Math.floor((side - w) / 2), Math.floor((side - h) / 2));

  await mkdir(BUILD, { recursive: true });

  // Linux build wants a single icon.png (recommended 512×512 or 1024×1024).
  const linuxIcon = canvas.clone().resize(512, 512, Jimp.RESIZE_BICUBIC);
  await linuxIcon.writeAsync(join(BUILD, "icon.png"));
  console.log(`[icon] wrote build/icon.png (512×512)`);

  // Generate the iconset.
  await rm(ICONSET, { recursive: true, force: true });
  await mkdir(ICONSET, { recursive: true });
  for (const { name, size } of ICON_SIZES) {
    const out = canvas.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
    await out.writeAsync(join(ICONSET, name));
    console.log(`[icon] wrote ${name} (${size}×${size})`);
  }

  // Convert iconset → icns via macOS-native iconutil.
  console.log(`[icon] iconutil -c icns ${ICONSET}`);
  await run("iconutil", [
    "-c", "icns",
    ICONSET,
    "-o", join(BUILD, "icon.icns"),
  ]);

  console.log(`[icon] done → build/icon.icns + build/icon.png`);
}

main().catch((e) => {
  console.error(`[icon] FAILED: ${e.message}`);
  process.exit(1);
});
