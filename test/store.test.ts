import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_AUTH_TTL_MS, pendingAuthIsLive, Store } from "../src/store.ts";

const session = (id: string, uid: string, hash: string) => ({
  session_id: id,
  aspsp: { name: "Test Bank", country: "DK" },
  psu_type: "personal",
  access: { valid_until: "2027-01-01T00:00:00Z" },
  accounts: [{ uid, name: "Everyday", currency: "DKK", identification_hash: hash }],
});

test("re-consent replaces the account uid but keeps label and watches", () => {
  const dir = mkdtempSync(join(tmpdir(), "bank-"));
  const s = new Store(join(dir, "store.json"));
  s.addSession(session("s1", "u1", "h1"));
  s.update((d) => void (d.accounts["u1"]!.label = "Main"));
  s.putWatch({ id: "w1", account: "u1", rule: { type: "balance_below", amount: 100 }, created: "2026-01-01", active: true, seen: [] });

  s.addSession(session("s2", "u2", "h1"));
  assert.deepEqual(Object.keys(s.data.accounts), ["u2"]);
  assert.equal(s.data.accounts["u2"]!.label, "Main");
  assert.equal(s.data.watches["w1"]!.account, "u2");
  assert.deepEqual(Object.keys(s.data.sessions), ["s2"], "session without accounts is dropped");

  const reloaded = new Store(join(dir, "store.json"));
  assert.equal(reloaded.accounts().length, 1);
  assert.equal(reloaded.watches().length, 1);
});

test("pending auth is single use", () => {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  s.addPendingAuth({ state: "st", bank: { name: "B", country: "DK" }, started: new Date().toISOString() });
  assert.equal(s.takePendingAuth("st")?.bank.name, "B");
  assert.equal(s.takePendingAuth("st"), undefined);
});

test("a pending auth stops being live once it is past the ttl", () => {
  const at = (ms: number) => ({ state: "st", bank: { name: "B", country: "DK" }, started: new Date(Date.now() - ms).toISOString() });
  assert.equal(pendingAuthIsLive(at(0)), true);
  assert.equal(pendingAuthIsLive(at(PENDING_AUTH_TTL_MS - 60_000)), true);
  assert.equal(pendingAuthIsLive(at(PENDING_AUTH_TTL_MS + 60_000)), false);
});

test("starting a login sweeps expired pending auths but keeps live ones", () => {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const started = (ms: number) => new Date(Date.now() - ms).toISOString();
  s.addPendingAuth({ state: "stale", bank: { name: "B", country: "DK" }, started: started(PENDING_AUTH_TTL_MS + 60_000) });
  s.addPendingAuth({ state: "recent", bank: { name: "B", country: "DK" }, started: started(60_000) });
  s.addPendingAuth({ state: "new", bank: { name: "B", country: "DK" }, started: started(0) });
  assert.deepEqual(Object.keys(s.data.pending_auth).sort(), ["new", "recent"]);
});
