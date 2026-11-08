import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, isConfigured } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { pendingAuthIsLive, store, type StoredAccount, type WatchRule } from "./store.ts";
import {
  daysAgo,
  daysLeft,
  describeAccount,
  findOwnTransfers,
  isoDate,
  matchesQuery,
  round2,
  simplifyBalances,
  simplifyTransactions,
  totalsByMonth,
  type AccountTransaction,
} from "./data.ts";
import { runWatches } from "./watcher.ts";
import {
  ATTESTATION_TTL_SECONDS,
  ATTESTATION_VERSION,
  attestationEnabled,
  attestationRateLimitMessage,
  holderNameAllowed,
  maxAttestableBalance,
  normalizeIban,
  signAttestation,
  takeAttestationSlot,
  type Attestation,
  type AttestationClaims,
} from "./attestation.ts";
import { BankGuard, BankReadError, type GuardedRead } from "./bankguard.ts";

const MAX_CONSENT_DAYS = 180;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/**
 * An attestation as a tool result. Every other tool here answers an assistant,
 * which reads the text; this one answers a verifier, which parses the object
 * and checks a signature over exactly these fields. So it is the one tool that
 * declares an outputSchema, and it must carry `structuredContent` to match —
 * the text copy stays so that a client which ignores structured output still
 * sees the same answer rather than an empty result.
 */
const attested = (attestation: Attestation) => ({
  content: [{ type: "text" as const, text: JSON.stringify(attestation, null, 2) }],
  structuredContent: attestation as unknown as Record<string, unknown>,
});

class ToolError extends Error {}

/** Accepts an account uid, or your label / the bank's name / IBAN (case-insensitive). */
export function resolveAccount(ref: string): StoredAccount {
  const s = store();
  const direct = s.account(ref);
  if (direct) return direct;
  const needle = ref.trim().toLowerCase();
  const matches = s.accounts().filter((a) => [a.label, a.name, a.product, a.iban, a.other_id].some((v) => v?.toLowerCase() === needle));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new ToolError(`"${ref}" matches ${matches.length} accounts; use the uid from list_accounts.`);
  const partial = s.accounts().filter((a) => [a.label, a.name, a.product].some((v) => v?.toLowerCase().includes(needle)));
  if (partial.length === 1) return partial[0]!;
  throw new ToolError(`No account "${ref}". Call list_accounts for the uids and labels.`);
}

const bankGuard = new BankGuard({
  store,
  now: () => Date.now(),
  log: (msg) => console.log(`[bank ${new Date().toISOString()}] ${msg}`),
  sessionStatus: async (id) => (await eb.getSession(id)).status,
  dailyLimit: config.bankDailyCallLimit,
  cacheTtlMs: config.bankCacheTtlMinutes * 60_000,
  staleMaxMs: 24 * 3600_000,
  cooldownMs: 6 * 3600_000,
});

/** Cache and staleness fields added to an answer that came from the guard. */
const freshness = (r: GuardedRead<unknown>) => ({
  ...(r.cached_at ? { cached_at: r.cached_at } : {}),
  ...(r.stale ? { stale: true } : {}),
  ...(r.note ? { note: r.note } : {}),
});

/** Runs a bank read for one account through the cache, budget and rate-limit guard. */
async function withAccount<T>(ref: string, key: string, fn: (a: StoredAccount) => Promise<T>, options: { live?: boolean } = {}): Promise<GuardedRead<T> & { account: StoredAccount }> {
  const account = resolveAccount(ref);
  return { ...(await bankGuard.read(account, key, () => fn(account), options)), account };
}

/** Pages fetched per account by the tools that read across accounts. */
const MAX_PAGES_PER_ACCOUNT = 50;

interface Checked {
  account: string;
  uid: string;
  from: string;
  to: string;
  transactions: number;
  /** False when the page cap stopped the fetch, or the account could not be read. */
  complete: boolean;
  error?: string;
  /** Set when the transactions came from the in-memory cache. */
  cached_at?: string;
  stale?: boolean;
  note?: string;
}

/**
 * Every transaction of the given accounts (all of them when none are named) in a date range, with a record of what
 * was checked. An account that fails is reported in `checked` rather than failing the whole call.
 */
async function fetchAcross(refs: string[] | undefined, from: string, to: string): Promise<{ transactions: AccountTransaction[]; checked: Checked[] }> {
  const accounts = refs?.length ? refs.map(resolveAccount) : store().accounts();
  if (!accounts.length) throw new ToolError("No accounts are connected yet. Run start_consent first.");
  const transactions: AccountTransaction[] = [];
  const checked: Checked[] = [];
  for (const account of accounts) {
    const name = account.label ?? account.name ?? account.uid;
    try {
      const read = await withAccount(account.uid, `transactions|${from}|${to}|all`, async (a) => {
        const fetched = [];
        let key: string | undefined;
        let pages = 0;
        do {
          const page = await eb.getTransactionPage(a.uid, { dateFrom: from, dateTo: to, continuationKey: key });
          fetched.push(...page.transactions);
          key = page.continuation_key || undefined;
          pages += 1;
        } while (key && pages < MAX_PAGES_PER_ACCOUNT);
        return { fetched, complete: !key };
      });
      const { fetched, complete } = read.value;
      const simple = simplifyTransactions(fetched);
      transactions.push(...simple.map((t) => ({ ...t, account_uid: account.uid })));
      checked.push({ account: name, uid: account.uid, from, to, transactions: simple.length, complete, ...freshness(read) });
    } catch (err) {
      if (!(err instanceof ToolError || err instanceof BankReadError)) throw err;
      checked.push({ account: name, uid: account.uid, from, to, transactions: 0, complete: false, error: err.message });
    }
  }
  return { transactions, checked };
}

function guard<A extends unknown[]>(fn: (...args: A) => Promise<ReturnType<typeof json> | ReturnType<typeof fail>>) {
  return async (...args: A) => {
    try {
      if (!isConfigured()) {
        return fail(
          `${config.appName} is not set up yet. Tell the owner to open ${config.baseUrl} in a browser and follow the setup page: it can register the Enable Banking application for them from their email, or take an application id and key file.` +
            (config.localMode ? " The browser will warn about a self-signed certificate on localhost; continue past it." : ""),
        );
      }
      return await fn(...args);
    } catch (err) {
      if (err instanceof ToolError || err instanceof BankReadError) return fail(err.message);
      if (err instanceof EnableBankingError && err.applicationInactive) {
        return fail(
          "The Enable Banking application behind this server is not active yet, so no bank can be reached. This is a one-time step the owner does in their browser, not something to retry here. Tell them exactly this: " +
            "open https://enablebanking.com/cp/applications, choose the application, press 'Activate by linking accounts' and log in at your bank when asked. Then ask again.",
        );
      }
      if (err instanceof EnableBankingError) return fail(`Enable Banking returned ${err.status}: ${err.body.slice(0, 500)}`);
      return fail(`Error: ${(err as Error).message}`);
    }
  };
}

/** attest_account, when the owner turned attestations on. The only tool a token with just the `bank:attest` scope sees. */
function registerAttestation(server: McpServer): void {
  // --- Attestation ---

  // Registered only when the owner turned it on. A tool that is absent is a
  // clearer answer than one that always refuses, and it keeps the default
  // tool list of this server exactly what it has always been.
  if (!attestationEnabled()) return;
  const ceiling = maxAttestableBalance();
  server.registerTool(
    "attest_account",
    {
      title: "Attest an account",
      description:
        "Answer, in a signed object a third party can verify, whether an IBAN belongs to one of the connected accounts" +
        (ceiling === undefined ? "" : ` and whether it holds at least a given amount (up to ${ceiling})`) +
        ". Returns no balance, no transactions and no account list: a yes/no, the currency, and a signature. " +
        "Intended for a service the owner is proving an account to, such as a payment authorizer verifying a funding source. " +
        "The public key is at /.well-known/bankmcp-attestation.",
      inputSchema: {
        iban: z.string().min(5).describe("The IBAN to ask about"),
        nonce: z.string().min(8).max(128).describe("A value from the caller, echoed into the signed claims so the answer cannot be replayed"),
        ...(ceiling === undefined
          ? {}
          : {
              min_balance: z
                .number()
                .positive()
                .optional()
                .describe(`Ask whether the account holds at least this much. At most ${ceiling}.`),
            }),
      },
      // The one tool here whose reader is a program rather than an assistant.
      // A verifier rebuilds the signed bytes from these fields in this order,
      // so the shape is already a fixed contract — declaring it lets a client
      // check it reached the end intact instead of discovering a missing
      // field when the signature fails. Mirrors AttestationClaims in
      // attestation.ts; the two must stay in step.
      outputSchema: {
        claims: z
          .object({
            v: z.literal(ATTESTATION_VERSION).describe("Attestation format; a verifier rejects what it does not know"),
            iban: z.string().describe("The IBAN that was asked about, without spaces and upper-cased"),
            owned: z.boolean().describe("True when that IBAN belongs to an account this server has a live consent for"),
            holder_name: z.string().nullable().describe("Name on the account, or null when the owner withholds it"),
            currency: z.string().nullable().describe("Currency of the account, or null when it is not owned"),
            sufficient: z.boolean().nullable().describe("Answer to the min_balance question, or null when none was asked"),
            min_balance: z.number().nullable().describe("The threshold `sufficient` answers, echoed so the claim cannot be reused for another"),
            nonce: z.string().describe("The caller's value, echoed back to bind this answer to one request"),
            issued_at: z.number().int().describe("Seconds since the epoch when this was signed"),
            expires_at: z.number().int().describe(`Seconds since the epoch when it goes stale, ${ATTESTATION_TTL_SECONDS} seconds after issue`),
            issuer: z.string().describe("Base URL of the server that said it, and where its public key is published"),
          })
          .describe("Exactly the fields the signature covers, in the order they are signed in"),
        signature: z.string().describe("Ed25519 over the canonical JSON of `claims`, base64url"),
        key_id: z.string().describe("Which key signed it, to match against /.well-known/bankmcp-attestation"),
      },
    },
    guard(async ({ iban, nonce, min_balance }: { iban: string; nonce: string; min_balance?: number }) => {
      // Before anything is looked up or asked of the bank. The ceiling above
      // bounds what one answer reveals; this bounds how many answers a caller
      // gets, and the two only work together — a caller free to ask "at least
      // X?" as often as it likes can still binary-search the balance out of
      // the range the ceiling leaves open. Counted here rather than per IBAN
      // so that walking a list of guesses costs the same as repeating one.
      if (!takeAttestationSlot()) throw new ToolError(attestationRateLimitMessage());

      // Before the account is looked up, because the answer does not depend on it: asked
      // after, an over-ceiling threshold would error for an owned IBAN and return a signed
      // "no" for an unowned one, which tells the caller which it asked about.
      if (min_balance !== undefined && ceiling !== undefined && min_balance > ceiling) {
        throw new ToolError(`min_balance is above the limit the owner set for this server (${ceiling}).`);
      }

      const wanted = normalizeIban(iban);
      const account = store()
        .accounts()
        .find((a) => a.iban && normalizeIban(a.iban) === wanted);

      const issuedAt = Math.floor(Date.now() / 1000);
      const base = {
        v: ATTESTATION_VERSION,
        iban: wanted,
        nonce,
        issued_at: issuedAt,
        expires_at: issuedAt + ATTESTATION_TTL_SECONDS,
        issuer: config.baseUrl,
      } as const;

      // Not ours: say so, signed. A signed "no" is worth as much to the caller as a signed "yes",
      // and it reveals nothing — the caller already knew the IBAN it asked about.
      if (!account) {
        const claims: AttestationClaims = { ...base, owned: false, holder_name: null, currency: null, sufficient: null, min_balance: null };
        return attested(signAttestation(claims));
      }

      let sufficient: boolean | null = null;
      if (min_balance !== undefined) {
        // One balance read, the same call get_balances makes. Only the comparison leaves this function.
        // Live read: a signed statement must never rest on a cached balance.
        const balances = (await withAccount(account.uid, "balances", async (a) => simplifyBalances(await eb.getBalances(a.uid)), { live: true })).value;
        if (balances.booked === undefined) throw new ToolError("The bank did not report a booked balance for this account, so no threshold can be attested.");
        sufficient = balances.booked >= min_balance;
      }

      const claims: AttestationClaims = {
        ...base,
        owned: true,
        holder_name: holderNameAllowed() ? (account.name ?? null) : null,
        currency: account.currency,
        sufficient,
        min_balance: min_balance ?? null,
      };
      return attested(signAttestation(claims));
    }),
  );
}

/** Every tool, or only attest_account for a token granted for attestation alone. */
export function registerTools(server: McpServer, opts: { attestOnly?: boolean } = {}): void {
  if (opts.attestOnly) return registerAttestation(server);

  // --- Connecting banks ---

  server.registerTool(
    "list_banks",
    {
      title: "List banks",
      description: "Banks available through Enable Banking in a country, with the maximum consent length. Use the exact `name` with start_consent.",
      inputSchema: {
        country: z.string().length(2).optional().describe(`ISO country code, default ${config.country}`),
        search: z.string().optional().describe("Filter by (part of) the bank name"),
      },
    },
    guard(async ({ country, search }) => {
      const banks = await eb.listAspsps((country ?? config.country).toUpperCase());
      const q = search?.toLowerCase();
      return json(
        banks
          .filter((b) => !q || b.name.toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((b) => ({
            name: b.name,
            country: b.country,
            max_consent_days: b.maximum_consent_validity ? Math.floor(b.maximum_consent_validity / 86_400) : null,
            customer_types: b.psu_types ?? ["personal"],
            beta: b.beta ?? false,
          })),
      );
    }),
  );

  server.registerTool(
    "start_consent",
    {
      title: "Connect a bank",
      description:
        "Start linking a bank. Returns a URL the account holder must open in a browser to log in at their bank and approve read-only access. After approval the bank redirects back to this server and the accounts appear in list_accounts. Consents last up to 180 days.",
      inputSchema: {
        bank: z.string().describe("Exact bank name from list_banks"),
        country: z.string().length(2).optional().describe(`ISO country code, default ${config.country}`),
        customer_type: z.enum(["personal", "business"]).default("personal"),
      },
    },
    guard(async ({ bank, country, customer_type }) => {
      const cc = (country ?? config.country).toUpperCase();
      const banks = await eb.listAspsps(cc);
      const aspsp = banks.find((b) => b.name === bank) ?? banks.find((b) => b.name.toLowerCase() === bank.toLowerCase());
      if (!aspsp) throw new ToolError(`Bank "${bank}" not found in ${cc}. Use list_banks to find the exact name.`);
      const maxSeconds = Math.min(aspsp.maximum_consent_validity ?? MAX_CONSENT_DAYS * 86_400, MAX_CONSENT_DAYS * 86_400);
      const validUntil = new Date(Date.now() + maxSeconds * 1000 - 60_000);
      const state = randomUUID();
      store().addPendingAuth({ state, bank: { name: aspsp.name, country: aspsp.country }, started: new Date().toISOString() });
      const auth = await eb.startAuthorization({ aspsp, state, redirectUrl: `${config.baseUrl}/callback`, validUntil, psuType: customer_type });
      return json({
        url: auth.url,
        bank: aspsp.name,
        consent_valid_until: validUntil.toISOString().slice(0, 10),
        next: "Open the URL, log in at the bank and approve. Then call consent_status or list_accounts to confirm the accounts are linked.",
      });
    }),
  );

  server.registerTool(
    "consent_status",
    {
      title: "Consent status",
      description: "Which banks are connected, how many days each consent has left, and any bank logins that were started but not finished.",
    },
    guard(async () => {
      const s = store();
      const banks = [];
      for (const session of s.sessions()) {
        let live: string;
        try {
          live = (await eb.getSession(session.id)).status;
          if (live !== session.status) s.update((d) => void (d.sessions[session.id]!.status = live));
        } catch (err) {
          live = err instanceof EnableBankingError ? `UNKNOWN (${err.status})` : "UNKNOWN";
        }
        banks.push({
          session_id: session.id,
          bank: `${session.bank.name} (${session.bank.country})`,
          status: live,
          valid_until: session.valid_until.slice(0, 10),
          days_left: daysLeft(session.valid_until),
          accounts: s.accounts().filter((a) => a.session_id === session.id).length,
        });
      }
      // Expired ones are only swept when the next login starts, so filter here
      // too; listing logins that can no longer be completed just misleads.
      const pending = Object.values(s.data.pending_auth)
        .filter((p) => pendingAuthIsLive(p))
        .map((p) => ({ bank: p.bank.name, started: p.started }));
      return json({ banks, pending_logins: pending, hint: banks.length ? undefined : "No bank connected yet. Use start_consent." });
    }),
  );

  server.registerTool(
    "disconnect_bank",
    {
      title: "Disconnect a bank",
      description: "Revoke a bank consent at Enable Banking and forget its accounts, labels and watches on this server.",
      inputSchema: { session_id: z.string().describe("From consent_status") },
    },
    guard(async ({ session_id }) => {
      if (!store().data.sessions[session_id]) throw new ToolError("Unknown session_id. See consent_status.");
      try {
        await eb.deleteSession(session_id);
      } catch (err) {
        if (!(err instanceof EnableBankingError && err.consentGone)) throw err;
      }
      store().update((d) => {
        for (const w of Object.values(d.watches)) if (d.accounts[w.account]?.session_id === session_id) delete d.watches[w.id];
      });
      store().removeSession(session_id);
      return json({ ok: true });
    }),
  );

  // --- Accounts & data ---

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "All linked accounts with bank, IBAN, currency and consent expiry. With include_balances the booked balance is fetched for each account (one bank call per account). Use the `booked` balance for totals; `available` may include credit lines.",
      inputSchema: { include_balances: z.boolean().default(false) },
    },
    guard(async ({ include_balances }) => {
      const s = store();
      const out = [];
      for (const a of s.accounts()) {
        const base = describeAccount(a, s.data.sessions[a.session_id]);
        if (!include_balances) {
          out.push(base);
          continue;
        }
        try {
          const r = await bankGuard.read(a, "balances", async () => simplifyBalances(await eb.getBalances(a.uid)));
          out.push({ ...base, booked: r.value.booked, available: r.value.available, balance_date: r.value.reference_date, ...freshness(r) });
        } catch (err) {
          out.push({ ...base, balance_error: err instanceof BankReadError ? err.message : err instanceof EnableBankingError ? err.summary : String(err) });
        }
      }
      if (!out.length) return json({ accounts: [], hint: "No accounts linked yet. Use start_consent to connect a bank." });
      return json({ accounts: out, as_of: isoDate() });
    }),
  );

  server.registerTool(
    "set_account_label",
    {
      title: "Label an account",
      description: "Give an account a name you will recognise, e.g. 'Joint expenses' or 'Mortgage'. Labels can be used instead of uids in every other tool.",
      inputSchema: { account: z.string().describe("Account uid, or current label/name"), label: z.string().min(1).max(60) },
    },
    guard(async ({ account, label }) => {
      const a = resolveAccount(account);
      store().update((d) => void (d.accounts[a.uid]!.label = label.trim()));
      return json({ ok: true, uid: a.uid, label: label.trim() });
    }),
  );

  server.registerTool(
    "get_balances",
    {
      title: "Get balances",
      description: "Current balances of one account. `booked` is the cleared balance (use this for net worth); `available` is what the bank says can be spent, which for credit and mortgage accounts includes the credit line.",
      inputSchema: { account: z.string().describe("Account uid or label") },
    },
    guard(async ({ account }) => {
      const r = await withAccount(account, "balances", async (a) => simplifyBalances(await eb.getBalances(a.uid)));
      return json({ account: r.account.label ?? r.account.name ?? r.account.uid, uid: r.account.uid, ...r.value, ...freshness(r) });
    }),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get transactions",
      description:
        "Transactions of one account, newest first. Amounts are signed (negative = money out). Defaults to the last 30 days. Banks return limited history (often 90 days, some up to 2 years). If the result has `continuation`, pass it back to fetch more. A busy account can return hundreds of transactions: to find a merchant or reference use search_transactions, and for totals over months use monthly_summary, rather than reading long lists.",
      inputSchema: {
        account: z.string().describe("Account uid or label"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default 30 days ago"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
        continuation: z.string().optional().describe("Continuation key from a previous call"),
        max_pages: z.number().int().min(1).max(50).default(10).describe("Pages to fetch in one call"),
        include_raw: z.boolean().default(false).describe("Include the bank's raw transaction objects"),
      },
    },
    guard(async ({ account, from, to, continuation, max_pages, include_raw }) => {
      const dateFrom = from ?? daysAgo(30);
      const dateTo = to ?? isoDate();
      const r = await withAccount(account, `transactions|${dateFrom}|${dateTo}|${continuation ?? ""}|${max_pages}`, async (a) => {
        const fetched = [];
        let key = continuation;
        let pages = 0;
        do {
          const pageData = await eb.getTransactionPage(a.uid, { dateFrom, dateTo, continuationKey: key });
          fetched.push(...pageData.transactions);
          key = pageData.continuation_key || undefined;
          pages += 1;
        } while (key && pages < max_pages);
        return { fetched, key };
      });
      const { fetched, key } = r.value;
      const all = simplifyTransactions(fetched);
      all.sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0));
      const inflow = all.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
      const outflow = all.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0);
      return json({
        account: r.account.label ?? r.account.name ?? r.account.uid,
        uid: r.account.uid,
        from: dateFrom,
        to: dateTo,
        count: all.length,
        total_in: Math.round(inflow * 100) / 100,
        total_out: Math.round(outflow * 100) / 100,
        continuation: key,
        ...freshness(r),
        transactions: all,
        ...(include_raw ? { raw: fetched } : {}),
      });
    }),
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Transactions across accounts whose counterparty or description contains a merchant name, invoice number or other reference, newest first. " +
        "Matches whole words, case-insensitive: `1044` finds `Invoice 1044` but not `1044B`. Searches every connected account unless `accounts` is given. " +
        "Defaults to the last 90 days. `checked` lists each account and date range searched; one with `complete: false` was not fully read.",
      inputSchema: {
        query: z.string().min(1).describe("Merchant name, invoice number or other text to look for"),
        accounts: z.array(z.string()).optional().describe("Account uids or labels; default all"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default 90 days ago"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
      },
    },
    guard(async ({ query, accounts, from, to }) => {
      const { transactions, checked } = await fetchAcross(accounts, from ?? daysAgo(90), to ?? isoDate());
      const names = new Map(checked.map((c) => [c.uid, c.account]));
      const matches = transactions
        .filter((t) => matchesQuery(t, query))
        .sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0))
        .map(({ account_uid, ...t }) => ({ account: names.get(account_uid), ...t }));
      const totals: Record<string, number> = {};
      for (const t of matches) totals[t.currency] = round2((totals[t.currency] ?? 0) + t.amount);
      return json({ query, count: matches.length, totals, checked, transactions: matches });
    }),
  );

  server.registerTool(
    "monthly_summary",
    {
      title: "Monthly summary",
      description:
        "Money in and money out per calendar month across accounts, in each currency, without returning the transactions. " +
        "Transfers between the owner's own accounts are left out of both sides, card repayments to a connected card account included: " +
        "a transaction counts as a transfer when its counterparty account is a connected account, or when another connected account has the opposite amount within two days. " +
        "Card purchases and refunds stay in. Defaults to the last 90 days; whole months give clean totals. `checked` lists each account and date range read.",
      inputSchema: {
        accounts: z.array(z.string()).optional().describe("Account uids or labels; default all"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default 90 days ago"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
      },
    },
    guard(async ({ accounts, from, to }) => {
      const { transactions, checked } = await fetchAcross(accounts, from ?? daysAgo(90), to ?? isoDate());
      const ownIds = store()
        .accounts()
        .flatMap((a) => [a.iban, a.other_id].filter((v): v is string => Boolean(v)));
      const transfers = findOwnTransfers(transactions, ownIds);
      const transferTotals: Record<string, number> = {};
      for (const t of transfers) if (t.amount < 0) transferTotals[t.currency] = round2((transferTotals[t.currency] ?? 0) - t.amount);
      return json({
        months: totalsByMonth(transactions, transfers),
        transfers_excluded: { transactions: transfers.size, amount_moved: transferTotals },
        checked,
      });
    }),
  );

  registerAttestation(server);

  // --- Watches ---

  const ruleDescription = [
    "balance_below / balance_above: `amount` threshold on the booked balance.",
    "large_debit: any single outgoing payment of at least `amount`.",
    "credit_matching / debit_matching: an incoming / outgoing transaction whose counterparty or description contains `match` (optionally at least `min_amount`).",
    "credit_missing_by: notify on `by_date` if no incoming transaction matching `match` has arrived since the watch was created; also notifies when it does arrive.",
  ].join(" ");

  server.registerTool(
    "create_watch",
    {
      title: "Create a watch",
      description: `Watch an account in the background and send a notification to the webhook the server's operator configured (NOTIFY_WEBHOOK_URL; Slack or any URL) when a rule fires. The destination cannot be chosen here. Accounts are checked at most ${Math.floor(24 / config.pollIntervalHours)} times a day, the limit PSD2 sets for unattended access. Rules: ${ruleDescription}`,
      inputSchema: {
        account: z.string().describe("Account uid or label"),
        type: z.enum(["balance_below", "balance_above", "large_debit", "credit_matching", "debit_matching", "credit_missing_by"]),
        amount: z.number().optional().describe("Threshold for balance_* and large_debit"),
        match: z.string().optional().describe("Text to look for in counterparty/description"),
        min_amount: z.number().optional().describe("Minimum amount for *_matching and credit_missing_by"),
        by_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Deadline for credit_missing_by"),
        note: z.string().optional().describe("Shown in the notification, e.g. 'Invoice 2024-17 from Acme'"),
      },
    },
    guard(async ({ account, type, amount, match, min_amount, by_date, note }) => {
      const a = resolveAccount(account);
      let rule: WatchRule;
      switch (type) {
        case "balance_below":
        case "balance_above":
        case "large_debit":
          if (amount === undefined) throw new ToolError(`${type} needs \`amount\`.`);
          rule = { type, amount };
          break;
        case "credit_matching":
        case "debit_matching":
          if (!match) throw new ToolError(`${type} needs \`match\`.`);
          rule = { type, match, min_amount };
          break;
        case "credit_missing_by":
          if (!match || !by_date) throw new ToolError("credit_missing_by needs `match` and `by_date`.");
          rule = { type, match, by_date, min_amount };
          break;
      }
      if (!config.notifyWebhookUrl) {
        return fail("No webhook configured. The server's operator sets NOTIFY_WEBHOOK_URL on the host (a Slack incoming webhook works); it cannot be set from here. You can still run check_watches manually.");
      }
      const watch = { id: randomUUID().slice(0, 8), account: a.uid, rule, note, created: new Date().toISOString(), active: true, seen: [] };
      store().putWatch(watch);
      return json({ ok: true, watch: { ...watch, account: a.label ?? a.name ?? a.uid } });
    }),
  );

  server.registerTool("list_watches", { title: "List watches", description: "All watches with their rule, status and when they last fired." }, guard(async () => {
    const s = store();
    return json(
      s.watches().map((w) => ({
        ...w,
        seen: undefined,
        account: s.account(w.account)?.label ?? s.account(w.account)?.name ?? w.account,
        account_uid: w.account,
      })),
    );
  }));

  server.registerTool(
    "delete_watch",
    { title: "Delete a watch", description: "Remove a watch by id.", inputSchema: { id: z.string() } },
    guard(async ({ id }) => json({ ok: store().deleteWatch(id) })),
  );

  server.registerTool(
    "check_watches",
    {
      title: "Check watches now",
      description: "Evaluate every active watch right now (counts as an attended check, so it does not wait for the polling slot) and return what fired.",
    },
    guard(async () => json(await runWatches({ force: true }))),
  );
}
