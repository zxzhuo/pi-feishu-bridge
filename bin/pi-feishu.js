#!/usr/bin/env node
/**
 * Launcher for pi-feishu-bridge.
 *
 * Reads config from ~/.config/pi-feishu/config.json and env vars, starts
 * the bridge, and handles SIGINT/SIGTERM for clean shutdown.
 */
import { startBridge, loadConfig } from "../dist/index.js";

const cfg = loadConfig();
const shutdownFn = await startBridge(cfg);

let shuttingDown = false;
async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	process.stderr.write(`\n[pi-feishu] received ${signal}, shutting down…\n`);
	try {
		await shutdownFn();
	} catch (err) {
		process.stderr.write(`[pi-feishu] shutdown error: ${err?.message ?? err}\n`);
	}
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
