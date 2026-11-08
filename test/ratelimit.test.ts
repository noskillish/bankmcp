import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnableBankingError } from "../src/enablebanking.ts";
import { BankGuard } from "../src/bankguard.ts";
import { Store } from "../src/store.ts";

const ebBody = (code: number, error: string, message: string, detail?: unknown) => JSON.stringify({ code, error, message, detail });

// Shape documented by Enable Banking; `detail` carries the bank's own text, which may say "consent".
const RATE_LIMIT = () =>
  new EnableBankingError(429, ebBody(429, "ASPSP_RATE_LIMIT_EXCEEDED", "ASPSP Rate limit exceeded", "The access on the account has been exceeding the consented multiplicity per day"));

test("a 429 rate limit is not a lost consent, even when the bank text says consent", () => {
  const err = RATE_LIMIT();
  assert.equal(err.errorCode, "ASPSP_RATE_LIMIT_EXCEEDED");
  assert.equal(err.rateLimited, true);
  assert.equal(err.consentGone, false);
});

test("ASPSP_RATE_LIMIT_EXCEEDED is a rate limit whatever the HTTP status", () => {
  const err = new EnableBankingError(400, ebBody(400, "ASPSP_RATE_LIMIT_EXCEEDED", "ASPSP Rate limit exceeded"));
  assert.equal(err.rateLimited, true);
  assert.equal(err.consentGone, false);
});

test("expired, closed, revoked and unknown sessions are a lost consent", () => {
  for (const code of ["EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION", "SESSION_DOES_NOT_EXIST"]) {
    const err = new EnableBankingError(401, ebBody(401, code, "Session problem"));
    assert.equal(err.consentGone, true, code);
    assert.equal(err.rateLimited, false, code);
  }
});

test("other coded errors are not a lost consent, even when the text mentions a session", () => {
  assert.equal(new EnableBankingError(403, ebBody(403, "ACCESS_DENIED", "Access to this resource is denied")).consentGone, false);
  assert.equal(new EnableBankingError(422, ebBody(422, "WRONG_TRANSACTIONS_PERIOD", "Wrong period for this session")).consentGone, false);
  assert.equal(new EnableBankingError(500, "internal error in session handler").consentGone, false);
});

test("uncoded 401 and 410 keep meaning a lost consent", () => {
  assert.equal(new EnableBankingError(401, "Unauthorized").consentGone, true);
  assert.equal(new EnableBankingError(410, "").consentGone, true);
});

test("Retry-After in seconds is kept", () => {
  assert.equal(new EnableBankingError(429, "", "120").retryAfterSeconds, 120);
  assert.equal(new EnableBankingError(429, "").retryAfterSeconds, undefined);
});

test("the summary never carries the bank's detail text", () => {
  const s = RATE_LIMIT().summary;
  assert.match(s, /429 ASPSP_RATE_LIMIT_EXCEEDED/);
  assert.doesNotMatch(s, /multiplicity/);
});

// --- BankGuard ---

function setup(opts: { dailyLimit?: number; liveStatus?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bank-guard-"));
  const store = new Store(join(dir, "store.json"));
  store.addSession({
    session_id: "s1",
    aspsp: { name: "BBVA", country: "ES" },
    psu_type: "personal",
    access: { valid_until: "2027-05-07T00:00:00Z" },
    accounts: [{ uid: "u1", name: "Cuenta", currency: "EUR", identification_hash: "h1" }],
  });
  store.update((d) => void (d.sessions["s1"]!.status = "AUTHORIZED"));
  let now = Date.parse("2026-11-09T10:00:00Z");
  const logs: string[] = [];
  const guard = new BankGuard({
    store: () => store,
    now: () => now,
    log: (m) => void logs.push(m),
    sessionStatus: async () => opts.liveStatus ?? "AUTHORIZED",
    dailyLimit: opts.dailyLimit ?? 4,
    cacheTtlMs: 15 * 60_000,
    staleMaxMs: 24 * 3600_000,
    cooldownMs: 6 * 3600_000,
  });
  const account = store.account("u1")!;
  return { store, guard, account, logs, advance: (ms: number) => void (now += ms) };
}

test("rate limit: session stays AUTHORIZED, the bank is not called again during the cooldown, then it recovers", async () => {
  const { store, guard, account, logs, advance } = setup();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw RATE_LIMIT();
  };
  await assert.rejects(guard.read(account, "balances", failing), /rate limit.*still valid.*do not run start_consent/is);
  assert.equal(store.data.sessions["s1"]!.status, "AUTHORIZED");
  assert.ok(logs.some((l) => /429 ASPSP_RATE_LIMIT_EXCEEDED/.test(l)), "the original error code is logged");
  assert.ok(logs.every((l) => !/multiplicity/.test(l)), "the bank's text is not logged");

  await assert.rejects(guard.read(account, "balances", failing), /rate limit/i);
  assert.equal(calls, 1, "no bank call while cooling down");

  advance(6 * 3600_000 + 1);
  const r = await guard.read(account, "balances", async () => ({ booked: 1 }));
  assert.deepEqual(r.value, { booked: 1 });
  assert.equal(r.stale, false);
});

test("rate limit with a cached answer returns it marked stale", async () => {
  const { guard, account, advance } = setup();
  await guard.read(account, "balances", async () => ({ booked: 1 }));
  advance(20 * 60_000); // past the fresh TTL
  const r = await guard.read(account, "balances", async () => {
    throw RATE_LIMIT();
  });
  assert.deepEqual(r.value, { booked: 1 });
  assert.equal(r.stale, true);
  assert.match(r.note ?? "", /rate limit/i);
});

test("a fresh cache hit does not call the bank", async () => {
  const { guard, account } = setup();
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  await guard.read(account, "tx|2026-10-10|2026-11-09", fn);
  const r = await guard.read(account, "tx|2026-10-10|2026-11-09", fn);
  assert.equal(calls, 1);
  assert.deepEqual(r.value, { n: 1 });
  assert.ok(r.cached_at);
});

test("the daily budget stops bank calls before the bank does", async () => {
  const { guard, account, advance } = setup({ dailyLimit: 2 });
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  await guard.read(account, "a", fn);
  await guard.read(account, "b", fn);
  await assert.rejects(guard.read(account, "c", fn), /budget/i);
  assert.equal(calls, 2);
  const cached = await guard.read(account, "a", fn); // still served from cache
  assert.deepEqual(cached.value, { n: 1 });
  advance(24 * 3600_000 + 1);
  await guard.read(account, "c", fn);
  assert.equal(calls, 3, "budget is a rolling 24 h window");
});

test("a lost consent is marked only when Enable Banking confirms it", async () => {
  const gone = new EnableBankingError(401, ebBody(401, "EXPIRED_SESSION", "Session is expired"));
  const confirmed = setup({ liveStatus: "EXPIRED" });
  await assert.rejects(confirmed.guard.read(confirmed.account, "balances", async () => { throw gone; }), /start_consent/);
  assert.equal(confirmed.store.data.sessions["s1"]!.status, "EXPIRED");

  const notConfirmed = setup({ liveStatus: "AUTHORIZED" });
  await assert.rejects(notConfirmed.guard.read(notConfirmed.account, "balances", async () => { throw gone; }), /401 EXPIRED_SESSION/);
  assert.equal(notConfirmed.store.data.sessions["s1"]!.status, "AUTHORIZED");
});

test("a successful read heals a session wrongly marked EXPIRED", async () => {
  const { store, guard, account } = setup();
  store.update((d) => void (d.sessions["s1"]!.status = "EXPIRED"));
  await guard.read(account, "balances", async () => ({ booked: 1 }));
  assert.equal(store.data.sessions["s1"]!.status, "AUTHORIZED");
});

test("a read that must be live never uses the cache, not even when rate limited", async () => {
  const { guard, account } = setup();
  let calls = 0;
  await guard.read(account, "balances", async () => ({ booked: ++calls }));
  const live = await guard.read(account, "balances", async () => ({ booked: ++calls }), { live: true });
  assert.deepEqual(live.value, { booked: 2 });
  assert.equal(live.cached_at, undefined);
  await assert.rejects(guard.read(account, "balances", async () => { throw RATE_LIMIT(); }, { live: true }), /rate limit/i);
  await assert.rejects(guard.read(account, "balances", async () => ({ booked: ++calls }), { live: true }), /rate limit/i);
  assert.equal(calls, 2);
});
