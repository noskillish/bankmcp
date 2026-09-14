import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

process.env.BANKMCP_LOCAL = "1";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bankmcp-local-"));
for (const k of ["EB_APP_ID", "EB_PRIVATE_KEY", "EB_PRIVATE_KEY_PATH", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "BASE_URL"]) delete process.env[k];
const { applySetup, setupAvailable } = await import("../src/setup.ts");
const { config, setupProblems } = await import("../src/config.ts");
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

test("local mode needs no password and points the redirect at https://localhost", async () => {
  assert.equal(config.localMode, true);
  assert.match(config.baseUrl, /^https:\/\/localhost:\d+$/);
  assert.equal(setupAvailable(), true);
  assert.equal(await applySetup({ app_id: "11111111-2222-3333-4444-555555555555", pem }, null), null);
  assert.deepEqual(setupProblems(), []);
  assert.equal(setupAvailable(), false);
  assert.equal(config.adminPasswordHash, "");
});
