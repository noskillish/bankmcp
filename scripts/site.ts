// Builds the subpages of bankmcp.dk into docs/: the hand-written pages in
// scripts/site/pages.ts, one page per country from docs/banks/banks.json, and
// the sitemap. The landing page docs/index.html is written by hand; its
// <style> block is reused here so the pages share one stylesheet.
//
//   node scripts/site.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { HOW_SECTION, NOT_SECTION, pages, type Page } from "./site/pages.ts";

const SITE = "https://bankmcp.dk";
const GITHUB = "https://github.com/noskillish/bankmcp";
const index = readFileSync("docs/index.html", "utf8");
const style = index.slice(index.indexOf("<style>"), index.indexOf("</style>") + 8);
const FAQ_SECTION = (index.match(/<section id="faq">[\s\S]*?<\/section>/) ?? [""])[0];

interface BankList {
  fetched: string;
  countries: { code: string; name: string; banks: { name: string; max_consent_days: number | null; customer_types: string[]; beta: boolean }[] }[];
}
const banks: BankList = JSON.parse(readFileSync("docs/banks/banks.json", "utf8"));
const total = banks.countries.reduce((n, c) => n + c.banks.length, 0);
const fetchedLong = new Date(banks.fetched + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const num = (n: number) => n.toLocaleString("en-US");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAV: [string, string][] = [
  ["/#how", "How it works"],
  ["/start/", "Get started"],
  ["/setup/", "Setup"],
  ["/banks/", "Banks"],
  ["/security/", "Security"],
  ["/questions/", "Questions"],
  [GITHUB, "GitHub"],
];

const PAGE_CSS = `<style>
  .page { padding: 4rem 0 1rem; }
  @media (min-width: 768px) { .page { padding: 5.5rem 0 1.5rem; } }
  .page h1 { font-size: clamp(2rem, 4.5vw, 3rem); font-weight: 400; letter-spacing: -0.035em; line-height: 1.1; margin-bottom: 1rem; }
  .page .lead { font-size: 1.05rem; color: var(--dim); max-width: 600px; font-weight: 300; line-height: 1.6; }
  main section:first-of-type { border-top: 0; padding-top: 2rem; }
  .more { margin-top: 2rem; font-size: 0.85rem; color: var(--dim); } .more a { color: var(--ink); }
  nav a[aria-current] { color: var(--ink); }
  .flow { list-style: none; margin: 2.5rem 0 0; padding: 0; max-width: 640px; }
  .frow { display: grid; grid-template-columns: 2.75rem 1fr; gap: 0 1rem; padding: 1.6rem 0; border-top: 1px solid var(--border); transition: opacity .3s; }
  .frow:last-child { border-bottom: 1px solid var(--border); }
  .frow .num { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: var(--accent); padding-top: 0.25rem; }
  .frow.done .num { color: var(--ok); } .frow.done .num::after { content: " ✓"; }
  .frow h3 { font-size: 0.95rem; font-weight: 500; letter-spacing: -0.01em; margin: 0 0 0.35rem; }
  .fbody p { font-size: 0.88rem; color: var(--dim); font-weight: 300; line-height: 1.55; margin: 0 0 0.6rem; }
  .fbody p:last-child { margin-bottom: 0; }
  .fbody code { font-size: 0.8rem; color: var(--ink); }
  .act { display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; margin-top: 0.9rem !important; }
  .act .btn { font-size: 0.82rem; padding: 0.55rem 1.1rem; }
  .hint { font-size: 0.78rem; color: var(--muted); }
  .addr { display: flex; gap: 0.5rem; margin: 0.9rem 0 0.6rem; }
  .addr input { flex: 1; min-width: 0; font: inherit; font-size: 0.85rem; padding: 0.55rem 0.8rem; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-card); color: var(--ink); }
  .addr input:focus { outline: none; border-color: var(--ink); }
  .addr button { font: inherit; font-size: 0.82rem; font-weight: 500; padding: 0.55rem 1rem; border: 1px solid var(--ink); border-radius: 8px; background: var(--ink); color: #f5f5f3; cursor: pointer; }
  .status { position: relative; padding-left: 1.1rem; font-size: 0.82rem; color: var(--dim); line-height: 1.5; }
  .status .dot { position: absolute; left: 0; top: 0.5em; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .status.wait .dot { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .status.ok { color: var(--ok); } .status.ok .dot { background: var(--ok); }
  .status.err { color: var(--accent); } .status.err .dot { background: var(--accent); }
  .status .arrow { color: var(--ink); font-weight: 500; text-decoration: none; margin-left: 0.4rem; white-space: nowrap; } .status .arrow:hover { text-decoration: underline; }
  @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
  .copyrow { display: flex; gap: 0.5rem; align-items: stretch; margin-top: 0.6rem; }
  .copyrow code { flex: 1; font-size: 0.78rem; padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-card); word-break: break-all; display: flex; align-items: center; }
  .copybtn { font: inherit; font-size: 0.78rem; font-weight: 500; padding: 0.45rem 0.8rem; border: 1px solid var(--border-strong); border-radius: 8px; background: transparent; color: var(--ink); cursor: pointer; white-space: nowrap; }
  .copybtn.done { color: var(--ok); border-color: var(--ok); }
  @media (max-width: 520px) { .frow { grid-template-columns: 2.2rem 1fr; } .act { gap: 0.6rem; } }
  .countries { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 2rem; margin-top: 2.5rem; max-width: 680px; }
  @media (min-width: 640px) { .countries { grid-template-columns: 1fr 1fr 1fr; } }
  .countries a { display: flex; justify-content: space-between; gap: 1rem; padding: 0.6rem 0; border-top: 1px solid var(--border); color: var(--ink); text-decoration: none; font-size: 0.9rem; }
  .countries a:hover { color: var(--accent); }
  .countries span { color: var(--muted); font-variant-numeric: tabular-nums; }
  .table-wrap { overflow-x: auto; margin-top: 2.5rem; }
  table.banks { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  table.banks th { text-align: left; font-weight: 500; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); padding: 0 1rem 0.6rem 0; border-bottom: 1px solid var(--border-strong); }
  table.banks td { padding: 0.55rem 1rem 0.55rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.banks td:not(:first-child) { color: var(--dim); font-weight: 300; white-space: nowrap; }
  table.banks .beta { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); border: 1px solid var(--border-strong); border-radius: 999px; padding: 0.05rem 0.45rem; margin-left: 0.5rem; vertical-align: middle; }
</style>`;

const ICONS = `<link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png">
<link rel="icon" href="/favicon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

const FOOTER = `<footer>
  <div class="container">
    <p>BankMCP™ is not a bank and does not give financial advice. Not affiliated with Enable Banking, Anthropic or any bank. MIT licence.</p>
    <nav>
      <a href="${GITHUB}">GitHub</a>
      <a href="/setup/">Setup</a>
      <a href="/banks/">Banks</a>
      <a href="/security/">Security</a>
      <a href="/questions/">Questions</a>
      <a href="https://enablebanking.com">Enable Banking</a>
    </nav>
  </div>
</footer>`;

function header(active: string) {
  const links = NAV.map(([href, text]) => `      <a href="${href}"${href === active ? ' aria-current="page"' : ""}>${text}</a>`).join("\n");
  return `<header>
  <div class="container">
    <a class="logo" href="/"><span class="mark">B</span>BankMCP™</a>
    <nav>
${links}
    </nav>
  </div>
</header>`;
}

interface Crumb { name: string; path: string }

function render(page: Page & { crumbs?: Crumb[]; extraLd?: object[]; active?: string }) {
  const url = SITE + page.path;
  const crumbs: Crumb[] = [{ name: "BankMCP™", path: "/" }, ...(page.crumbs ?? [{ name: page.title.split(" · ")[0], path: page.path }])];
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", "@id": url, url, name: page.title, description: page.description, isPartOf: { "@id": `${SITE}/#website` }, about: { "@id": `${SITE}/#software` }, inLanguage: "en" },
      { "@type": "BreadcrumbList", itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: SITE + c.path })) },
      ...(page.extraLd ?? []),
    ],
  };
  const body = page.body.replace("<!--HOW-->", HOW_SECTION.trimEnd()).replace("<!--NOT-->", NOT_SECTION.trimEnd()).replace("<!--FAQ-->", FAQ_SECTION);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<meta name="theme-color" content="#f5f2ec">
<meta property="og:site_name" content="BankMCP™">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${SITE}/og.png">
${ICONS}
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
${style}
${PAGE_CSS}
<script type="application/ld+json">
${JSON.stringify(ld, null, 1)}
</script>
</head>
<body>
${header(page.active ?? page.path)}
${body}
${FOOTER}
</body>
</html>
`;
}

function write(path: string, html: string) {
  mkdirSync("docs" + path, { recursive: true });
  writeFileSync(`docs${path}index.html`, html);
}

// --- hand-written pages; the questions page carries the FAQ markup from the landing page
const indexLd = JSON.parse(index.slice(index.indexOf('<script type="application/ld+json">') + 35, index.indexOf("</script>", index.indexOf('<script type="application/ld+json">'))));
const faq = (indexLd["@graph"] as { "@type": string }[]).find((n) => n["@type"] === "FAQPage");
for (const p of pages) write(p.path, render({ ...p, extraLd: p.path === "/questions/" && faq ? [faq] : [] }));

// --- banks overview
const countryLinks = banks.countries.map((c) => `      <a href="/banks/${c.code}/">${esc(c.name)}<span>${num(c.banks.length)}</span></a>`).join("\n");
write("/banks/", render({
  path: "/banks/",
  title: "Banks · BankMCP™",
  description: `The banks BankMCP™ can connect to through Enable Banking, by country: ${num(total)} in ${banks.countries.length} European countries in their list on ${fetchedLong}.`,
  body: `<div class="page"><div class="container">
  <h1>Banks BankMCP™ connects to</h1>
  <p class="lead">The banks Enable Banking supports, by country. Their list had ${num(total)} connections in ${banks.countries.length} European countries on ${fetchedLong}. The list is theirs and changes; whether a given account works depends on the bank and on Enable Banking.</p>
</div></div>
<main>
<section id="countries">
  <div class="container">
    <div class="eyebrow">By country · fetched ${fetchedLong}</div>
    <h2>${banks.countries.length} countries.</h2>
    <p class="section-subtitle">Each page lists every bank in Enable Banking's list for that country, with how long a consent lasts and whether it is for personal or business accounts. Your assistant sees the same list through the <code>list_banks</code> tool.</p>
    <div class="countries">
${countryLinks}
    </div>
  </div>
</section>
<!--HOW-->
<!--NOT-->
</main>`,
}));

// --- one page per country
for (const c of banks.countries) {
  const rows = c.banks.map((b) => {
    const consent = b.max_consent_days === null ? "" : `${b.max_consent_days} days`;
    const who = b.customer_types.map((t) => (t === "business" ? "Business" : "Personal")).join(", ");
    return `        <tr><td>${esc(b.name)}${b.beta ? '<span class="beta">beta</span>' : ""}</td><td>${consent}</td><td>${who}</td></tr>`;
  }).join("\n");
  const betaCount = c.banks.filter((b) => b.beta).length;
  const title = `Banks in ${c.name} · BankMCP™`;
  write(`/banks/${c.code}/`, render({
    path: `/banks/${c.code}/`,
    active: "/banks/",
    title,
    description: `Banks in ${c.name} that BankMCP™ can connect to through Enable Banking: ${num(c.banks.length)} in their list on ${fetchedLong}, with consent lengths and customer types. Read-only access to your own accounts from Claude, ChatGPT or any MCP client.`,
    crumbs: [{ name: "Banks", path: "/banks/" }, { name: c.name, path: `/banks/${c.code}/` }],
    extraLd: [{ "@type": "ItemList", name: `Banks in ${c.name} in Enable Banking's list`, numberOfItems: c.banks.length, itemListElement: c.banks.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.name })) }],
    body: `<div class="page"><div class="container">
  <h1>Banks in ${esc(c.name)}</h1>
  <p class="lead">BankMCP™ connects to the banks Enable Banking supports in ${esc(c.name)}. There were ${num(c.banks.length)} in their list on ${fetchedLong}. Your assistant sees the same list through the <code>list_banks</code> tool and connects with <code>start_consent</code>.</p>
</div></div>
<main>
<section id="list">
  <div class="container">
    <div class="eyebrow">Enable Banking's list · fetched ${fetchedLong}</div>
    <h2>${num(c.banks.length)} ${c.banks.length === 1 ? "bank" : "banks"}.</h2>
    <p class="section-subtitle">Consent is how long a connection lasts before you log in at the bank again; BankMCP™ caps it at 180 days. Customers says whether the connection is for personal or business accounts. Beta is Enable Banking's own flag for connections still being tested${betaCount ? ` (${num(betaCount)} here)` : ""}. The list changes; whether a given account works depends on the bank and on Enable Banking.</p>
    <div class="table-wrap">
      <table class="banks">
        <thead><tr><th>Bank</th><th>Consent</th><th>Customers</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
    <p class="more"><a href="/banks/">All countries →</a></p>
  </div>
</section>
<!--HOW-->
<!--NOT-->
</main>`,
  }));
}

// --- sitemap
const today = new Date().toISOString().slice(0, 10);
const urls = ["/", ...pages.map((p) => p.path), "/banks/", ...banks.countries.map((c) => `/banks/${c.code}/`)];
writeFileSync("docs/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`);

console.log(`${pages.length + 1 + banks.countries.length} pages, ${urls.length} sitemap entries, ${num(total)} banks in ${banks.countries.length} countries (fetched ${banks.fetched})`);
