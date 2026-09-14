// Fetches Enable Banking's bank list for every European country it covers and
// writes docs/banks/banks.json, the data behind the country pages on the site.
//
//   node --env-file=.env scripts/banks.ts
//
// Needs a configured Enable Banking application (EB_APP_ID and the key), like
// the server itself. Only bank names, countries, consent lengths and customer
// types are written; nothing about the application.
import { mkdirSync, writeFileSync } from "node:fs";
import { eb, EnableBankingError } from "../src/enablebanking.ts";

// EEA plus the United Kingdom. Countries with no banks in the list are dropped.
const CANDIDATES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT",
  "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB",
];

const names = new Intl.DisplayNames(["en"], { type: "region" });

interface Bank {
  name: string;
  max_consent_days: number | null;
  customer_types: string[];
  beta: boolean;
}

const countries: { code: string; name: string; banks: Bank[] }[] = [];
for (const code of CANDIDATES) {
  let list;
  try {
    list = await eb.listAspsps(code);
  } catch (err) {
    if (err instanceof EnableBankingError && err.status === 404) continue;
    throw err;
  }
  const banks = list
    .filter((a) => !a.sandbox && a.name)
    .map((a) => ({
      name: a.name,
      max_consent_days: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86_400) : null,
      customer_types: a.psu_types?.length ? a.psu_types : ["personal"],
      beta: Boolean(a.beta),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  // The same bank can appear once per customer type; keep one row per name.
  const byName = new Map<string, Bank>();
  for (const b of banks) {
    const seen = byName.get(b.name);
    if (seen) seen.customer_types = [...new Set([...seen.customer_types, ...b.customer_types])];
    else byName.set(b.name, b);
  }
  if (!byName.size) continue;
  countries.push({ code: code.toLowerCase(), name: names.of(code) ?? code, banks: [...byName.values()] });
  console.error(`${code} ${byName.size}`);
}

countries.sort((a, b) => a.name.localeCompare(b.name, "en"));
const out = { fetched: new Date().toISOString().slice(0, 10), source: "Enable Banking /aspsps", countries };
mkdirSync("docs/banks", { recursive: true });
writeFileSync("docs/banks/banks.json", JSON.stringify(out, null, 1) + "\n");
console.error(`${countries.length} countries, ${countries.reduce((n, c) => n + c.banks.length, 0)} banks → docs/banks/banks.json`);
