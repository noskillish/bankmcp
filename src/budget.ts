import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config, isConfigured } from "./config.ts";
import { verifyPassword } from "./auth.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import {
  daysLeft,
  findOwnTransfers,
  round2,
  simplifyBalances,
  simplifyTransactions,
  type AccountTransaction,
  type SimpleTransaction,
} from "./data.ts";
import { store, type StoredAccount } from "./store.ts";
import { defaultBudgetState, type BudgetBlock, type BudgetCategory, type BudgetManualMovement, type BudgetRule } from "./budget-types.ts";

const DAY = 86_400_000;
const MAX_PAGES_PER_ACCOUNT = 50;
const HISTORY_CYCLES = 6;

export interface BudgetCycle {
  offset: number;
  start: string;
  end: string;
  label: string;
}

export interface BudgetMovementView {
  id: string;
  date: string;
  amount: number;
  currency: string;
  bank: string;
  account: string;
  counterparty: string | null;
  description: string | null;
  status: "pending" | "confirmed";
  source: "bank" | "manual";
  block: BudgetBlock;
  category: BudgetCategory;
  planned: boolean;
  is_transfer: boolean;
}

interface BankMovement extends AccountTransaction {
  bank: string;
  account_label: string;
  status: "pending" | "confirmed";
  source: "bank";
  dedupe_key: string;
}

interface Classified {
  block: BudgetBlock;
  category: BudgetCategory;
  planned: boolean;
}

export interface BudgetSummary {
  demo: boolean;
  source: "demo" | "enable_banking";
  synced_at: string;
  currency: string;
  cycle: BudgetCycle;
  income: { planned: number; actual: number };
  blocks: Array<{ id: Exclude<BudgetBlock, "unclassified">; label: string; planned: number; actual: number; remaining: number }>;
  leisure_week: { current: number; total: number; spent: number; remaining: number; week: number };
  totals: { spending: number; pending: number; savings: number; unclassified: number; unplanned: number };
  history: Array<{ label: string; start: string; end: string; income: number; spending: number; savings: number }>;
  categories: Array<{ category: BudgetCategory; label: string; amount: number; count: number }>;
  movements: BudgetMovementView[];
  accounts: Array<{ id: string; bank: string; label: string; currency: string; balance: number | null; available: number | null; consent_valid_until: string | null; consent_days_left: number | null }>;
  connections: Array<{ bank: string; country: string; status: string; accounts: number; valid_until: string; days_left: number }>;
  checked: Array<{ account: string; bank: string; transactions: number; complete: boolean; error?: string }>;
  sync_errors: string[];
  duplicates_removed: number;
  settings: { payroll_day: number; monthly_income: number; budgets: { needs: number; leisure: number; savings: number }; rules: BudgetRule[] };
}

const categoryLabels: Record<BudgetCategory, string> = {
  income: "Ingresos",
  housing: "Vivienda",
  utilities: "Suministros",
  groceries: "Compra",
  transport: "Transporte",
  health: "Salud",
  subscriptions: "Suscripciones",
  food_out: "Comer fuera",
  shopping: "Compras",
  travel: "Viajes",
  savings_transfer: "Ahorro",
  other: "Otros",
  unclassified: "Sin clasificar",
};

const blockLabels: Record<Exclude<BudgetBlock, "unclassified">, string> = {
  needs: "Necesidades",
  leisure: "Ocio",
  savings: "Ahorro",
};

const validBlocks = new Set<BudgetBlock>(["needs", "leisure", "savings", "unclassified"]);
const validCategories = new Set<BudgetCategory>(Object.keys(categoryLabels) as BudgetCategory[]);

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const utcDate = (year: number, month: number, day: number): Date => new Date(Date.UTC(year, month, day, 12));
const monthDays = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const clampPayday = (year: number, month: number, day: number): number => Math.min(Math.max(Math.round(day), 28), monthDays(year, month));
const moveMonth = (date: Date, delta: number): Date => utcDate(date.getUTCFullYear(), date.getUTCMonth() + delta, 1);
const paydayDate = (month: Date, payday: number): Date => utcDate(month.getUTCFullYear(), month.getUTCMonth(), clampPayday(month.getUTCFullYear(), month.getUTCMonth(), payday));
const dateDiff = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const safeMoney = (n: number): number => Number.isFinite(n) ? round2(n) : 0;

export function cycleFor(date = new Date(), payrollDay = 28, offset = 0): BudgetCycle {
  const normalized = utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const thisMonth = moveMonth(normalized, 0);
  const currentPayday = paydayDate(thisMonth, payrollDay);
  const startMonth = normalized >= currentPayday ? thisMonth : moveMonth(thisMonth, -1);
  const startMonthWithOffset = moveMonth(startMonth, -offset);
  const endMonth = moveMonth(startMonthWithOffset, 1);
  const start = paydayDate(startMonthWithOffset, payrollDay);
  const next = paydayDate(endMonth, payrollDay);
  const end = new Date(next.getTime() - DAY);
  const fmt = (value: Date): string => value.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  return { offset, start: iso(start), end: iso(end), label: `${fmt(start)} – ${fmt(end)}` };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeKey(t: SimpleTransaction): string {
  return [t.date, safeMoney(t.amount).toFixed(2), t.currency.toUpperCase(), normalize(t.counterparty), normalize(t.description)].join("|");
}

function statusOf(status: string): "pending" | "confirmed" {
  return /pending|pdng|provisional|scheduled/i.test(status) ? "pending" : "confirmed";
}

function classifyText(text: string, rules: BudgetRule[]): Classified {
  const normalized = normalize(text);
  for (const rule of rules) {
    const terms = rule.contains.split(",").map(normalize).filter(Boolean);
    if (terms.some((term) => normalized.includes(term))) return { block: rule.block, category: rule.category, planned: rule.planned };
  }
  return { block: "unclassified", category: "unclassified", planned: false };
}

function classify(t: { amount: number; counterparty?: string; description?: string; id: string; dedupe_key?: string }, state: ReturnType<typeof store>["data"]["budget"]): Classified {
  const budget = state ?? defaultBudgetState();
  if (t.amount > 0) return { block: "unclassified", category: "income", planned: true };
  const override = budget.overrides[t.id] ?? (t.dedupe_key ? budget.overrides[t.dedupe_key] : undefined);
  const base = classifyText(`${t.counterparty ?? ""} ${t.description ?? ""}`, budget.rules);
  return {
    block: override?.block ?? base.block,
    category: override?.category ?? base.category,
    planned: override?.planned ?? base.planned,
  };
}

function toView(m: BankMovement | BudgetManualMovement, classified: Classified, transfer = false): BudgetMovementView {
  return {
    id: m.id,
    date: m.date,
    amount: safeMoney(m.amount),
    currency: m.currency,
    bank: m.bank || "Manual",
    account: "account_label" in m ? m.account_label : "Registro manual",
    counterparty: "counterparty" in m ? m.counterparty ?? null : null,
    description: m.description ?? null,
    status: m.status,
    source: "source" in m ? m.source : "manual",
    block: classified.block,
    category: classified.category,
    planned: classified.planned,
    is_transfer: transfer,
  };
}

async function loadBankData(from: string, to: string): Promise<{ movements: BankMovement[]; checked: BudgetSummary["checked"]; errors: string[]; duplicatesRemoved: number }> {
  const accounts = store().accounts();
  const movements: BankMovement[] = [];
  const checked: BudgetSummary["checked"] = [];
  const errors: string[] = [];
  for (const account of accounts) {
    const session = store().data.sessions[account.session_id];
    const bank = session?.bank.name ?? "Banco conectado";
    const label = account.label ?? account.name ?? account.product ?? "Cuenta";
    try {
      const fetched: Awaited<ReturnType<typeof eb.getTransactionPage>>["transactions"] = [];
      let continuation: string | undefined;
      let pages = 0;
      do {
        const page = await eb.getTransactionPage(account.uid, { dateFrom: from, dateTo: to, continuationKey: continuation });
        fetched.push(...page.transactions);
        continuation = page.continuation_key || undefined;
        pages += 1;
      } while (continuation && pages < MAX_PAGES_PER_ACCOUNT);
      const simplified = simplifyTransactions(fetched);
      for (const t of simplified) {
        movements.push({
          ...t,
          account_uid: account.uid,
          bank,
          account_label: label,
          status: statusOf(fetched[simplified.indexOf(t)]?.status ?? "BOOK"),
          source: "bank",
          dedupe_key: dedupeKey(t),
        });
      }
      checked.push({ account: label, bank, transactions: simplified.length, complete: !continuation });
    } catch (error) {
      if (error instanceof EnableBankingError && error.consentGone && session) {
        store().update((data) => void (data.sessions[session.id]!.status = "EXPIRED"));
      }
      const message = error instanceof EnableBankingError ? `${error.status}: ${error.body.slice(0, 180)}` : (error as Error).message;
      checked.push({ account: label, bank, transactions: 0, complete: false, error: message });
      errors.push(`${bank} · ${label}: ${message}`);
    }
  }

  const seenByKey = new Map<string, BankMovement>();
  const kept: BankMovement[] = [];
  let duplicatesRemoved = 0;
  for (const movement of movements) {
    const previous = seenByKey.get(movement.dedupe_key);
    if (previous && previous.bank !== movement.bank) {
      duplicatesRemoved += 1;
      continue;
    }
    if (!previous) seenByKey.set(movement.dedupe_key, movement);
    kept.push(movement);
  }
  return { movements: kept, checked, errors, duplicatesRemoved };
}

function demoMovements(cycle: BudgetCycle): Array<BankMovement | BudgetManualMovement> {
  const date = (days: number) => iso(new Date(Date.parse(`${cycle.start}T12:00:00Z`) + days * DAY));
  return [
    { id: "demo-income", date: date(0), amount: 2_800, currency: "EUR", bank: "Revolut · demo", account_label: "Cuenta diaria", counterparty: "Nómina", description: "Nómina mensual", status: "confirmed", source: "bank", account_uid: "demo-revolut", dedupe_key: "demo-income" },
    { id: "demo-rent", date: date(1), amount: -950, currency: "EUR", bank: "CaixaBank · demo", account_label: "Cuenta principal", counterparty: "Alquiler vivienda", description: "Alquiler", status: "confirmed", source: "bank", account_uid: "demo-caixa", dedupe_key: "demo-rent" },
    { id: "demo-grocery", date: date(3), amount: -128.45, currency: "EUR", bank: "Revolut · demo", account_label: "Cuenta diaria", counterparty: "Mercadona", description: "Compra semanal", status: "confirmed", source: "bank", account_uid: "demo-revolut", dedupe_key: "demo-grocery" },
    { id: "demo-leisure", date: date(5), amount: -42, currency: "EUR", bank: "Revolut · demo", account_label: "Cuenta diaria", counterparty: "Restaurante La Plaza", description: "Cena", status: "confirmed", source: "bank", account_uid: "demo-revolut", dedupe_key: "demo-leisure" },
    { id: "demo-subscription", date: date(6), amount: -17.99, currency: "EUR", bank: "CaixaBank · demo", account_label: "Cuenta principal", counterparty: "Netflix", description: "Suscripción", status: "confirmed", source: "bank", account_uid: "demo-caixa", dedupe_key: "demo-subscription" },
    { id: "demo-unknown", date: date(8), amount: -75, currency: "EUR", bank: "Revolut · demo", account_label: "Cuenta diaria", counterparty: "PAYMENT 4821", description: "", status: "pending", source: "bank", account_uid: "demo-revolut", dedupe_key: "demo-unknown" },
    { id: "demo-savings", date: date(9), amount: -250, currency: "EUR", bank: "CaixaBank · demo", account_label: "Cuenta principal", counterparty: "Transferencia ahorro", description: "Ahorro", status: "confirmed", source: "bank", account_uid: "demo-caixa", dedupe_key: "demo-savings" },
  ];
}

function demoSummary(): BudgetSummary {
  const state = defaultBudgetState();
  const cycle = cycleFor(new Date(), state.payroll_day);
  const raw = demoMovements(cycle);
  const views = raw.map((movement) => toView(movement, classify(movement, state)));
  return buildSummary({ demo: true, cycle, state, movements: views, accounts: [
    { id: "demo-revolut", bank: "Revolut · demo", label: "Cuenta diaria", currency: "EUR", balance: 1_486.22, available: 1_486.22, consent_valid_until: null, consent_days_left: null },
    { id: "demo-caixa", bank: "CaixaBank · demo", label: "Cuenta principal", currency: "EUR", balance: 2_107.8, available: 2_107.8, consent_valid_until: null, consent_days_left: null },
  ], connections: [
    { bank: "Revolut · demo", country: "ES", status: "DEMO", accounts: 1, valid_until: "", days_left: 0 },
    { bank: "CaixaBank · demo", country: "ES", status: "DEMO", accounts: 1, valid_until: "", days_left: 0 },
  ], checked: [], errors: [], duplicatesRemoved: 0 });
}

function buildSummary(input: { demo: boolean; cycle: BudgetCycle; state: NonNullable<ReturnType<typeof store>["data"]["budget"]>; movements: BudgetMovementView[]; accounts: BudgetSummary["accounts"]; connections: BudgetSummary["connections"]; checked: BudgetSummary["checked"]; errors: string[]; duplicatesRemoved: number }): BudgetSummary {
  const confirmed = input.movements.filter((m) => m.status === "confirmed" && !m.is_transfer);
  const inCycle = (m: BudgetMovementView, cycle: BudgetCycle) => m.date >= cycle.start && m.date <= cycle.end;
  const current = confirmed.filter((m) => inCycle(m, input.cycle));
  const incomeActual = safeMoney(current.filter((m) => m.amount > 0).reduce((sum, m) => sum + m.amount, 0));
  const expenses = current.filter((m) => m.amount < 0);
  const spending = safeMoney(expenses.reduce((sum, m) => sum + Math.abs(m.amount), 0));
  const byBlock = (block: BudgetBlock) => safeMoney(expenses.filter((m) => m.block === block).reduce((sum, m) => sum + Math.abs(m.amount), 0));
  const blockRows = (["needs", "leisure", "savings"] as const).map((id) => {
    const planned = input.state.budgets[id];
    const actual = byBlock(id);
    return { id, label: blockLabels[id], planned, actual, remaining: safeMoney(planned - actual) };
  });
  const unclassified = safeMoney(expenses.filter((m) => m.block === "unclassified").reduce((sum, m) => sum + Math.abs(m.amount), 0));
  const unplanned = safeMoney(expenses.filter((m) => !m.planned).reduce((sum, m) => sum + Math.abs(m.amount), 0));
  const pending = safeMoney(input.movements.filter((m) => inCycle(m, input.cycle) && m.status === "pending" && m.amount < 0).reduce((sum, m) => sum + Math.abs(m.amount), 0));
  const history = Array.from({ length: HISTORY_CYCLES }, (_, offset) => {
    const cycle = cycleFor(new Date(), input.state.payroll_day, offset);
    const rows = confirmed.filter((m) => inCycle(m, cycle));
    const income = safeMoney(rows.filter((m) => m.amount > 0).reduce((sum, m) => sum + m.amount, 0));
    const out = safeMoney(rows.filter((m) => m.amount < 0).reduce((sum, m) => sum + Math.abs(m.amount), 0));
    return { label: cycle.label, start: cycle.start, end: cycle.end, income, spending: out, savings: safeMoney(income - out) };
  });
  const categories = new Map<BudgetCategory, { amount: number; count: number }>();
  for (const movement of expenses) {
    const row = categories.get(movement.category) ?? { amount: 0, count: 0 };
    row.amount += Math.abs(movement.amount);
    row.count += 1;
    categories.set(movement.category, row);
  }
  const first = input.cycle.start;
  const days = Math.max(0, Math.min(27, dateDiff(first, new Date().toISOString().slice(0, 10))));
  const week = Math.min(4, Math.floor(days / 7) + 1);
  const totalLeisure = input.state.budgets.leisure;
  const weekly = safeMoney(totalLeisure / 4);
  const leisureSpent = byBlock("leisure");
  const currentWeekStart = iso(new Date(Date.parse(`${input.cycle.start}T12:00:00Z`) + (week - 1) * 7 * DAY));
  const currentWeekEnd = iso(new Date(Math.min(Date.parse(`${input.cycle.end}T12:00:00Z`), Date.parse(`${currentWeekStart}T12:00:00Z`) + 6 * DAY)));
  const weekSpent = safeMoney(expenses.filter((m) => m.block === "leisure" && m.date >= currentWeekStart && m.date <= currentWeekEnd).reduce((sum, m) => sum + Math.abs(m.amount), 0));
  const currentSavings = safeMoney(incomeActual - spending);
  return {
    demo: input.demo,
    source: input.demo ? "demo" : "enable_banking",
    synced_at: new Date().toISOString(),
    currency: input.movements.find((m) => m.currency)?.currency ?? input.accounts[0]?.currency ?? "EUR",
    cycle: input.cycle,
    income: { planned: input.state.monthly_income, actual: incomeActual },
    blocks: blockRows,
    leisure_week: { current: weekly, total: totalLeisure, spent: weekSpent, remaining: safeMoney(weekly - weekSpent), week },
    totals: { spending, pending, savings: currentSavings, unclassified, unplanned },
    history,
    categories: [...categories.entries()].map(([category, row]) => ({ category, label: categoryLabels[category], amount: safeMoney(row.amount), count: row.count })).sort((a, b) => b.amount - a.amount),
    movements: input.movements.filter((m) => inCycle(m, input.cycle)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 120),
    accounts: input.accounts,
    connections: input.connections,
    checked: input.checked,
    sync_errors: input.errors,
    duplicates_removed: input.duplicatesRemoved,
    settings: { payroll_day: input.state.payroll_day, monthly_income: input.state.monthly_income, budgets: input.state.budgets, rules: input.state.rules },
  };
}

export async function getBudgetSummary(): Promise<BudgetSummary> {
  if (!isConfigured()) return demoSummary();
  const s = store();
  const state = s.budget() ?? defaultBudgetState();
  const currentCycle = cycleFor(new Date(), state.payroll_day);
  const oldest = cycleFor(new Date(), state.payroll_day, HISTORY_CYCLES - 1);
  const loaded = await loadBankData(oldest.start, currentCycle.end);
  const ownIds = s.accounts().flatMap((account) => [account.iban, account.other_id].filter((value): value is string => Boolean(value)));
  const transfers = findOwnTransfers(loaded.movements, ownIds);
  const manual = state.manual_movements.map((movement) => ({ ...movement, source: "manual" as const }));
  const views = [...loaded.movements.map((movement) => toView(movement, classify(movement, state), transfers.has(movement))), ...manual.map((movement) => toView(movement, { block: movement.block, category: movement.category, planned: movement.planned }))];
  const accounts: BudgetSummary["accounts"] = [];
  for (const account of s.accounts()) {
    const session = s.data.sessions[account.session_id];
    let balance: number | null = null;
    let available: number | null = null;
    try {
      const balances = simplifyBalances(await eb.getBalances(account.uid));
      balance = balances.booked ?? null;
      available = balances.available ?? null;
    } catch (error) {
      loaded.errors.push(`${session?.bank.name ?? "Banco"} · ${account.label ?? account.name ?? "Cuenta"}: ${(error as Error).message}`);
    }
    accounts.push({ id: account.uid, bank: session?.bank.name ?? "Banco conectado", label: account.label ?? account.name ?? account.product ?? "Cuenta", currency: account.currency, balance, available, consent_valid_until: session?.valid_until ?? null, consent_days_left: session ? daysLeft(session.valid_until) : null });
  }
  const connections = s.sessions().map((session) => ({ bank: session.bank.name, country: session.bank.country, status: session.status ?? "UNKNOWN", accounts: s.accounts().filter((account) => account.session_id === session.id).length, valid_until: session.valid_until.slice(0, 10), days_left: daysLeft(session.valid_until) }));
  return buildSummary({ demo: false, cycle: currentCycle, state, movements: views, accounts, connections, checked: loaded.checked, errors: loaded.errors, duplicatesRemoved: loaded.duplicatesRemoved });
}

export function updateBudgetSettings(input: { payroll_day?: number; monthly_income?: number; needs?: number; leisure?: number; savings?: number }): void {
  const state = store().budget();
  const payroll = input.payroll_day === undefined ? state.payroll_day : Math.round(input.payroll_day);
  const positive = (value: number | undefined, fallback: number) => value === undefined ? fallback : Math.max(0, safeMoney(value));
  if (payroll < 28 || payroll > 31) throw new Error("El día de nómina debe estar entre 28 y 31.");
  store().update((data) => {
    const budget = data.budget ?? defaultBudgetState();
    budget.payroll_day = payroll;
    budget.monthly_income = positive(input.monthly_income, budget.monthly_income);
    budget.budgets.needs = positive(input.needs, budget.budgets.needs);
    budget.budgets.leisure = positive(input.leisure, budget.budgets.leisure);
    budget.budgets.savings = positive(input.savings, budget.budgets.savings);
    data.budget = budget;
  });
}

export function addManualMovement(input: { date: string; amount: number; currency?: string; description: string; block?: BudgetBlock; category?: BudgetCategory; planned?: boolean; status?: "pending" | "confirmed" }): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("La fecha debe tener formato AAAA-MM-DD.");
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new Error("El importe debe ser distinto de cero.");
  if (!input.description.trim()) throw new Error("Añade una descripción.");
  if (input.block !== undefined && !validBlocks.has(input.block)) throw new Error("Bloque no válido.");
  if (input.category !== undefined && !validCategories.has(input.category)) throw new Error("Categoría no válida.");
  const id = `manual-${randomUUID()}`;
  store().update((data) => {
    const budget = data.budget ?? defaultBudgetState();
    const classification = input.block ?? (input.amount > 0 ? "unclassified" : "unclassified");
    budget.manual_movements.push({ id, date: input.date, amount: safeMoney(input.amount), currency: (input.currency ?? "EUR").toUpperCase().slice(0, 3), description: input.description.trim().slice(0, 120), bank: "Manual", block: classification, category: input.category ?? (input.amount > 0 ? "income" : "unclassified"), planned: input.planned ?? false, status: input.status ?? "confirmed", created_at: new Date().toISOString() });
    data.budget = budget;
  });
  return id;
}

export function classifyMovement(id: string, input: { block: BudgetBlock; category: BudgetCategory; planned: boolean }): void {
  if (!id || !validBlocks.has(input.block) || !validCategories.has(input.category)) throw new Error("Clasificación no válida.");
  store().update((data) => {
    const budget = data.budget ?? defaultBudgetState();
    const manual = budget.manual_movements.find((movement) => movement.id === id);
    if (manual) {
      manual.block = input.block;
      manual.category = input.category;
      manual.planned = input.planned;
    } else {
      budget.overrides[id] = { block: input.block, category: input.category, planned: input.planned };
    }
    data.budget = budget;
  });
}

export function addBudgetRule(input: { contains: string; label: string; block: Exclude<BudgetBlock, "unclassified">; category: Exclude<BudgetCategory, "income" | "unclassified">; planned: boolean }): string {
  if (!input.contains.trim() || !input.label.trim()) throw new Error("La regla necesita texto y nombre.");
  if (!validBlocks.has(input.block) || !validCategories.has(input.category)) throw new Error("Regla no válida.");
  const id = `rule-${randomUUID()}`;
  store().update((data) => {
    const budget = data.budget ?? defaultBudgetState();
    budget.rules.push({ id, contains: input.contains.trim().slice(0, 180), label: input.label.trim().slice(0, 60), block: input.block, category: input.category, planned: input.planned });
    data.budget = budget;
  });
  return id;
}

export class BudgetAuth {
  private sessions = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();

  login(password: string, ip: string): string | undefined {
    const stored = this.failures.get(ip);
    const failure = stored && stored.until > Date.now() ? stored : undefined;
    if (!failure && stored) this.failures.delete(ip);
    if (failure && failure.count >= 5 && failure.until > Date.now()) return undefined;
    if (!verifyPassword(password)) {
      const count = (failure?.count ?? 0) + 1;
      this.failures.set(ip, { count, until: Date.now() + 15 * 60_000 });
      return undefined;
    }
    this.failures.delete(ip);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(createHash("sha256").update(token).digest("hex"), Date.now() + 12 * 60 * 60_000);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const key = createHash("sha256").update(token).digest("hex");
    const expires = this.sessions.get(key);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(createHash("sha256").update(token).digest("hex"));
  }
}

export const budgetCategoryLabels = categoryLabels;
export const budgetBlockLabels = blockLabels;
export const budgetAppName = config.appName.replace(/[™®]/g, "").trim() || "BankMCP";
