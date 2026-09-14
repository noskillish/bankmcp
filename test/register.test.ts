import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bank-register-"));
process.env.DATA_DIR = dir;
for (const k of ["EB_APP_ID", "EB_PRIVATE_KEY", "EB_PRIVATE_KEY_PATH", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "BANKMCP_LOCAL"]) delete process.env[k];
const { startRegistration, finishRegistration, registeredButUnfinished, parseSignInLink, _resetPending } = await import("../src/register.ts");
const { ControlPanelError, newKeyPair } = await import("../src/controlpanel.ts");
const { config } = await import("../src/config.ts");
const { applyPassword, setupAvailable } = await import("../src/setup.ts");

const calls: Record<string, unknown[]> = {};
const deps = {
  requestSignInLink: async (email: string, continueUrl: string) => { (calls.link ??= []).push([email, continueUrl]); return {}; },
  completeSignIn: async (email: string, oobCode: string) => { (calls.signin ??= []).push([email, oobCode]); if (oobCode !== "good") throw new ControlPanelError(400, "INVALID_OOB_CODE"); return { idToken: "cp-token" }; },
  registerApplication: async (idToken: string, certificate: string, reg: unknown) => { (calls.register ??= []).push([idToken, certificate.slice(0, 26), reg]); return { app_id: "22222222-3333-4444-5555-666666666666" }; },
  newKeyPair,
};

test("registration rejects a bad email and a link that was not started here", async () => {
  _resetPending();
  assert.match((await startRegistration({ email: "nope" }, "https://h.example", deps) as { error: string }).error, /email/);
  assert.match((await finishRegistration({ state: "x", oobCode: "good" }, "https://h.example", deps) as { error: string }).error, /expired or was never started/);
});

test("registration sends the link with a state, then creates the application and stores id and key", async () => {
  const started = await startRegistration({ email: "Me@Example.com", environment: "SANDBOX", country: "dk" }, "https://h.example/", deps);
  assert.deepEqual(started, { email: "me@example.com" });
  const [email, continueUrl] = calls.link![0] as [string, string];
  assert.equal(email, "me@example.com");
  const state = new URL(continueUrl).searchParams.get("state")!;
  assert.equal(new URL(continueUrl).pathname, "/setup/complete");

  assert.match((await finishRegistration({ state: "wrong", oobCode: "good" }, "https://h.example", deps) as { error: string }).error, /does not match/);
  assert.match((await finishRegistration({ state, oobCode: "bad" }, "https://h.example", deps) as { error: string }).error, /did not accept the sign-in link/);

  const done = await finishRegistration({ state, oobCode: "good" }, "https://h.example", deps);
  assert.ok(!("error" in done), JSON.stringify(done));
  const reg = (calls.register![0] as unknown[])[2] as Record<string, unknown>;
  assert.equal(reg.environment, "SANDBOX");
  assert.deepEqual(reg.redirect_urls, ["https://h.example/callback"]);
  assert.equal(reg.privacy_url, "https://h.example/privacy");
  assert.equal(reg.gdpr_email, "me@example.com");
  assert.equal((calls.register![0] as unknown[])[1], "-----BEGIN PUBLIC KEY-----");

  assert.equal(config.appId, "22222222-3333-4444-5555-666666666666");
  assert.equal(config.country, "DK");
  assert.ok(existsSync(join(dir, "enablebanking.pem")));
  assert.deepEqual(registeredButUnfinished(), { appId: "22222222-3333-4444-5555-666666666666", email: "me@example.com" });
  assert.equal(setupAvailable(), true, "hosted mode still needs a password");

  assert.match(applyPassword({ password: "short", password2: "short" })!, /12 characters/);
  assert.equal(applyPassword({ password: "a-long-password!", password2: "a-long-password!" }), null);
  assert.equal(setupAvailable(), false);
  assert.equal(registeredButUnfinished(), null);
});

test("a pasted email link yields the sign-in code however it is wrapped", () => {
  assert.equal(parseSignInLink("https://enablebanking.com/cp/auth?mode=signIn&oobCode=AbC-123_x&continueUrl=http%3A%2F%2Flocalhost%3A8080%2Fsetup%2Fcomplete%3Fstate%3Ds1").oobCode, "AbC-123_x");
  assert.equal(parseSignInLink("https://enablebanking.com/cp/auth?mode=signIn&oobCode=AbC-123_x&continueUrl=http%3A%2F%2Flocalhost%3A8080%2Fsetup%2Fcomplete%3Fstate%3Ds1").state, "s1");
  assert.equal(parseSignInLink("https://x.page.link/?link=https%3A%2F%2Fenablebanking.com%2Fauth%3FoobCode%3DZZ9%26mode%3DsignIn").oobCode, "ZZ9");
  assert.equal(parseSignInLink("hello").oobCode, undefined);
});
