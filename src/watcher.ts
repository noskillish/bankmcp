// Background checks for watches. Each account is polled at most every
// POLL_INTERVAL_HOURS (default 6, i.e. four times a day: the PSD2 limit for
// access without the account holder present). Nothing is stored except which
// transaction ids already triggered a notification.
import { config } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { store, type StoredAccount, type Watch } from "./store.ts";
import { daysLeft, isoDate, simplifyBalances, simplifyTransaction, type SimpleTransaction } from "./data.ts";

export interface WatchEvent {
  watch_id: string;
  account: string;
  type: string;
  text: string;
  details?: unknown;
}

export interface WatchRun {
  checked_accounts: number;
  skipped_accounts: number;
  events: WatchEvent[];
  errors: string[];
}

const log = (msg: string, extra?: unknown) => console.error(`[watcher ${new Date().toISOString()}] ${msg}`, extra ?? "");

const fmt = (n: number, ccy: string) => `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${ccy}`;
const matches = (t: SimpleTransaction, needle: string) => `${t.counterparty ?? ""} ${t.description ?? ""}`.toLowerCase().includes(needle.toLowerCase());

export async function runWatches(opts: { force?: boolean } = {}): Promise<WatchRun> {
  const s = store();
  const run: WatchRun = { checked_accounts: 0, skipped_accounts: 0, events: [], errors: [] };

  // Consent expiry warnings need no bank call.
  for (const session of s.sessions()) {
    const left = daysLeft(session.valid_until);
    if (left <= 7 && !session.expiry_notified) {
      const text = `Bank consent for ${session.bank.name} expires in ${left} day${left === 1 ? "" : "s"}. Ask your assistant to connect the bank again to renew it.`;
      run.events.push({ watch_id: "consent", account: session.bank.name, type: "consent_expiring", text });
      s.update((d) => void (d.sessions[session.id]!.expiry_notified = true));
    }
  }

  const active = s.watches().filter((w) => w.active);
  const byAccount = new Map<string, Watch[]>();
  for (const w of active) byAccount.set(w.account, [...(byAccount.get(w.account) ?? []), w]);

  const dueBefore = Date.now() - config.pollIntervalHours * 3_600_000;
  for (const [uid, watches] of byAccount) {
    const account = s.account(uid);
    if (!account) continue;
    if (!opts.force && account.last_polled && Date.parse(account.last_polled) > dueBefore) {
      run.skipped_accounts += 1;
      continue;
    }
    try {
      run.events.push(...(await checkAccount(account, watches)));
      run.checked_accounts += 1;
    } catch (err) {
      const msg = err instanceof EnableBankingError && err.consentGone ? `consent for ${account.label ?? account.name} is no longer valid` : (err as Error).message;
      run.errors.push(`${account.label ?? account.name ?? uid}: ${msg}`);
      log(`check failed for ${uid}`, msg);
    }
    s.update((d) => void (d.accounts[uid]!.last_polled = new Date().toISOString()));
  }

  // Notifications go to the one destination the operator configured on the host. A watch cannot
  // name its own (a client could otherwise send transaction data anywhere, including inside the network).
  for (const e of run.events) {
    const url = config.notifyWebhookUrl;
    if (url) await notify(url, e).catch((err) => run.errors.push(`notify: ${(err as Error).message}`));
  }
  return run;
}

/** Pure rule evaluation, shared by the poller and the tests. Mutates the watches (seen, last_triggered, active). */
export function evaluate(account: StoredAccount, watches: Watch[], booked: number | undefined, txs: SimpleTransaction[], today = isoDate()): WatchEvent[] {
  const name = account.label ?? account.name ?? account.uid;
  const ccy = account.currency;
  const events: WatchEvent[] = [];
  const now = new Date().toISOString();

  for (const w of watches) {
    const r = w.rule;
    const recentlyFired = !!w.last_triggered && Date.now() - Date.parse(w.last_triggered) < 24 * 3_600_000;
    const fire = (text: string, details?: unknown, ids: string[] = []) => {
      events.push({ watch_id: w.id, account: name, type: r.type, text: w.note ? `${text} (${w.note})` : text, details });
      w.last_triggered = now;
      w.seen = [...w.seen, ...ids].slice(-200);
    };

    switch (r.type) {
      case "balance_below":
        if (booked !== undefined && booked < r.amount && !recentlyFired) fire(`${name}: balance ${fmt(booked, ccy)} is below ${fmt(r.amount, ccy)}.`, { booked });
        break;
      case "balance_above":
        if (booked !== undefined && booked > r.amount && !recentlyFired) fire(`${name}: balance ${fmt(booked, ccy)} is above ${fmt(r.amount, ccy)}.`, { booked });
        break;
      case "large_debit": {
        for (const t of txs.filter((t) => t.amount <= -r.amount && !w.seen.includes(t.id)))
          fire(`${name}: ${fmt(-t.amount, ccy)} to ${t.counterparty ?? t.description ?? "unknown"} on ${t.date}.`, t, [t.id]);
        break;
      }
      case "credit_matching":
      case "debit_matching": {
        const sign = r.type === "credit_matching" ? 1 : -1;
        const hits = txs.filter((t) => Math.sign(t.amount) === sign && Math.abs(t.amount) >= (r.min_amount ?? 0) && matches(t, r.match) && !w.seen.includes(t.id));
        for (const t of hits)
          fire(`${name}: ${sign > 0 ? "received" : "paid"} ${fmt(Math.abs(t.amount), ccy)} ${sign > 0 ? "from" : "to"} ${t.counterparty ?? t.description ?? r.match} on ${t.date}.`, t, [t.id]);
        break;
      }
      case "credit_missing_by": {
        const since = w.created.slice(0, 10);
        const arrived = txs.find((t) => t.amount >= (r.min_amount ?? 0.01) && matches(t, r.match) && t.date >= since);
        if (arrived) {
          fire(`${name}: the payment you were waiting for arrived: ${fmt(arrived.amount, ccy)} from ${arrived.counterparty ?? r.match} on ${arrived.date}.`, arrived, [arrived.id]);
          w.active = false;
        } else if (today >= r.by_date) {
          fire(`${name}: no payment matching "${r.match}" has arrived by ${r.by_date}.`);
          w.active = false;
        }
        break;
      }
    }
    w.last_checked = now;
  }
  return events;
}

async function checkAccount(account: StoredAccount, watches: Watch[]): Promise<WatchEvent[]> {
  const needsBalance = watches.some((w) => w.rule.type.startsWith("balance_"));
  const needsTx = watches.some((w) => !w.rule.type.startsWith("balance_"));

  let booked: number | undefined;
  if (needsBalance) booked = simplifyBalances(await eb.getBalances(account.uid)).booked;

  const txs: SimpleTransaction[] = [];
  if (needsTx) {
    // Look back far enough to cover the oldest open "missing credit" watch, but at most 90 days.
    const oldest = Math.min(...watches.filter((w) => w.rule.type === "credit_missing_by").map((w) => Date.parse(w.created)), Date.now() - 3 * 86_400_000);
    const from = new Date(Math.max(oldest, Date.now() - 90 * 86_400_000)).toISOString().slice(0, 10);
    let key: string | undefined;
    do {
      const pageData = await eb.getTransactionPage(account.uid, { dateFrom: from, dateTo: isoDate(), continuationKey: key });
      txs.push(...pageData.transactions.map(simplifyTransaction));
      key = pageData.continuation_key || undefined;
    } while (key && txs.length < 2000);
  }

  const events = evaluate(account, watches, booked, txs);
  const s = store();
  for (const w of watches) s.putWatch(w);
  return events;
}

async function notify(url: string, event: WatchEvent): Promise<void> {
  if (!/^https:\/\//.test(url)) throw new Error("NOTIFY_WEBHOOK_URL must be an https URL");
  const slack = /hooks\.slack\.com/.test(url);
  const body = slack ? { text: event.text } : { source: "bank-mcp", ...event };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

/** Starts the background loop. Returns a stop function. */
export function startWatcher(everyMinutes = 5): () => void {
  const tick = () =>
    runWatches()
      .then((r) => {
        if (r.events.length || r.errors.length) log(`checked ${r.checked_accounts}, events ${r.events.length}, errors ${r.errors.length}`, r.errors);
      })
      .catch((err) => log("run failed", err));
  const timer = setInterval(tick, everyMinutes * 60_000);
  setTimeout(tick, 15_000).unref();
  return () => clearInterval(timer);
}
