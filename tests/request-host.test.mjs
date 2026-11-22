import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-request-host-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const stub = join(outDir, "next-headers-stub.mjs");
writeFileSync(stub, "export async function headers() { return globalThis.__testHeaders; }\n");

await build({
	entryPoints: { host: join(root, "src/lib/branding/request-host.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	alias: { "@": join(root, "src"), "next/headers": stub },
});
const { pickRequestHost, getRequestHost } = await import(pathToFileURL(join(outDir, "host.mjs")).href);

const h = (entries) => new Headers(entries);

test("on Workers (not node) x-forwarded-host is ignored and host is used", () => {
	assert.equal(pickRequestHost(h({ host: "mail.example.com", "x-forwarded-host": "evil.example" }), false), "mail.example.com");
});

test("on the node runtime x-forwarded-host wins when present, host otherwise", () => {
	assert.equal(pickRequestHost(h({ host: "127.0.0.1:3000", "x-forwarded-host": "mail.example.com" }), true), "mail.example.com");
	assert.equal(pickRequestHost(h({ host: "mail.example.com" }), true), "mail.example.com");
	assert.equal(pickRequestHost(h({}), false), null);
});

test("getRequestHost reads MAILFLARE_RUNTIME from the runtime env", async () => {
	globalThis.__testHeaders = h({ host: "mail.example.com", "x-forwarded-host": "evil.example" });
	try {
		globalThis.__mailflareNodeEnv = undefined;
		assert.equal(await getRequestHost(), "mail.example.com");
		globalThis.__mailflareNodeEnv = { MAILFLARE_RUNTIME: "node" };
		assert.equal(await getRequestHost(), "evil.example");
	} finally {
		delete globalThis.__mailflareNodeEnv;
		delete globalThis.__testHeaders;
	}
});
