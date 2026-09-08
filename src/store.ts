// The only state this server keeps: bank sessions and account ids, watches,
// and the OAuth clients/tokens for the MCP connector. One JSON file, written
// atomically. Transactions and balances are never stored.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";

export interface StoredSession {
  id: string;
  bank: { name: string; country: string };
  psu_type: string;
  valid_until: string;
  created: string;
  /** Last status reported by Enable Banking, if we have checked. */
  status?: string;
  expiry_notified?: boolean;
}

export interface StoredAccount {
  uid: string;
  session_id: string;
  name?: string;
  product?: string;
  iban?: string;
  other_id?: string;
  currency: string;
  cash_account_type?: string;
  identification_hash: string;
  /** Your own name for the account, e.g. "Joint expenses". */
  label?: string;
  last_polled?: string;
}

export interface PendingAuth {
  state: string;
  bank: { name: string; country: string };
  started: string;
}

/** How long a started-but-unfinished bank login stays interesting. */
export const PENDING_AUTH_TTL_MS = 60 * 60 * 1000;

/** True while a pending authorization is recent enough to still be completed. */
export const pendingAuthIsLive = (p: PendingAuth, now = Date.now()): boolean => Date.parse(p.started) >= now - PENDING_AUTH_TTL_MS;

export type WatchRule =
  | { type: "balance_below"; amount: number }
  | { type: "balance_above"; amount: number }
  | { type: "large_debit"; amount: number }
  | { type: "credit_matching"; match: string; min_amount?: number }
  | { type: "debit_matching"; match: string; min_amount?: number }
  | { type: "credit_missing_by"; match: string; by_date: string; min_amount?: number };

export interface Watch {
  id: string;
  account: string;
  rule: WatchRule;
  note?: string;
  webhook_url?: string;
  created: string;
  active: boolean;
  last_checked?: string;
  last_triggered?: string;
  /** Transaction ids already reported, so a match notifies once. */
  seen: string[];
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  [key: string]: unknown;
}

export interface AuthCode {
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  resource?: string;
  scopes: string[];
  expires: number;
}

export interface Token {
  client_id: string;
  scopes: string[];
  expires: number;
  resource?: string;
  /** For refresh tokens: nothing extra. For access tokens: nothing extra. */
  kind: "access" | "refresh";
}

export interface StoreData {
  version: 1;
  sessions: Record<string, StoredSession>;
  accounts: Record<string, StoredAccount>;
  pending_auth: Record<string, PendingAuth>;
  watches: Record<string, Watch>;
  oauth: {
    clients: Record<string, OAuthClient>;
    codes: Record<string, AuthCode>;
    /** Keyed by sha256 of the token value. */
    tokens: Record<string, Token>;
    /** Fingerprint of the admin password the tokens were issued under. */
    password_fingerprint?: string;
  };
}

const empty = (): StoreData => ({
  version: 1,
  sessions: {},
  accounts: {},
  pending_auth: {},
  watches: {},
  oauth: { clients: {}, codes: {}, tokens: {} },
});

export class Store {
  readonly path: string;
  data: StoreData;

  constructor(path = join(config.dataDir, "bank.json")) {
    this.path = path;
    this.data = empty();
    // Earlier versions named the file openbank.json or openbanking.json.
    for (const old of ["openbanking.json", "openbank.json"]) {
      const legacy = join(dirname(path), old);
      if (!existsSync(path) && existsSync(legacy)) renameSync(legacy, path);
    }
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreData>;
      this.data = { ...empty(), ...parsed, oauth: { ...empty().oauth, ...(parsed.oauth ?? {}) } };
    }
  }

  save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.error(`[bank] cannot write state file ${this.path}: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Mutate under a callback and persist once. */
  update<T>(fn: (d: StoreData) => T): T {
    const result = fn(this.data);
    this.save();
    return result;
  }

  // --- Sessions & accounts ---

  addSession(session: { session_id: string; aspsp: { name: string; country: string }; psu_type: string; access: { valid_until: string }; accounts: Array<{ uid: string; name?: string; product?: string; currency: string; cash_account_type?: string; identification_hash: string; account_id?: { iban?: string; other?: { identification?: string } } }> }): void {
    this.update((d) => {
      d.sessions[session.session_id] = {
        id: session.session_id,
        bank: { name: session.aspsp.name, country: session.aspsp.country },
        psu_type: session.psu_type,
        valid_until: session.access.valid_until,
        created: new Date().toISOString(),
        status: "AUTHORIZED",
      };
      for (const a of session.accounts) {
        // A re-consent returns the same account under a new uid; carry the
        // label and watches over and drop the stale entry.
        const previous = Object.values(d.accounts).find((x) => x.identification_hash === a.identification_hash && x.uid !== a.uid);
        if (previous) {
          for (const w of Object.values(d.watches)) if (w.account === previous.uid) w.account = a.uid;
          delete d.accounts[previous.uid];
        }
        d.accounts[a.uid] = {
          uid: a.uid,
          session_id: session.session_id,
          name: a.name,
          product: a.product,
          iban: a.account_id?.iban,
          other_id: a.account_id?.other?.identification,
          currency: a.currency,
          cash_account_type: a.cash_account_type,
          identification_hash: a.identification_hash,
          label: previous?.label,
          last_polled: previous?.last_polled,
        };
      }
      // Sessions that no longer own any account are dead weight.
      for (const s of Object.values(d.sessions)) {
        if (s.id !== session.session_id && !Object.values(d.accounts).some((a) => a.session_id === s.id)) delete d.sessions[s.id];
      }
    });
  }

  removeSession(sessionId: string): void {
    this.update((d) => {
      delete d.sessions[sessionId];
      for (const a of Object.values(d.accounts)) if (a.session_id === sessionId) delete d.accounts[a.uid];
    });
  }

  accounts(): StoredAccount[] {
    return Object.values(this.data.accounts);
  }

  account(uid: string): StoredAccount | undefined {
    return this.data.accounts[uid];
  }

  sessions(): StoredSession[] {
    return Object.values(this.data.sessions);
  }

  // --- Pending bank authorizations ---

  addPendingAuth(p: PendingAuth): void {
    this.update((d) => {
      for (const [k, v] of Object.entries(d.pending_auth)) if (!pendingAuthIsLive(v)) delete d.pending_auth[k];
      d.pending_auth[p.state] = p;
    });
  }

  takePendingAuth(state: string): PendingAuth | undefined {
    return this.update((d) => {
      const p = d.pending_auth[state];
      delete d.pending_auth[state];
      return p;
    });
  }

  // --- Watches ---

  watches(): Watch[] {
    return Object.values(this.data.watches);
  }

  putWatch(w: Watch): void {
    this.update((d) => {
      d.watches[w.id] = w;
    });
  }

  deleteWatch(id: string): boolean {
    return this.update((d) => {
      const had = id in d.watches;
      delete d.watches[id];
      return had;
    });
  }
}

let shared: Store | undefined;
export function store(): Store {
  return (shared ??= new Store());
}
