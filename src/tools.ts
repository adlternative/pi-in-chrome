/**
 * Claude in Chrome Browser Tools & Execution Pipeline for Pi.
 *
 * Replicated from Claude Code v2.1.258:
 * - chunk-7kjwdqkx.js (`Aut` tool definitions & schemas)
 * - chunk-dygr1ker.js (`e` tool execution wrapper, `navigate` auto-frontloading, `ZKt` host-side file_upload, `qKt` screenshot save_to_disk, `oe` image normalization)
 * - chunk-7m0pkhzw.js (`closeEmptyTabGroups` session cleanup)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionToolContext,
	type ToolDefinition,
	type ToolNamespace,
	type ToolRenderContext,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import {
	CHROME_INSTALL_URL,
	CHROME_RECONNECT_URL,
	type ExtensionToolResponse,
	MAX_FILE_UPLOAD_BYTES,
	type SocketPool,
	ToolAbortedError,
	type ToolResultBlock,
} from "./protocol.ts";

export const CHROME_TOOL_PREFIX = "mcp__claude-in-chrome__";

export const CHROME_NAMESPACE: ToolNamespace = {
	name: "mcp__claude-in-chrome",
	aliases: ["claude-in-chrome", "chrome"],
	description: "Claude in Chrome browser automation tools (DOM, computer vision/clicks, JS execution, network & console inspection, GIF recording)",
};

const MIME_BY_EXTENSION: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".csv": "text/csv",
	".html": "text/html",
	".htm": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".json": "application/json",
	".xml": "application/xml",
	".yaml": "application/x-yaml",
	".yml": "application/x-yaml",
	".md": "text/markdown",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mov": "video/quicktime",
};

function guessMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Host-side `file_upload` file reader: reads local file paths up to 10 MiB total (`10485760` bytes)
 * and transforms `{ paths, ref, tabId }` into `{ files: [{ data: base64, name, mimeType }], ref, tabId }`.
 * Replicates `ZKt()` in `chunk-dygr1ker.js`.
 */
async function transformFileUploadArgs(
	args: Record<string, unknown>,
	cwd: string,
): Promise<
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; error: string }
> {
	const rawPaths = args.paths;
	if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
		return { ok: false, error: "file_upload requires a non-empty 'paths' array" };
	}

	const files: Array<{ data: string; name: string; mimeType: string }> = [];
	let totalBytes = 0;

	for (const p of rawPaths) {
		if (typeof p !== "string") {
			return { ok: false, error: `Invalid file path: ${String(p)}` };
		}
		const resolvedPath = path.isAbsolute(p) ? p : path.resolve(cwd, p);
		let buf: Buffer;
		try {
			buf = await fsp.readFile(resolvedPath);
		} catch (err: any) {
			return { ok: false, error: `Cannot read file "${resolvedPath}": ${err.message}` };
		}
		totalBytes += buf.byteLength;
		if (totalBytes > MAX_FILE_UPLOAD_BYTES) {
			return {
				ok: false,
				error: `Total file size exceeds ${formatBytes(MAX_FILE_UPLOAD_BYTES)} limit (${formatBytes(totalBytes)}). Split into smaller uploads.`,
			};
		}
		files.push({
			data: buf.toString("base64"),
			name: path.basename(resolvedPath),
			mimeType: guessMimeType(resolvedPath),
		});
	}

	return {
		ok: true,
		args: {
			files,
			ref: args.ref,
			tabId: args.tabId,
		},
	};
}

let screenshotDir: string | null = null;
let screenshotCounter = 0;

function getScreenshotDir(): string {
	if (!screenshotDir) {
		screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-chrome-screenshots-"));
	}
	return screenshotDir;
}

/**
 * Save base64 screenshot blocks to disk when `save_to_disk: true` is passed to `computer` or `browser_batch`.
 * Replicates `qKt()` in `chunk-dygr1ker.js`.
 */
function saveScreenshotsFromResponse(response: ExtensionToolResponse): string[] {
	const content = response.result?.content ?? response.error?.content;
	if (!Array.isArray(content)) return [];
	const savedPaths: string[] = [];

	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			block.type === "image" &&
			block.source &&
			typeof block.source.data === "string"
		) {
			try {
				const dir = getScreenshotDir();
				const filePath = path.join(dir, `screenshot-${Date.now()}-${++screenshotCounter}.png`);
				fs.writeFileSync(filePath, Buffer.from(block.source.data, "base64"));
				savedPaths.push(filePath);
			} catch {
				// Ignore write failures
			}
		}
	}
	return savedPaths;
}

/**
 * Normalize extension content blocks into Pi's `(TextContent | ImageContent)[]`.
 * Replicates `oe()` in `chunk-dygr1ker.js`.
 */
function normalizeExtensionContent(
	rawContent: ToolResultBlock[] | ToolResultBlock | string | undefined,
): (TextContent | ImageContent)[] {
	if (rawContent === undefined || rawContent === null) {
		return [{ type: "text", text: "Tool execution completed" }];
	}
	if (typeof rawContent === "string") {
		return [{ type: "text", text: rawContent }];
	}

	const blocks = Array.isArray(rawContent) ? rawContent : [rawContent];
	const result: (TextContent | ImageContent)[] = [];

	for (const block of blocks) {
		if (!block || typeof block !== "object") {
			result.push({ type: "text", text: String(block) });
			continue;
		}
		if (block.type === "image") {
			if (block.source && typeof block.source.data === "string") {
				result.push({
					type: "image",
					data: block.source.data,
					mimeType: block.source.media_type || "image/png",
				});
				continue;
			}
			if (typeof block.data === "string") {
				result.push({
					type: "image",
					data: block.data,
					mimeType: block.mimeType || "image/png",
				});
				continue;
			}
		}
		if (typeof block.text === "string") {
			result.push({ type: "text", text: block.text });
		} else {
			result.push({ type: "text", text: JSON.stringify(block) });
		}
	}

	return result.length > 0 ? result : [{ type: "text", text: "Tool execution completed" }];
}

function parseFirstTabFromTabsContext(
	response: ExtensionToolResponse,
): { tabId: number; tabGroupId?: number } | null {
	const content = response.result?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
			try {
				const parsed = JSON.parse(block.text);
				const tabs = Array.isArray(parsed) ? parsed : parsed?.availableTabs;
				if (Array.isArray(tabs) && tabs.length > 0 && typeof tabs[0].tabId === "number") {
					return {
						tabId: tabs[0].tabId,
						tabGroupId: typeof parsed?.tabGroupId === "number" ? parsed.tabGroupId : tabs[0].tabGroupId,
					};
				}
			} catch {
				// Ignore non-JSON text blocks
			}
		}
	}
	return null;
}

export interface BrowserToolExecutionOptions {
	/** Abort signal from Pi. When it fires, Pi stops waiting for the browser. */
	signal?: AbortSignal;
	/** Pi's tool-call id, relayed as `tool_use_id` so the response can be correlated. */
	toolCallId?: string;
}

export class ChromeExecutionManager {
	public readonly pool: SocketPool;
	private readonly trackedTabIds = new Set<number>();
	/**
	 * Abort signal of the browser tool currently being awaited. `find` samples the
	 * page with Pi's own model via an `inference_request` notification while the
	 * tool is in flight, so this is the signal that nested model call must honour.
	 */
	public activeAbortSignal: AbortSignal | undefined;

	constructor(pool: SocketPool) {
		this.pool = pool;
	}

	public getTrackedTabIds(): ReadonlySet<number> {
		return this.trackedTabIds;
	}

	public clearTrackedTabs(): void {
		this.trackedTabIds.clear();
	}

	/**
	 * Execute a Claude in Chrome tool with full fidelity to `e()` in `chunk-dygr1ker.js`.
	 */
	public async executeBrowserTool(
		rawToolName: string,
		rawArgs: Record<string, unknown>,
		ctx: ExtensionToolContext,
		options: BrowserToolExecutionOptions = {},
	): Promise<{ content: (TextContent | ImageContent)[]; isError?: boolean; details?: Record<string, unknown> }> {
		const toolName = rawToolName.startsWith(CHROME_TOOL_PREFIX)
			? rawToolName.slice(CHROME_TOOL_PREFIX.length)
			: rawToolName;

		const callerSignal = options.signal;
		if (callerSignal?.aborted) {
			return abortedToolResult(toolName);
		}

		this.activeAbortSignal = callerSignal;
		try {
			return await this.runBrowserTool(toolName, rawArgs, ctx, options);
		} finally {
			if (this.activeAbortSignal === callerSignal) {
				this.activeAbortSignal = undefined;
			}
		}
	}

	private async runBrowserTool(
		toolName: string,
		rawArgs: Record<string, unknown>,
		ctx: ExtensionToolContext,
		options: BrowserToolExecutionOptions,
	): Promise<{ content: (TextContent | ImageContent)[]; isError?: boolean; details?: Record<string, unknown> }> {
		const signal = options.signal;

		let args: Record<string, unknown> = { ...rawArgs };

		// Handle local meta-tool `list_connected_browsers`
		if (toolName === "list_connected_browsers") {
			const connected = await this.pool.ensureConnected();
			const sockets = this.pool.getConnectedSockets();
			if (!connected || sockets.length === 0) {
				return {
					content: [{ type: "text", text: "No browsers currently connected." }],
				};
			}
			const lines = sockets.map(
				(s, idx) => `- Browser #${idx + 1}: socket=${s} (connected)`,
			);
			return {
				content: [
					{
						type: "text",
						text: `Connected Chrome instances (${sockets.length}):\n${lines.join("\n")}`,
					},
				],
			};
		}

		// Ensure socket pool is connected
		const isConnected = await this.pool.ensureConnected();
		if (!isConnected) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `Browser extension is not connected. Please ensure the Claude in Chrome extension is installed and active (${CHROME_INSTALL_URL}), or visit ${CHROME_RECONNECT_URL} to reconnect the native host. You can also run \`/chrome status\` or \`/chrome install-host\` in Pi.`,
					},
				],
			};
		}

		// Track tabId for empty tab-group cleanup on session shutdown
		if (typeof args.tabId === "number") {
			this.trackedTabIds.add(args.tabId);
		}

		// Handle `save_to_disk` on `computer` or inside `browser_batch` (`NKt` in chunk-dygr1ker.js)
		let shouldSaveScreenshots = toolName === "computer" && Boolean(args.save_to_disk);
		if (toolName === "browser_batch" && Array.isArray(args.actions)) {
			const patchedActions: Array<{ name: string; input: Record<string, unknown> }> = [];
			for (const action of args.actions as Array<{ name: string; input?: Record<string, unknown> }>) {
				const actionInput = { ...(action.input ?? {}) };
				if (typeof actionInput.tabId === "number") {
					this.trackedTabIds.add(actionInput.tabId);
				}
				if (action.name === "computer" && actionInput.save_to_disk) {
					shouldSaveScreenshots = true;
					const { save_to_disk: _omit, ...restInput } = actionInput;
					patchedActions.push({ ...action, input: restInput });
				} else if (action.name === "file_upload") {
					const transformed = await transformFileUploadArgs(actionInput, ctx.cwd);
					if (!transformed.ok) {
						return {
							isError: true,
							content: [{ type: "text", text: `Error: ${transformed.error}` }],
						};
					}
					patchedActions.push({ ...action, input: transformed.args });
				} else {
					patchedActions.push({ ...action, input: actionInput });
				}
			}
			args = { ...args, actions: patchedActions };
		}

		// Handle standalone `file_upload` (`ZKt` in chunk-dygr1ker.js)
		if (toolName === "file_upload") {
			const transformed = await transformFileUploadArgs(args, ctx.cwd);
			if (!transformed.ok) {
				return {
					isError: true,
					content: [{ type: "text", text: `Error: ${transformed.error}` }],
				};
			}
			args = transformed.args;
		}

		// Handle standalone `navigate` without `tabId` -> Auto front-load `tabs_context_mcp({ createIfEmpty: true })`
		// Replicates lines 536-573 in `chunk-dygr1ker.js`
		let frontLoadedTabInfo: { tabId: number; tabGroupId?: number } | null = null;
		const urlArg = typeof args.url === "string" ? args.url.trim().toLowerCase() : "";
		if (
			toolName === "navigate" &&
			args.tabId === undefined &&
			urlArg !== "back" &&
			urlArg !== "forward"
		) {
			try {
				const tabsResp = await this.pool.callTool(
					"tabs_context_mcp",
					{ createIfEmpty: true },
					{
						timeoutMs: 8000,
						signal,
						requestId: options.toolCallId ? `${options.toolCallId}:tabs` : undefined,
					},
				);
				if (!tabsResp.error) {
					frontLoadedTabInfo = parseFirstTabFromTabsContext(tabsResp);
					if (frontLoadedTabInfo) {
						args = { ...args, tabId: frontLoadedTabInfo.tabId };
						this.trackedTabIds.add(frontLoadedTabInfo.tabId);
					}
				}
			} catch {
				// Proceed without front-loading if timeout/error
			}
		}

		try {
			const response = await this.pool.callTool(toolName, args, {
				signal,
				requestId: options.toolCallId,
			});
			if (!response) {
				return {
					isError: true,
					content: [{ type: "text", text: "Error: No response received from browser extension" }],
				};
			}

			// Track any tabs returned by `tabs_context_mcp` or `tabs_create_mcp`
			const parsedTab = parseFirstTabFromTabsContext(response);
			if (parsedTab) {
				this.trackedTabIds.add(parsedTab.tabId);
			}

			let savedFiles: string[] = [];
			if (shouldSaveScreenshots) {
				savedFiles = saveScreenshotsFromResponse(response);
			}

			if (response.error) {
				const errBlocks = normalizeExtensionContent(response.error.content);
				const firstText = errBlocks.find((b) => b.type === "text")?.text ?? "";
				if (firstText.includes("Could not verify this site's safety category")) {
					errBlocks.push({
						type: "text",
						text: `\n[pi-claude-in-chrome hint] The Claude in Chrome extension (fcoeoabgfenejglbffodgkkbkcdhcgfn) blocked navigation because its claude.ai OAuth token is missing/expired and it could not reach https://api.anthropic.com/api/web/url_hash_check/browser_extension. Run \`/chrome unlock\` in Pi for a 1-line Chrome DevTools fix that switches the extension to offline API-Key Mode.`,
					});
				}
				if (firstText.includes("Anthropic client not available")) {
					errBlocks.push({
						type: "text",
						text: `\n[pi-claude-in-chrome hint] \`find\` asks the host for a model sample and Pi did not provide one (extension build without the Pi inference relay, or no active model). Use \`read_page\` / \`get_page_text\` and pick the ref yourself instead of \`find\`.`,
					});
				}
				return {
					isError: true,
					content: errBlocks,
				};
			}

			const content = normalizeExtensionContent(response.result?.content);

			if (savedFiles.length > 0) {
				content.push({
					type: "text",
					text: savedFiles.map((p) => `Screenshot saved to: ${p}`).join("\n"),
				});
			}

			if (frontLoadedTabInfo) {
				content.push({
					type: "text",
					text: `\nTab context (from front-loaded tabs_context_mcp): ${JSON.stringify({
						tabId: frontLoadedTabInfo.tabId,
						...(frontLoadedTabInfo.tabGroupId !== undefined
							? { tabGroupId: frontLoadedTabInfo.tabGroupId }
							: {}),
					})}`,
				});
			}

			return {
				content,
				details: {
					toolName,
					tabId: args.tabId,
					savedFiles: savedFiles.length > 0 ? savedFiles : undefined,
				},
			};
		} catch (err: any) {
			// An abort/timeout is not a browser failure: Pi already stopped waiting.
			if (err instanceof ToolAbortedError || signal?.aborted) {
				return abortedToolResult(toolName);
			}
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `Browser tool execution error (${toolName}): ${err.message || String(err)}`,
					},
				],
			};
		}
	}

	/**
	 * Close empty (`chrome://newtab/`, `about:blank`, `""`) MCP tab groups on session switch/exit.
	 * Replicates `closeEmptyTabGroups` in `chunk-7m0pkhzw.js`.
	 */
	public async closeEmptyTabGroups(budgetMs = 3000): Promise<number> {
		if (this.trackedTabIds.size === 0) return 0;
		const tracked = new Set(this.trackedTabIds);
		this.trackedTabIds.clear();
		// Session shutdown/switch awaits this; a stale socket must never hang Pi for
		// (2s + 50 x 500ms) while the user is trying to quit.
		const deadline = Date.now() + budgetMs;
		const remaining = () => Math.max(0, deadline - Date.now());

		try {
			const ok = await this.pool.ensureConnected();
			if (!ok) return 0;

			const resp = await this.pool.callTool(
				"tabs_context_mcp",
				{ createIfEmpty: false },
				{ timeoutMs: Math.min(2000, remaining()) },
			);
			const content = resp.result?.content;
			if (!Array.isArray(content)) return 0;

			const tabs: Array<{ tabId: number; url?: string }> = [];
			for (const block of content) {
				if (block && block.type === "text" && typeof block.text === "string") {
					try {
						const parsed = JSON.parse(block.text);
						const list = Array.isArray(parsed) ? parsed : parsed?.availableTabs;
						if (Array.isArray(list)) {
							tabs.push(...list);
						}
					} catch {
						// Ignore
					}
				}
			}

			if (tabs.length === 0 || !tabs.some((t) => tracked.has(t.tabId))) {
				return 0;
			}

			const emptyUrls = new Set(["chrome://newtab/", "chrome://newtab", "about:blank", ""]);
			if (!tabs.every((t) => emptyUrls.has(t.url ?? ""))) {
				return 0;
			}

			let closedCount = 0;
			for (const tab of tabs.slice(0, 50)) {
				if (remaining() <= 0) break;
				try {
					await this.pool.callTool("tabs_close_mcp", { tabId: tab.tabId }, {
						timeoutMs: Math.min(500, remaining()),
					});
					closedCount++;
				} catch {
					// Ignore
				}
			}
			return closedCount;
		} catch {
			return 0;
		}
	}
}

/**
 * Result Pi shows when the user pressed ESC (or Pi timed out) mid-call.
 * The extension has no cancel method, so we can only stop waiting.
 */
function abortedToolResult(toolName: string): {
	content: (TextContent | ImageContent)[];
	isError: boolean;
} {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: `Operation aborted (${toolName}): Pi stopped waiting for the Chrome extension. Chrome's extension exposes no cancel API, so an action already sent to the browser (click, navigation, or a \`computer\` wait) may still finish there.`,
			},
		],
	};
}

/**
 * Summarize tool arguments for concise Pi TUI rendering (replicating `chunk-s9rat6j0.js`).
 */
function summarizeToolArgs(shortName: string, args: Record<string, unknown>): string {
	const parts: string[] = [];
	if (shortName === "navigate" && args.url) {
		parts.push(String(args.url));
	} else if (shortName === "computer" && args.action) {
		parts.push(String(args.action));
		if (Array.isArray(args.coordinate)) {
			parts.push(`@(${args.coordinate.join(",")})`);
		}
		if (args.text) {
			const t = String(args.text);
			parts.push(`"${t.length > 24 ? `${t.slice(0, 24)}…` : t}"`);
		}
		if (args.ref) {
			parts.push(`ref=${args.ref}`);
		}
	} else if (shortName === "javascript_tool" && args.text) {
		const code = String(args.text).replace(/\s+/g, " ").trim();
		parts.push(code.length > 48 ? `${code.slice(0, 48)}…` : code);
	} else if (shortName === "read_page") {
		if (args.filter) parts.push(`filter=${args.filter}`);
		if (args.ref_id) parts.push(`ref=${args.ref_id}`);
	} else if (shortName === "find" && args.query) {
		parts.push(`"${args.query}"`);
	} else if (shortName === "form_input" && args.ref) {
		parts.push(`${args.ref} = ${JSON.stringify(args.value)}`);
	} else if (shortName === "gif_creator" && args.action) {
		parts.push(String(args.action));
		if (args.filename) parts.push(String(args.filename));
	} else if (shortName === "browser_batch" && Array.isArray(args.actions)) {
		parts.push(`${args.actions.length} actions`);
	} else if (shortName === "file_upload" && Array.isArray(args.paths)) {
		parts.push(`${args.paths.length} file(s) -> ${args.ref}`);
	} else if (shortName === "tabs_context_mcp" && args.createIfEmpty !== undefined) {
		parts.push(`createIfEmpty=${args.createIfEmpty}`);
	}
	if (typeof args.tabId === "number") {
		parts.push(`[tab ${args.tabId}]`);
	}
	return parts.join(" ");
}

function makeTool<TParams extends TSchema>(
	manager: ChromeExecutionManager,
	shortName: string,
	title: string,
	description: string,
	parameters: TParams,
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	},
): ToolDefinition<TParams> {
	const fullName = `${CHROME_TOOL_PREFIX}${shortName}`;
	return defineTool({
		name: fullName,
		label: `Chrome: ${title}`,
		description,
		promptSnippet: `${fullName}: ${title}`,
		parameters,
		namespace: CHROME_NAMESPACE,
		annotations: {
			openWorldHint: true,
			...annotations,
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return manager.executeBrowserTool(shortName, params as Record<string, unknown>, ctx, {
				signal,
				toolCallId,
			});
		},
		renderCall(args: any, theme: any, _context: ToolRenderContext) {
			const summary = summarizeToolArgs(shortName, (args ?? {}) as Record<string, unknown>);
			const label = theme.fg("toolTitle", theme.bold(`🌐 chrome:${shortName}`));
			const detail = summary ? ` ${theme.fg("muted", summary)}` : "";
			return new Text(label + detail, 0, 0);
		},
		renderResult(result: any, { expanded }: ToolRenderResultOptions, theme: any, _context: ToolRenderContext) {
			if (result.isError) {
				const errText = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "Browser error";
				return new Text(theme.fg("error", `✗ ${errText}`), 0, 0);
			}
			const images = (result.content ?? []).filter((c: any) => c.type === "image");
			const texts = (result.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n")
				.trim();

			const firstLine = texts.split("\n")[0] ?? "Completed";
			const preview =
				firstLine.length > 90 && !expanded ? `${firstLine.slice(0, 90)}…` : firstLine;
			const imgBadge = images.length > 0 ? theme.fg("accent", ` [📷 ${images.length} screenshot]`) : "";
			const headline = `${theme.fg("success", "✓")} ${theme.fg("muted", preview)}${imgBadge}`;

			if (expanded && texts.includes("\n")) {
				return new Text(`${headline}\n${theme.fg("dim", texts)}`, 0, 0);
			}
			return new Text(headline, 0, 0);
		},
	});
}

/**
 * Build all 20 Claude in Chrome tools (19 local browser tools from `Aut` in `chunk-7kjwdqkx.js` + `list_connected_browsers`).
 */
export function createChromeBrowserTools(manager: ChromeExecutionManager): ToolDefinition<any>[] {
	return [
		// 1. tabs_context_mcp
		makeTool(
			manager,
			"tabs_context_mcp",
			"Tabs Context",
			"Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
			Type.Object({
				createIfEmpty: Type.Optional(
					Type.Boolean({
						description:
							"Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.",
					}),
				),
			}),
			{ readOnlyHint: true },
		),

		// 2. tabs_create_mcp
		makeTool(
			manager,
			"tabs_create_mcp",
			"Tabs Create",
			"Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools.",
			Type.Object({}),
		),

		// 3. tabs_close_mcp
		makeTool(
			manager,
			"tabs_close_mcp",
			"Tabs Close",
			"Closes a tab or multiple tabs by their tab IDs.",
			Type.Object({
				tabId: Type.Number({
					description: "Tab ID to close.",
				}),
			}),
			{ destructiveHint: true },
		),

		// 4. navigate
		makeTool(
			manager,
			"navigate",
			"Navigate",
			'Navigate to a URL, or go forward/back in browser history. Provide a tabId to navigate an existing tab, or omit tabId on the first call of a session to automatically create a new tab (saving a separate tabs_context_mcp round-trip). Always provide tabId when navigating a tab you are already working with or when using "back"/"forward".',
			Type.Object({
				url: Type.String({
					description:
						'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.',
				}),
				tabId: Type.Optional(
					Type.Number({
						description:
							'Tab ID to navigate. Omit ONLY on the first navigate of a session to auto-create a fresh tab; always provide when navigating an existing tab or using "back"/"forward".',
					}),
				),
			}),
		),

		// 5. read_page
		makeTool(
			manager,
			"read_page",
			"Read Page DOM / Accessibility Tree",
			"Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. Always call this or get_page_text before interacting with elements by ref.",
			Type.Object({
				filter: Type.Optional(
					Type.Union([Type.Literal("interactive"), Type.Literal("all")], {
						description:
							'Filter elements: "all" returns all elements including non-visible ones, "interactive" returns only interactive/clickable/focusable elements.',
					}),
				),
				tabId: Type.Number({
					description: "Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
				}),
				depth: Type.Optional(
					Type.Number({
						description: "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large.",
					}),
				),
				ref_id: Type.Optional(
					Type.String({
						description: "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large.",
					}),
				),
				max_chars: Type.Optional(
					Type.Number({
						description: "Maximum character limit for output (default: 50000). Set to a higher value if your client can handle large outputs.",
					}),
				),
			}),
			{ readOnlyHint: true },
		),

		// 6. get_page_text
		makeTool(
			manager,
			"get_page_text",
			"Get Page Text",
			"Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting.",
			Type.Object({
				tabId: Type.Number({
					description: "Tab ID to extract text from. Must be a tab in the current group.",
				}),
			}),
			{ readOnlyHint: true },
		),

		// 7. find
		makeTool(
			manager,
			"find",
			"Find Elements",
			'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools.',
			Type.Object({
				query: Type.String({
					description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")',
				}),
				tabId: Type.Number({
					description: "Tab ID to search in. Must be a tab in the current group.",
				}),
			}),
			{ readOnlyHint: true },
		),

		// 8. form_input
		makeTool(
			manager,
			"form_input",
			"Form Input",
			"Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first.",
			Type.Object({
				ref: Type.String({
					description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")',
				}),
				value: Type.Union([Type.String(), Type.Boolean(), Type.Number()], {
					description: "The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number",
				}),
				tabId: Type.Number({
					description: "Tab ID to set form value in. Must be a tab in the current group.",
				}),
			}),
		),

		// 9. computer
		makeTool(
			manager,
			"computer",
			"Computer Mouse / Keyboard / Screenshot",
			"Use a mouse and keyboard to interact with a web browser, and take screenshots. Whenever you intend to click on an element, prefer using `ref` from `read_page` or `find`, or take a `screenshot` first to determine coordinates.",
			Type.Object({
				action: Type.Union(
					[
						Type.Literal("left_click"),
						Type.Literal("right_click"),
						Type.Literal("type"),
						Type.Literal("screenshot"),
						Type.Literal("wait"),
						Type.Literal("scroll"),
						Type.Literal("key"),
						Type.Literal("left_click_drag"),
						Type.Literal("double_click"),
						Type.Literal("triple_click"),
						Type.Literal("zoom"),
						Type.Literal("scroll_to"),
						Type.Literal("hover"),
					],
					{
						description:
							"The action to perform: `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `left_click_drag`, `type`, `key`, `screenshot`, `wait`, `scroll`, `scroll_to`, or `zoom`.",
					},
				),
				tabId: Type.Number({
					description: "Tab ID to execute the action on.",
				}),
				coordinate: Type.Optional(
					Type.Array(Type.Number(), {
						description: "(x, y): The (x, y) pixel coordinates for click/scroll/hover.",
					}),
				),
				text: Type.Optional(
					Type.String({
						description: "The text to type (for `type` action) or key/chord to press (for `key` action, e.g. 'Enter', 'Backspace', 'cmd+a').",
					}),
				),
				duration: Type.Optional(
					Type.Number({
						description: "The number of seconds to wait (for `wait` action, max 30).",
					}),
				),
				scroll_direction: Type.Optional(
					Type.Union(
						[Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")],
						{ description: "The direction to scroll (`up`, `down`, `left`, `right`)." },
					),
				),
				scroll_amount: Type.Optional(
					Type.Number({
						description: "The number of scroll wheel ticks (default 3, max 10).",
					}),
				),
				start_coordinate: Type.Optional(
					Type.Array(Type.Number(), {
						description: "(x, y): Starting coordinates for `left_click_drag`.",
					}),
				),
				region: Type.Optional(
					Type.Array(Type.Number(), {
						description: "(x0, y0, x1, y1): Rectangular region to inspect for `zoom`.",
					}),
				),
				repeat: Type.Optional(
					Type.Number({
						description: "Number of times to repeat key press (for `key` action, 1-100).",
					}),
				),
				ref: Type.Optional(
					Type.String({
						description: 'Element reference ID from read_page or find (e.g. "ref_1") for click/hover/scroll_to.',
					}),
				),
				modifiers: Type.Optional(
					Type.String({
						description: 'Modifier keys for click actions (e.g., "shift", "ctrl", "alt", "meta", "cmd+shift").',
					}),
				),
				save_to_disk: Type.Optional(
					Type.Boolean({
						description: "When true on `screenshot` or `zoom`, saves the screenshot PNG to a temporary file on disk and returns its path.",
					}),
				),
			}),
		),

		// 10. javascript_tool
		makeTool(
			manager,
			"javascript_tool",
			"Execute JavaScript in Page",
			"Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. Do NOT use `javascript_exec` to call alert(), confirm(), or prompt().",
			Type.Object({
				action: Type.Literal("javascript_exec", {
					description: "Must be set to 'javascript_exec'",
				}),
				text: Type.String({
					description: "The JavaScript code to execute. The result of the last expression will be returned automatically. Do NOT use 'return' statements unless inside a function body.",
				}),
				tabId: Type.Number({
					description: "Tab ID to execute the code in. Must be a tab in the current group.",
				}),
			}),
		),

		// 11. browser_batch
		makeTool(
			manager,
			"browser_batch",
			"Batch Browser Actions",
			"Execute multiple browser actions in a single call. Actions run sequentially and stop on the first error. Use this to chain known sequences like navigate -> wait -> read_page, or form_input -> form_input -> click, saving round-trips. Maximum 20 actions per batch. browser_batch cannot be nested inside itself.",
			Type.Object({
				actions: Type.Array(
					Type.Object({
						name: Type.String({
							description: "Tool name without the mcp__claude-in-chrome__ prefix (e.g. 'navigate', 'computer', 'read_page', 'form_input', 'find', 'file_upload').",
						}),
						input: Type.Record(Type.String(), Type.Unknown(), {
							description: "Arguments object for that tool.",
						}),
					}),
					{
						description: "Ordered list of browser tool actions to execute sequentially (1 to 20 actions).",
					},
				),
			}),
		),

		// 12. read_console_messages
		makeTool(
			manager,
			"read_console_messages",
			"Read Console Logs",
			"Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Always provide a pattern to filter the messages when looking for specific logs.",
			Type.Object({
				tabId: Type.Number({
					description: "Tab ID to read console messages from.",
				}),
				onlyErrors: Type.Optional(
					Type.Boolean({
						description: "If true, only return error and exception messages. Default is false.",
					}),
				),
				clear: Type.Optional(
					Type.Boolean({
						description: "If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false.",
					}),
				),
				pattern: Type.Optional(
					Type.String({
						description: "Regex pattern to filter console messages. Only messages matching this pattern will be returned.",
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description: "Maximum number of messages to return. Defaults to 100.",
					}),
				),
			}),
			{ readOnlyHint: true },
		),

		// 13. read_network_requests
		makeTool(
			manager,
			"read_network_requests",
			"Read Network Requests",
			"Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls and monitoring network activity.",
			Type.Object({
				tabId: Type.Number({
					description: "Tab ID to read network requests from.",
				}),
				urlPattern: Type.Optional(
					Type.String({
						description: "Optional URL substring filter (e.g. '/api/', 'graphql').",
					}),
				),
				clear: Type.Optional(
					Type.Boolean({
						description: "If true, clear the network requests after reading. Default is false.",
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description: "Maximum number of requests to return. Defaults to 100.",
					}),
				),
			}),
			{ readOnlyHint: true },
		),

		// 14. resize_window
		makeTool(
			manager,
			"resize_window",
			"Resize Browser Window",
			"Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting a specific viewport size.",
			Type.Object({
				width: Type.Number({ description: "Target window width in pixels" }),
				height: Type.Number({ description: "Target window height in pixels" }),
				tabId: Type.Number({ description: "Tab ID to get the window for." }),
			}),
		),

		// 15. gif_creator
		makeTool(
			manager,
			"gif_creator",
			"Record Animated GIF",
			"Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays.",
			Type.Object({
				action: Type.Union(
					[
						Type.Literal("start_recording"),
						Type.Literal("stop_recording"),
						Type.Literal("export"),
						Type.Literal("clear"),
					],
					{
						description:
							"Action to perform: 'start_recording', 'stop_recording', 'export', or 'clear'.",
					},
				),
				tabId: Type.Number({
					description: "Tab ID to identify which tab group this operation applies to",
				}),
				download: Type.Optional(
					Type.Boolean({
						description: "Always set this to true for the 'export' action only. This downloads the GIF in the browser.",
					}),
				),
				filename: Type.Optional(
					Type.String({
						description: "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only.",
					}),
				),
				options: Type.Optional(
					Type.Object({
						showClickIndicators: Type.Optional(Type.Boolean()),
						showDragPaths: Type.Optional(Type.Boolean()),
						showActionLabels: Type.Optional(Type.Boolean()),
						showProgressBar: Type.Optional(Type.Boolean()),
						showWatermark: Type.Optional(Type.Boolean()),
						quality: Type.Optional(Type.Number()),
					}),
				),
			}),
		),

		// 16. upload_image
		makeTool(
			manager,
			"upload_image",
			"Upload Screenshot / Image to Page",
			"Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target.",
			Type.Object({
				imageId: Type.String({
					description: "ID of a previously captured screenshot or user-uploaded image.",
				}),
				tabId: Type.Number({
					description: "Tab ID where the target element is located.",
				}),
				ref: Type.Optional(
					Type.String({
						description: 'Element reference ID from read_page or find (e.g. "ref_1"). Provide either ref or coordinate.',
					}),
				),
				coordinate: Type.Optional(
					Type.Array(Type.Number(), {
						description: "[x, y] viewport coordinates for drag & drop target.",
					}),
				),
				filename: Type.Optional(
					Type.String({
						description: 'Optional filename for the uploaded file (default: "image.png")',
					}),
				),
			}),
		),

		// 17. file_upload
		makeTool(
			manager,
			"file_upload",
			"Upload Local Files to File Input",
			"Upload one or more files from the local filesystem to a file input element on the page. Reads files on the host, base64-encodes them (up to 10 MB total), and transfers them to the browser extension. Do NOT use javascript_tool or computer click on file inputs, as native OS file dialogs block browser automation.",
			Type.Object({
				paths: Type.Array(Type.String(), {
					description: "The absolute paths to the files to upload. Can be a single file or multiple files (for file inputs with the 'multiple' attribute).",
				}),
				ref: Type.String({
					description: 'Element reference ID of the file input from read_page or find (e.g., "ref_1", "ref_2"). Must be an <input type="file"> element.',
				}),
				tabId: Type.Number({
					description: "Tab ID where the file input is located.",
				}),
			}),
		),

		// 18. shortcuts_list
		makeTool(
			manager,
			"shortcuts_list",
			"List Saved Browser Shortcuts",
			"List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows.",
			Type.Object({
				tabId: Type.Number({
					description: "Tab ID to list shortcuts from.",
				}),
			}),
			{ readOnlyHint: true },
		),

		// 19. shortcuts_execute
		makeTool(
			manager,
			"shortcuts_execute",
			"Execute Saved Browser Shortcut",
			"Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts.",
			Type.Object({
				tabId: Type.Number({
					description: "Tab ID to execute the shortcut on.",
				}),
				shortcutId: Type.Optional(
					Type.String({
						description: "The ID of the shortcut to execute",
					}),
				),
				command: Type.Optional(
					Type.String({
						description: "The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash.",
					}),
				),
			}),
		),

		// 20. list_connected_browsers
		makeTool(
			manager,
			"list_connected_browsers",
			"List Connected Browsers",
			"List all connected Chrome browser bridge sockets in the local socket pool.",
			Type.Object({}),
			{ readOnlyHint: true },
		),
	];
}
