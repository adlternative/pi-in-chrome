/**
 * Pi Coding Agent Extension: Claude in Chrome (`pi-claude-in-chrome`)
 *
 * Full replication of Claude Code's built-in browser integration (`claude-in-chrome`),
 * reverse-engineered using REA (`rea-agents`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	detectChromeExtensionStatus,
	getChromeExtensionPath,
	installChromeNativeHost,
} from "./native-host.ts";
import { BASE_CHROME_PROMPT } from "./prompt.ts";
import {
	CHROME_INSTALL_URL,
	CHROME_PERMISSIONS_URL,
	CHROME_RECONNECT_URL,
	CLAUDE_CHROME_EXTENSION_ID,
	getAvailableSocketPaths,
	getSocketDirPath,
	PI_CHROME_EXTENSION_ID,
	PI_NATIVE_HOST_NAME,
	SocketPool,
} from "./protocol.ts";
import {
	CHROME_TOOL_PREFIX,
	ChromeExecutionManager,
	createChromeBrowserTools,
} from "./tools.ts";

const SUBCOMMANDS = [
	{ value: "status", label: "status", description: "Show Chrome extension, Native Host, and socket pool status" },
	{ value: "setup", label: "setup", description: "One-click install Native Host and show unpacked Chrome extension path" },
	{ value: "extension", label: "extension", description: "Display standalone unrestricted Chrome extension path and installation instructions" },
	{ value: "tabs", label: "tabs", description: "List active browser tabs in the MCP tab group" },
	{ value: "reconnect", label: "reconnect", description: "Refresh and reconnect to Chrome Native Host sockets" },
	{ value: "install-host", label: "install-host", description: "Install Native Messaging Host manifest for Chrome/Brave/Arc/Edge" },
	{ value: "close-tabs", label: "close-tabs", description: "Close empty MCP tab groups" },
	{ value: "enable", label: "enable", description: "Activate all Claude in Chrome tools for this session" },
	{ value: "disable", label: "disable", description: "Deactivate Claude in Chrome tools for this session" },
] as const;

export default function claudeInChromeExtension(pi: ExtensionAPI): void {
	const pool = new SocketPool();
	const manager = new ChromeExecutionManager(pool);
	const tools = createChromeBrowserTools(manager);
	const allChromeToolNames = tools.map((t) => t.name);

	let chromeEnabled = true;

	// Register CLI flags (`--chrome` / `--no-chrome`, matching Claude Code)
	pi.registerFlag("chrome", {
		description: "Enable Claude in Chrome browser integration",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-chrome", {
		description: "Disable Claude in Chrome browser integration",
		type: "boolean",
		default: false,
	});

	// Register all 20 `mcp__claude-in-chrome__*` tools
	for (const tool of tools) {
		pi.registerTool(tool);
	}

	async function updateFooterStatus(ctx: ExtensionContext): Promise<void> {
		if (!chromeEnabled) {
			ctx.ui.setStatus("chrome", undefined);
			return;
		}
		const connected = await pool.ensureConnected();
		const sockets = pool.getConnectedSockets();
		if (connected && sockets.length > 0) {
			ctx.ui.setStatus(
				"chrome",
				ctx.ui.theme.fg("success", `🌐 chrome(${sockets.length})`),
			);
		} else {
			ctx.ui.setStatus("chrome", ctx.ui.theme.fg("warning", "🌐 chrome(offline)"));
		}
	}

	function setChromeToolsActive(enable: boolean): void {
		chromeEnabled = enable;
		const currentActive = new Set(pi.getActiveTools());
		if (enable) {
			for (const name of allChromeToolNames) {
				currentActive.add(name);
			}
		} else {
			for (const name of allChromeToolNames) {
				currentActive.delete(name);
			}
		}
		pi.setActiveTools(Array.from(currentActive));
	}

	// Listen for notifications from Chrome Extension
	pool.setNotificationHandler((notification) => {
		pi.events.emit("chrome:notification", notification);
	});

	// Session startup: check CLI flags, auto-install native host if missing, and connect socket pool
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("no-chrome") === true || pi.getFlag("chrome") === false) {
			setChromeToolsActive(false);
			return;
		}

		try {
			const status = await detectChromeExtensionStatus();
			if (status.nativeHostManifests.length === 0) {
				await installChromeNativeHost({ force: false });
			}
		} catch {
			// Non-fatal
		}

		await updateFooterStatus(ctx);
	});

	// Inject Claude in Chrome system prompt guidelines when Chrome tools are active
	// Replicates `VKe` in `chunk-darxmw8c.js`
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!chromeEnabled) return;
		const activeTools = pi.getActiveTools();
		const hasChromeToolActive = activeTools.some((t) => t.startsWith(CHROME_TOOL_PREFIX));
		if (!hasChromeToolActive) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${BASE_CHROME_PROMPT}`,
		};
	});

	// Session switch / shutdown: close empty MCP tab groups (`chunk-7m0pkhzw.js`) and disconnect sockets
	pi.on("session_before_switch", async () => {
		await manager.closeEmptyTabGroups();
	});

	pi.on("session_shutdown", async () => {
		await manager.closeEmptyTabGroups();
		pool.disconnect();
	});

	// Register `/chrome` command (replicating `/chrome` in `chunk-hp175n4t.js`)
	pi.registerCommand("chrome", {
		description: "Manage Claude in Chrome browser integration (status, tabs, reconnect, install-host, enable, disable)",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trim().toLowerCase();
			return SUBCOMMANDS.filter((s) => s.value.startsWith(trimmed)).map((s) => ({
				value: s.value,
				label: s.label,
				description: s.description,
			}));
		},
		handler: async (args, ctx) => {
			let sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "";

			if (!sub && ctx.hasUI) {
				const connected = await pool.ensureConnected();
				const sockets = pool.getConnectedSockets();
				const statusLabel = connected
					? `Connected (${sockets.length} socket${sockets.length === 1 ? "" : "s"})`
					: "Disconnected";

				const choice = await ctx.ui.select(`Claude in Chrome — ${statusLabel}`, [
					"status — Show detailed connection & extension diagnostics",
					"unlock — Fix 'Could not verify this site's safety category' (API-Key Mode bypass)",
					"tabs — List open tabs in the MCP tab group",
					"reconnect — Re-scan and reconnect to Chrome Native Host sockets",
					"install-host — Install/repair Native Messaging Host manifests",
					"close-tabs — Close empty MCP tab groups",
					chromeEnabled
						? "disable — Disable Claude in Chrome tools in this session"
						: "enable — Enable Claude in Chrome tools in this session",
				]);
				if (!choice) return;
				sub = choice.split(" — ")[0].trim();
			}

			if (sub === "setup" || sub === "extension") {
				const res = await installChromeNativeHost({ force: false });
				const extPath = getChromeExtensionPath();
				const isMac = process.platform === "darwin";

				const setupGuide = [
					"## 🚀 Pi in Chrome (Unrestricted Browser Bridge) Setup",
					"",
					"✅ **Native Messaging Host manifests registered successfully**:",
					...res.installedManifests.map((m) => `  - \`${m}\``),
					"",
					"### 📦 Load Unpacked Extension into Chrome (One-Time, 10s):",
					"1. Open `chrome://extensions` in Google Chrome (or Edge / Brave / Arc).",
					"2. Enable **'Developer mode'** (toggle in the top-right corner).",
					"3. Click **'Load unpacked'** (top-left).",
					`4. Select this folder:`,
					`   \`${extPath}\``,
					"",
					"> **Note**: This standalone extension has **Zero restrictions** — no Anthropic safety checks, no `url_hash_check`, no permission popups, and no login required!",
					isMac ? "\n*Run `open -R \"" + extPath + "\"` in your terminal to reveal this folder in Finder.*" : "",
				].join("\n");

				pi.sendMessage({
					customType: "chrome-setup",
					content: setupGuide,
					display: true,
				});
				return;
			}

			if (!sub || sub === "status") {
				const extStatus = await detectChromeExtensionStatus();
				const socketDir = getSocketDirPath("pi");
				const claudeSocketDir = getSocketDirPath("claude");
				const availableSockets = getAvailableSocketPaths();
				await pool.ensureConnected();
				const connectedSockets = pool.getConnectedSockets();
				const routes = pool.getTabRoutes();
				const extPath = getChromeExtensionPath();

				const lines: string[] = [
					"## 🌐 Pi & Claude in Chrome Status",
					`- **Enabled in Session**: ${chromeEnabled ? "Yes" : "No"}`,
					`- **Pi Extension ID**: \`${PI_CHROME_EXTENSION_ID}\``,
					`- **Claude Extension ID**: \`${CLAUDE_CHROME_EXTENSION_ID}\``,
					`- **Standalone Extension Path**: \`${extPath}\``,
					`- **Extension Installed**: ${extStatus.installed ? `Yes (${extStatus.browsers.map((b) => `${b.browser} [${b.profile}] v${b.version}`).join(", ")})` : `No (Load unpacked from \`${extPath}\`)`}`,
					`- **Native Host Manifests**: ${extStatus.nativeHostManifests.length > 0 ? extStatus.nativeHostManifests.map((m) => `${m.browser} -> \`${m.wrapperPath}\``).join(", ") : "None (run `/chrome setup`)"}`,
					`- **Socket Pool Directories**: \`${socketDir}\`, \`${claudeSocketDir}\``,
					`- **Discovered Sockets**: ${availableSockets.length > 0 ? availableSockets.map((s) => `\`${s}\``).join(", ") : "None"}`,
					`- **Connected Sockets**: ${connectedSockets.length > 0 ? connectedSockets.map((s) => `\`${s}\``).join(", ") : "None"}`,
					`- **Routed Tabs**: ${routes.size}`,
					`- **Setup Command**: run \`/chrome setup\` to auto-install Native Host manifests`,
				];

				await updateFooterStatus(ctx);
				pi.sendMessage({
					customType: "chrome-status",
					content: lines.join("\n"),
					display: true,
				});
				return;
			}

			if (sub === "tabs") {
				const ok = await pool.ensureConnected();
				if (!ok) {
					ctx.ui.notify("Chrome extension is not connected. Run `/chrome status` or visit https://clau.de/chrome/reconnect", "warning");
					return;
				}
				try {
					const resp = await pool.callTool("tabs_context_mcp", { createIfEmpty: false }, { timeoutMs: 5000 });
					const content = resp.result?.content;
					const textBlock = Array.isArray(content)
						? content.find((b) => b.type === "text" && typeof b.text === "string")?.text
						: undefined;

					pi.sendMessage({
						customType: "chrome-tabs",
						content: textBlock
							? `## 🌐 Chrome MCP Tabs\n\`\`\`json\n${textBlock}\n\`\`\``
							: "No tabs returned from Chrome extension.",
						display: true,
					});
				} catch (err: any) {
					ctx.ui.notify(`Failed to query tabs: ${err.message}`, "error");
				}
				return;
			}

			if (sub === "reconnect") {
				pool.disconnect();
				const ok = await pool.ensureConnected();
				await updateFooterStatus(ctx);
				if (ok) {
					const count = pool.getConnectedSockets().length;
					ctx.ui.notify(`Reconnected to Chrome (${count} socket${count === 1 ? "" : "s"} active)`, "info");
				} else {
					ctx.ui.notify(`No active Chrome sockets found. Visit ${CHROME_RECONNECT_URL} in Chrome.`, "warning");
				}
				return;
			}

			if (sub === "install-host") {
				try {
					const res = await installChromeNativeHost({ force: false });
					ctx.ui.notify(
						`Installed Native Host manifests (${res.installedManifests.length} browsers) -> ${res.wrapperPath}`,
						"info",
					);
				} catch (err: any) {
					ctx.ui.notify(`Failed to install Native Host: ${err.message}`, "error");
				}
				return;
			}

			if (sub === "close-tabs") {
				const closed = await manager.closeEmptyTabGroups();
				ctx.ui.notify(`Closed ${closed} empty MCP tab(s).`, "info");
				return;
			}

			if (sub === "enable") {
				setChromeToolsActive(true);
				await updateFooterStatus(ctx);
				ctx.ui.notify(`Enabled ${allChromeToolNames.length} Claude in Chrome tools.`, "info");
				return;
			}

			if (sub === "disable") {
				setChromeToolsActive(false);
				await updateFooterStatus(ctx);
				ctx.ui.notify("Disabled Claude in Chrome tools for this session.", "info");
				return;
			}

			ctx.ui.notify(
				`Unknown /chrome subcommand '${sub}'. Available: ${SUBCOMMANDS.map((s) => s.value).join(", ")}`,
				"warning",
			);
		},
	});
}
