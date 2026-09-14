// HTTP entry point: the MCP endpoint behind OAuth, the OAuth server itself,
// the Enable Banking redirect target, and a status page.
import { createHash } from "node:crypto";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, isConfigured, setupProblems } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { store } from "./store.ts";
import { SingleUserProvider } from "./auth.ts";
import { connectedPage, failedPage, loginPage, privacyPage, returningPage, setupPage, signedInPage, welcomePage, checkEmailPage, signInFailedPage, statusPage, termsPage } from "./pages.ts";
import { applyPassword, applySetup, setupAvailable } from "./setup.ts";
import { finishRegistration, pendingEmail, registeredButUnfinished, startRegistration } from "./register.ts";
import { createServer, VERSION } from "./mcp.ts";
import { startWatcher } from "./watcher.ts";

export interface AppOptions {
  /** Mount the OAuth server and the /mcp endpoint. Off in local (stdio) mode. */
  remote: boolean;
}

export function createApp(opts: AppOptions) {
  const log = (msg: string, extra?: unknown) => console.log(`[bank ${new Date().toISOString()}] ${msg}`, extra ?? "");

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });

  const baseUrl = new URL(config.baseUrl);
  const mcpUrl = new URL("/mcp", baseUrl);
  const provider = new SingleUserProvider(store(), {
    onLogin: (e) => {
      const who = e.clientName ? ` for ${e.clientName}` : "";
      if (e.ok) {
        log(`sign-in from ${e.ip}${who}`);
        notify(`${config.appName}: new sign-in from ${e.ip}${who}. If this was not you, change ADMIN_PASSWORD now; that logs every client out.`);
      } else {
        log(`failed sign-in from ${e.ip}${who} (${e.reason})`);
      }
    },
  });

  // Changing the admin password logs every client out.
  function rememberPasswordFingerprint(): void {
    const secret = config.adminPasswordHash || config.adminPassword;
    if (!secret) return;
    const fingerprint = createHash("sha256").update(secret).digest("hex");
    if (store().data.oauth.password_fingerprint && store().data.oauth.password_fingerprint !== fingerprint) {
      provider.revokeAll();
      log("admin password changed: all tokens revoked");
    }
    if (store().data.oauth.password_fingerprint !== fingerprint) store().update((d) => void (d.oauth.password_fingerprint = fingerprint));
  }
  if (opts.remote) rememberPasswordFingerprint();

  let watcherStarted = false;
  function startWatcherOnce(): void {
    if (watcherStarted || !isConfigured()) return;
    watcherStarted = true;
    startWatcher();
  }

  function notify(text: string): void {
    if (!config.notifyWebhookUrl) return;
    const slack = /hooks\.slack\.com/.test(config.notifyWebhookUrl);
    fetch(config.notifyWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slack ? { text } : { source: config.appName, type: "sign_in", text }),
    }).catch((err) => log("notify failed", (err as Error).message));
  }

  // --- Status page, health, legal ---

  const callbackUrl = new URL("/callback", baseUrl).href;
  // The setup page reads the chosen key file in the browser, which needs one inline script.
  const setupCsp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

  app.get("/", async (req, res) => {
    if (setupAvailable()) return void res.set("Content-Security-Policy", setupCsp).type("html").send(setupPage({ baseUrl: config.baseUrl, registered: registeredButUnfinished() ?? undefined }));
    const problems = setupProblems();
    if ("welcome" in req.query && !problems.length) {
      // Right after setup: what was checked, and the two things to do next.
      const application = await eb.getApplication().catch(() => undefined);
      return void res.set("Content-Security-Policy", setupCsp).type("html").send(welcomePage({ application, mcpUrl: mcpUrl.href, callbackUrl }));
    }
    res.set("Content-Security-Policy", setupCsp).type("html").send(statusPage({ problems, mcpUrl: mcpUrl.href, callbackUrl }));
  });

  // "Register for me": Enable Banking mails the sign-in link; the link returns to /setup/complete.
  app.post("/setup/register", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    if (!setupAvailable()) return void res.status(404).type("html").send(failedPage("Setup is already complete."));
    const body = req.body as Record<string, string | undefined>;
    const result = await startRegistration(body, config.baseUrl);
    if ("error" in result) return void res.status(400).set("Content-Security-Policy", setupCsp).type("html").send(setupPage({ error: result.error, values: { email: body.email, country: body.country }, baseUrl: config.baseUrl }));
    log(`registration: sign-in link requested for ${result.email.replace(/^(.).*(@.*)$/, "$1…$2")}`);
    res.set("Content-Security-Policy", setupCsp).type("html").send(checkEmailPage(result.email));
  });

  const complete = async (input: { state?: string; oobCode?: string; link?: string }, res: express.Response) => {
    const result = await finishRegistration(input, config.baseUrl);
    if ("error" in result) {
      const email = pendingEmail();
      if (input.link && email) return void res.status(400).set("Content-Security-Policy", setupCsp).type("html").send(checkEmailPage(email, { error: result.error, paste: true }));
      return void res.status(400).set("Content-Security-Policy", setupCsp).type("html").send(setupPage({ error: result.error, baseUrl: config.baseUrl }));
    }
    log(`registration: application ${result.appId} created (${result.environment})`);
    if (config.localMode) {
      startWatcherOnce();
      return void res.redirect(303, "/?welcome");
    }
    res.redirect(303, "/");
  };

  // Local mode: the click on the emailed link lands here. Hosted: the user pastes the link (POST).
  app.get("/setup/complete", async (req, res) => {
    if (!setupAvailable()) return void res.status(404).type("html").send(failedPage("Setup is already complete."));
    const q = req.query as Record<string, string | undefined>;
    await complete({ state: q.state, oobCode: q.oobCode }, res);
  });
  app.post("/setup/complete", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    if (!setupAvailable()) return void res.status(404).type("html").send(failedPage("Setup is already complete."));
    await complete({ link: String((req.body as Record<string, string | undefined>).link ?? "") }, res);
  });

  app.post("/setup", express.urlencoded({ extended: false, limit: "64kb" }), async (req, res) => {
    if (!setupAvailable()) return void res.status(404).type("html").send(failedPage("Setup is already complete."));
    const body = req.body as Record<string, string | undefined>;
    const registered = registeredButUnfinished();
    const error = registered && !body.app_id ? applyPassword(body) : await applySetup(body);
    if (error) return void res.status(400).set("Content-Security-Policy", setupCsp).type("html").send(setupPage({ error, values: { app_id: body.app_id, country: body.country }, baseUrl: config.baseUrl, registered: registered ?? undefined }));
    log("setup completed via the setup page");
    if (opts.remote) rememberPasswordFingerprint();
    startWatcherOnce();
    res.redirect(303, "/?welcome");
  });

  // Readable from any origin: the Get started page on the website polls it from the visitor's browser
  // to tell when their own server is up. It carries no data beyond "running" and "configured".
  app.get("/healthz", (_req, res) => void res.set("Access-Control-Allow-Origin", "*").json({ ok: true, version: VERSION, configured: isConfigured() }));

  app.get("/privacy", (_req, res) => void res.type("html").send(privacyPage()));
  app.get("/terms", (_req, res) => void res.type("html").send(termsPage()));

  // --- OAuth server for the MCP connector (single user) ---

  if (opts.remote) app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "bank-mcp",
      scopesSupported: ["bank:read"],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  // Request trace for the OAuth endpoints (no secrets: query strings and bodies are not logged).
  if (opts.remote) app.use((req, _res, next) => {
    if (/^\/(authorize|login|token|register)$/.test(req.path)) log(`${req.method} ${req.path} from ${req.ip} ua="${String(req.headers["user-agent"] ?? "").slice(0, 60)}" referer=${req.headers.referer ? new URL(String(req.headers.referer)).host : "-"}`);
    next();
  });

  if (opts.remote) app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const { request, password } = req.body as Record<string, string | undefined>;
    const result = provider.completeLogin(String(request ?? ""), String(password ?? ""), req.ip ?? "unknown");
    log(`login request=${String(request ?? "").slice(0, 6)}… → ${"redirect" in result ? "redirect to " + new URL(result.redirect).host : "done" in result ? "already done" : "error: " + result.error.slice(0, 40)}`);
    // A page that forwards at once, not a redirect: the form leaves the screen immediately, so a
    // second press cannot post it again, and the hop to the assistant is not a form submission
    // (Chrome applies form-action to redirects that follow one).
    if ("redirect" in result) return void res.status(200).type("html").send(returningPage(result.redirect));
    if ("done" in result) return void res.status(200).type("html").send(signedInPage());
    if (result.requestId) return void res.status(401).type("html").send(loginPage({ requestId: result.requestId, error: result.error }));
    res.status(400).type("html").send(signInFailedPage(result.error));
  });

  // --- MCP endpoint (stateless: one transport per request) ---

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

  // People paste the bare domain into their assistant as often as the /mcp address. Both work:
  // the MCP handler is mounted at /mcp and at the root, where GET remains the status page.
  if (opts.remote) app.post(["/mcp", "/"], bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("mcp request failed", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  if (opts.remote) app.get("/mcp", bearer, (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "This server is stateless; use POST." }));
  if (opts.remote) app.delete("/mcp", bearer, (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "This server is stateless; use POST." }));

  // --- Enable Banking redirect target ---

  app.get("/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>;
    const pending = state ? store().takePendingAuth(state) : undefined;
    const failed = (msg: string) => res.status(400).type("html").send(failedPage(msg));

    if (error || !code) return void failed(error_description || error || "The bank did not return an authorization code.");
    if (!pending) return void failed("Unknown or expired authorization. Start again from your assistant.");

    try {
      const session = await eb.createSession(code);
      store().addSession(session);
      log(`bank connected: ${session.aspsp.name}, ${session.accounts.length} account(s)`);
      res.type("html").send(connectedPage(session));
    } catch (err) {
      const msg = err instanceof EnableBankingError ? `Enable Banking returned ${err.status}: ${err.body.slice(0, 300)}` : (err as Error).message;
      log("callback failed", msg);
      failed(msg);
    }
  });

  return Object.assign(app, { startWatcherOnce });
}
