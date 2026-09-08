# BankMCP™

**Your AI now reads your bank.** Ask it anything about your accounts. Read-only, self-hosted, one user. Standard MCP; tested with Claude and Ollama.

BankMCP™ is not a bank. It is a small open-source server you host yourself
(npm package `bankmcp`). It connects to your banks
through [Enable Banking](https://enablebanking.com), which wraps 2,700+
European banks in one PSD2 API, and exposes them to any MCP client as a
connector. Read-only, no payments, no third party holding your data.

> "Has the invoice from Acme been paid?" · "What did we spend on groceries in
> August?" · "Which subscriptions am I paying for, and what do they cost per
> year?" · "Tell me when my balance drops below 5,000."

## How it works

```
Your assistant ──OAuth──▶ your BankMCP™ server ──JWT──▶ Enable Banking ──PSD2──▶ your bank
```

- **Your assistant** (Claude, ChatGPT, Cursor, or any MCP client) talks to
  your server as a connector. You sign in once with a password; tokens handle
  the rest.
- **Your server** holds the Enable Banking application key, the bank consents
  and your account ids. It does not store balances or transactions and sends no
  telemetry.
- **Enable Banking** is the licensed provider between your server and your
  bank. Every balance and transaction you ask for passes through their
  servers on the way to yours; they do not store it, and they do not see your
  bank credentials, since you log in at your bank's own site. This hop is how
  PSD2 works and is the one part of the chain that is not on your machine.

## Setup

Two ways to run it. Both need a free Enable Banking account and about ten
minutes.

- **On your own machine** for Claude Desktop, Claude Code, Cursor and other
  desktop MCP clients. Nothing to deploy, no password.
- **On a small server** when you want it in claude.ai or on your phone.

### On your own machine

The server and its state live on your computer, and no AI vendor or app
maker sees your data. The bank connection is not on your computer: it goes
through Enable Banking, as described above.

Requires [Node 24](https://nodejs.org) or newer. Add BankMCP™ to your client:

Claude Code:

```bash
claude mcp add bankmcp -- npx -y bankmcp
```

Claude Desktop: download
[bankmcp.mcpb](https://github.com/noskillish/bankmcp/releases/latest/download/bankmcp.mcpb)
and open it; Claude Desktop installs it as an extension. Or add it by hand in
`claude_desktop_config.json`:

```json
{ "mcpServers": { "bankmcp": { "command": "npx", "args": ["-y", "bankmcp"] } } }
```

Cursor and others: the same command, `npx -y bankmcp`, as a stdio server.

Then ask your assistant anything about your bank. It will answer with a
localhost address. Open it: the setup page lists the values to register an
application at Enable Banking, then takes the application id and the key file.
Your browser will warn once about the certificate on localhost, which the
server made for itself because Enable Banking requires https for the bank
redirect. Continue past it. Say "connect my bank" and log in at your bank.

To avoid the warning altogether, use a certificate your browser already
trusts: [mkcert](https://github.com/FiloSottile/mkcert) makes one with
`mkcert localhost 127.0.0.1`; point `TLS_CERT_PATH` and `TLS_KEY_PATH` at the
two files and the server uses them instead of generating its own. BankMCP™
itself does not touch your system's trust store.

State lives in `~/.bankmcp`. Delete the folder to forget everything.

### On a server

#### 1. Deploy

Any container host works. The server needs a persistent volume at `/data`
and a public https address; it asks you for everything else in the browser.

**Railway:** New Project, Deploy from GitHub repo, pick this repo. Add a
volume mounted at `/data` and generate a domain (Settings, Networking, port
8080). The Dockerfile and [railway.json](railway.json) are picked up
automatically, and the server learns its own address from Railway.

**Docker Compose on your own box:** `docker compose up -d`, then put a TLS
terminator in front (Caddy needs two lines:
`YOUR-HOST { reverse_proxy localhost:8080 }`) and set `BASE_URL` to the
public address. Fly.io works like Railway: volume at `/data`, the app name
gives the address.

Open the address. A fresh server shows a setup page.

#### 2. Register an Enable Banking application

The setup page lists the exact values Enable Banking's form asks for: the
redirect URL, a description for the consent screen, and the privacy and
terms URLs, all pointing at your server. At
<https://enablebanking.com/cp/applications> create an application with them:

- Environment: **Production** for your real accounts, **Sandbox** for test
  data (see *Going live* below for the production rules).
- Keep "generate private key" selected. A `.pem` file downloads once when you
  save; that is the key. The application id (a UUID) is shown after saving.

#### 3. Finish setup

Back on the setup page: paste the application id, choose the `.pem` file, pick
a password of twelve characters or more. Everything is stored on the volume,
and the page turns into a status page showing the connector URL for your
assistant.

Prefer configuration by environment? Set these and the setup page does not
appears:

| Variable | Value |
|---|---|
| `EB_APP_ID` | the application id |
| `EB_PRIVATE_KEY` | the `.pem` contents, base64: `base64 -i app.pem \| tr -d '\n'` |
| `ADMIN_PASSWORD_HASH` | output of `npm run hash-password` (or set `ADMIN_PASSWORD`) |
| `BASE_URL` | `https://YOUR-HOST` (Railway and Fly set this for you) |
| `DEFAULT_COUNTRY` | your country code, e.g. `DK` |
| `APP_NAME` | optional, the name shown on the sign-in and status pages (default `BankMCP™`) |

Optional: `NOTIFY_WEBHOOK_URL` for watch notifications and sign-in alerts (a
Slack incoming webhook works). Full list in [.env.example](.env.example).
`npm run check` verifies a configuration from a terminal.

#### 4. Add the connector in your assistant

In claude.ai (or the desktop app): **Settings → Connectors → Add custom
connector**. Name it `BankMCP™`, paste `https://YOUR-HOST/mcp`, save, then click
**Connect**. Your server shows a password page; enter the admin password. That
is the only login you will do.

In Claude Code:

```bash
claude mcp add --transport http bank https://YOUR-HOST/mcp
```

then run `/mcp` inside Claude Code to sign in.

Other MCP clients (ChatGPT, Mistral Le Chat, Cursor, VS Code) work the same
way: add the URL as a remote MCP server, sign in with the password. Tested
with Claude, Claude Code and Ollama; the others follow the same standard.
A client whose domain is not in `ALLOWED_REDIRECT_HOSTS` needs adding there.

#### 5. Connect your bank

In your assistant, say **"connect my bank"** (or use the `connect-bank` prompt). It
looks up your bank, gives you a link, you log in at the bank and approve, and
the accounts appear. Consents last up to 180 days; you are told when one
is about to expire and the same conversation renews it.

Give accounts labels ("Everyday", "Joint expenses", "Mortgage") when it
suggests them. Every tool accepts labels instead of ids.

## Going live with your own accounts

Enable Banking's production environment normally requires a contract, but it
has a **restricted mode** for accessing *your own* accounts, explicitly allowed
for individual non-commercial use. After registering a Production application:

1. On the (Inactive) application click **Activate by linking accounts**.
2. Log in at your bank and approve. Repeat for each bank you want.
3. The application becomes active and the API returns only the accounts you
   linked this way.

Read the *Restriction of Use* section of Enable Banking's
[Terms of Service](https://enablebanking.com/terms-of-service/) before you
rely on it: restricted mode is for your own accounts, not for offering a
service to others. This project does not change those terms.

## What you get

**Tools** (all read-only):

| Tool | What it does |
|---|---|
| `list_banks`, `start_consent`, `consent_status`, `disconnect_bank` | connect and manage banks |
| `list_accounts`, `set_account_label` | accounts with booked balances; your own names for them |
| `get_balances` | booked and available balance for one account |
| `get_transactions` | signed amounts, one counterparty, one description; paginated |
| `create_watch`, `list_watches`, `delete_watch`, `check_watches` | background rules with webhook notifications |

**Prompts**: `connect-bank`, `monthly-summary`, `build-budget`,
`savings-scan`, `subscription-audit`, `unusual-transactions`.

**Watches** run on the server. Rules: balance below or above an amount, a
single debit over an amount, an incoming or outgoing payment matching a name,
and "tell me if this payment has not arrived by this date". Accounts are
checked at most four times a day, the PSD2 limit for unattended access.
Notifications go to `NOTIFY_WEBHOOK_URL` as a Slack message or a JSON POST.

Enable Banking's own webhooks cover payment initiation only, so account data
is polled. There is no way around that under PSD2.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. The `bank` plugin
brings three skills: `/bank:setup` walks you through installing BankMCP™ on
your machine, `/bank:deploy` through hosting it, and `bank` encodes how to work
with the data: an account map, categorisation rules, the monthly review format
and when to create watches.

Point it at your server, then install:

```bash
export OPENBANK_URL=https://YOUR-HOST/mcp   # put this in your shell profile
```

```
/plugin marketplace add noskillish/bankmcp
/plugin install bank@bank
```

Then `/mcp`, select `bank`, Authenticate, and enter your password. No
organisation admin is involved; plugins are per user.

The skill lives at [plugin/skills/bank/SKILL.md](plugin/skills/bank/SKILL.md).
Copy it into your own skills to fill in the account map and your merchant
rules. The server stays generic; your rules stay yours.

## Local models (experimental)

The server does not care which model asks. `npm run chat` bridges an
[Ollama](https://ollama.com) model to the same tools over stdio, so no AI
vendor sees a transaction:

```bash
ollama pull qwen3:8b
npm run chat -- "what's my balance?"
```

Measured on a MacBook Air with 24 GB: correct per-account balances, a wrong
total, ten minutes per answer. An 8B model is not yet trustworthy with money;
a 30B-class model on a machine with a real GPU is where it gets useful. Any
MCP client with tool calling (LM Studio, Goose, Jan) can also point at
`node src/stdio.ts` directly. Enable Banking still sits between you and the
bank either way; that part is regulated and unavoidable.

## Security notes

- The server is a complete OAuth 2.1 authorization server with one user.
  Discovery, dynamic client registration and PKCE come from the MCP SDK;
  tokens are stored hashed; five wrong passwords lock an address out for
  fifteen minutes.
- State is one JSON file in `DATA_DIR`: consents, account ids, watches (with
  the ids of transactions that already fired) and OAuth tokens. Balances and
  transactions are not written to disk. Your assistant keeps the
  conversation as any chat does, and a watch notification carries the matched
  transaction to your webhook. Back the file up if you care about not
  re-consenting; delete it to forget everything.
- Only clients that redirect back to a known MCP client domain (Claude,
  ChatGPT, Mistral, Cursor, VS Code) or localhost can register
  (`ALLOWED_REDIRECT_HOSTS`), which stops a phishing link from routing your sign-in to
  another site. Using a client not on the list? Add its domain. The sign-in page also names the host you will
  be sent back to.
- Anyone with the admin password can read your accounts. Use a long one.
  Every successful sign-in is logged and, if `NOTIFY_WEBHOOK_URL` is set,
  sent to you as a message. A sign-in you did not make is your alarm.
- Changing `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD`) and restarting logs
  every client out. That is the kill switch. Revoking the consents at your
  bank, or deleting the state file, is the step beyond it.
- There are no payment tools. Payments need a licensed PISP and a very
  different security model, so they are out of scope.

## Commands

```bash
npm start              # http server (reads env from the environment)
npm run dev            # same, with reload and .env
npm run check          # verify config and the Enable Banking application
npm run hash-password  # produce ADMIN_PASSWORD_HASH
npm run watch -- --force   # run all watches once, print what fired
npm test               # unit tests (node:test)
npm run typecheck
sh scripts/build-mcpb.sh   # Claude Desktop bundle → dist/bankmcp.mcpb
```

Requires Node 24 or newer (runs TypeScript directly, no build step).

## Layout

```
src/server.ts         Express: /mcp behind OAuth, OAuth endpoints, /callback, status page
src/auth.ts           single-user OAuth provider, password login page
src/mcp.ts            McpServer factory (tools + prompts + instructions)
src/tools.ts          the MCP tools
src/prompts.ts        the MCP prompts
src/watcher.ts        background rule checks and notifications
src/enablebanking.ts  JWT signing and a thin typed API client
src/store.ts          the JSON state file
src/data.ts           shaping balances and transactions for an assistant
src/stdio.ts          local entry point (stdio, used by `npx bankmcp`)
src/local.ts          localhost https server for setup and the bank redirect in local mode
src/app.ts            the Express app shared by both modes
src/cli.ts            check, hash-password, watch
plugin/               Claude Code plugin with the bank skill
```

## What this is, and is not

BankMCP™ is software, not a service. There is no hosted BankMCP™, no account to sign
up for, and nobody but you handles your server, your key or your bank
consents. Each person who uses it deploys their own copy and is the sole
operator of that copy: they register their own Enable Banking application,
accept Enable Banking's terms themselves, and are responsible for their own
hosting, password and security.

The authors publish the code and nothing else. They do not run any instance
for others, receive no data, and are not affiliated with Enable Banking,
Anthropic or any bank. BankMCP™ is not a bank, does not hold money, and gives no
financial advice.

**Use at your own risk.** If you deploy it, you own that deployment and its
security. The software is provided as is, without warranty of any kind, and
the authors accept no liability for how it is used or for any loss that
follows. MIT licence below.

## License

MIT
