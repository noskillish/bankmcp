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
import { connectedPage, failedPage, loginPage, privacyPage, setupPage, signedInPage, signInFailedPage, statusPage, termsPage } from "./pages.ts";
import { applySetup, setupAvailable } from "./setup.ts";
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

  app.get("/", (_req, res) => {
    if (setupAvailable()) return void res.set("Content-Security-Policy", setupCsp).type("html").send(setupPage({ baseUrl: config.baseUrl }));
    res.type("html").send(statusPage({ problems: setupProblems(), mcpUrl: mcpUrl.href, callbackUrl }));
  });

  app.post("/setup", express.urlencoded({ extended: false, limit: "64kb" }), (req, res) => {
    if (!setupAvailable()) return void res.status(404).type("html").send(failedPage("Setup is already complete."));
    const body = req.body as Record<string, string | undefined>;
    const error = applySetup(body);
    if (error) return void res.status(400).set("Content-Security-Policy", setupCsp).type("html").send(setupPage({ error, values: { app_id: body.app_id, country: body.country }, baseUrl: config.baseUrl }));
    log("setup completed via the setup page");
    if (opts.remote) rememberPasswordFingerprint();
    startWatcherOnce();
    res.redirect(303, "/");
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true, version: VERSION, configured: isConfigured() }));

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

  if (opts.remote) app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const { request, password } = req.body as Record<string, string | undefined>;
    const result = provider.completeLogin(String(request ?? ""), String(password ?? ""), req.ip ?? "unknown");
    if ("redirect" in result) return void res.redirect(303, result.redirect);
    if ("done" in result) return void res.status(200).type("html").send(signedInPage());
    if (result.requestId) return void res.status(401).type("html").send(loginPage({ requestId: result.requestId, error: result.error }));
    res.status(400).type("html").send(signInFailedPage(result.error));
  });

  // --- MCP endpoint (stateless: one transport per request) ---

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

  if (opts.remote) app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
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
