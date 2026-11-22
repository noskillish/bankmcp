// Fleet identity (src/identity.ts): offline, synthetic key and synthetic Supabase URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bankmcp-identity-"));
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.BANKMCP_LOCAL;
for (const name of ["SR_IDENTITY_URL", "SR_IDENTITY_ALLOWED_SUBS", "SR_IDENTITY_ALLOWED_EMAILS"]) delete process.env[name];

const { createApp } = await import("../src/app.ts");

const URL_ = "https://identity.example.test";
const ISSUER = `${URL_}/auth/v1`;
const OWNER = "00000000-0000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@example.test";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "ES256" }] };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === `${ISSUER}/.well-known/jwks.json`) return new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });
  return realFetch(input, init);
}) as typeof fetch;

function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: "k1", typ: "JWT" }): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${enc(header)}.${enc({ iss: ISSUER, aud: "authenticated", role: "authenticated", sub: OWNER, exp: now + 600, iat: now, ...claims })}`;
  return `${body}.${sign("sha256", Buffer.from(body), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function listen(): Promise<{ server: Server; base: string }> {
  const server = createServer(createApp({ remote: true }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let identity: { server: Server; base: string };
let upstream: { server: Server; base: string };

before(async () => {
  upstream = await listen();
  process.env.SR_IDENTITY_URL = URL_ + "/";
  process.env.SR_IDENTITY_ALLOWED_SUBS = OWNER;
  identity = await listen();
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const { server } of [identity, upstream]) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const toolsList = (base: string, token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("refuses to start with SR_IDENTITY_URL set and no allowlist, or a non-https URL", () => {
  const saved = { ...process.env };
  try {
    delete process.env.SR_IDENTITY_ALLOWED_SUBS;
    delete process.env.SR_IDENTITY_ALLOWED_EMAILS;
    assert.throws(() => createApp({ remote: true }), /ALLOWED_SUBS and SR_IDENTITY_ALLOWED_EMAILS are both empty/);
    process.env.SR_IDENTITY_ALLOWED_SUBS = OWNER;
    process.env.SR_IDENTITY_URL = "http://identity.example.test";
    assert.throws(() => createApp({ remote: true }), /https/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("protected-resource metadata names the identity issuer, at the root and at /mcp", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(identity.base + path);
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(doc.resource, "http://localhost:8080/mcp");
    assert.deepEqual(doc.authorization_servers, [ISSUER]);
  }
});

test("the local authorization server is gone in identity mode", async () => {
  for (const [method, path] of [["GET", "/.well-known/oauth-authorization-server"], ["POST", "/register"], ["GET", "/authorize"], ["POST", "/token"], ["POST", "/revoke"], ["POST", "/login"]] as const) {
    const res = await fetch(identity.base + path, { method, redirect: "manual" });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test("no token: 401 with resource_metadata", async () => {
  const res = await toolsList(identity.base);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer .*resource_metadata="http:\/\/localhost:8080\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("owner token (by sub or by email) reaches tools/list", async () => {
  const bySub = await toolsList(identity.base, jwt({}));
  assert.equal(bySub.status, 200, await bySub.clone().text());
  assert.ok(((await bySub.json()) as { result: { tools: unknown[] } }).result.tools.length > 0);

  process.env.SR_IDENTITY_ALLOWED_SUBS = "";
  process.env.SR_IDENTITY_ALLOWED_EMAILS = OWNER_EMAIL.toUpperCase();
  const byEmail = await listen();
  try {
    assert.equal((await toolsList(byEmail.base, jwt({ sub: "someone-else", email: OWNER_EMAIL }))).status, 200);
    assert.equal((await toolsList(byEmail.base, jwt({ sub: "someone-else", email: "other@example.test" }))).status, 403);
  } finally {
    process.env.SR_IDENTITY_ALLOWED_SUBS = OWNER;
    delete process.env.SR_IDENTITY_ALLOWED_EMAILS;
    await new Promise<void>((resolve) => byEmail.server.close(() => resolve()));
  }
});

test("bad iss, aud, role, exp, signature or algorithm is 401; a non-owner is 403", async () => {
  const { privateKey: otherKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const forged = jwt({}).split(".").slice(0, 2).join(".");
  const cases: Array<[string, string, number]> = [
    ["iss", jwt({ iss: "https://elsewhere.example.test/auth/v1" }), 401],
    ["aud", jwt({ aud: "anon" }), 401],
    ["role", jwt({ role: "anon" }), 401],
    ["exp", jwt({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401],
    ["signature", `${forged}.${sign("sha256", Buffer.from(forged), { key: otherKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`, 401],
    ["alg none", `${forged.replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url"))}.`, 401],
    ["non-owner", jwt({ sub: "00000000-0000-4000-8000-000000000002" }), 403],
  ];
  for (const [name, token, status] of cases) {
    const res = await toolsList(identity.base, token);
    assert.equal(res.status, status, name);
  }
});

test("unset SR_IDENTITY_URL keeps the local authorization server", async () => {
  const as = await fetch(`${upstream.base}/.well-known/oauth-authorization-server`);
  assert.equal(as.status, 200);
  assert.ok(((await as.json()) as { registration_endpoint?: string }).registration_endpoint);
  const pr = (await (await fetch(`${upstream.base}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
  assert.deepEqual(pr.authorization_servers, ["http://localhost:8080/"]);
  assert.equal((await toolsList(upstream.base, jwt({}))).status, 401, "an identity token means nothing to the local server");
});
