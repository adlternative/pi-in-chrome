/**
 * Claude in Chrome Wire Protocol, Socket Security Validation, SocketClient, and Multi-Profile SocketPool.
 *
 * Replicated from Claude Code v2.1.258 embedded Bun modules:
 * - chunk-rf49jb1h.js (socket paths & platform discovery)
 * - chunk-dygr1ker.js (socket security validation & SocketClient `class k`)
 * - chunk-6xnead1w.js (multi-browser SocketPool `class P` & tabId routing)
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const PI_CHROME_EXTENSION_ID = "jlgmmfgplddjhfbfhnohfnjhdbpnalka";
export const CLAUDE_CHROME_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const PI_NATIVE_HOST_NAME = "com.pi.chrome_browser_extension";
export const CLAUDE_NATIVE_HOST_NAME = "com.anthropic.claude_code_browser_extension";
export const NATIVE_HOST_NAME = CLAUDE_NATIVE_HOST_NAME;
export const CHROME_INSTALL_URL = "https://claude.ai/chrome";
export const CHROME_RECONNECT_URL = "https://clau.de/chrome/reconnect";
export const CHROME_PERMISSIONS_URL = "https://clau.de/chrome/permissions";

/** 1 MiB max frame payload size (`$Kt = 1048576` in chunk-rnvpz4kd.js & chunk-dygr1ker.js) */
export const MAX_MESSAGE_SIZE = 1048576;

/** 10 MiB max total file upload payload size (`UKt = 10485760` in chunk-dygr1ker.js) */
export const MAX_FILE_UPLOAD_BYTES = 10485760;

export interface Logger {
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	debug(msg: string, ...args: unknown[]): void;
}

export const noopLogger: Logger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

export interface ToolResultBlock {
	type: string;
	text?: string;
	source?: {
		type?: string;
		data: string;
		media_type?: string;
	};
	data?: string;
	mimeType?: string;
}

export interface ExtensionToolResponse {
	result?: {
		content: ToolResultBlock[] | ToolResultBlock | string;
	};
	error?: {
		content: ToolResultBlock[] | ToolResultBlock | string;
	};
}

export interface NotificationMessage {
	method: string;
	params?: Record<string, unknown>;
}

export class SocketConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SocketConnectionError";
	}
}

/**
 * Resolve sanitized username used in socket path (`/tmp/claude-mcp-browser-bridge-<user>`).
 * Replicates `hQt()` / `n2t()` in `chunk-rf49jb1h.js`.
 */
export function getSocketUsername(): string {
	try {
		return os.userInfo().username || "default";
	} catch {
		return process.env.USER || process.env.USERNAME || "default";
	}
}

/**
 * Directory holding per-PID Unix sockets for each running Chrome Native Host instance.
 * Replicates `hQt()` in `chunk-rf49jb1h.js`.
 */
export function getSocketDirPath(type: "pi" | "claude" = "pi"): string {
	const username = getSocketUsername();
	if (process.platform === "win32") {
		return type === "pi"
			? `\\\\.\\pipe\\pi-mcp-browser-bridge-${username}`
			: `\\\\.\\pipe\\claude-mcp-browser-bridge-${username}`;
	}
	return type === "pi"
		? `/tmp/pi-mcp-browser-bridge-${username}`
		: `/tmp/claude-mcp-browser-bridge-${username}`;
}

/**
 * Enumerate all active `.sock` files in the socket pool directories (Pi sockets first, then Claude sockets).
 * Replicates `r2t()` in `chunk-rf49jb1h.js`.
 */
export function getAvailableSocketPaths(): string[] {
	if (process.platform === "win32") {
		return [getSocketDirPath("pi"), getSocketDirPath("claude")];
	}
	const paths: string[] = [];
	const searchDirs = [getSocketDirPath("pi"), getSocketDirPath("claude")];

	for (const dir of searchDirs) {
		try {
			const files = fs.readdirSync(dir);
			for (const file of files) {
				if (file.endsWith(".sock")) {
					// Check if the PID is still alive if filename is `<pid>.sock`
					const pidMatch = /^(\d+)\.sock$/.exec(file);
					if (pidMatch) {
						const pid = Number.parseInt(pidMatch[1], 10);
						try {
							process.kill(pid, 0);
						} catch (err: any) {
							if (err?.code === "ESRCH") {
								continue;
							}
						}
					}
					const fullPath = path.join(dir, file);
					if (!paths.includes(fullPath)) {
						paths.push(fullPath);
					}
				}
			}
		} catch {
			// Directory doesn't exist yet
		}
	}

	// Fallback to legacy TMPDIR socket if present
	const username = getSocketUsername();
	for (const prefix of ["pi-mcp-browser-bridge-", "claude-mcp-browser-bridge-"]) {
		const legacyPath = path.join(os.tmpdir(), `${prefix}${username}`);
		try {
			if (fs.existsSync(legacyPath) && !paths.includes(legacyPath)) {
				const stat = fs.statSync(legacyPath);
				if (stat.isSocket()) {
					paths.push(legacyPath);
				}
			}
		} catch {
			// Ignore
		}
	}

	return paths;
}

/**
 * Validate permissions and ownership of the socket directory (`0700`) and socket file (`0600`).
 * Replicates `bKt()`, `TKt()`, and `xKt()` in `chunk-dygr1ker.js`.
 */
export function validateSocketSecurity(socketPath: string): void {
	if (process.platform === "win32") return;

	const currentUid = process.getuid?.();
	const dir = path.dirname(socketPath);
	const dirName = path.basename(dir);

	if (dirName.startsWith("claude-mcp-browser-bridge-") || dirName.startsWith("pi-mcp-browser-bridge-")) {
		try {
			const dirStat = fs.statSync(dir);
			if (!dirStat.isDirectory()) {
				throw new Error(`Socket directory path ${dir} is not a directory`);
			}
			const dirMode = dirStat.mode & 0o777;
			if (dirMode !== 0o700) {
				throw new Error(
					`Insecure socket directory permissions on ${dir}: mode 0${dirMode.toString(8)} (expected 0700)`,
				);
			}
			if (currentUid !== undefined && dirStat.uid !== currentUid) {
				throw new Error(
					`Socket directory ${dir} is not owned by current user (uid ${currentUid}, owner ${dirStat.uid})`,
				);
			}
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				throw err;
			}
		}
	}

	const stat = fs.statSync(socketPath);
	if (!stat.isSocket()) {
		throw new Error(`Path ${socketPath} is not a Unix domain socket`);
	}
	const sockMode = stat.mode & 0o777;
	if (sockMode !== 0o600) {
		throw new Error(
			`Insecure socket permissions on ${socketPath}: mode 0${sockMode.toString(8)} (expected 0600)`,
		);
	}
	if (currentUid !== undefined && stat.uid !== currentUid) {
		throw new Error(
			`Socket ${socketPath} is not owned by current user (uid ${currentUid}, owner ${stat.uid})`,
		);
	}
}

export interface SocketClientOptions {
	socketPath: string;
	logger?: Logger;
	clientId?: string;
	sessionScope?: string;
	toolCallTimeoutMs?: number;
}

/**
 * Single-socket client speaking 4-byte UInt32LE length-prefixed JSON frames to a Chrome Native Host.
 * Replicates `class k` (`wKt`) in `chunk-dygr1ker.js`.
 */
export class SocketClient {
	private socket: net.Socket | null = null;
	private connected = false;
	private connecting = false;
	private responseCallback: ((res: ExtensionToolResponse) => void) | null = null;
	private notificationHandler: ((notification: NotificationMessage) => void) | null = null;
	private responseBuffer = Buffer.alloc(0);
	private reconnectAttempts = 0;
	private readonly maxReconnectAttempts = 10;
	private readonly reconnectDelay = 100;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private disableAutoReconnect = false;

	public readonly socketPath: string;
	private readonly logger: Logger;
	private readonly clientId: string;
	private readonly sessionScope?: string;
	private readonly toolCallTimeoutMs: number;

	constructor(options: SocketClientOptions) {
		this.socketPath = options.socketPath;
		this.logger = options.logger ?? noopLogger;
		this.clientId = options.clientId ?? "claude-code";
		this.sessionScope = options.sessionScope;
		this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 60_000;
	}

	public async ensureConnected(): Promise<boolean> {
		if (this.connected) return true;
		if (!this.connecting) {
			await this.connect();
		} else {
			await new Promise<void>((resolve) => {
				const timer = setInterval(() => {
					if (!this.connecting) {
						clearInterval(timer);
						resolve();
					}
				}, 50);
			});
		}
		return this.connected;
	}

	public isConnected(): boolean {
		return this.connected;
	}

	public setNotificationHandler(handler: (notification: NotificationMessage) => void): void {
		this.notificationHandler = handler;
	}

	public async callTool(
		toolName: string,
		args: Record<string, unknown>,
		options?: { sessionScope?: string; timeoutMs?: number },
	): Promise<ExtensionToolResponse> {
		const attemptCall = async (): Promise<ExtensionToolResponse> => {
			const ok = await this.ensureConnected();
			if (!ok) {
				throw new SocketConnectionError(`Not connected to Chrome bridge socket at ${this.socketPath}`);
			}
			return this.sendToolRequest(toolName, args, options);
		};

		try {
			return await attemptCall();
		} catch (err) {
			if (err instanceof SocketConnectionError) {
				this.logger.info(`Socket error during ${toolName}, reconnecting once and retrying...`);
				this.closeSocket();
				return await attemptCall();
			}
			throw err;
		}
	}

	private sendToolRequest(
		toolName: string,
		args: Record<string, unknown>,
		options?: { sessionScope?: string; timeoutMs?: number },
	): Promise<ExtensionToolResponse> {
		return new Promise<ExtensionToolResponse>((resolve, reject) => {
			if (!this.socket || !this.connected) {
				reject(new SocketConnectionError("Socket is not connected"));
				return;
			}

			const timeoutMs = options?.timeoutMs ?? this.toolCallTimeoutMs;
			const timer = setTimeout(() => {
				if (this.responseCallback) {
					this.responseCallback = null;
					reject(new SocketConnectionError(`Tool call '${toolName}' timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);

			this.responseCallback = (response: ExtensionToolResponse) => {
				clearTimeout(timer);
				resolve(response);
			};

			const sessionScope = options?.sessionScope ?? this.sessionScope;
			const requestPayload = JSON.stringify({
				method: "execute_tool",
				params: {
					client_id: this.clientId,
					tool: toolName,
					args,
					...(sessionScope ? { session_scope: sessionScope } : {}),
				},
			});

			const payloadBuf = Buffer.from(requestPayload, "utf-8");
			const headerBuf = Buffer.allocUnsafe(4);
			headerBuf.writeUInt32LE(payloadBuf.length, 0);
			const frame = Buffer.concat([headerBuf, payloadBuf]);

			this.socket.write(frame, (err) => {
				if (err) {
					clearTimeout(timer);
					this.responseCallback = null;
					reject(new SocketConnectionError(`Failed to write to socket: ${err.message}`));
				}
			});
		});
	}

	private async connect(): Promise<void> {
		if (this.connecting || this.connected) return;
		this.connecting = true;
		this.disableAutoReconnect = false;

		try {
			validateSocketSecurity(this.socketPath);
		} catch (err: any) {
			this.connecting = false;
			this.logger.warn(`Socket security check failed for ${this.socketPath}: ${err.message}`);
			return;
		}

		await new Promise<void>((resolve) => {
			this.socket = net.createConnection(this.socketPath);

			const connectTimer = setTimeout(() => {
				if (!this.connected) {
					this.socket?.destroy();
					this.connecting = false;
					resolve();
				}
			}, 3000);

			this.socket.on("connect", () => {
				clearTimeout(connectTimer);
				this.connected = true;
				this.connecting = false;
				this.reconnectAttempts = 0;
				this.logger.info(`Connected to Chrome bridge socket: ${this.socketPath}`);
				resolve();
			});

			this.socket.on("data", (chunk: Buffer) => {
				this.responseBuffer = Buffer.concat([this.responseBuffer, chunk]);
				while (this.responseBuffer.length >= 4) {
					const frameLen = this.responseBuffer.readUInt32LE(0);
					if (frameLen > MAX_MESSAGE_SIZE) {
						this.logger.error(`Received oversized frame (${frameLen} bytes), closing socket`);
						this.responseBuffer = Buffer.alloc(0);
						this.socket?.destroy();
						return;
					}
					if (this.responseBuffer.length < 4 + frameLen) {
						break;
					}
					const jsonBytes = this.responseBuffer.subarray(4, 4 + frameLen);
					this.responseBuffer = this.responseBuffer.subarray(4 + frameLen);
					try {
						const parsed = JSON.parse(jsonBytes.toString("utf-8"));
						if (parsed && typeof parsed === "object" && "method" in parsed && !("result" in parsed) && !("error" in parsed)) {
							this.notificationHandler?.(parsed as NotificationMessage);
						} else if ("result" in parsed || "error" in parsed) {
							const cb = this.responseCallback;
							this.responseCallback = null;
							cb?.(parsed as ExtensionToolResponse);
						}
					} catch (err: any) {
						this.logger.error(`Failed to parse frame JSON: ${err.message}`);
					}
				}
			});

			this.socket.on("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(connectTimer);
				if (this.responseCallback) {
					const cb = this.responseCallback;
					this.responseCallback = null;
					cb({
						error: {
							content: [{ type: "text", text: `Socket error: ${err.message}` }],
						},
					});
				}
				this.connected = false;
				this.connecting = false;
				if (err.code && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT"].includes(err.code)) {
					if (!this.disableAutoReconnect) {
						this.scheduleReconnect();
					}
				}
				resolve();
			});

			this.socket.on("close", () => {
				clearTimeout(connectTimer);
				this.connected = false;
				this.connecting = false;
				if (!this.disableAutoReconnect) {
					this.scheduleReconnect();
				}
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.disableAutoReconnect) return;
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.reconnectAttempts = 0;
			return;
		}
		this.reconnectAttempts++;
		const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 2000);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.disableAutoReconnect) {
				void this.connect();
			}
		}, delay);
		this.reconnectTimer.unref?.();
	}

	private closeSocket(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.end();
			this.socket.destroy();
			this.socket = null;
		}
		this.connected = false;
		this.connecting = false;
		this.responseCallback = null;
		this.responseBuffer = Buffer.alloc(0);
	}

	public disconnect(): void {
		this.disableAutoReconnect = true;
		this.closeSocket();
		this.reconnectAttempts = 0;
	}
}

export interface TabInfo {
	tabId: number;
	title?: string;
	url?: string;
	active?: boolean;
	windowId?: number;
	tabGroupId?: number;
	socketPath?: string;
}

/**
 * Multi-profile Socket Pool that connects to all active Chrome Native Host sockets,
 * aggregates `tabs_context_mcp` across browser profiles, and routes tool calls by `args.tabId`.
 *
 * Replicates `class P` (`RLt`) in `chunk-6xnead1w.js`.
 */
export class SocketPool extends EventEmitter {
	private readonly clients = new Map<string, SocketClient>();
	private readonly tabRoutes = new Map<number, string>();
	private readonly logger: Logger;
	private notificationHandler: ((notification: NotificationMessage) => void) | null = null;
	public readonly sessionScope: string;

	constructor(logger: Logger = noopLogger) {
		super();
		this.logger = logger;
		this.sessionScope = `pi-${process.pid}-${Date.now().toString(36)}`;
	}

	public setNotificationHandler(handler: (notification: NotificationMessage) => void): void {
		this.notificationHandler = handler;
		for (const client of this.clients.values()) {
			client.setNotificationHandler(handler);
		}
	}

	public async ensureConnected(): Promise<boolean> {
		this.refreshClients();
		const results = await Promise.all(
			Array.from(this.clients.values()).map((client) => client.ensureConnected()),
		);
		return results.some(Boolean);
	}

	public getConnectedSockets(): string[] {
		const connected: string[] = [];
		for (const [sockPath, client] of this.clients.entries()) {
			if (client.isConnected()) {
				connected.push(sockPath);
			}
		}
		return connected;
	}

	public getTabRoutes(): ReadonlyMap<number, string> {
		return this.tabRoutes;
	}

	public async callTool(
		toolName: string,
		args: Record<string, unknown>,
		options?: { timeoutMs?: number },
	): Promise<ExtensionToolResponse> {
		if (toolName === "tabs_context_mcp") {
			return this.callTabsContext(args, options);
		}

		const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
		if (tabId !== undefined) {
			const targetSocketPath = this.tabRoutes.get(tabId);
			if (targetSocketPath) {
				const targetClient = this.clients.get(targetSocketPath);
				if (targetClient && (await targetClient.ensureConnected())) {
					return targetClient.callTool(toolName, args, {
						sessionScope: this.sessionScope,
						timeoutMs: options?.timeoutMs,
					});
				}
			}
		}

		// Fallback: refresh pool and use first connected client
		this.refreshClients();
		for (const client of this.clients.values()) {
			if (await client.ensureConnected()) {
				return client.callTool(toolName, args, {
					sessionScope: this.sessionScope,
					timeoutMs: options?.timeoutMs,
				});
			}
		}

		throw new SocketConnectionError("No connected Chrome bridge sockets available");
	}

	public disconnect(): void {
		for (const client of this.clients.values()) {
			client.disconnect();
		}
		this.clients.clear();
		this.tabRoutes.clear();
	}

	private refreshClients(): void {
		const currentPaths = getAvailableSocketPaths();
		const currentSet = new Set(currentPaths);

		for (const existingPath of currentPaths) {
			if (!this.clients.has(existingPath)) {
				this.logger.info(`Adding Chrome socket to pool: ${existingPath}`);
				const client = new SocketClient({
					socketPath: existingPath,
					logger: this.logger,
					clientId: "claude-code",
					sessionScope: this.sessionScope,
				});
				if (this.notificationHandler) {
					client.setNotificationHandler(this.notificationHandler);
				}
				this.clients.set(existingPath, client);
			}
		}

		for (const [sockPath, client] of this.clients.entries()) {
			if (!currentSet.has(sockPath)) {
				this.logger.info(`Removing stale Chrome socket from pool: ${sockPath}`);
				client.disconnect();
				this.clients.delete(sockPath);
				for (const [tabId, routedPath] of this.tabRoutes.entries()) {
					if (routedPath === sockPath) {
						this.tabRoutes.delete(tabId);
					}
				}
			}
		}
	}

	/**
	 * Query `tabs_context_mcp` across all connected sockets in parallel, merge `availableTabs`,
	 * and populate `tabRoutes: Map<tabId, socketPath>`.
	 * Replicates `callTabsContext` in `chunk-6xnead1w.js`.
	 */
	private async callTabsContext(
		args: Record<string, unknown>,
		options?: { timeoutMs?: number },
	): Promise<ExtensionToolResponse> {
		this.refreshClients();
		if (this.clients.size === 0) {
			throw new SocketConnectionError("No Chrome bridge sockets found in pool");
		}

		// Single socket fast path
		if (this.clients.size === 1) {
			const [sockPath, client] = Array.from(this.clients.entries())[0];
			if (!(await client.ensureConnected())) {
				throw new SocketConnectionError(`Socket ${sockPath} failed to connect`);
			}
			const response = await client.callTool("tabs_context_mcp", args, {
				sessionScope: this.sessionScope,
				timeoutMs: options?.timeoutMs,
			});
			this.updateTabRoutesFromResponse(response, sockPath);
			return response;
		}

		// Multi-socket parallel aggregation
		const settled = await Promise.allSettled(
			Array.from(this.clients.entries()).map(async ([sockPath, client]) => {
				const ok = await client.ensureConnected();
				if (!ok) throw new SocketConnectionError(`Not connected: ${sockPath}`);
				const response = await client.callTool("tabs_context_mcp", args, {
					sessionScope: this.sessionScope,
					timeoutMs: options?.timeoutMs,
				});
				return { sockPath, response };
			}),
		);

		const mergedTabs: TabInfo[] = [];
		const extraContentBlocks: ToolResultBlock[] = [];
		this.tabRoutes.clear();
		let anySuccess = false;

		for (const item of settled) {
			if (item.status !== "fulfilled") {
				this.logger.debug(`tabs_context_mcp failed on one socket: ${item.reason}`);
				continue;
			}
			anySuccess = true;
			const { sockPath, response } = item.value;
			const extracted = this.extractTabsFromResponse(response, sockPath);
			if (extracted) {
				mergedTabs.push(...extracted.tabs);
				extraContentBlocks.push(...extracted.otherBlocks);
			} else if (response.result?.content) {
				const blocks = Array.isArray(response.result.content)
					? response.result.content
					: [response.result.content as ToolResultBlock];
				extraContentBlocks.push(...blocks);
			}
		}

		if (!anySuccess) {
			throw new SocketConnectionError("All Chrome sockets in pool failed to respond to tabs_context_mcp");
		}

		if (mergedTabs.length > 0) {
			return {
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify({ availableTabs: mergedTabs }),
						},
						...extraContentBlocks,
					],
				},
			};
		}

		return {
			result: {
				content: extraContentBlocks,
			},
		};
	}

	private updateTabRoutesFromResponse(response: ExtensionToolResponse, sockPath: string): void {
		this.extractTabsFromResponse(response, sockPath);
	}

	private extractTabsFromResponse(
		response: ExtensionToolResponse,
		sockPath: string,
	): { tabs: TabInfo[]; otherBlocks: ToolResultBlock[] } | null {
		if (!response?.result?.content) return null;
		const content = Array.isArray(response.result.content)
			? response.result.content
			: [response.result.content as ToolResultBlock];

		const tabs: TabInfo[] = [];
		const otherBlocks: ToolResultBlock[] = [];
		let foundTabsJson = false;

		for (const block of content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				try {
					const parsed = JSON.parse(block.text);
					if (parsed && Array.isArray(parsed.availableTabs)) {
						foundTabsJson = true;
						for (const tab of parsed.availableTabs) {
							if (tab && typeof tab.tabId === "number") {
								this.tabRoutes.set(tab.tabId, sockPath);
								tabs.push(tab);
							}
						}
						continue;
					}
				} catch {
					// Not the JSON block, keep in otherBlocks
				}
			}
			otherBlocks.push(block);
		}

		return foundTabsJson ? { tabs, otherBlocks } : null;
	}
}
