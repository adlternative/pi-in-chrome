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
	/**
	 * Correlation id echoed back by the extension when the request carried
	 * `params.tool_use_id` (see `kr3()` in the bundled `service-worker.js`).
	 */
	tool_use_id?: string;
}

export interface NotificationMessage {
	method: string;
	params?: Record<string, unknown>;
}

/**
 * Inference request the extension sends when a tool needs a model sample
 * (`find` is the only one today). Body shape mirrors the extension's
 * desktop/relay inference contract.
 */
export interface InferenceRelayBody {
	model_class?: "default" | "small_fast";
	max_tokens?: number;
	system?: string | unknown[];
	messages?: Array<{ role: string; content: unknown }>;
}

/** Reply shape the extension accepts from any inference relay provider. */
export interface InferenceRelayResult {
	ok: boolean;
	content?: Array<{ type: string; text?: string }>;
	stop_reason?: string | null;
	error?: string;
}

export class SocketConnectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SocketConnectionError";
	}
}

/**
 * Raised when a tool call gets no response within its timeout.
 *
 * Distinct from a plain `SocketConnectionError` so that `callTool` never retries
 * it: a timed-out `computer` click or `navigate` may still have run in the
 * browser, and re-sending it would duplicate the action.
 */
export class ToolTimeoutError extends SocketConnectionError {
	constructor(message: string) {
		super(message);
		this.name = "ToolTimeoutError";
	}
}

/**
 * Raised when the caller's `AbortSignal` fires while a tool call is in flight.
 *
 * The Chrome extension has no cancel method, so the browser-side action may still
 * run to completion; this error only stops Pi from waiting for it. The pending
 * slot is kept as a "tombstone" so the eventual late response is discarded
 * instead of being handed to the next tool call.
 */
export class ToolAbortedError extends Error {
	constructor(message = "Tool call aborted by the user") {
		super(message);
		this.name = "ToolAbortedError";
	}
}

/** A tool request that is on the wire, or a tombstone for one that was abandoned. */
interface PendingToolCall {
	requestId: string;
	toolName: string;
	/** True once the waiter was rejected (abort/timeout); the slot only swallows the late response. */
	abandoned: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	resolve: (response: ExtensionToolResponse) => void;
	reject: (err: Error) => void;
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
/**
 * Enumerate active bridge sockets.
 *
 * Pi's own sockets are always included. Sockets in the Claude directory are only
 * included when they are Pi's own mirrors (`pi-<pid>.sock`) or when
 * `PI_CHROME_ALLOW_CLAUDE_BRIDGE=1` is set: a bare `<pid>.sock` there belongs to
 * Claude Code's native host and is served by Claude's own extension, which
 * enforces claude.ai login, URL hash checks and permission prompts. Driving that
 * extension from Pi produced confusing failures (`Permission denied by user`,
 * "tab is not in Pi's tab group").
 *
 * Paths are de-duplicated by real path so a mirror symlink never yields a second
 * connection to the same host.
 */
export function getAvailableSocketPaths(): string[] {
	if (process.platform === "win32") {
		return [getSocketDirPath("pi"), getSocketDirPath("claude")];
	}

	const allowClaudeBridge = process.env.PI_CHROME_ALLOW_CLAUDE_BRIDGE === "1";
	const paths: string[] = [];
	const seenRealPaths = new Set<string>();

	const addPath = (fullPath: string): void => {
		let realPath: string;
		try {
			realPath = fs.realpathSync(fullPath);
		} catch {
			// Dead symlink or unreadable entry
			return;
		}
		if (seenRealPaths.has(realPath)) return;
		seenRealPaths.add(realPath);
		paths.push(fullPath);
	};

	const isPidAlive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err: any) {
			return err?.code !== "ESRCH";
		}
	};

	const collect = (dir: string, include: (file: string) => boolean): void => {
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			// Directory doesn't exist yet
			return;
		}
		for (const file of files) {
			if (!file.endsWith(".sock") || !include(file)) continue;
			// `<pid>.sock` and Pi mirrors (`pi-<pid>.sock`): skip dead hosts.
			const pidMatch = /^(?:pi-)?(\d+)\.sock$/.exec(file);
			if (pidMatch && !isPidAlive(Number.parseInt(pidMatch[1], 10))) continue;
			addPath(path.join(dir, file));
		}
	};

	// 1. Pi's own sockets: everything the Pi native host publishes.
	collect(getSocketDirPath("pi"), () => true);

	// 2. Claude directory: only Pi's own mirrors, unless explicitly opted in.
	collect(getSocketDirPath("claude"), (file) => allowClaudeBridge || file.startsWith("pi-"));

	// Fallback to legacy TMPDIR socket if present
	const username = getSocketUsername();
	for (const prefix of ["pi-mcp-browser-bridge-", "claude-mcp-browser-bridge-"]) {
		const legacyPath = path.join(os.tmpdir(), `${prefix}${username}`);
		try {
			if (fs.existsSync(legacyPath)) {
				const stat = fs.statSync(legacyPath);
				if (stat.isSocket()) {
					addPath(legacyPath);
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
	/**
	 * In-flight tool calls keyed by request id (insertion ordered). Abandoned calls
	 * stay in the map as tombstones until their late response arrives, so a stale
	 * frame can never resolve a newer call.
	 */
	private readonly pendingCalls = new Map<string, PendingToolCall>();
	private requestSeq = 0;
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
		options?: {
			sessionScope?: string;
			timeoutMs?: number;
			relayInference?: boolean;
			signal?: AbortSignal;
			requestId?: string;
		},
	): Promise<ExtensionToolResponse> {
		const attemptCall = async (): Promise<ExtensionToolResponse> => {
			if (options?.signal?.aborted) {
				throw new ToolAbortedError(`Tool call '${toolName}' aborted before it was sent`);
			}
			const ok = await this.ensureConnected();
			if (!ok) {
				throw new SocketConnectionError(`Not connected to Chrome bridge socket at ${this.socketPath}`);
			}
			return this.sendToolRequest(toolName, args, options);
		};

		try {
			return await attemptCall();
		} catch (err) {
			// Never retry after an abort or a timeout: the action may already have run in
			// Chrome, and retrying a destructive call (click/navigate) would duplicate it.
			const retryable =
				err instanceof SocketConnectionError &&
				!(err instanceof ToolTimeoutError) &&
				!options?.signal?.aborted;
			if (retryable) {
				this.logger.info(`Socket error during ${toolName}, reconnecting once and retrying...`);
				this.closeSocket();
				return await attemptCall();
			}
			throw err;
		}
	}

	private nextRequestId(): string {
		this.requestSeq += 1;
		return `pi-${process.pid}-${this.requestSeq}`;
	}

	/** Drop a pending slot and its timeout timer. */
	private removePending(requestId: string): void {
		const entry = this.pendingCalls.get(requestId);
		if (!entry) return;
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		this.pendingCalls.delete(requestId);
	}

	/**
	 * Keep an abandoned call's slot so its late response is swallowed, not delivered
	 * to whichever call happens to be waiting next.
	 */
	private keepTombstone(requestId: string, ttlMs: number): void {
		const entry = this.pendingCalls.get(requestId);
		if (!entry) return;
		entry.abandoned = true;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			this.pendingCalls.delete(requestId);
		}, ttlMs);
		entry.timer.unref?.();

		// Bound memory: evict the oldest tombstones beyond a safe cap.
		const MAX_TOMBSTONES = 32;
		if (this.pendingCalls.size > MAX_TOMBSTONES) {
			for (const [id, pending] of this.pendingCalls) {
				if (this.pendingCalls.size <= MAX_TOMBSTONES) break;
				if (pending.abandoned) {
					this.removePending(id);
				}
			}
		}
	}

	/** Route one `tool_response` frame to its waiting call. */
	private settleFromResponse(response: ExtensionToolResponse): void {
		let entry: PendingToolCall | undefined;
		const id = typeof response.tool_use_id === "string" ? response.tool_use_id : undefined;
		if (id) {
			entry = this.pendingCalls.get(id);
			if (!entry) {
				// Another session on this socket, or a response we already gave up on.
				this.logger.debug(`Discarding response for unknown request ${id}`);
				return;
			}
		} else {
			// Older extension builds do not echo `tool_use_id`; fall back to FIFO order.
			const head = this.pendingCalls.keys().next();
			if (head.done) {
				this.logger.debug("Discarding response with no pending tool call");
				return;
			}
			entry = this.pendingCalls.get(head.value);
		}
		if (!entry) return;

		const { requestId, abandoned, resolve } = entry;
		this.removePending(requestId);
		if (abandoned) {
			this.logger.debug(`Discarding late response for abandoned request ${requestId}`);
			return;
		}
		resolve(response);
	}

	/** Reject every in-flight call, e.g. when the socket dies. */
	private failPendingCalls(err: Error): void {
		const entries = Array.from(this.pendingCalls.values());
		this.pendingCalls.clear();
		for (const entry of entries) {
			if (entry.timer) {
				clearTimeout(entry.timer);
				entry.timer = null;
			}
			if (entry.abandoned) continue;
			entry.reject(err);
		}
	}

	/** Write one length-prefixed JSON frame to the bridge socket. */
	private writeFrame(payload: unknown): boolean {
		if (!this.socket || !this.connected) return false;
		const payloadBuf = Buffer.from(JSON.stringify(payload), "utf-8");
		if (payloadBuf.length > MAX_MESSAGE_SIZE) {
			this.logger.error(`Refusing to send oversized frame (${payloadBuf.length} bytes)`);
			return false;
		}
		const headerBuf = Buffer.allocUnsafe(4);
		headerBuf.writeUInt32LE(payloadBuf.length, 0);
		this.socket.write(Buffer.concat([headerBuf, payloadBuf]));
		return true;
	}

	/**
	 * Answer an `inference_request` notification. The extension resolves its
	 * pending model call with this payload instead of calling Anthropic.
	 *
	 * The frame is deliberately method-shaped rather than a new top-level `type`:
	 * the installed Chrome native host forwards socket frames to the extension
	 * only as `{type:"tool_request", method, params}`, and that host binary
	 * cannot be modified.
	 */
	public sendInferenceResponse(requestId: string, result: InferenceRelayResult): boolean {
		return this.writeFrame({
			method: "inference_response",
			params: { request_id: requestId, result },
		});
	}

	private sendToolRequest(
		toolName: string,
		args: Record<string, unknown>,
		options?: {
			sessionScope?: string;
			timeoutMs?: number;
			relayInference?: boolean;
			signal?: AbortSignal;
			requestId?: string;
		},
	): Promise<ExtensionToolResponse> {
		return new Promise<ExtensionToolResponse>((resolve, reject) => {
			if (!this.socket || !this.connected) {
				reject(new SocketConnectionError("Socket is not connected"));
				return;
			}
			if (options?.signal?.aborted) {
				reject(new ToolAbortedError(`Tool call '${toolName}' aborted before it was sent`));
				return;
			}

			const timeoutMs = options?.timeoutMs ?? this.toolCallTimeoutMs;
			const signal = options?.signal;
			const requestId = options?.requestId ?? this.nextRequestId();
			this.removePending(requestId);

			let settled = false;
			const entry: PendingToolCall = {
				requestId,
				toolName,
				abandoned: false,
				timer: null,
				resolve: (response) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					resolve(response);
				},
				reject: (err) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					reject(err);
				},
			};

			const onAbort = () => {
				if (settled) return;
				entry.abandoned = true;
				entry.reject(new ToolAbortedError(`Tool call '${toolName}' aborted by the user`));
				this.keepTombstone(requestId, timeoutMs);
			};

			entry.timer = setTimeout(() => {
				if (settled) return;
				entry.abandoned = true;
				entry.reject(
					new ToolTimeoutError(`Tool call '${toolName}' timed out after ${timeoutMs}ms`),
				);
				this.keepTombstone(requestId, timeoutMs);
			}, timeoutMs);
			entry.timer.unref?.();

			this.pendingCalls.set(requestId, entry);
			signal?.addEventListener("abort", onAbort, { once: true });

			const sessionScope = options?.sessionScope ?? this.sessionScope;
			const requestPayload = JSON.stringify({
				method: "execute_tool",
				params: {
					client_id: this.clientId,
					tool: toolName,
					args,
					// The extension echoes this back on the matching `tool_response`,
					// which is what makes abort/parallel calls safe to correlate.
					tool_use_id: requestId,
					...(sessionScope ? { session_scope: sessionScope } : {}),
					// Advertise that this host can answer `inference_request`
					// notifications, so the extension routes model samples here.
					...(options?.relayInference ? { relay_inference: true } : {}),
				},
			});

			const payloadBuf = Buffer.from(requestPayload, "utf-8");
			const headerBuf = Buffer.allocUnsafe(4);
			headerBuf.writeUInt32LE(payloadBuf.length, 0);
			const frame = Buffer.concat([headerBuf, payloadBuf]);

			this.socket.write(frame, (err) => {
				if (err) {
					this.removePending(requestId);
					entry.reject(new SocketConnectionError(`Failed to write to socket: ${err.message}`));
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
							this.settleFromResponse(parsed as ExtensionToolResponse);
						}
					} catch (err: any) {
						this.logger.error(`Failed to parse frame JSON: ${err.message}`);
					}
				}
			});

			this.socket.on("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(connectTimer);
				this.failPendingCalls(new SocketConnectionError(`Socket error: ${err.message}`));
				this.pendingCalls.clear();
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
				this.failPendingCalls(new SocketConnectionError(`Socket ${this.socketPath} closed`));
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
		this.failPendingCalls(new SocketConnectionError(`Socket ${this.socketPath} closed`));
		this.pendingCalls.clear();
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
	/**
	 * When true, tool calls advertise `relay_inference` so the extension sends its
	 * model samples (currently only the `find` tool) back to Pi instead of
	 * Anthropic. Set by the Pi extension once a model is available.
	 */
	public relayInference = false;

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
		options?: { timeoutMs?: number; signal?: AbortSignal; requestId?: string },
	): Promise<ExtensionToolResponse> {
		if (options?.signal?.aborted) {
			throw new ToolAbortedError(`Tool call '${toolName}' aborted before it was sent`);
		}
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
						relayInference: this.relayInference,
						signal: options?.signal,
						requestId: options?.requestId,
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
					relayInference: this.relayInference,
					signal: options?.signal,
					requestId: options?.requestId,
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

	/** Broadcast an inference answer to every connected bridge socket. */
	public sendInferenceResponse(requestId: string, result: InferenceRelayResult): void {
		for (const client of this.clients.values()) {
			if (client.isConnected()) {
				client.sendInferenceResponse(requestId, result);
			}
		}
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
		options?: { timeoutMs?: number; signal?: AbortSignal; requestId?: string },
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
				signal: options?.signal,
				requestId: options?.requestId,
			});
			this.updateTabRoutesFromResponse(response, sockPath);
			return response;
		}

		// Multi-socket parallel aggregation
		const settled = await Promise.allSettled(
			Array.from(this.clients.entries()).map(async ([sockPath, client], index) => {
				const ok = await client.ensureConnected();
				if (!ok) throw new SocketConnectionError(`Not connected: ${sockPath}`);
				const response = await client.callTool("tabs_context_mcp", args, {
					sessionScope: this.sessionScope,
					timeoutMs: options?.timeoutMs,
					signal: options?.signal,
					requestId: options?.requestId ? `${options.requestId}:${index}` : undefined,
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
