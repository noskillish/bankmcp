// The password form posts to this server and the success response redirects
// the browser to the MCP client. Chrome applies the page's form-action to
// that redirect, so the header has to name the validated callback.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bankmcp-csp-"));
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.ALLOWED_REDIRECT_HOSTS;
delete process.env.BANKMCP_LOCAL;

const { createApp } = await import("../src/app.ts");
const { contentSecurityPolicy } = await import("../src/auth.ts");

let server: Server;
let base: string;

before(async () => {
  const app = createApp({ remote: true });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function call(method: string, path: string, body?: string, contentType?: string): Promise<{ status: number; csp: string | null; location: string | null; text: string }> {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: body && contentType ? { "content-type": contentType } : undefined,
    body,
  });
  return { status: res.status, csp: res.headers.get("content-security-policy"), location: res.headers.get("location"), text: await res.text() };
}

test("ordinary pages keep form-action limited to this server", async () => {
  const health = await call("GET", "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.csp, contentSecurityPolicy());
  const privacy = await call("GET", "/privacy");
  assert.equal(privacy.csp, contentSecurityPolicy());
});

test("POST /login redirects to the client callback and the CSP allows that origin", async () => {
  const cases = [
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://cursor.com/oauth/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "https://claude.ai/api/mcp/auth_callback",
  ];
  for (const redirectUri of cases) {
    const registered = await call(
      "POST",
      "/register",
      JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", client_name: "Cursor" }),
      "application/json",
    );
    assert.equal(registered.status, 201, registered.text);
    const clientId = (JSON.parse(registered.text) as { client_id: string }).client_id;
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "xyz",
    });
    const page = await call("GET", `/authorize?${query}`);
    assert.equal(page.status, 200, page.text);
    const expected = contentSecurityPolicy({ redirectUri });
    assert.equal(page.csp, expected, redirectUri);
    const requestId = /name="request" value="([^"]+)"/.exec(page.text)?.[1];
    assert.ok(requestId, "login page carries the request id");

    const wrong = await call("POST", "/login", new URLSearchParams({ request: requestId, password: "nope" }).toString(), "application/x-www-form-urlencoded");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.csp, expected, redirectUri);

    const ok = await call("POST", "/login", new URLSearchParams({ request: requestId, password: "correct horse" }).toString(), "application/x-www-form-urlencoded");
    assert.equal(ok.status, 302, ok.text);
    const location = ok.location ?? "";
    assert.ok(location.startsWith(`${redirectUri}?`), location);
    assert.match(location, /[?&]code=/);
    assert.match(location, /[?&]state=xyz/);
    assert.equal(ok.csp, expected, redirectUri);
    assert.equal(ok.csp?.includes(new URL(location).searchParams.get("code") ?? "code-missing"), false);
  }
});

test("a client still cannot register a redirect outside the allowlist", async () => {
  for (const redirectUri of ["https://evil.example/cb", "cursor://evil.example/oauth/callback", "https://www.cursor.com.evil.example/cb"]) {
    const res = await call(
      "POST",
      "/register",
      JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
      "application/json",
    );
    assert.equal(res.status, 400, redirectUri);
    assert.match(res.text, /not allowed/);
  }
});
