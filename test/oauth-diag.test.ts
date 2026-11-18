// OAuth diagnostics must be enough to see where a connector stops, and must
// not contain passwords, authorization codes, tokens, or PKCE verifiers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bankmcp-oauth-diag-"));
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ALLOWED_REDIRECT_HOSTS;
delete process.env.BANKMCP_LOCAL;

const { createApp } = await import("../src/app.ts");

const lines: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  originalLog(...args);
};

let server: Server;
let base: string;

before(async () => {
  const app = createApp({ remote: true });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  console.log = originalLog;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function oauthLines(event: string): Array<Record<string, unknown>> {
  const prefix = `oauth ${event} `;
  return lines.flatMap((line) => {
    const at = line.indexOf(prefix);
    if (at === -1) return [];
    return [JSON.parse(line.slice(at + prefix.length)) as Record<string, unknown>];
  });
}

async function call(method: string, path: string, body?: string, contentType?: string, headers?: Record<string, string>): Promise<{ status: number; location: string | null; text: string }> {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { ...(body && contentType ? { "content-type": contentType } : {}), ...headers },
    body,
  });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

function callbackFrom(html: string): string {
  const href = /id="return" href="([^"]*)"/.exec(html)?.[1];
  assert.ok(href, html);
  return href.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = `verifier-${randomBytes(24).toString("base64url")}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

test("protected-resource metadata is served at the host root and at /mcp", async () => {
  const root = await call("GET", "/.well-known/oauth-protected-resource");
  const path = await call("GET", "/.well-known/oauth-protected-resource/mcp");
  assert.equal(root.status, 200);
  assert.equal(path.status, 200);
  assert.deepEqual(JSON.parse(root.text), JSON.parse(path.text));
  const doc = JSON.parse(root.text) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
  assert.equal(doc.resource, "http://localhost:8080/mcp");
  assert.deepEqual(doc.authorization_servers, ["http://localhost:8080/"]);
  assert.deepEqual(doc.scopes_supported, ["bank:read"]);
});

test("oauth logs name each step and leave out credentials", async () => {
  const redirectUri = "https://www.cursor.com/agents/mcp/oauth/callback";
  const resource = "http://localhost:8080/mcp";
  const registered = await call(
    "POST",
    "/register",
    JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: "Cursor Desktop" }),
    "application/json",
  );
  assert.equal(registered.status, 201, registered.text);
  const client = JSON.parse(registered.text) as { client_id: string };
  const registeredLog = oauthLines("register").at(-1);
  assert.equal(registeredLog?.ok, true);
  assert.equal(registeredLog?.client_name, "Cursor Desktop");
  assert.deepEqual(registeredLog?.redirect_hosts, ["www.cursor.com"]);
  assert.equal(registeredLog?.token_endpoint_auth_method, "none");

  const rejected = await call("GET", `/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&response_type=code&code_challenge=abc&code_challenge_method=S256`);
  assert.equal(rejected.status, 400, rejected.text);
  const rejectLog = oauthLines("authorize").at(-1);
  assert.equal(rejectLog?.error, "invalid_request");
  assert.match(String(rejectLog?.reason), /Unregistered redirect_uri/);

  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource,
  });
  const page = await call("GET", `/authorize?${query}`);
  assert.equal(page.status, 200, page.text);
  const requestId = /name="request" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(requestId);
  const signedIn = await call("POST", "/login", new URLSearchParams({ request: requestId, password: "correct horse" }).toString(), "application/x-www-form-urlencoded");
  assert.equal(signedIn.status, 200, signedIn.text);
  const code = new URL(callbackFrom(signedIn.text)).searchParams.get("code");
  assert.ok(code);
  const loginLog = oauthLines("login").at(-1);
  assert.equal(loginLog?.redirect_host, "www.cursor.com");
  assert.equal(loginLog?.state, true);
  assert.equal(String(loginLog?.client).length, 8);

  const reused = await call("POST", "/login", new URLSearchParams({ request: requestId, password: "correct horse" }).toString(), "application/x-www-form-urlencoded");
  assert.equal(reused.status, 400);
  assert.match(reused.text, /This sign-in is already completed — return to your assistant/);
  assert.doesNotMatch(reused.text, /server restarted/);
  assert.match(lines.at(-1) ?? "", /pending used/);

  const token = await call(
    "POST",
    "/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      resource,
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert.equal(token.status, 200, token.text);
  const access = (JSON.parse(token.text) as { access_token: string }).access_token;
  const tokenLog = oauthLines("token").at(-1);
  assert.equal(tokenLog?.grant_type, "authorization_code");
  assert.equal(tokenLog?.client_known, true);
  assert.equal(tokenLog?.redirect_match, true);
  assert.equal(tokenLog?.pkce, "ok");
  assert.equal(tokenLog?.code, "found");
  assert.equal(tokenLog?.resource, resource);
  assert.equal(tokenLog?.resource_match, true);
  assert.equal(tokenLog?.status, 200);
  assert.equal(tokenLog?.error, null);

  const again = await call(
    "POST",
    "/token",
    new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert.equal(again.status, 400, again.text);
  assert.equal(oauthLines("token").at(-1)?.code, "used");
  assert.equal(oauthLines("token").at(-1)?.error, "invalid_grant");

  const badPkce = pkce();
  const second = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: badPkce.challenge,
    code_challenge_method: "S256",
  });
  const secondPage = await call("GET", `/authorize?${second}`);
  const secondId = /name="request" value="([^"]+)"/.exec(secondPage.text)?.[1];
  assert.ok(secondId);
  const secondLogin = await call("POST", "/login", new URLSearchParams({ request: secondId, password: "correct horse" }).toString(), "application/x-www-form-urlencoded");
  const secondCode = new URL(callbackFrom(secondLogin.text)).searchParams.get("code");
  assert.ok(secondCode);
  const mismatch = await call(
    "POST",
    "/token",
    new URLSearchParams({ grant_type: "authorization_code", code: secondCode, code_verifier: "not-the-verifier", redirect_uri: redirectUri, client_id: client.client_id }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert.equal(mismatch.status, 400, mismatch.text);
  assert.equal(oauthLines("token").at(-1)?.pkce, "fail");
  assert.equal(oauthLines("token").at(-1)?.code, "found");

  const missing = await call("POST", "/mcp", "{}");
  assert.equal(missing.status, 401);
  assert.equal(oauthLines("mcp").at(-1)?.reason, "missing");
  const invalid = await call("POST", "/mcp", "{}", undefined, { authorization: "Bearer not-a-real-token" });
  assert.equal(invalid.status, 401, invalid.text);
  assert.equal(oauthLines("mcp").at(-1)?.reason, "invalid");

  const foreign = pkce();
  const foreignQuery = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: foreign.challenge,
    code_challenge_method: "S256",
    resource: "http://localhost:8080/other",
  });
  const foreignPage = await call("GET", `/authorize?${foreignQuery}`);
  const foreignId = /name="request" value="([^"]+)"/.exec(foreignPage.text)?.[1];
  assert.ok(foreignId);
  const foreignLogin = await call("POST", "/login", new URLSearchParams({ request: foreignId, password: "correct horse" }).toString(), "application/x-www-form-urlencoded");
  const foreignCode = new URL(callbackFrom(foreignLogin.text)).searchParams.get("code");
  assert.ok(foreignCode);
  const foreignToken = await call(
    "POST",
    "/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code: foreignCode,
      code_verifier: foreign.verifier,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      resource: "http://localhost:8080/other",
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert.equal(foreignToken.status, 200, foreignToken.text);
  const foreignAccess = (JSON.parse(foreignToken.text) as { access_token: string }).access_token;
  const audience = await call("POST", "/mcp", "{}", undefined, { authorization: `Bearer ${foreignAccess}` });
  assert.equal(audience.status, 401, audience.text);
  assert.equal(oauthLines("mcp").at(-1)?.reason, "audience");

  const dumped = lines.join("\n");
  for (const secret of ["correct horse", code, verifier, access, secondCode, badPkce.verifier, foreign.verifier, foreignCode, foreignAccess, "not-a-real-token"]) {
    assert.equal(dumped.includes(secret), false, secret);
  }
});
