#!/usr/bin/env node
/**
 * One-click installer for Pi in Chrome:
 * 1. Registers Native Messaging Host manifests for all Chromium browsers.
 * 2. Displays the standalone unpacked Chrome extension path and quick setup steps.
 */

import * as child_process from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getChromeExtensionPath, installChromeNativeHost } from "../src/native-host.ts";
import { PI_CHROME_EXTENSION_ID } from "../src/protocol.ts";

async function main() {
	console.log("\n=======================================================");
	console.log("  🚀 Pi in Chrome — Unrestricted Browser Bridge Setup");
	console.log("=======================================================\n");

	try {
		const res = await installChromeNativeHost({ force: true });
		console.log("✅ Native Messaging Host installed successfully:");
		console.log(`   Wrapper script: ${res.wrapperPath}`);
		console.log(`   Manifests registered for ${res.installedManifests.length} browser profiles:`);
		for (const m of res.installedManifests) {
			console.log(`     • ${m}`);
		}
	} catch (err) {
		console.error("❌ Failed to install Native Host:", err.message);
	}

	const extPath = getChromeExtensionPath();
	console.log("\n-------------------------------------------------------");
	console.log("📦 Standalone Unrestricted Chrome Extension:");
	console.log(`   Extension ID : ${PI_CHROME_EXTENSION_ID}`);
	console.log(`   Folder Path  : ${extPath}`);
	console.log("-------------------------------------------------------\n");

	console.log("👉 How to load in Google Chrome (Takes 10 seconds):");
	console.log("   1. Open: chrome://extensions");
	console.log("   2. Turn on 'Developer mode' (toggle switch in the top right)");
	console.log("   3. Click 'Load unpacked' (button in the top left)");
	console.log(`   4. Select the folder:`);
	console.log(`      ${extPath}\n`);

	console.log("✨ Features & Unrestricted Capabilities:");
	console.log("   • Zero Anthropic cloud url_hash_check calls (works on localhost, intranet, any site)");
	console.log("   • Zero 600x600 permission popups or 30s timeouts");
	console.log("   • Zero OAuth login or API key required inside the extension");
	console.log("   • Inspect and automate both dedicated Pi tab groups and any open Chrome tab");
	console.log("   • Full 20-tool execution suite (DOM accessibility tree, CDP computer, JS, console, network, screenshots)\n");

	if (process.argv.includes("--open") && process.platform === "darwin") {
		try {
			child_process.spawn("open", ["-R", extPath], { detached: true, stdio: "ignore" });
			child_process.spawn("open", ["-a", "Google Chrome", "chrome://extensions"], { detached: true, stdio: "ignore" });
		} catch {}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
