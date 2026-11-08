// Every read from a bank goes through here. It keeps a short in-memory cache, a per-account budget of bank
// calls, and a cooldown after the bank says "too many requests", so a chatty client cannot burn the PSD2
// allowance for unattended access (often 4 a day per account) or get a valid consent marked as expired.
//
// The cache lives only in this process: nothing is written to disk, it is gone on restart, and entries
// older than staleMaxMs are dropped. Transactions and balances are still never stored in the data file.
import { EnableBankingError } from "./enablebanking.ts";
import type { Store, StoredAccount } from "./store.ts";

/** A failure to show the client as-is: it explains what happened and what to do. */
export class BankReadError extends Error {}

export interface BankGuardOptions {
  store: () => Store;
  now: () => number;
  log: (msg: string) => void;
  /** Live session status from Enable Banking (GET /sessions/{id}). */
  sessionStatus: (sessionId: string) => Promise<string>;
  /** Bank calls allowed per account in any 24 hours. 0 turns the budget off. */
  dailyLimit: number;
  /** Answers younger than this are served from the cache without asking the bank. */
  cacheTtlMs: number;
  /** Older answers are only served when the bank cannot be asked (rate limit or budget), up to this age. */
  staleMaxMs: number;
  /** Pause after a rate limit when the bank did not send Retry-After. */
  cooldownMs: number;
}

export interface GuardedRead<T> {
  value: T;
  /** When the bank produced this answer, if it came from the cache. */
  cached_at?: string;
  /** True when a cached answer older than the fresh window is returned because the bank cannot be asked. */
  stale: boolean;
  note?: string;
}

const DAY_MS = 24 * 3600_000;

export class BankGuard {
  private cache = new Map<string, { value: unknown; at: number }>();
  private calls = new Map<string, number[]>();
  private coolUntil = new Map<string, number>();

  private opts: BankGuardOptions;

  constructor(opts: BankGuardOptions) {
    this.opts = opts;
  }

  /**
   * Reads through the guard. With `live`, the answer always comes from the bank and no cached answer is ever
   * returned (for signed statements such as attestations); the budget and the rate-limit pause still apply.
   */
  async read<T>(account: StoredAccount, key: string, fetch: () => Promise<T>, options: { live?: boolean } = {}): Promise<GuardedRead<T>> {
    const now = this.opts.now();
    const cacheKey = `${account.uid}|${key}`;
    const cached = options.live ? undefined : this.cached<T>(cacheKey, now);
    if (cached && now - cached.at < this.opts.cacheTtlMs) return { value: cached.value, cached_at: iso(cached.at), stale: false };

    const blocked = this.blockedReason(account, now);
    if (blocked) {
      if (cached) return { value: cached.value, cached_at: iso(cached.at), stale: true, note: blocked };
      throw new BankReadError(blocked);
    }

    this.recordCall(account.uid, now);
    try {
      const value = await fetch();
      if (!options.live) this.cache.set(cacheKey, { value, at: this.opts.now() });
      this.healSession(account);
      return { value, stale: false };
    } catch (err) {
      if (!(err instanceof EnableBankingError)) throw err;
      const bank = this.bankName(account);
      if (err.rateLimited) {
        const until = this.opts.now() + (err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : this.opts.cooldownMs);
        this.coolUntil.set(account.uid, until);
        this.opts.log(`rate limited by ${bank} (${err.summary}), account …${account.uid.slice(-4)}, pausing until ${iso(until)}`);
        const note = rateLimitMessage(bank, until);
        if (cached) return { value: cached.value, cached_at: iso(cached.at), stale: true, note };
        throw new BankReadError(note);
      }
      if (err.consentGone) {
        this.opts.log(`bank call refused by ${bank} (${err.summary}), checking the session`);
        const live = await this.opts.sessionStatus(account.session_id).catch(() => undefined);
        if (live && live !== "AUTHORIZED") {
          this.setSessionStatus(account.session_id, live);
          throw new BankReadError(`The bank consent for ${bank} is no longer valid (${err.summary}, session ${live}). Run start_consent for that bank again; the account keeps its label and watches.`);
        }
        throw new BankReadError(`${bank} refused the request (${err.summary}), but Enable Banking reports the consent as ${live ?? "unknown"}. Do not run start_consent yet; try again later.`);
      }
      this.opts.log(`bank call failed for ${bank} (${err.summary})`);
      throw err;
    }
  }

  private cached<T>(cacheKey: string, now: number): { value: T; at: number } | undefined {
    const hit = this.cache.get(cacheKey);
    if (!hit) return undefined;
    if (now - hit.at > this.opts.staleMaxMs) {
      this.cache.delete(cacheKey);
      return undefined;
    }
    return hit as { value: T; at: number };
  }

  private blockedReason(account: StoredAccount, now: number): string | undefined {
    const until = this.coolUntil.get(account.uid);
    if (until && until > now) return rateLimitMessage(this.bankName(account), until);
    if (this.opts.dailyLimit > 0) {
      const recent = this.recentCalls(account.uid, now);
      if (recent.length >= this.opts.dailyLimit) {
        const next = recent[0]! + DAY_MS;
        return `The daily budget of ${this.opts.dailyLimit} bank calls for this account is used up (it protects the PSD2 limit on unattended access). The consent is still valid; do not run start_consent. More calls are possible after ${iso(next)}.`;
      }
    }
    return undefined;
  }

  private recentCalls(uid: string, now: number): number[] {
    const recent = (this.calls.get(uid) ?? []).filter((t) => now - t < DAY_MS);
    this.calls.set(uid, recent);
    return recent;
  }

  private recordCall(uid: string, now: number): void {
    this.recentCalls(uid, now).push(now);
  }

  /** A read worked, so the consent works: undo an EXPIRED mark left by an earlier misclassified error. */
  private healSession(account: StoredAccount): void {
    const session = this.opts.store().data.sessions[account.session_id];
    if (session && session.status !== "AUTHORIZED") this.setSessionStatus(account.session_id, "AUTHORIZED");
  }

  private setSessionStatus(sessionId: string, status: string): void {
    const s = this.opts.store();
    if (s.data.sessions[sessionId]) s.update((d) => void (d.sessions[sessionId]!.status = status));
  }

  private bankName(account: StoredAccount): string {
    return this.opts.store().data.sessions[account.session_id]?.bank.name ?? "the bank";
  }
}

function rateLimitMessage(bank: string, until: number): string {
  return `${bank} rate limit reached (too many requests). The consent is still valid; do not run start_consent. Try again after ${iso(until)}.`;
}

const iso = (ms: number) => new Date(ms).toISOString();
