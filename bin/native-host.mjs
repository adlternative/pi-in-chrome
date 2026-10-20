#!/usr/bin/env node
/**
 * Standalone Chrome Native Messaging Host entrypoint (`pi-chrome-native-host`).
 * Compatible with both Pi and Claude Code (`com.anthropic.claude_code_browser_extension`).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const MAX_MESSAGE_SIZE = 1048576;
const NATIVE_HOST_VERSION = "1.0.0";

function getSocketDirPaths() {
	let username = "default";
	try {
		username = os.userInfo().username || "default";
	} catch {
		username = process.env.USER || process.env.USERNAME || "default";
	}
	if (process.platform === "win32") {
		return [
			`\\\\.\\pipe\\pi-mcp-browser-bridge-${username}`,
			`\\\\.\\pipe\\claude-mcp-browser-bridge-${username}`,
		];
	}
	return [
		`/tmp/pi-mcp-browser-bridge-${username}`,
		`/tmp/claude-mcp-browser-bridge-${username}`,
	];
}

function writeToChromeStdout(message) {
	const payload = Buffer.from(JSON.stringify(message), "utf-8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(payload.length, 0);
	process.stdout.write(header);
	process.stdout.write(payload);
}

class NativeStdinReader {
	buffer = Buffer.alloc(0);
	pendingResolve = null;
	closed = false;

	constructor() {
		process.stdin.on("data", (chunk) => {
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

	tryProcessMessage() {
		if (!this.pendingResolve || this.buffer.length < 4) return;
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

	async read() {
		if (this.closed) return null;
		if (this.buffer.length >= 4) {
			const len = this.buffer.readUInt32LE(0);
			if (len > 0 && len <= MAX_MESSAGE_SIZE && this.buffer.length >= 4 + len) {
				const payload = this.buffer.subarray(4, 4 + len);
				this.buffer = this.buffer.subarray(4 + len);
				return payload.toString("utf-8");
			}
		}
		return new Promise((resolve) => {
			this.pendingResolve = resolve;
			this.tryProcessMessage();
		});
	}
}

async function main() {
	const mcpClients = new Map();
	let nextClientId = 1;
	const [piDir, claudeDir] = getSocketDirPaths();
	const socketDir = piDir;

	if (process.platform !== "win32") {
		for (const dir of [piDir, claudeDir]) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			try {
				fs.chmodSync(dir, 0o700);
			} catch {}
			try {
				for (const file of fs.readdirSync(dir)) {
					if (!file.endsWith(".sock")) continue;
					const pid = Number.parseInt(file.replace(/^pi-/, "").replace(".sock", ""), 10);
					if (!Number.isNaN(pid)) {
						try {
							process.kill(pid, 0);
						} catch (e) {
							if (e && e.code === "ESRCH") {
								try {
									fs.unlinkSync(path.join(dir, file));
								} catch {}
							}
						}
					}
				}
			} catch {}
		}
	}

	const socketPath =
		process.platform === "win32" ? socketDir : path.join(socketDir, `${process.pid}.sock`);
	const mirrorPath =
		process.platform === "win32" ? null : path.join(claudeDir, `pi-${process.pid}.sock`);

	if (process.platform !== "win32") {
		for (const p of [socketPath, mirrorPath]) {
			if (p && fs.existsSync(p)) {
				try {
					fs.unlinkSync(p);
				} catch {}
			}
		}
	}

	const server = net.createServer((socket) => {
		const id = nextClientId++;
		const entry = { id, socket, buffer: Buffer.alloc(0) };
		mcpClients.set(id, entry);
		writeToChromeStdout({ type: "mcp_connected" });

		socket.on("data", (chunk) => {
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
						// Answer to a model sample the extension delegated to Pi (`find`).
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
				} catch {}
			}
		});

		socket.on("close", () => {
			mcpClients.delete(id);
			writeToChromeStdout({ type: "mcp_disconnected" });
		});
		socket.on("error", () => {});
	});

	await new Promise((resolve, reject) => {
		server.listen(socketPath, () => {
			if (process.platform !== "win32") {
				try {
					fs.chmodSync(socketPath, 0o600);
				} catch {}
				if (mirrorPath) {
					try {
						fs.symlinkSync(socketPath, mirrorPath);
					} catch {}
				}
			}
			resolve();
		});
		server.on("error", reject);
	});

	const reader = new NativeStdinReader();
	while (true) {
		const msgText = await reader.read();
		if (msgText === null) break;
		try {
			const msg = JSON.parse(msgText);
			if (msg.type === "ping") {
				writeToChromeStdout({ type: "pong", timestamp: Date.now() });
			} else if (msg.type === "get_status") {
				writeToChromeStdout({
					type: "status_response",
					native_host_version: NATIVE_HOST_VERSION,
				});
			} else if (msg.type === "tool_response" || msg.type === "notification") {
				const { type: _omit, ...rest } = msg;
				const payload = Buffer.from(JSON.stringify(rest), "utf-8");
				const header = Buffer.allocUnsafe(4);
				header.writeUInt32LE(payload.length, 0);
				const frame = Buffer.concat([header, payload]);
				for (const client of mcpClients.values()) {
					try {
						client.socket.write(frame);
					} catch {}
				}
			}
		} catch {}
	}

	for (const client of mcpClients.values()) {
		client.socket.destroy();
	}
	await new Promise((resolve) => server.close(resolve));
	if (process.platform !== "win32") {
		for (const p of [socketPath, mirrorPath]) {
			if (p && fs.existsSync(p)) {
				try {
					fs.unlinkSync(p);
				} catch {}
			}
		}
	}
}

main().catch(() => process.exit(1));
