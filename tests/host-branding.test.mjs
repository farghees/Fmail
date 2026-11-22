import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-host-branding-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { hosts: join(root, "src/lib/branding/hosts.ts"), utils: join(root, "src/lib/i18n/utils.ts") },
	outdir: outDir,
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	loader: { ".json": "json" },
});
const hosts = await import(pathToFileURL(join(outDir, "hosts.js")).href);
const i18n = await import(pathToFileURL(join(outDir, "utils.js")).href);

const config = { APP_HOST: "mail.example.com", APP_NAME: "Acme Mail" };

test("the configured APP_HOST resolves to the APP_NAME branding", () => {
	assert.equal(hosts.resolveAppName("mail.example.com", config), "Acme Mail");
	assert.equal(hosts.resolveAppName("MAIL.EXAMPLE.COM:443", config), "Acme Mail");
	assert.equal(hosts.resolveAppName("mail.example.com, proxy.internal", config), "Acme Mail");
});

test("APP_NAME defaults to fmail", () => {
	assert.equal(hosts.resolveAppName("mail.example.com", { APP_HOST: "mail.example.com" }), "fmail");
	assert.equal(hosts.resolveAppName("mail.example.com", { APP_HOST: "mail.example.com", APP_NAME: "  " }), "fmail");
});

test("unknown, empty and prototype-key hosts fall back to fmail", () => {
	for (const host of ["example.com", "", null, undefined, "evil.example", "constructor", "__proto__"]) {
		assert.equal(hosts.resolveAppName(host, config), "fmail");
	}
	assert.equal(hosts.resolveAppName("mail.example.com", {}), "fmail", "no APP_HOST configured");
	assert.equal(hosts.resolveAppName("mail.example.com", undefined), "fmail");
});

test("extra hosts from HOST_BRANDING are optional and additive", () => {
	const env = { ...config, HOST_BRANDING: { "Mail.Other.Test": { appName: "Other" }, "": { appName: "x" }, bad: null } };
	assert.equal(hosts.resolveAppName("mail.other.test", env), "Other");
	assert.equal(hosts.resolveAppName("mail.example.com", env), "Acme Mail");
	assert.equal(hosts.resolveAppName("mail.other.test", { HOST_BRANDING: "not json" }), "fmail");
});

test("applyBrandName rewrites the default name only for branded hosts", () => {
	assert.equal(hosts.applyBrandName("Open fmail now", "Acme Mail"), "Open Acme Mail now");
	assert.equal(hosts.applyBrandName("Open fmail now", "fmail"), "Open fmail now");
	assert.equal(hosts.applyBrandName("Open fmail now", "$&"), "Open $& now", "replacement is literal");
});

test("translator brands templates but not interpolated user data", () => {
	const t = i18n.createTranslator("en", undefined, "Acme Mail");
	assert.equal(t("update.upToDate", { current: "fmail@example.com" }), "Acme Mail vfmail@example.com is up to date.");
	assert.equal(i18n.createTranslator("en")("update.updateButton"), "Update fmail");
	assert.equal(t("update.updateButton"), "Update Acme Mail");
});
