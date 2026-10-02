import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The key lives in DATA_DIR, so point that at a scratch directory before the
// module reads config. Every test in this file shares the one key.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bank-attest-"));

const {
  ATTESTATION_DEFAULT_RATE_LIMIT,
  ATTESTATION_RATE_WINDOW_SECONDS,
  ATTESTATION_TTL_SECONDS,
  ATTESTATION_VERSION,
  attestationEnabled,
  attestationRateLimit,
  attestationRateLimitMessage,
  attestationRetryAfterSeconds,
  canonical,
  holderNameAllowed,
  keyId,
  maxAttestableBalance,
  normalizeIban,
  publicKeyDocument,
  resetAttestationRate,
  signAttestation,
  takeAttestationSlot,
  verifyAttestation,
} = await import("../src/attestation.ts");

type AttestationClaims = import("../src/attestation.ts").AttestationClaims;

const claims = (over: Partial<AttestationClaims> = {}): AttestationClaims => {
  const issued = Math.floor(Date.now() / 1000);
  return {
    v: ATTESTATION_VERSION,
    iban: "DK5000400440116243",
    owned: true,
    holder_name: null,
    currency: "DKK",
    sufficient: true,
    min_balance: 100,
    nonce: "nonce-abcdefgh",
    issued_at: issued,
    expires_at: issued + ATTESTATION_TTL_SECONDS,
    issuer: "https://bank.example",
    ...over,
  };
};

test("a signed attestation verifies against the published public key", () => {
  const signed = signAttestation(claims());
  const doc = publicKeyDocument();
  assert.equal(signed.key_id, doc.key_id);
  assert.deepEqual(verifyAttestation(signed, doc.public_key, { nonce: "nonce-abcdefgh" }), { valid: true });
});

test("different keys get different ids, which is the whole point of checking one", () => {
  // An Ed25519 SPKI DER opens with a fixed 12-byte ASN.1 header, and 16 base64url
  // characters cover exactly those 12 bytes. Naming a key by the start of its own
  // encoding therefore named every key alike, and the verifier's "key_id matches the
  // published key" check passed for any key at all. One id per key, or no check.
  const ids = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const { publicKey } = generateKeyPairSync("ed25519");
    ids.add(keyId(publicKey.export({ type: "spki", format: "der" }).toString("base64url")));
  }
  assert.equal(ids.size, 50);
});

test("a key id is stable for one key, so a verifier can compare it", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal(keyId(encoded), keyId(encoded));
});

test("the key is stable across calls, so a verifier can cache it", () => {
  assert.equal(publicKeyDocument().public_key, publicKeyDocument().public_key);
  assert.equal(publicKeyDocument().algorithm, "ed25519");
});

test("changing any signed field breaks the signature", () => {
  const doc = publicKeyDocument();
  // Every field a verifier decides on must be covered, so walk them all.
  const tampering: Array<Partial<AttestationClaims>> = [
    { owned: false },
    { sufficient: false },
    { min_balance: 1 },
    { iban: "DK5000400440116244" },
    { currency: "EUR" },
    { holder_name: "Someone Else" },
    { nonce: "different-nonce" },
    { issuer: "https://evil.example" },
    { expires_at: Math.floor(Date.now() / 1000) + 99999 },
  ];
  for (const patch of tampering) {
    const signed = signAttestation(claims());
    const forged = { ...signed, claims: { ...signed.claims, ...patch } };
    const result = verifyAttestation(forged, doc.public_key);
    assert.equal(result.valid, false, `tampering with ${Object.keys(patch)[0]} must not verify`);
  }
});

test("a mismatched nonce is refused even though the signature is good", () => {
  const signed = signAttestation(claims({ nonce: "issued-for-this" }));
  const result = verifyAttestation(signed, publicKeyDocument().public_key, { nonce: "asked-for-that" });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /nonce/i);
});

test("an expired attestation is refused", () => {
  const issued = Math.floor(Date.now() / 1000) - 3600;
  const signed = signAttestation(claims({ issued_at: issued, expires_at: issued + ATTESTATION_TTL_SECONDS }));
  const result = verifyAttestation(signed, publicKeyDocument().public_key);
  assert.equal(result.valid, false);
  assert.match(result.reason!, /expired/i);
});

test("an attestation minted in the future is refused", () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const signed = signAttestation(claims({ issued_at: future, expires_at: future + ATTESTATION_TTL_SECONDS }));
  const result = verifyAttestation(signed, publicKeyDocument().public_key);
  assert.equal(result.valid, false);
  assert.match(result.reason!, /future/i);
});

test("an unknown version is refused before the signature is even checked", () => {
  const signed = signAttestation(claims());
  const forged = { ...signed, claims: { ...signed.claims, v: "bankmcp-attestation-v2" as typeof ATTESTATION_VERSION } };
  const result = verifyAttestation(forged, publicKeyDocument().public_key);
  assert.equal(result.valid, false);
  assert.match(result.reason!, /version/i);
});

test("a signature from a different key does not verify", () => {
  const signed = signAttestation(claims());
  // A well-formed Ed25519 public key that did not sign this.
  const { publicKey } = generateKeyPairSync("ed25519");
  const other = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal(verifyAttestation(signed, other).valid, false);
});

test("garbage in place of a public key is refused, not thrown", () => {
  const signed = signAttestation(claims());
  const result = verifyAttestation(signed, "not-a-key");
  assert.equal(result.valid, false);
  assert.match(result.reason!, /could not be checked/i);
});

test("canonical bytes do not depend on the order the claims were built in", () => {
  const a = claims();
  const shuffled = { issuer: a.issuer, nonce: a.nonce, v: a.v, owned: a.owned, iban: a.iban, currency: a.currency, holder_name: a.holder_name, sufficient: a.sufficient, min_balance: a.min_balance, issued_at: a.issued_at, expires_at: a.expires_at } as AttestationClaims;
  assert.equal(canonical(a), canonical(shuffled));
});

test("IBANs are compared without spaces or case", () => {
  assert.equal(normalizeIban(" dk50 0040 0440 1162 43 "), "DK5000400440116243");
});

test("attestation is off unless the owner turns it on", () => {
  delete process.env.ATTESTATION_ENABLED;
  assert.equal(attestationEnabled(), false);
  process.env.ATTESTATION_ENABLED = "1";
  assert.equal(attestationEnabled(), true);
  delete process.env.ATTESTATION_ENABLED;
});

test("the holder name is withheld unless the owner allows it", () => {
  delete process.env.ATTESTATION_INCLUDE_HOLDER_NAME;
  assert.equal(holderNameAllowed(), false);
  process.env.ATTESTATION_INCLUDE_HOLDER_NAME = "1";
  assert.equal(holderNameAllowed(), true);
  delete process.env.ATTESTATION_INCLUDE_HOLDER_NAME;
});

test("no balance ceiling is set unless the owner sets a positive one", () => {
  delete process.env.ATTESTATION_MAX_BALANCE;
  assert.equal(maxAttestableBalance(), undefined);
  process.env.ATTESTATION_MAX_BALANCE = "5000";
  assert.equal(maxAttestableBalance(), 5000);
  // A nonsense ceiling must not become "unlimited" by accident.
  process.env.ATTESTATION_MAX_BALANCE = "-1";
  assert.equal(maxAttestableBalance(), undefined);
  process.env.ATTESTATION_MAX_BALANCE = "not a number";
  assert.equal(maxAttestableBalance(), undefined);
  delete process.env.ATTESTATION_MAX_BALANCE;
});

// --- Rate limiting ---
//
// The ceiling on min_balance bounds what one answer reveals; the limiter bounds
// how many answers a caller gets. These tests cover the second half of that
// pair, so they care about counting and about the window, not about signatures.

test("a limit is in force by default, because unlimited answers defeat the balance ceiling", () => {
  delete process.env.ATTESTATION_RATE_LIMIT;
  assert.equal(attestationRateLimit(), ATTESTATION_DEFAULT_RATE_LIMIT);
  // Low enough that a binary search is not worth starting; the window is an hour.
  assert.ok(ATTESTATION_DEFAULT_RATE_LIMIT > 0 && ATTESTATION_DEFAULT_RATE_LIMIT < 100);
  assert.equal(ATTESTATION_RATE_WINDOW_SECONDS, 3600);
});

test("the owner can set the limit, and a nonsense value falls back to the default rather than to unlimited", () => {
  process.env.ATTESTATION_RATE_LIMIT = "5";
  assert.equal(attestationRateLimit(), 5);
  // Turning it off has to be a deliberate, well-formed choice.
  process.env.ATTESTATION_RATE_LIMIT = "0";
  assert.equal(attestationRateLimit(), 0);
  process.env.ATTESTATION_RATE_LIMIT = "-1";
  assert.equal(attestationRateLimit(), ATTESTATION_DEFAULT_RATE_LIMIT);
  process.env.ATTESTATION_RATE_LIMIT = "2.5";
  assert.equal(attestationRateLimit(), ATTESTATION_DEFAULT_RATE_LIMIT);
  process.env.ATTESTATION_RATE_LIMIT = "not a number";
  assert.equal(attestationRateLimit(), ATTESTATION_DEFAULT_RATE_LIMIT);
  delete process.env.ATTESTATION_RATE_LIMIT;
});

test("the limit is enforced once the window is full", () => {
  process.env.ATTESTATION_RATE_LIMIT = "3";
  resetAttestationRate();
  const now = Date.now();
  assert.deepEqual([0, 1, 2].map((i) => takeAttestationSlot(now + i)), [true, true, true]);
  assert.equal(takeAttestationSlot(now + 3), false);
  // A refusal must not itself consume a slot, or a caller could never recover.
  assert.equal(takeAttestationSlot(now + 4), false);
  delete process.env.ATTESTATION_RATE_LIMIT;
  resetAttestationRate();
});

test("the window slides, so a caller that waits is served again", () => {
  process.env.ATTESTATION_RATE_LIMIT = "2";
  resetAttestationRate();
  const now = Date.now();
  assert.equal(takeAttestationSlot(now), true);
  assert.equal(takeAttestationSlot(now + 1000), true);
  assert.equal(takeAttestationSlot(now + 2000), false);
  // Still inside the window a moment before it closes, free a moment after.
  assert.equal(takeAttestationSlot(now + ATTESTATION_RATE_WINDOW_SECONDS * 1000 - 1), false);
  assert.equal(takeAttestationSlot(now + ATTESTATION_RATE_WINDOW_SECONDS * 1000 + 1), true);
  delete process.env.ATTESTATION_RATE_LIMIT;
  resetAttestationRate();
});

test("a refusal can say how long to wait", () => {
  process.env.ATTESTATION_RATE_LIMIT = "1";
  resetAttestationRate();
  const now = Date.now();
  assert.equal(attestationRetryAfterSeconds(now), 0);
  takeAttestationSlot(now);
  // Nearly the whole window at first, and never zero while a slot is still held.
  assert.equal(attestationRetryAfterSeconds(now), ATTESTATION_RATE_WINDOW_SECONDS);
  assert.equal(attestationRetryAfterSeconds(now + (ATTESTATION_RATE_WINDOW_SECONDS - 10) * 1000), 10);
  assert.equal(attestationRetryAfterSeconds(now + ATTESTATION_RATE_WINDOW_SECONDS * 1000), 1);
  delete process.env.ATTESTATION_RATE_LIMIT;
  resetAttestationRate();
});

test("the owner can turn the limiter off, and then nothing is counted", () => {
  process.env.ATTESTATION_RATE_LIMIT = "0";
  resetAttestationRate();
  const now = Date.now();
  for (let i = 0; i < ATTESTATION_DEFAULT_RATE_LIMIT * 3; i += 1) {
    assert.equal(takeAttestationSlot(now + i), true);
  }
  delete process.env.ATTESTATION_RATE_LIMIT;
  resetAttestationRate();
});

test("the refusal names the limit and when to come back, and says nothing about the account", () => {
  process.env.ATTESTATION_RATE_LIMIT = "2";
  resetAttestationRate();
  const now = Date.now();
  takeAttestationSlot(now);
  const message = attestationRateLimitMessage(now);
  assert.match(message, /at most 2 attestations per 60 minutes/);
  assert.match(message, /Try again in about 3600 seconds/);
  // The caller is another service deciding whether to retry; a refusal that
  // leaked anything about the IBAN would be an answer it did not pay for.
  assert.doesNotMatch(message, /iban|owned|balance/i);
  delete process.env.ATTESTATION_RATE_LIMIT;
  resetAttestationRate();
});
