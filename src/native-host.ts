/**
 * Standalone Chrome Native Messaging Host & Multi-Browser Installer.
 *
 * Replicated from Claude Code v2.1.258:
 * - chunk-rnvpz4kd.js (`runChromeNativeHost`, `ChromeNativeHostServer`, `StdinReader`)
 * - chunk-rf49jb1h.js (`EQt` browser profile/manifest path discovery, extension detection)
 * - chunk-q8r5dtky.js (`hLt` NativeMessagingHosts manifest generator)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CLAUDE_CHROME_EXTENSION_ID,
	CLAUDE_NATIVE_HOST_NAME,
	getSocketDirPath,
	MAX_MESSAGE_SIZE,
	NATIVE_HOST_NAME,
	PI_CHROME_EXTENSION_ID,
	PI_NATIVE_HOST_NAME,
} from "./protocol.ts";

const NATIVE_HOST_VERSION = "1.0.0";

export type BrowserId = "chrome" | "brave" | "arc" | "edge" | "chromium" | "vivaldi" | "opera";

export interface BrowserConfig {
	name: string;
	macos: {
		appName: string;
		dataPath: string[];
		nativeMessagingPath: string[];
	};
	linux: {
		binaries: string[];
		dataPath: string[];
		nativeMessagingPath: string[];
	};
	windows: {
		dataPath: string[];
		registryKey: string;
	};
}

/**
 * Complete Chromium browser matrix replicated from `EQt` in `chunk-rf49jb1h.js`.
 */
export const CHROMIUM_BROWSERS: Record<BrowserId, BrowserConfig> = {
	chrome: {
		name: "Google Chrome",
		macos: {
			appName: "Google Chrome.app",
			dataPath: ["Google", "Chrome"],
			nativeMessagingPath: ["Google", "Chrome", "NativeMessagingHosts"],
		},
		linux: {
			binaries: ["google-chrome", "google-chrome-stable"],
			dataPath: ["google-chrome"],
			nativeMessagingPath: ["google-chrome", "NativeMessagingHosts"],
		},
		windows: {
			dataPath: ["Google", "Chrome", "User Data"],
			registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
	brave: {
		name: "Brave",
		macos: {
			appName: "Brave Browser.app",
			dataPath: ["BraveSoftware", "Brave-Browser"],
			nativeMessagingPath: ["BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
		},
		linux: {
			binaries: ["brave-browser", "brave"],
			dataPath: ["BraveSoftware", "Brave-Browser"],
			nativeMessagingPath: ["BraveSoftware", "Brave-Browser", "NativeMessagingHosts"],
		},
		windows: {
			dataPath: ["BraveSoftware", "Brave-Browser", "User Data"],
			registryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
	arc: {
		name: "Arc",
		macos: {
			appName: "Arc.app",
			dataPath: ["Arc", "User Data"],
			nativeMessagingPath: ["Arc", "User Data", "NativeMessagingHosts"],
		},
		linux: {
			binaries: [],
			dataPath: [],
			nativeMessagingPath: [],
		},
		windows: {
			dataPath: ["Arc", "User Data"],
			registryKey: `HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
	edge: {
		name: "Microsoft Edge",
		macos: {
			appName: "Microsoft Edge.app",
			dataPath: ["Microsoft Edge"],
			nativeMessagingPath: ["Microsoft Edge", "NativeMessagingHosts"],
		},
		linux: {
			binaries: ["microsoft-edge", "microsoft-edge-stable"],
			dataPath: ["microsoft-edge"],
			nativeMessagingPath: ["microsoft-edge", "NativeMessagingHosts"],
		},
		windows: {
			dataPath: ["Microsoft", "Edge", "User Data"],
			registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
	chromium: {
		name: "Chromium",
		macos: {
			appName: "Chromium.app",
			dataPath: ["Chromium"],
			nativeMessagingPath: ["Chromium", "NativeMessagingHosts"],
		},
		linux: {
			binaries: ["chromium", "chromium-browser"],
			dataPath: ["chromium"],
			nativeMessagingPath: ["chromium", "NativeMessagingHosts"],
		},
		windows: {
			dataPath: ["Chromium", "User Data"],
			registryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
	vivaldi: {
		name: "Vivaldi",
		macos: {
			appName: "Vivaldi.app",
			dataPath: ["Vivaldi"],
			nativeMessagingPath: ["Vivaldi", "NativeMessagingHosts"],
		},
		linux: {
			binaries: ["vivaldi", "vivaldi-stable"],
			dataPath: ["vivaldi"],
			nativeMessagingPath: ["vivaldi", "NativeMessagingHosts"],
		},
		windows: {
			dataPath: ["Vivaldi", "User Data"],
			registryKey: `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
	opera: {
		name: "Opera",
		macos: {
			appName: "Opera.app",
			dataPath: ["com.operasoftware.Opera"],
			nativeMessagingPath: ["com.operasoftware.Opera", "NativeMessagingHosts"],
		},
		linux: {
			binaries: ["opera"],
			dataPath: ["opera"],
			nativeMessagingPath: ["opera", "NativeMessagingHosts"],
		},
		windows: {
			dataPath: ["Opera Software", "Opera Stable"],
			registryKey: `HKCU\\Software\\Opera Software\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
		},
	},
};

export interface ExtensionDetectionStatus {
	installed: boolean;
	browsers: Array<{ browser: string; profile: string; version?: string }>;
	nativeHostManifests: Array<{ browser: string; manifestPath: string; wrapperPath?: string }>;
}

/**
 * Check if the Claude in Chrome extension (`fcoeoabgfenejglbffodgkkbkcdhcgfn`) and Native Host
 * manifests are installed across local Chromium browser profiles.
 * Replicates `LQe()` in `chunk-rf49jb1h.js`.
 */
export async function detectChromeExtensionStatus(): Promise<ExtensionDetectionStatus> {
	const home = os.homedir();
	const foundBrowsers: Array<{ browser: string; profile: string; version?: string }> = [];
	const foundManifests: Array<{ browser: string; manifestPath: string; wrapperPath?: string }> = [];

	for (const [, config] of Object.entries(CHROMIUM_BROWSERS)) {
		let dataBaseDir: string | null = null;
		let manifestDir: string | null = null;

		if (process.platform === "darwin") {
			dataBaseDir = path.join(home, "Library", "Application Support", ...config.macos.dataPath);
			manifestDir = path.join(home, "Library", "Application Support", ...config.macos.nativeMessagingPath);
		} else if (process.platform === "linux") {
			if (config.linux.dataPath.length > 0) {
				dataBaseDir = path.join(home, ".config", ...config.linux.dataPath);
				manifestDir = path.join(home, ".config", ...config.linux.nativeMessagingPath);
			}
		} else if (process.platform === "win32") {
			const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
			dataBaseDir = path.join(localAppData, ...config.windows.dataPath);
		}

		if (manifestDir) {
			const manifestFile = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
			try {
				const raw = await fsp.readFile(manifestFile, "utf-8");
				const parsed = JSON.parse(raw);
				foundManifests.push({
					browser: config.name,
					manifestPath: manifestFile,
					wrapperPath: parsed.path,
				});
			} catch {
				// Not installed for this browser
			}
		}

		if (dataBaseDir) {
			try {
				const entries = await fsp.readdir(dataBaseDir, { withFileTypes: true });
				const profiles = entries
					.filter((e) => e.isDirectory() && (e.name === "Default" || e.name.startsWith("Profile ")))
					.map((e) => e.name);

				for (const profile of profiles) {
					const extPath = path.join(dataBaseDir, profile, "Extensions", CLAUDE_CHROME_EXTENSION_ID);
					try {
						const versions = await fsp.readdir(extPath);
						const validVersions = versions.filter((v) => !v.startsWith("."));
						if (validVersions.length > 0) {
							foundBrowsers.push({
								browser: config.name,
								profile,
								version: validVersions[validVersions.length - 1],
							});
						}
					} catch {
						// Extension not in this profile
					}
				}
			} catch {
				// Browser data dir not present
			}
		}
	}

	return {
		installed: foundBrowsers.length > 0,
		browsers: foundBrowsers,
		nativeHostManifests: foundManifests,
	};
}

/**
 * Install the Native Messaging Host wrapper script (`~/.claude/chrome/chrome-native-host`)
 * and browser NativeMessagingHosts manifests.
 * Replicates `pLt()` and `hLt()` in `chunk-q8r5dtky.js`.
 */
export async function installChromeNativeHost(options?: {
	force?: boolean;
}): Promise<{ wrapperPath: string; installedManifests: string[] }> {
	const home = os.homedir();
	const wrapperDir = path.join(home, ".claude", "chrome");
	await fsp.mkdir(wrapperDir, { recursive: true });

	const isWindows = process.platform === "win32";
	const wrapperPath = isWindows
		? path.join(wrapperDir, "chrome-native-host.bat")
		: path.join(wrapperDir, "chrome-native-host");

	// Resolve our standalone bin/native-host.mjs
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	const nativeHostBin = path.resolve(thisDir, "..", "bin", "native-host.mjs");
	const nodeBin = process.execPath;

	// Only overwrite wrapper if force=true or if wrapper does not exist yet
	let wrapperExists = false;
	try {
		await fsp.access(wrapperPath);
		wrapperExists = true;
	} catch {
		wrapperExists = false;
	}

	if (!wrapperExists || options?.force) {
		const content = isWindows
			? `@echo off\r\n"${nodeBin}" "${nativeHostBin}"\r\n`
			: `#!/bin/sh\n# Chrome native host wrapper script\n# Generated by pi-claude-in-chrome\nexec "${nodeBin}" "${nativeHostBin}"\n`;
		await fsp.writeFile(wrapperPath, content, "utf-8");
		if (!isWindows) {
			await fsp.chmod(wrapperPath, 0o755);
		}
	}

	const allowedOrigins = [
		`chrome-extension://${PI_CHROME_EXTENSION_ID}/`,
		`chrome-extension://${CLAUDE_CHROME_EXTENSION_ID}/`,
	];

	const hostConfigs = [
		{
			name: PI_NATIVE_HOST_NAME,
			description: "Pi in Chrome Native Messaging Host (Unrestricted)",
		},
		{
			name: CLAUDE_NATIVE_HOST_NAME,
			description: "Claude Code / Pi Browser Automation Native Host",
		},
	];

	const installedManifests: string[] = [];

	if (process.platform === "darwin" || process.platform === "linux") {
		for (const [, config] of Object.entries(CHROMIUM_BROWSERS)) {
			const segments =
				process.platform === "darwin"
					? [home, "Library", "Application Support", ...config.macos.nativeMessagingPath]
					: config.linux.nativeMessagingPath.length > 0
						? [home, ".config", ...config.linux.nativeMessagingPath]
						: [];
			if (segments.length === 0) continue;

			const nmDir = path.join(...segments);
			const parentDir = path.dirname(nmDir);
			// Install for Chrome always, or for any browser whose parent config directory exists
			if (config.name === "Google Chrome" || fs.existsSync(parentDir)) {
				await fsp.mkdir(nmDir, { recursive: true });
				for (const host of hostConfigs) {
					const manifestJson = JSON.stringify(
						{
							name: host.name,
							description: host.description,
							path: wrapperPath,
							type: "stdio",
							allowed_origins: allowedOrigins,
						},
						null,
						2,
					);
					const manifestPath = path.join(nmDir, `${host.name}.json`);
					await fsp.writeFile(manifestPath, manifestJson, "utf-8");
					installedManifests.push(manifestPath);
				}
			}
		}
	}

	return { wrapperPath, installedManifests };
}

/**
 * Return absolute path to our standalone unrestricted Chrome Extension.
 */
export function getChromeExtensionPath(): string {
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(thisDir, "..", "chrome-extension");
}

/**
 * Write a 4-byte UInt32LE length-prefixed JSON message to Chrome over `process.stdout`.
 * Replicates `pR()` in `chunk-rnvpz4kd.js`.
 */
function writeToChromeStdout(message: unknown): void {
	const payload = Buffer.from(JSON.stringify(message), "utf-8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(payload.length, 0);
	process.stdout.write(header);
	process.stdout.write(payload);
}

/**
 * Reads 4-byte UInt32LE length-prefixed JSON messages from Chrome over `process.stdin`.
 * Replicates `class C` in `chunk-rnvpz4kd.js`.
 */
class NativeStdinReader {
	private buffer = Buffer.alloc(0);
	private pendingResolve: ((msg: string | null) => void) | null = null;
	private closed = false;

	constructor() {
		process.stdin.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.tryProcessMessage();
		});
		process.stdin.on("end", () => {
			this.closed = true;
			if (this.pendingResolve) {
				this.pendingResolve(null);
				this.pendingResolve = null;
			}
		});
		process.stdin.on("error", () => {
			this.closed = true;
			if (this.pendingResolve) {
				this.pendingResolve(null);
				this.pendingResolve = null;
			}
		});
	}

	private tryProcessMessage(): void {
		if (!this.pendingResolve) return;
		if (this.buffer.length < 4) return;
		const len = this.buffer.readUInt32LE(0);
		if (len === 0 || len > MAX_MESSAGE_SIZE) {
			this.pendingResolve(null);
			this.pendingResolve = null;
			return;
		}
		if (this.buffer.length < 4 + len) return;
		const payload = this.buffer.subarray(4, 4 + len);
		this.buffer = this.buffer.subarray(4 + len);
		const resolve = this.pendingResolve;
		this.pendingResolve = null;
		resolve(payload.toString("utf-8"));
	}

	public async read(): Promise<string | null> {
		if (this.closed) return null;
		if (this.buffer.length >= 4) {
			const len = this.buffer.readUInt32LE(0);
			if (len > 0 && len <= MAX_MESSAGE_SIZE && this.buffer.length >= 4 + len) {
				const payload = this.buffer.subarray(4, 4 + len);
				this.buffer = this.buffer.subarray(4 + len);
				return payload.toString("utf-8");
			}
		}
		return new Promise<string | null>((resolve) => {
			this.pendingResolve = resolve;
			this.tryProcessMessage();
		});
	}
}

interface McpClientEntry {
	id: number;
	socket: net.Socket;
	buffer: Buffer;
}

/**
 * Native Messaging Host Server that bridges Chrome Extension stdio <-> Unix Socket Pool.
 * Replicates `class y` in `chunk-rnvpz4kd.js`.
 */
export class ChromeNativeHostServer {
	private mcpClients = new Map<number, McpClientEntry>();
	private nextClientId = 1;
	private server: net.Server | null = null;
	private running = false;
	private socketPath: string | null = null;

	public async start(): Promise<void> {
		if (this.running) return;

		const socketDir = getSocketDirPath();
		if (process.platform !== "win32") {
			try {
				const stat = fs.lstatSync(socketDir);
				if (stat.isSymbolicLink() || !stat.isDirectory()) {
					fs.unlinkSync(socketDir);
					fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
				} else {
					fs.chmodSync(socketDir, 0o700);
				}
			} catch {
				fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
			}

			// Clean up stale `<pid>.sock` files
			try {
				const files = fs.readdirSync(socketDir);
				for (const file of files) {
					if (!file.endsWith(".sock")) continue;
					const pid = Number.parseInt(file.replace(".sock", ""), 10);
					if (!Number.isNaN(pid)) {
						try {
							process.kill(pid, 0);
						} catch (err: any) {
							if (err?.code === "ESRCH") {
								try {
									fs.unlinkSync(path.join(socketDir, file));
								} catch {
									// Ignore
								}
							}
						}
					}
				}
			} catch {
				// Ignore
			}
		}

		this.socketPath =
			process.platform === "win32" ? socketDir : path.join(socketDir, `${process.pid}.sock`);

		if (process.platform !== "win32") {
			try {
				if (fs.existsSync(this.socketPath)) {
					fs.unlinkSync(this.socketPath);
				}
			} catch {
				// Ignore
			}
		}

		this.server = net.createServer((socket) => this.handleMcpClient(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.listen(this.socketPath!, () => {
				if (process.platform !== "win32" && this.socketPath) {
					try {
						fs.chmodSync(this.socketPath, 0o600);
					} catch {
						// Ignore
					}
				}
				this.running = true;
				resolve();
			});
			this.server!.on("error", reject);
		});
	}

	public async stop(): Promise<void> {
		if (!this.running) return;
		for (const client of this.mcpClients.values()) {
			client.socket.destroy();
		}
		this.mcpClients.clear();
		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = null;
		}
		if (process.platform !== "win32" && this.socketPath) {
			try {
				if (fs.existsSync(this.socketPath)) {
					fs.unlinkSync(this.socketPath);
				}
				const dir = path.dirname(this.socketPath);
				const remaining = fs.readdirSync(dir);
				if (remaining.length === 0) {
					fs.rmdirSync(dir);
				}
			} catch {
				// Ignore
			}
		}
		this.running = false;
	}

	public async handleChromeMessage(jsonText: string): Promise<void> {
		const msg = JSON.parse(jsonText);
		switch (msg.type) {
			case "ping":
				writeToChromeStdout({ type: "pong", timestamp: Date.now() });
				break;
			case "get_status":
				writeToChromeStdout({
					type: "status_response",
					native_host_version: NATIVE_HOST_VERSION,
				});
				break;
			case "tool_response": {
				if (this.mcpClients.size > 0) {
					const { type: _omit, ...rest } = msg;
					const payload = Buffer.from(JSON.stringify(rest), "utf-8");
					const header = Buffer.allocUnsafe(4);
					header.writeUInt32LE(payload.length, 0);
					const frame = Buffer.concat([header, payload]);
					for (const client of this.mcpClients.values()) {
						try {
							client.socket.write(frame);
						} catch {
							// Ignore write errors on individual clients
						}
					}
				}
				break;
			}
			case "notification": {
				if (this.mcpClients.size > 0) {
					const { type: _omit, ...rest } = msg;
					const payload = Buffer.from(JSON.stringify(rest), "utf-8");
					const header = Buffer.allocUnsafe(4);
					header.writeUInt32LE(payload.length, 0);
					const frame = Buffer.concat([header, payload]);
					for (const client of this.mcpClients.values()) {
						try {
							client.socket.write(frame);
						} catch {
							// Ignore
						}
					}
				}
				break;
			}
		}
	}

	private handleMcpClient(socket: net.Socket): void {
		const id = this.nextClientId++;
		const entry: McpClientEntry = {
			id,
			socket,
			buffer: Buffer.alloc(0),
		};
		this.mcpClients.set(id, entry);
		writeToChromeStdout({ type: "mcp_connected" });

		socket.on("data", (chunk: Buffer) => {
			entry.buffer = Buffer.concat([entry.buffer, chunk]);
			while (entry.buffer.length >= 4) {
				const len = entry.buffer.readUInt32LE(0);
				if (len === 0 || len > MAX_MESSAGE_SIZE) {
					socket.destroy();
					return;
				}
				if (entry.buffer.length < 4 + len) break;
				const payload = entry.buffer.subarray(4, 4 + len);
				entry.buffer = entry.buffer.subarray(4 + len);
				try {
					const req = JSON.parse(payload.toString("utf-8"));
					if (req && req.type === "inference_response") {
						// Answer to a model sample the extension delegated to Pi.
						writeToChromeStdout({
							type: "inference_response",
							request_id: req.request_id,
							result: req.result,
						});
						continue;
					}
					writeToChromeStdout({
						type: "tool_request",
						method: req.method,
						params: req.params,
					});
				} catch {
					// Ignore malformed JSON
				}
			}
		});

		socket.on("close", () => {
			this.mcpClients.delete(id);
			writeToChromeStdout({ type: "mcp_disconnected" });
		});

		socket.on("error", () => {
			// Handled by close
		});
	}
}

/**
 * Entrypoint for the Chrome Native Messaging Host binary (`pi-chrome-native-host`).
 * Replicates `runChromeNativeHost` in `chunk-rnvpz4kd.js`.
 */
export async function runChromeNativeHost(): Promise<void> {
	const server = new ChromeNativeHostServer();
	const reader = new NativeStdinReader();

	await server.start();

	while (true) {
		const message = await reader.read();
		if (message === null) break;
		await server.handleChromeMessage(message);
	}

	await server.stop();
}
