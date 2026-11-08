// Thin typed client for the Enable Banking API. Every request carries an
// RS256 JWT signed with the application's private key (see the quick start at
// https://enablebanking.com/docs/api/quick-start/).
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { config, readPrivateKey } from "./config.ts";

export interface Amount {
  currency: string;
  amount: string;
}

export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  sandbox?: boolean;
  beta?: boolean;
}

export interface AccountResource {
  uid: string;
  account_id?: { iban?: string; other?: { identification?: string; scheme_name?: string } };
  name?: string;
  product?: string;
  currency: string;
  cash_account_type?: string;
  identification_hash: string;
}

export interface Balance {
  name?: string;
  balance_amount: Amount;
  balance_type: string;
  reference_date?: string;
  last_change_date_time?: string;
}

export interface Transaction {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: Amount;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  creditor?: { name?: string };
  debtor?: { name?: string };
  creditor_account?: { iban?: string; other?: { identification?: string } };
  debtor_account?: { iban?: string; other?: { identification?: string } };
  remittance_information?: string[];
  bank_transaction_code?: { code?: string; sub_code?: string; description?: string };
  merchant_category_code?: string;
  balance_after_transaction?: Amount;
  note?: string;
}

export interface Session {
  session_id: string;
  accounts: AccountResource[];
  aspsp: { name: string; country: string };
  psu_type: string;
  access: { valid_until: string };
}

export interface SessionStatus {
  status: string;
  accounts: string[];
  aspsp: { name: string; country: string };
  access: { valid_until: string };
  created: string;
  authorized?: string;
  closed?: string;
}

export interface Application {
  name: string;
  kid: string;
  environment: "SANDBOX" | "PRODUCTION";
  redirect_urls: string[];
  active: boolean;
}

/** Enable Banking error codes that mean the bank consent behind a session can no longer be used. */
const CONSENT_GONE_CODES = new Set(["EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION", "SESSION_DOES_NOT_EXIST"]);

export class EnableBankingError extends Error {
  status: number;
  body: string;
  /** The `error` field of Enable Banking's error response, e.g. ASPSP_RATE_LIMIT_EXCEEDED. */
  errorCode?: string;
  /** Seconds from a Retry-After header, when the response had one. */
  retryAfterSeconds?: number;
  constructor(status: number, body: string, retryAfter?: string | null) {
    super(`Enable Banking API ${status}: ${body}`);
    this.status = status;
    this.body = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === "string") this.errorCode = parsed.error;
    } catch {
      // not JSON: no code
    }
    const seconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(seconds) && seconds >= 0) this.retryAfterSeconds = seconds;
  }
  /** True when Enable Banking refuses because the application has not been activated yet. */
  get applicationInactive(): boolean {
    return this.status === 403 && /not active/i.test(this.body);
  }
  /** True when the bank (or Enable Banking on its behalf) refuses because too many requests were made. */
  get rateLimited(): boolean {
    return this.status === 429 || this.errorCode === "ASPSP_RATE_LIMIT_EXCEEDED";
  }
  /**
   * True when the bank consent behind this call is no longer usable. Decided by Enable Banking's error code,
   * never by words in the message: a bank's rate-limit text can say "consent" while the consent is fine.
   * Without a code, only 401 and 410 count.
   */
  get consentGone(): boolean {
    if (this.rateLimited) return false;
    if (this.errorCode) return CONSENT_GONE_CODES.has(this.errorCode);
    return this.status === 401 || this.status === 410;
  }
  /** Status and code only, safe to log: the body's `detail` can carry the bank's own text. */
  get summary(): string {
    return `${this.status}${this.errorCode ? ` ${this.errorCode}` : ""}`;
  }
}

// --- JWT ---

let keyObject: KeyObject | undefined;
let cachedToken: { value: string; exp: number } | undefined;

/** Forget the loaded key and token, e.g. after the setup page stored a new key. */
export function resetKeyCache(): void {
  keyObject = undefined;
  cachedToken = undefined;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function signJwt(appId: string, key: KeyObject, now: number): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function makeJwt(now = Math.floor(Date.now() / 1000)): string {
  if (cachedToken && cachedToken.exp - now > 300) return cachedToken.value;
  keyObject ??= createPrivateKey(readPrivateKey());
  cachedToken = { value: signJwt(config.appId, keyObject, now), exp: now + 3600 };
  return cachedToken.value;
}

// --- HTTP ---

async function api<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, config.apiBase);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${makeJwt()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new EnableBankingError(res.status, text, res.headers.get("retry-after"));
  return (text ? JSON.parse(text) : {}) as T;
}

export interface TransactionPage {
  transactions: Transaction[];
  continuation_key?: string;
}

/** Asks Enable Banking about an application with a key that is not stored yet (the setup page). */
export async function checkApplication(appId: string, pem: string): Promise<Application> {
  const jwt = signJwt(appId, createPrivateKey(pem), Math.floor(Date.now() / 1000));
  const res = await fetch(new URL("/application", config.apiBase), { headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new EnableBankingError(res.status, text);
  return JSON.parse(text) as Application;
}

export const eb = {
  getApplication: () => api<Application>("GET", "/application"),

  listAspsps: async (country: string) => (await api<{ aspsps: Aspsp[] }>("GET", "/aspsps", undefined, { country })).aspsps,

  startAuthorization: (input: { aspsp: Aspsp; state: string; redirectUrl: string; validUntil: Date; psuType?: string }) =>
    api<{ url: string; authorization_id: string; psu_id_hash: string }>("POST", "/auth", {
      access: { valid_until: input.validUntil.toISOString() },
      aspsp: { name: input.aspsp.name, country: input.aspsp.country },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: input.psuType ?? "personal",
    }),

  createSession: (code: string) => api<Session>("POST", "/sessions", { code }),
  getSession: (sessionId: string) => api<SessionStatus>("GET", `/sessions/${sessionId}`),
  deleteSession: (sessionId: string) => api<unknown>("DELETE", `/sessions/${sessionId}`),

  getBalances: async (accountUid: string) => (await api<{ balances: Balance[] }>("GET", `/accounts/${accountUid}/balances`)).balances,

  getTransactionPage: (accountUid: string, opts: { dateFrom?: string; dateTo?: string; continuationKey?: string } = {}) =>
    api<TransactionPage>("GET", `/accounts/${accountUid}/transactions`, undefined, {
      date_from: opts.dateFrom,
      date_to: opts.dateTo,
      continuation_key: opts.continuationKey,
    }),
};
