// HTTP entry point: the MCP endpoint behind OAuth, the OAuth server itself,
// the Enable Banking redirect target, and a status page.
import { createHash } from "node:crypto";
import express, { type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, isConfigured, setupProblems } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { store } from "./store.ts";
import { SingleUserProvider, contentSecurityPolicy, cspNonce } from "./auth.ts";
import { grantForLog, hostsOf, idPrefix, oauthLog, registerDiag, resourceForLog, safeReason, tokenDiag, type RegisterDiag, type TokenDiag } from "./oauth-log.ts";
import { connectedPage, failedPage, loginPage, privacyPage, returningPage, setupPage, signInFailedPage, statusPage, termsPage } from "./pages.ts";
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
      "Content-Security-Policy": contentSecurityPolicy(),
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
        oauthLog("login", { client: idPrefix(e.clientId), redirect_host: e.redirectHost ?? "none", state: e.state === true });
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
  const setupCsp = contentSecurityPolicy({ script: true });

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

  const protectedResource = {
    resource: mcpUrl.href,
    authorization_servers: [baseUrl.href],
    scopes_supported: ["bank:read"],
    resource_name: "bank-mcp",
  };

  if (opts.remote) {
    app.use("/register", (req, res, next) => {
      const diag: RegisterDiag = { logged: false };
      const captured = captureOAuthError(res);
      res.on("finish", () => {
        if (diag.logged) return;
        const body = req.body as Record<string, unknown> | undefined;
        oauthLog("register", {
          client_name: typeof body?.client_name === "string" ? body.client_name.slice(0, 80) : "none",
          redirect_hosts: hostsOf(body?.redirect_uris),
          token_endpoint_auth_method: typeof body?.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method.slice(0, 40) : "absent",
          ok: false,
          status: res.statusCode,
          error: captured.error ?? "invalid_request",
        });
      });
      registerDiag.run(diag, () => next());
    });
    app.use("/authorize", (_req, res, next) => {
      const captured = captureOAuthError(res);
      res.on("finish", () => {
        if (res.statusCode === 200) return;
        let error = captured.error;
        let description = captured.description;
        if (!error && (res.statusCode === 302 || res.statusCode === 303)) {
          const location = res.getHeader("location");
          if (typeof location === "string") {
            try {
              const url = new URL(location, baseUrl);
              error = url.searchParams.get("error") ?? undefined;
              description = url.searchParams.get("error_description") ?? undefined;
            } catch {
              description = "redirect";
            }
          }
        }
        oauthLog("authorize", { status: res.statusCode, error: error ?? "unknown", reason: safeReason(description) });
      });
      next();
    });
    app.use("/token", (req, res, next) => {
      const diag: TokenDiag = { code: "n/a", pkce: "n/a", redirect_match: "n/a", resource_match: null };
      const captured = captureOAuthError(res);
      res.on("finish", () => {
        const body = req.body as Record<string, unknown> | undefined;
        const client = (req as typeof req & { client?: { client_id?: string } }).client;
        let pkce = diag.pkce;
        if (pkce === "pending") pkce = captured.error === "invalid_grant" ? "fail" : "n/a";
        oauthLog("token", {
          grant_type: grantForLog(body?.grant_type),
          client: idPrefix(client?.client_id ?? (typeof body?.client_id === "string" ? body.client_id : undefined)),
          client_known: Boolean(client?.client_id),
          redirect_match: diag.redirect_match,
          pkce,
          code: diag.code,
          resource: resourceForLog(body?.resource),
          resource_match: diag.resource_match,
          status: res.statusCode,
          error: captured.error ?? null,
        });
      });
      tokenDiag.run(diag, () => next());
    });
  }

  if (opts.remote) app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: baseUrl,
      resourceServerUrl: mcpUrl,
      resourceName: protectedResource.resource_name,
      scopesSupported: [...protectedResource.scopes_supported],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  // Cursor fetches the metadata at the host root. The router above also
  // serves the same document at /.well-known/oauth-protected-resource/mcp.
  if (opts.remote) app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(protectedResource);
  });

  if (opts.remote) app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const { request, password } = req.body as Record<string, string | undefined>;
    const result = provider.completeLogin(String(request ?? ""), String(password ?? ""), req.ip ?? "unknown");
    // A 302 here is still the form's navigation, so form-action blocks the
    // callback and any further redirect Cursor makes. A 200 page navigates itself.
    if ("redirect" in result) {
      const nonce = cspNonce();
      return void res.status(200).set("Content-Security-Policy", contentSecurityPolicy({ scriptNonce: nonce })).type("html").send(returningPage({ url: result.redirect, nonce }));
    }
    if (result.requestId) {
      const nonce = cspNonce();
      res.set("Content-Security-Policy", contentSecurityPolicy({ redirectUri: result.redirectUri, scriptNonce: nonce }));
      return void res.status(401).type("html").send(loginPage({ requestId: result.requestId, error: result.error, nonce }));
    }
    res.status(400).type("html").send(signInFailedPage(result.error));
  });

  // --- MCP endpoint (stateless: one transport per request) ---

  const bearer = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (tokenValue: string) => {
        try {
          const info = await provider.verifyAccessToken(tokenValue);
          if (info.resource && !sameResource(info.resource.href, mcpUrl.href)) {
            throw new InvalidTokenError("Token was not issued for this resource");
          }
          return info;
        } catch (err) {
          if (err instanceof InvalidTokenError) throw err;
          const message = err instanceof Error ? err.message : "Invalid access token";
          throw new InvalidTokenError(/expired/i.test(message) ? "Access token expired" : "Invalid access token");
        }
      },
    },
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  if (opts.remote) app.use("/mcp", (req, res, next) => {
    const captured = captureOAuthError(res);
    res.on("finish", () => {
      if (res.statusCode !== 401) return;
      oauthLog("mcp", { status: 401, reason: mcpAuthReason(req.headers.authorization, captured.description) });
    });
    next();
  });

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

function captureOAuthError(res: Response): { error?: string; description?: string } {
  const captured: { error?: string; description?: string } = {};
  const orig = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object") {
      const record = body as { error?: unknown; error_description?: unknown };
      if (typeof record.error === "string" && /^[a-z0-9_]+$/.test(record.error)) captured.error = record.error;
      if (typeof record.error_description === "string") captured.description = record.error_description;
    }
    return orig(body);
  }) as typeof res.json;
  return captured;
}

function sameResource(reported: string, expected: string): boolean {
  const clean = (value: string) => {
    const hash = value.indexOf("#");
    return (hash === -1 ? value : value.slice(0, hash)).replace(/\/$/, "");
  };
  return clean(reported) === clean(expected);
}

function mcpAuthReason(header: string | undefined, description: string | undefined): "missing" | "invalid" | "expired" | "audience" {
  const text = description ?? "";
  if (!header || /missing authorization/i.test(text)) return "missing";
  if (/not issued for this resource/i.test(text)) return "audience";
  if (/expired/i.test(text)) return "expired";
  return "invalid";
}
