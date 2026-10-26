/**
 * Offline tests for the bridge wire protocol (`src/protocol.ts`).
 *
 * They run against a fake extension: a Unix socket that speaks the same
 * 4-byte-UInt32LE length-prefixed JSON frames as the Chrome Native Messaging
 * host, so no Chrome instance or native host binary is required.
 *
 * What is covered: request/response correlation (`tool_use_id`), aborting a
 * tool call from Pi (ESC), and the tombstone bookkeeping that keeps a late
 * response from being delivered to an unrelated call.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SocketClient, ToolAbortedError } from "../src/protocol.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Write one length-prefixed frame, mirroring `SocketClient.writeFrame`. */
function writeFrame(socket, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf-8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(body.length, 0);
	socket.write(Buffer.concat([header, body]));
}

/**
 * Start a stand-in for the extension side of the bridge.
 *
 * `onRequest(frame, respond, raw)` receives one parsed `execute_tool` frame; call
 * `respond(result)` (or `respond({ error })`) whenever the test wants the
 * response to arrive, and `raw(payload)` to write an arbitrary frame (used to
 * simulate a response meant for somebody else). `echoToolUseId: false`
 * simulates older extension builds that never echoed `tool_use_id` back.
 */
async function startFakeExtension({ echoToolUseId = true, onRequest } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-in-chrome-test-"));
	fs.chmodSync(dir, 0o700);
	const socketPath = path.join(dir, "bridge.sock");
	const requests = [];
	const sockets = new Set();

	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4) {
				const frameLen = buffer.readUInt32LE(0);
				if (buffer.length < 4 + frameLen) break;
				const frame = JSON.parse(buffer.subarray(4, 4 + frameLen).toString("utf-8"));
				buffer = buffer.subarray(4 + frameLen);
				if (frame.method !== "execute_tool") continue;
				requests.push(frame);
				const raw = (payload) => writeFrame(socket, payload);
				const respond = (payload) => {
					raw({
						type: "tool_response",
						...(echoToolUseId && frame.params?.tool_use_id ? { tool_use_id: frame.params.tool_use_id } : {}),
						...payload,
					});
				};
				onRequest?.(frame, respond, raw);
			}
		});
	});

	await new Promise((resolve) => server.listen(socketPath, resolve));
	// `validateSocketSecurity` requires 0600 on the socket and 0700 on the directory.
	fs.chmodSync(socketPath, 0o600);

	return {
		socketPath,
		requests,
		/** Tool names in the order Pi sent them. */
		toolNames: () => requests.map((frame) => frame.params.tool),
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Response payload shaped like the extension's `tool_response`. */
function textResult(text) {
	return { result: { content: [{ type: "text", text }] } };
}

/** Text of the first content block of a response. */
function firstText(response) {
	return response.result?.content?.[0]?.text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Set up a fake extension + a connected client, torn down after the test. */
async function withBridge(t, options, body) {
	const extension = await startFakeExtension(options);
	const client = new SocketClient({
		socketPath: extension.socketPath,
		logger: silentLogger,
		toolCallTimeoutMs: 3000,
	});
	t.after(async () => {
		client.disconnect();
		await extension.close();
	});
	const connected = await client.ensureConnected();
	assert.equal(connected, true, "client failed to connect to the fake extension socket");
	await body({ client, extension });
}

describe("SocketClient tool calls", () => {
	it("resolves a call with the response the extension sent back", async (t) => {
		await withBridge(t, { onRequest: (_frame, respond) => respond(textResult("pong")) }, async ({ client }) => {
			const response = await client.callTool("read_page", { tabId: 1 });
			assert.equal(firstText(response), "pong");
		});
	});

	it("sends the request id as tool_use_id so responses can be correlated", async (t) => {
		await withBridge(t, { onRequest: (_frame, respond) => respond(textResult("ok")) }, async ({ client, extension }) => {
			await client.callTool("read_page", { tabId: 1 }, { requestId: "call-1" });
			assert.equal(extension.requests[0].params.tool_use_id, "call-1");
		});
	});

	it("generates a unique id per call when the caller does not provide one", async (t) => {
		await withBridge(t, { onRequest: (_frame, respond) => respond(textResult("ok")) }, async ({ client, extension }) => {
			await client.callTool("read_page", { tabId: 1 });
			await client.callTool("read_page", { tabId: 1 });
			const [first, second] = extension.requests.map((frame) => frame.params.tool_use_id);
			assert.ok(first, "first call should carry a generated tool_use_id");
			assert.ok(second, "second call should carry a generated tool_use_id");
			assert.notEqual(first, second);
		});
	});
});

describe("aborting a tool call (ESC in Pi)", () => {
	it("never sends the request when the signal is already aborted", async (t) => {
		await withBridge(t, { onRequest: (_frame, respond) => respond(textResult("should not happen")) }, async ({ client, extension }) => {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(
				() => client.callTool("computer", { tabId: 1, action: "wait", duration: 10 }, { signal: controller.signal }),
				ToolAbortedError,
			);
			assert.equal(extension.requests.length, 0, "aborted call must not reach the browser");
		});
	});

	it("stops waiting immediately when aborted mid-flight", async (t) => {
		// The fake extension never answers: before the fix this blocked until the
		// 60s default timeout, and ESC had no effect at all.
		await withBridge(t, { onRequest: () => {} }, async ({ client }) => {
			const controller = new AbortController();
			const started = Date.now();
			setTimeout(() => controller.abort(), 50);
			await assert.rejects(
				() => client.callTool("computer", { tabId: 1, action: "wait", duration: 30 }, { signal: controller.signal }),
				ToolAbortedError,
			);
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 1000, `abort should return immediately, took ${elapsed}ms`);
		});
	});

	it("discards the late response of an aborted call instead of resolving the next one with it", async (t) => {
		// The first (aborted) call's response arrives after the second call is in
		// flight — the exact case that used to hand the wrong result to the wrong tool.
		let answerFirst;
		let answerSecond;
		await withBridge(
			t,
			{
				onRequest: (frame, respond) => {
					if (frame.params.args.action === "wait") answerFirst = () => respond(textResult("late-wait"));
					else answerSecond = () => respond(textResult("fresh-js"));
				},
			},
			async ({ client }) => {
				const controller = new AbortController();
				const aborted = client.callTool(
					"computer",
					{ tabId: 1, action: "wait", duration: 5 },
					{ signal: controller.signal },
				);
				await sleep(20);
				controller.abort();
				await assert.rejects(() => aborted, ToolAbortedError);

				const fresh = client.callTool("javascript_tool", { tabId: 1, action: "javascript_exec", text: "1" });
				await sleep(20);

				answerFirst(); // late response for the aborted call
				answerSecond();
				assert.equal(firstText(await fresh), "fresh-js");
			},
		);
	});

	it("keeps working after an abort", async (t) => {
		let calls = 0;
		await withBridge(
			t,
			{
				onRequest: (frame, respond) => {
					calls += 1;
					if (frame.params.args.action === "wait") return; // never answered
					respond(textResult(`call-${calls}`));
				},
			},
			async ({ client }) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 20);
				await assert.rejects(
					() => client.callTool("computer", { tabId: 1, action: "wait", duration: 5 }, { signal: controller.signal }),
					ToolAbortedError,
				);
				const response = await client.callTool("read_page", { tabId: 1 });
				assert.equal(firstText(response), "call-2");
			},
		);
	});
});

describe("response correlation", () => {
	it("gives concurrent calls their own response, even out of order", async (t) => {
		const pending = [];
		await withBridge(
			t,
			{ onRequest: (frame, respond) => pending.push(() => respond(textResult(frame.params.tool))) },
			async ({ client }) => {
				const first = client.callTool("read_page", { tabId: 1 }, { requestId: "a" });
				const second = client.callTool("read_console_messages", { tabId: 1 }, { requestId: "b" });
				await sleep(50);
				assert.equal(pending.length, 2);
				pending[1](); // respond to the second request first
				pending[0]();
				assert.equal(firstText(await first), "read_page");
				assert.equal(firstText(await second), "read_console_messages");
			},
		);
	});

	it("ignores a response whose id belongs to no pending call", async (t) => {
		let sendForeign;
		let sendMine;
		await withBridge(
			t,
			{
				onRequest: (_frame, respond, raw) => {
					// Another host sharing this socket answers about an id we never used.
					sendForeign = () =>
						raw({ type: "tool_response", tool_use_id: "someone-elses-call", ...textResult("foreign") });
					sendMine = () => respond(textResult("mine"));
				},
			},
			async ({ client }) => {
				const call = client.callTool("read_page", { tabId: 1 }, { requestId: "mine" });
				await sleep(20);
				sendForeign();
				await sleep(20);
				sendMine();
				assert.equal(firstText(await call), "mine");
			},
		);
	});

	it("falls back to FIFO for extensions that do not echo tool_use_id", async (t) => {
		// Older extension builds answer without an id; the first call was aborted,
		// so its late response must be swallowed and the second call must get its own.
		const pending = [];
		await withBridge(
			t,
			{
				echoToolUseId: false,
				onRequest: (frame, respond) => pending.push(() => respond(textResult(frame.params.tool))),
			},
			async ({ client }) => {
				const controller = new AbortController();
				const aborted = client.callTool("computer", { tabId: 1, action: "wait", duration: 5 }, { signal: controller.signal });
				await sleep(20);
				controller.abort();
				await assert.rejects(() => aborted, ToolAbortedError);

				const fresh = client.callTool("read_page", { tabId: 1 });
				await sleep(20);

				pending[0](); // late response, still queued for the aborted call
				pending[1]();
				assert.equal(firstText(await fresh), "read_page");
			},
		);
	});
});

describe("timeouts", () => {
	it("does not resend a call that timed out", async (t) => {
		// A timed-out `computer` click may still have run in the browser; resending it
		// would click twice. The old code retried any SocketConnectionError.
		await withBridge(t, { onRequest: () => {} }, async ({ client, extension }) => {
			await assert.rejects(
				() => client.callTool("computer", { tabId: 1, action: "left_click" }, { timeoutMs: 100 }),
				/timed out after 100ms/,
			);
			await sleep(50);
			assert.equal(extension.requests.length, 1, "a timed-out call must not be retried");
		});
	});

	it("rejects with a timeout error and drops the late response", async (t) => {
		let answer;
		await withBridge(
			t,
			{ onRequest: (frame, respond) => (answer = () => respond(textResult(frame.params.tool))) },
			async ({ client }) => {
				await assert.rejects(
					() => client.callTool("read_page", { tabId: 1 }, { requestId: "slow", timeoutMs: 100 }),
					/Tool call 'read_page' timed out after 100ms/,
				);
				const fresh = client.callTool("javascript_tool", { tabId: 1 }, { timeoutMs: 2000 });
				await sleep(20);
				answer(); // the timed-out call's response finally arrives
				const response = await fresh;
				assert.equal(firstText(response), "javascript_tool");
			},
		);
	});
});
