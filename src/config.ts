// Configuration comes from two places. Environment variables always win.
// Anything missing is read from the data directory, where the first-run
// setup page stores the application id, the key file and the password hash.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const env = process.env;
// Local mode: the server is launched by an MCP client on the user's own
// machine over stdio. No OAuth, no admin password; state lives in ~/.bankmcp.
const localMode = env.BANKMCP_LOCAL === "1";
const port = Number(env.PORT ?? 8080);
const dataDir = env.DATA_DIR ?? (localMode ? join(homedir(), ".bankmcp") : "./data");

export interface Settings {
  app_id?: string;
  admin_password_hash?: string;
  country?: string;
  setup_completed?: string;
  registered_email?: string;
}

const settingsPath = join(dataDir, "settings.json");
const keyPath = join(dataDir, "enablebanking.pem");
let settings: Settings = readSettings();

function readSettings(): Settings {
  try {
    return existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Settings) : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  settings = { ...settings, ...patch };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function saveKeyFile(pem: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(keyPath, pem.trim() + "\n", { mode: 0o600 });
}

/** Public URL guessed from the platform when BASE_URL is not set. */
function detectBaseUrl(): string {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
  if (localMode) return `https://localhost:${port}`;
  return `http://localhost:${port}`;
}

export const config = {
  localMode,
  get appId(): string {
    return env.EB_APP_ID ?? settings.app_id ?? "";
  },
  get privateKey(): string {
    return env.EB_PRIVATE_KEY ?? "";
  },
  get privateKeyPath(): string {
    if (env.EB_PRIVATE_KEY_PATH) return env.EB_PRIVATE_KEY_PATH;
    return existsSync(keyPath) ? keyPath : "";
  },
  apiBase: env.EB_API_BASE ?? "https://api.enablebanking.com",
  get country(): string {
    return (env.DEFAULT_COUNTRY ?? settings.country ?? "DK").toUpperCase();
  },
  port,
  baseUrl: detectBaseUrl(),
  dataDir,
  appName: env.APP_NAME ?? "BankMCP™",
  get registeredEmail(): string | undefined {
    return settings.registered_email;
  },
  get adminPasswordHash(): string {
    return env.ADMIN_PASSWORD_HASH ?? settings.admin_password_hash ?? "";
  },
  adminPassword: env.ADMIN_PASSWORD ?? "",
  notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL ?? "",
  // Hosts an OAuth client may send the sign-in back to. Stops a phishing link
  // from registering a client that redirects your authorization code elsewhere.
  // Defaults cover the well-known MCP clients; subdomains are included.
  allowedRedirectHosts: (env.ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com,chatgpt.com,openai.com,mistral.ai,cursor.com,cursor.sh,vscode.dev,localhost,127.0.0.1")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  // Optional: terminate TLS in the process itself (for running on your own
  // machine). Hosted deployments normally get TLS from the platform.
  tlsCertPath: env.TLS_CERT_PATH ?? "",
  tlsKeyPath: env.TLS_KEY_PATH ?? "",
  // Unattended polling for watches: PSD2 allows at most four account accesses
  // per day without the account holder present.
  pollIntervalHours: Number(env.POLL_INTERVAL_HOURS ?? 6),
  /** True when every secret came from the environment, so the setup page has nothing to do. */
  get lockedByEnv(): boolean {
    return Boolean(env.EB_APP_ID && (env.EB_PRIVATE_KEY || env.EB_PRIVATE_KEY_PATH) && (localMode || env.ADMIN_PASSWORD_HASH || env.ADMIN_PASSWORD));
  },
};

export function tlsOptions(): { cert: string; key: string } | undefined {
  if (!config.tlsCertPath || !config.tlsKeyPath) return undefined;
  return { cert: readFileSync(config.tlsCertPath, "utf8"), key: readFileSync(config.tlsKeyPath, "utf8") };
}

export const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human-readable list of what is still missing before the server can talk to banks. */
export function setupProblems(): string[] {
  const problems: string[] = [];
  if (!config.appId) problems.push("Enable Banking application id is not set");
  else if (!looksLikeUuid.test(config.appId)) problems.push("EB_APP_ID does not look like a UUID");
  if (!config.privateKey && !config.privateKeyPath) problems.push("Enable Banking private key is not set");
  else {
    try {
      const pem = readPrivateKey();
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) problems.push("The private key is not a PEM file (expected -----BEGIN PRIVATE KEY-----)");
    } catch (err) {
      problems.push(`Cannot read private key: ${(err as Error).message}`);
    }
  }
  if (!localMode && !config.adminPasswordHash && !config.adminPassword) problems.push("Admin password is not set");
  if (!/^https?:\/\//.test(config.baseUrl)) problems.push("BASE_URL must start with http:// or https://");
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
  } catch {
    problems.push(`DATA_DIR ${config.dataDir} is not writable by this process (check volume permissions)`);
  }
  return problems;
}

export function isConfigured(): boolean {
  return setupProblems().length === 0;
}

export function readPrivateKey(): string {
  if (config.privateKey) {
    const raw = config.privateKey.trim();
    if (raw.startsWith("-----")) return raw.replace(/\\n/g, "\n");
    return Buffer.from(raw, "base64").toString("utf8");
  }
  return readFileSync(config.privateKeyPath, "utf8");
}
