// Signed answers to narrow questions about an account, for a third party the
// owner chooses to share them with.
//
// The rest of this server answers "what is in my account" to the owner's own
// assistant. An attestation answers something smaller to someone else: "yes,
// this IBAN is one of mine", and optionally "yes, it holds at least X". No
// balance, no transactions, no account list — a boolean, a scope, and a
// signature over both.
//
// Off unless ATTESTATION_ENABLED=1. It is the one place where this server
// speaks to a party other than its owner, so it stays a deliberate choice.
//
// Read-only holds: nothing here initiates a payment or asks Enable Banking for
// any permission the server does not already have. The bank calls underneath
// are the same balance reads list_accounts and get_balances already make.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

/** Version of the attestation format. Goes in the signed payload; a verifier rejects what it does not know. */
export const ATTESTATION_VERSION = "bankmcp-attestation-v1";

/** How long an attestation is worth trusting. Balance statements go stale; ownership does not, but the
 * same window keeps one object from being replayed months later as if it were fresh. */
export const ATTESTATION_TTL_SECONDS = 300;

/**
 * What the signature covers. Everything a verifier decides on must be in here:
 * an attestation is only as honest as the fields it commits to.
 */
export interface AttestationClaims {
  v: typeof ATTESTATION_VERSION;
  /** The IBAN that was asked about, normalized. */
  iban: string;
  /** True when that IBAN belongs to an account this server has a live consent for. */
  owned: boolean;
  /** Name on the account as the bank reports it, when the owner allows it. Null when withheld. */
  holder_name: string | null;
  /** Currency of the account, when owned. */
  currency: string | null;
  /** Answer to "does it hold at least min_balance", or null when no threshold was asked about. */
  sufficient: boolean | null;
  /** The threshold that `sufficient` answers, echoed so the claim cannot be reused for a different one. */
  min_balance: number | null;
  /** The caller's value, echoed back. Binds this attestation to one request. */
  nonce: string;
  /** Seconds since the epoch: when this was signed, and when it stops being fresh. */
  issued_at: number;
  expires_at: number;
  /** Which server said it. */
  issuer: string;
}

export interface Attestation {
  claims: AttestationClaims;
  /** Ed25519 over the canonical JSON of `claims`, base64url. */
  signature: string;
  /** Key that signed it, so a verifier knows which public key to fetch. */
  key_id: string;
}

// --- Key management ---

const keyPath = () => join(config.dataDir, "attestation-key.pem");

let cached: { key: KeyObject; id: string } | undefined;

/** Forget the loaded key, e.g. after it was rotated. Tests use it too. */
export function resetAttestationKey(): void {
  cached = undefined;
}

/**
 * The server's own signing key, generated on first use and kept in the data
 * directory beside the Enable Banking key. Deliberately not the Enable Banking
 * key: that one authenticates this server *to the bank*, and reusing it to sign
 * statements *about* the bank would blur two very different authorities.
 */
export function attestationKey(): { key: KeyObject; id: string } {
  if (cached) return cached;
  const path = keyPath();
  let pem: string;
  if (existsSync(path)) {
    pem = readFileSync(path, "utf8");
  } else {
    const { privateKey } = generateKeyPairSync("ed25519");
    pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(path, pem, { mode: 0o600 });
  }
  const key = createPrivateKey(pem);
  cached = { key, id: keyId(publicKeyOf(key)) };
  return cached;
}

function publicKeyOf(key: KeyObject): string {
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url");
}

/**
 * A short stable name for a public key: a hash of it, truncated. Not a secret.
 * Hashed rather than sliced because an Ed25519 SPKI DER opens with a fixed
 * 12-byte ASN.1 header — exactly what 16 base64url characters cover — so
 * truncating the encoding itself would name every key `MCowBQYDK2VwAyEA` and
 * the verifier's "key_id matches the published key" check would pass for any
 * key at all, including across a rotation.
 */
export function keyId(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64url")).digest("base64url").slice(0, 16);
}

/** What /.well-known/bankmcp-attestation publishes. Public by design: it verifies signatures, it makes none. */
export function publicKeyDocument(): { version: string; issuer: string; key_id: string; algorithm: "ed25519"; public_key: string } {
  const { key, id } = attestationKey();
  return {
    version: ATTESTATION_VERSION,
    issuer: config.baseUrl,
    key_id: id,
    algorithm: "ed25519",
    public_key: publicKeyOf(key),
  };
}

// --- Signing and verifying ---

/**
 * Canonical bytes for a claims object: keys in a fixed order, no whitespace.
 * Both sides must produce the same bytes, so the order is written out rather
 * than left to JSON.stringify's insertion order.
 */
export function canonical(claims: AttestationClaims): string {
  const ordered: Record<string, unknown> = {
    v: claims.v,
    iban: claims.iban,
    owned: claims.owned,
    holder_name: claims.holder_name,
    currency: claims.currency,
    sufficient: claims.sufficient,
    min_balance: claims.min_balance,
    nonce: claims.nonce,
    issued_at: claims.issued_at,
    expires_at: claims.expires_at,
    issuer: claims.issuer,
  };
  return JSON.stringify(ordered);
}

export function signAttestation(claims: AttestationClaims): Attestation {
  const { key, id } = attestationKey();
  return {
    claims,
    signature: sign(null, Buffer.from(canonical(claims), "utf8"), key).toString("base64url"),
    key_id: id,
  };
}

/**
 * Checks the signature and the freshness of an attestation against a published
 * public key. Exported because the same check belongs in the test suite, and so
 * that anyone reading this file can see exactly what a verifier must do.
 */
export function verifyAttestation(
  attestation: Attestation,
  publicKeyB64: string,
  opts: { nonce?: string; now?: number } = {},
): { valid: boolean; reason?: string } {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const { claims } = attestation;
  if (claims.v !== ATTESTATION_VERSION) return { valid: false, reason: `Unknown attestation version ${claims.v}.` };
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) return { valid: false, reason: "Nonce does not match the request." };
  if (claims.expires_at <= now) return { valid: false, reason: "Attestation has expired." };
  // A clock a little ahead is normal; a claim minted far in the future is not.
  if (claims.issued_at > now + 60) return { valid: false, reason: "Attestation is issued in the future." };
  let ok: boolean;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64url"), format: "der", type: "spki" });
    ok = verify(null, Buffer.from(canonical(claims), "utf8"), key, Buffer.from(attestation.signature, "base64url"));
  } catch (err) {
    return { valid: false, reason: `Signature could not be checked: ${(err as Error).message}` };
  }
  return ok ? { valid: true } : { valid: false, reason: "Signature does not match the claims." };
}

// --- Policy ---

/** True when the owner has turned attestations on. Off by default. */
export function attestationEnabled(): boolean {
  return process.env.ATTESTATION_ENABLED === "1";
}

/** True when the owner allows the name on the account to be included. Off by default: it is personal data. */
export function holderNameAllowed(): boolean {
  return process.env.ATTESTATION_INCLUDE_HOLDER_NAME === "1";
}

/**
 * Highest threshold an attestation will answer `sufficient` for. A caller that
 * could ask about any amount could binary-search the balance out of a series of
 * yes/no answers; a ceiling bounds what those answers can reveal. Unset means
 * no balance question is answered at all.
 */
export function maxAttestableBalance(): number | undefined {
  const raw = process.env.ATTESTATION_MAX_BALANCE?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

// --- Rate limiting ---

/**
 * Attestations an hour. The ceiling in `maxAttestableBalance` bounds how much a
 * single yes/no answer can reveal; this bounds how many of them a caller gets.
 * The two are the same defence from opposite ends: twenty questions is enough
 * to binary-search a balance, so a caller who can ask freely eventually learns
 * the number even with a ceiling in place, by walking the range below it.
 *
 * Thirty an hour is far above what the intended use needs — proving a funding
 * source is a handful of calls when an account is first connected, and a
 * re-proof now and then after that — and far below the volume a search needs to
 * be worth running. The MCP tools specification asks servers to rate limit;
 * this is also the number that makes the ceiling hold.
 */
export const ATTESTATION_DEFAULT_RATE_LIMIT = 30;

/** The window the limit is counted over. One hour: long enough that a patient search is still bounded. */
export const ATTESTATION_RATE_WINDOW_SECONDS = 3600;

/**
 * How many attestations this server will issue per window. Set
 * ATTESTATION_RATE_LIMIT=0 to turn the limiter off, which is a deliberate
 * choice and not the default: unlimited yes/no answers defeat the balance
 * ceiling. Anything unparseable falls back to the default rather than to
 * "unlimited", so a typo cannot quietly remove the bound.
 */
export function attestationRateLimit(): number {
  const raw = process.env.ATTESTATION_RATE_LIMIT?.trim();
  if (!raw) return ATTESTATION_DEFAULT_RATE_LIMIT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : ATTESTATION_DEFAULT_RATE_LIMIT;
}

// Timestamps of the attestations issued inside the current window, oldest
// first. In process and not persisted, like every other count this server
// keeps: a restart is the owner's own action, not a caller's, so it is not a
// way around the limit. One server, one owner, one consent — there is no
// per-caller identity here worth partitioning by, and a shared budget is the
// conservative reading when there might be more than one.
let issued: number[] = [];

/** Forget the window. Tests use it; nothing in the server does. */
export function resetAttestationRate(): void {
  issued = [];
}

/**
 * Records one attestation against the window and says whether it was within
 * the limit. Called once per answer actually issued, including signed "no"s: an
 * IBAN that is not the owner's still costs a question, and letting those run
 * free would hand a caller an unmetered way to enumerate.
 */
export function takeAttestationSlot(now: number = Date.now()): boolean {
  const limit = attestationRateLimit();
  if (limit === 0) return true;
  const cutoff = now - ATTESTATION_RATE_WINDOW_SECONDS * 1000;
  issued = issued.filter((t) => t > cutoff);
  if (issued.length >= limit) return false;
  issued.push(now);
  return true;
}

/** Seconds until the oldest attestation in the window falls out of it, so a refusal can say when to come back. */
export function attestationRetryAfterSeconds(now: number = Date.now()): number {
  const oldest = issued[0];
  if (oldest === undefined) return 0;
  return Math.max(1, Math.ceil((oldest + ATTESTATION_RATE_WINDOW_SECONDS * 1000 - now) / 1000));
}

/**
 * What the caller is told when the window is full. It names the limit and when
 * to come back rather than only refusing, because the caller is another service
 * deciding whether to retry: a refusal it cannot act on becomes a retry loop.
 * It says nothing about the account that was asked about — a refusal that
 * leaked whether the IBAN was the owner's would be a free answer.
 */
export function attestationRateLimitMessage(now: number = Date.now()): string {
  const minutes = Math.round(ATTESTATION_RATE_WINDOW_SECONDS / 60);
  return `This server issues at most ${attestationRateLimit()} attestations per ${minutes} minutes, and that limit is reached. Try again in about ${attestationRetryAfterSeconds(now)} seconds.`;
}
