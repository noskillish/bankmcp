import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
delete process.env.ALLOWED_REDIRECT_HOSTS;
const { SingleUserProvider, hashPassword, verifyPassword, contentSecurityPolicy } = await import("../src/auth.ts");
const { Store } = await import("../src/store.ts");

const fakeRes = () => {
  const out = { status: 0, body: "" };
  const res = {
    status: (s: number) => ((out.status = s), res),
    set: () => res,
    type: () => res,
    send: (b: string) => ((out.body = b), res),
  };
  return { out, res: res as unknown as import("express").Response };
};

test("password hashing round-trips and the hash takes precedence over a plain password", () => {
  const h = hashPassword("secret-123");
  assert.match(h, /^scrypt\$/);
  process.env.ADMIN_PASSWORD_HASH = h;
  try {
    assert.equal(verifyPassword("secret-123"), true);
    assert.equal(verifyPassword("correct horse"), false, "plain ADMIN_PASSWORD is ignored while a hash is set");
  } finally {
    delete process.env.ADMIN_PASSWORD_HASH;
  }
  assert.equal(verifyPassword("correct horse"), true);
});

test("full authorization code flow with PKCE, refresh and revocation", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude", token_endpoint_auth_method: "none" });
  assert.ok(client.client_id);
  assert.equal(client.client_secret, undefined, "public client gets no secret");

  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "challenge", redirectUri: client.redirect_uris[0]!, state: "xyz", scopes: ["bank:read"] }, res);
  assert.equal(out.status, 200);
  const requestId = /name="request" value="([^"]+)"/.exec(out.body)?.[1];
  assert.ok(requestId, "login page carries the request id");

  const wrong = provider.completeLogin(requestId!, "nope", "1.2.3.4");
  assert.ok("error" in wrong && wrong.requestId === requestId);

  const ok = provider.completeLogin(requestId!, "correct horse", "1.2.3.4");
  assert.ok("redirect" in ok);
  const url = new URL(ok.redirect);
  assert.equal(url.origin + url.pathname, client.redirect_uris[0]);
  assert.equal(url.searchParams.get("state"), "xyz");
  const code = url.searchParams.get("code")!;

  assert.ok("error" in provider.completeLogin(requestId!, "correct horse", "1.2.3.4"), "request id is single use");

  assert.equal(await provider.challengeForAuthorizationCode(client, code), "challenge");
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);
  assert.ok(tokens.access_token && tokens.refresh_token);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code), /Invalid/);

  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, client.client_id);
  assert.deepEqual(info.scopes, ["bank:read"]);
  assert.ok(!JSON.stringify(store.data).includes(tokens.access_token), "tokens are stored hashed");

  const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
  assert.notEqual(refreshed.access_token, tokens.access_token);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!), /Invalid/, "refresh tokens rotate");

  await provider.revokeToken!(client, { token: refreshed.access_token });
  await assert.rejects(provider.verifyAccessToken(refreshed.access_token), /Invalid/);
});

test("five wrong passwords lock the address out", async () => {
  const provider = new SingleUserProvider(new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json")));
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"] });
  for (let i = 0; i < 5; i++) {
    const { out, res } = fakeRes();
    await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
    const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
    provider.completeLogin(id, "wrong", "9.9.9.9");
  }
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
  const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const r = provider.completeLogin(id, "correct horse", "9.9.9.9");
  assert.ok("error" in r && /Too many/.test(r.error));
});

test("revokeAll drops every token", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const events: unknown[] = [];
  const provider = new SingleUserProvider(store, { onLogin: (e) => events.push(e) });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" });
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
  const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const ok = provider.completeLogin(id, "correct horse", "5.5.5.5");
  assert.ok("redirect" in ok);
  assert.deepEqual(events, [{ ok: true, ip: "5.5.5.5", clientName: "Claude", clientId: client.client_id, redirectHost: "claude.ai", state: false }]);
  const tokens = await provider.exchangeAuthorizationCode(client, new URL(ok.redirect).searchParams.get("code")!, undefined, "https://claude.ai/cb");
  await provider.verifyAccessToken(tokens.access_token);
  provider.revokeAll();
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid/);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!), /Invalid/);
});

test("a missing sign-in is expired, already used, or unknown", async () => {
  const events: { reason?: string }[] = [];
  const provider = new SingleUserProvider(new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json")), { onLogin: (e) => events.push(e) });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"] });
  const unknown = provider.completeLogin("not-a-real-id", "correct horse", "1.1.1.1");
  assert.ok("error" in unknown);
  assert.equal(events.at(-1)?.reason, "pending unknown");

  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb", state: "xyz" }, res);
  const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const unknownMessage = unknown.error;
  assert.match(unknownMessage, /expired or the server restarted/);
  const ok = provider.completeLogin(id, "correct horse", "1.1.1.1");
  assert.ok("redirect" in ok);
  const used = provider.completeLogin(id, "correct horse", "1.1.1.1");
  assert.ok("error" in used);
  assert.equal(used.error, "This sign-in is already completed — return to your assistant");
  assert.equal(events.at(-1)?.reason, "pending used");

  const again = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, again.res);
  const id2 = /name="request" value="([^"]+)"/.exec(again.out.body)![1]!;
  const started = Date.now();
  const original = Date.now;
  Date.now = () => started + 31 * 60 * 1000;
  try {
    const expired = provider.completeLogin(id2, "correct horse", "1.1.1.1");
    assert.ok("error" in expired);
    assert.equal(events.at(-1)?.reason, "pending expired");
  } finally {
    Date.now = original;
  }
});

test("an expired authorization code is not reported as already used", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"] });
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb" }, res);
  const id = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const ok = provider.completeLogin(id, "correct horse", "1.1.1.1");
  assert.ok("redirect" in ok);
  const code = new URL(ok.redirect).searchParams.get("code")!;
  for (const entry of Object.values(store.data.oauth.codes)) entry.expires = 0;
  const { tokenDiag } = await import("../src/oauth-log.ts");
  const diag = { code: "n/a" as const, pkce: "n/a" as const, redirect_match: "n/a" as const, resource_match: null };
  await assert.rejects(() => tokenDiag.run(diag, () => provider.challengeForAuthorizationCode(client, code)), /Invalid or expired/);
  assert.equal(diag.code, "expired");
});

test("clients may only redirect to allowed hosts", async () => {
  const provider = new SingleUserProvider(new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json")));
  await assert.rejects(async () => provider.clientsStore.registerClient!({ redirect_uris: ["https://evil.example/cb"] }), /not allowed/);
  await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:53421/callback"] });
  await provider.clientsStore.registerClient!({ redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] });
  await assert.rejects(async () => provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai.evil.example/cb"] }), /not allowed/);
  await assert.rejects(async () => provider.clientsStore.registerClient!({ redirect_uris: ["cursor://evil.example/oauth/callback"] }), /not allowed/);
});

test("well-known MCP client domains are allowed by default", async () => {
  const { redirectAllowed } = await import("../src/auth.ts");
  for (const u of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chat.mistral.ai/oauth/callback",
    "https://cursor.com/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "http://localhost:3456/cb",
  ]) assert.equal(redirectAllowed(u), true, u);
  for (const u of [
    "https://evil.example/cb",
    "https://chatgpt.com.evil.example/cb",
    "https://notclaude.ai/cb",
    "cursor://evil.example/oauth/callback",
    "cursor://anysphere.cursor-mcp.evil.example/oauth/callback",
    "https://anysphere.cursor-mcp.evil.example/cb",
  ]) assert.equal(redirectAllowed(u), false, u);
});

test("sign-in CSP form-action follows the validated redirect and stays strict otherwise", () => {
  const formAction = (csp: string) => {
    const value = /form-action ([^;]+)/.exec(csp)?.[1];
    assert.ok(value, csp);
    return value;
  };
  const strict = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  assert.equal(contentSecurityPolicy(), strict);
  assert.equal(
    contentSecurityPolicy({ script: true }),
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.equal(formAction(contentSecurityPolicy({ redirectUri: "https://www.cursor.com/agents/mcp/oauth/callback?code=secret" })), "'self' https://www.cursor.com");
  assert.equal(formAction(contentSecurityPolicy({ redirectUri: "https://cursor.com/oauth/callback" })), "'self' https://cursor.com");
  assert.equal(formAction(contentSecurityPolicy({ redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback" })), "'self' cursor: cursor://anysphere.cursor-mcp");
  assert.equal(formAction(contentSecurityPolicy({ redirectUri: "http://localhost:3456/cb" })), "'self' http://localhost:3456");
  assert.equal(contentSecurityPolicy({ redirectUri: "https://www.cursor.com/agents/mcp/oauth/callback?code=secret" }).includes("secret"), false);
  assert.equal(contentSecurityPolicy({ redirectUri: "https://evil.example/cb" }), strict);
  assert.equal(contentSecurityPolicy({ redirectUri: "javascript://cursor.com" }), strict);
  assert.equal(contentSecurityPolicy({ redirectUri: "cursor://evil.example/oauth/callback" }), strict);
  assert.match(contentSecurityPolicy({ scriptNonce: "abc_12-XY" }), /script-src 'nonce-abc_12-XY'/);
  assert.equal(contentSecurityPolicy({ scriptNonce: "bad nonce" }).includes("script-src"), false);
});
