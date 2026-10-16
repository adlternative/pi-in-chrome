#!/usr/bin/env node

/**
 * Pi in Chrome Extension Build Script
 *
 * Bundles TypeScript sources from `extension-src/` into a clean, unhashed,
 * self-contained Chrome MV3 extension in `chrome-extension/`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXT_SRC = path.join(ROOT, "extension-src");
const EXT_DIST = path.join(ROOT, "chrome-extension");
const DOWNLOADS_DIST = "/Users/adl/Downloads/pi-chrome";

console.log("🔨 Building Pi in Chrome MV3 Extension...");

// 1. Bundle Service Worker
console.log("  📦 Bundling background service worker...");
execSync(
  `npx esbuild "${path.join(EXT_SRC, "background/service-worker.ts")}" ` +
  `--bundle --format=esm --target=chrome116 ` +
  `--outfile="${path.join(EXT_DIST, "service-worker.js")}"`,
  { stdio: "inherit", cwd: ROOT }
);

// 2. Format & copy content scripts
console.log("  📄 Copying content scripts...");
fs.copyFileSync(
  path.join(EXT_SRC, "content/accessibility-tree.ts"),
  path.join(EXT_DIST, "accessibility-tree.js")
);
fs.copyFileSync(
  path.join(EXT_SRC, "content/agent-visual-indicator.ts"),
  path.join(EXT_DIST, "agent-visual-indicator.js")
);

// 3. Sync to external unpacked location if it exists
if (fs.existsSync(DOWNLOADS_DIST)) {
  console.log(`  🔄 Syncing to ${DOWNLOADS_DIST}...`);
  const files = fs.readdirSync(EXT_DIST);
  for (const file of files) {
    const srcPath = path.join(EXT_DIST, file);
    const destPath = path.join(DOWNLOADS_DIST, file);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log("✅ Extension build completed successfully!\n");
