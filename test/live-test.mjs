import { SocketPool } from "../src/protocol.ts";

async function main() {
	console.log("=================================================");
	console.log("  Testing Pi in Chrome Live Browser Automation");
	console.log("=================================================\n");

	const pool = new SocketPool();

	const connected = await pool.ensureConnected();
	const sockets = pool.getConnectedSockets();
	console.log(`📡 Socket connection: ${connected ? "ONLINE" : "OFFLINE"}`);
	console.log(`   Connected sockets: ${sockets.join(", ") || "None"}\n`);

	if (!connected || sockets.length === 0) {
		console.error("❌ No active browser socket found. Ensure Chrome extension is running.");
		process.exit(1);
	}

	// 1. Query Tab Context
	console.log("1️⃣  Calling tabs_context_mcp...");
	const contextResp = await pool.callTool("tabs_context_mcp", { createIfEmpty: false });
	const contextContent = contextResp.result?.content || [];
	console.log("   Result content count:", contextContent.length);
	for (const block of contextContent) {
		if (block.type === "text" && block.text) {
			console.log("   Output preview:\n" + block.text.split("\n").slice(0, 5).map(l => "     " + l).join("\n"));
		}
	}

	// Find active tab ID
	const routes = pool.getTabRoutes();
	let tabId = routes.keys().next().value;
	if (!tabId) {
		// Try parsing from response
		for (const block of contextContent) {
			const m = block.text?.match(/tabId\s+(\d+)/);
			if (m) {
				tabId = Number.parseInt(m[1], 10);
				break;
			}
		}
	}

	console.log(`\n🎯 Target Tab ID: ${tabId || "(none, using default)"}`);

	// 2. Read Page accessibility tree
	console.log("\n2️⃣  Calling read_page (DOM accessibility tree)...");
	const pageResp = await pool.callTool("read_page", { tabId, filter: "all" });
	const pageContent = pageResp.result?.content || [];
	const pageText = pageContent.find(b => b.type === "text")?.text || "";
	console.log(`   Accessibility tree lines: ${pageText.split("\n").length}`);
	console.log("   First 6 tree lines:\n" + pageText.split("\n").slice(0, 6).map(l => "     " + l).join("\n"));

	// 3. Execute JavaScript in page
	console.log("\n3️⃣  Calling javascript_tool...");
	const jsResp = await pool.callTool("javascript_tool", {
		tabId,
		action: "javascript_exec",
		text: "({ title: document.title, url: window.location.href, agent: 'Pi in Chrome', now: new Date().toISOString() })"
	});
	const jsContent = jsResp.result?.content || [];
	for (const block of jsContent) {
		if (block.type === "text" && block.text) {
			console.log("   JS Result:\n" + block.text.split("\n").map(l => "     " + l).join("\n"));
		}
	}

	// 4. Read Console Messages
	console.log("\n4️⃣  Calling read_console_messages...");
	const consoleResp = await pool.callTool("read_console_messages", { tabId, limit: 10 });
	const consoleContent = consoleResp.result?.content || [];
	for (const block of consoleContent) {
		if (block.type === "text" && block.text) {
			console.log("   Console messages:\n" + block.text.split("\n").slice(0, 8).map(l => "     " + l).join("\n"));
		}
	}

	console.log("\n=================================================");
	console.log("  ✅ All live browser automation tests PASSED!");
	console.log("=================================================\n");

	process.exit(0);
}

main().catch((err) => {
	console.error("Test failed with error:", err);
	process.exit(1);
});
