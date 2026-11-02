import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SocketClient } from "../src/protocol.ts";

/**
 * Regression tests for SocketClient's request/response pairing.
 *
 * The bridge protocol has no request id on responses, so the client must keep a
 * single request in flight per socket and dispatch responses in order. Before
 * the fix, two concurrent calls shared one response slot: the second caller
 * consumed the first caller's frame and the first caller never settled (a tool
 * call hung for ~1h in the field until the session was interrupted).
 */

const RESPONSE_DELAY_MS = 25;

function encodeFrame(payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf-8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

function createTempSocketPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-browser-bridge-test-"));
	fs.chmodSync(dir, 0o700);
	return { dir, socketPath: path.join(dir, "s") };
}

/**
 * Fake native host: answers every frame in arrival order with the tool args it
 * received, so a test can prove each caller got *its own* response.
 */
async function startFakeBridge({ reply = true } = {}) {
	const { dir, socketPath } = createTempSocketPath();
	const received = [];
	const sockets = new Set();

	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4) {
				const len = buffer.readUInt32LE(0);
				if (buffer.length < 4 + len) break;
				const frame = JSON.parse(buffer.subarray(4, 4 + len).toString("utf-8"));
				buffer = buffer.subarray(4 + len);
				received.push(frame.params);
				if (!reply) continue;
				setTimeout(() => {
					if (socket.destroyed) return;
					socket.write(
						encodeFrame({
							result: {
								content: [{ type: "text", text: JSON.stringify(frame.params.args) }],
							},
						}),
					);
				}, RESPONSE_DELAY_MS);
			}
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	fs.chmodSync(socketPath, 0o600);

	return {
		socketPath,
		received,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

function textOf(response) {
	return response?.result?.content?.find((block) => block.type === "text")?.text ?? "";
}

function withDeadline(promise, ms, label) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function testConcurrentCallsGetTheirOwnResponse() {
	const bridge = await startFakeBridge();
	const client = new SocketClient({ socketPath: bridge.socketPath, toolCallTimeoutMs: 5000 });
	try {
		assert.equal(await client.ensureConnected(), true);

		const [first, second] = await withDeadline(
			Promise.all([
				client.callTool("javascript_tool", { tabId: 1, marker: "first" }),
				client.callTool("read_page", { tabId: 1, marker: "second" }),
			]),
			2000,
			"concurrent tool calls",
		);

		assert.equal(textOf(first), JSON.stringify({ tabId: 1, marker: "first" }));
		assert.equal(textOf(second), JSON.stringify({ tabId: 1, marker: "second" }));
		assert.deepEqual(
			bridge.received.map((params) => params.tool),
			["javascript_tool", "read_page"],
		);
		console.log("✅ concurrent calls keep their own responses");
	} finally {
		client.disconnect();
		await bridge.close();
	}
}

async function testTimeoutAlwaysSettles() {
	const bridge = await startFakeBridge({ reply: false });
	const client = new SocketClient({ socketPath: bridge.socketPath, toolCallTimeoutMs: 120 });
	try {
		assert.equal(await client.ensureConnected(), true);

		const results = await withDeadline(
			Promise.allSettled([
				client.callTool("javascript_tool", { tabId: 1, marker: "first" }),
				client.callTool("read_page", { tabId: 1, marker: "second" }),
			]),
			2000,
			"unanswered tool calls",
		);

		for (const result of results) {
			assert.equal(result.status, "rejected");
			assert.match(String(result.reason), /timed out after 120ms/);
		}
		console.log("✅ unanswered calls time out instead of hanging");
	} finally {
		client.disconnect();
		await bridge.close();
	}
}

async function testSocketCloseRejectsInflightCall() {
	const bridge = await startFakeBridge({ reply: false });
	const client = new SocketClient({ socketPath: bridge.socketPath, toolCallTimeoutMs: 30_000 });
	try {
		assert.equal(await client.ensureConnected(), true);

		const pending = client.callTool("javascript_tool", { tabId: 1 });
		await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
		await bridge.close();

		const result = await withDeadline(
			pending.then(
				() => ({ status: "fulfilled" }),
				(reason) => ({ status: "rejected", reason }),
			),
			2000,
			"in-flight call after socket close",
		);
		assert.equal(result.status, "rejected");
		console.log("✅ socket close rejects in-flight calls");
	} finally {
		client.disconnect();
		await bridge.close();
	}
}

async function testSocketUsableAfterTimeout() {
	const bridge = await startFakeBridge({ reply: false });
	const client = new SocketClient({ socketPath: bridge.socketPath, toolCallTimeoutMs: 120 });
	try {
		assert.equal(await client.ensureConnected(), true);
		await assert.rejects(client.callTool("javascript_tool", { tabId: 1 }), /timed out after 120ms/);

		// A timed-out call drops the socket (frames are unattributable), so the next
		// call must transparently reconnect instead of hanging on a dead socket.
		const bridgeAfterTimeout = client.isConnected();
		assert.equal(bridgeAfterTimeout, false);
		await assert.rejects(client.callTool("javascript_tool", { tabId: 1 }), /timed out after 120ms/);
		console.log("✅ a timed-out socket is dropped, not left desynchronized");
	} finally {
		client.disconnect();
		await bridge.close();
	}
}

const tests = [
	testConcurrentCallsGetTheirOwnResponse,
	testTimeoutAlwaysSettles,
	testSocketCloseRejectsInflightCall,
	testSocketUsableAfterTimeout,
];

for (const test of tests) {
	await test();
}
console.log("\nAll socket protocol tests passed.");
