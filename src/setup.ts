// First-run setup: takes the application id, the key file and a password,
// validates them and stores them in the data directory. Only reachable while
// the server has no working configuration.
import { createPrivateKey } from "node:crypto";
import { config, looksLikeUuid, saveKeyFile, saveSettings } from "./config.ts";
import { hashPassword } from "./auth.ts";
import { checkApplication, EnableBankingError, resetKeyCache, type Application } from "./enablebanking.ts";

export interface SetupInput {
  app_id?: string;
  pem?: string;
  password?: string;
  password2?: string;
  country?: string;
}

export function setupAvailable(): boolean {
  const hasPassword = config.localMode || Boolean(config.adminPasswordHash || config.adminPassword);
  return !config.lockedByEnv && !(config.appId && (config.privateKey || config.privateKeyPath) && hasPassword);
}

export type Verify = (appId: string, pem: string) => Promise<Application>;

/**
 * Returns null on success, otherwise a message for the form. Before anything is
 * stored the id and key are checked against Enable Banking, unless `verify` is null.
 */
export async function applySetup(input: SetupInput, verify: Verify | null = checkApplication): Promise<string | null> {
  const appId = (input.app_id ?? "").trim();
  const pem = (input.pem ?? "").trim();
  const password = input.password ?? "";
  const country = (input.country ?? "").trim().toUpperCase();

  if (!looksLikeUuid.test(appId)) return "The application id should be a UUID like 8d3f6c2a-1b4e-4f7a-9c2d-5e6f7a8b9c0d. It is shown on the application in the Enable Banking Control Panel.";
  if (!pem.includes("PRIVATE KEY")) return "That does not look like the key file. Choose the .pem file that downloaded when you registered the application.";
  try {
    createPrivateKey(pem);
  } catch {
    return "The key file could not be read as a private key.";
  }
  if (!config.localMode) {
    if (password.length < 12) return "Use a password of at least 12 characters. It is the only thing between the internet and your accounts.";
    if (password !== input.password2) return "The two passwords do not match.";
  }
  if (country && !/^[A-Z]{2}$/.test(country)) return "Country should be a two-letter code such as DK.";

  if (verify) {
    try {
      await verify(appId, pem);
    } catch (err) {
      if (err instanceof EnableBankingError && (err.status === 401 || err.status === 403)) return "Enable Banking did not accept this application id together with this key. Check that the id is the one shown on the application whose key you chose.";
      if (err instanceof EnableBankingError) return `Enable Banking answered ${err.status} when asked about the application. Nothing was saved; try again in a moment.`;
      return `Enable Banking could not be reached (${(err as Error).message}). Nothing was saved; try again in a moment.`;
    }
  }

  saveKeyFile(pem);
  saveSettings({ app_id: appId, admin_password_hash: config.localMode ? undefined : hashPassword(password), country: country || undefined, setup_completed: new Date().toISOString() });
  resetKeyCache();
  return null;
}

/** Password step alone, after the application was registered through the Control Panel flow. */
export function applyPassword(input: { password?: string; password2?: string }): string | null {
  const password = input.password ?? "";
  if (password.length < 12) return "Use a password of at least 12 characters. It is the only thing between the internet and your accounts.";
  if (password !== input.password2) return "The two passwords do not match.";
  saveSettings({ admin_password_hash: hashPassword(password), setup_completed: new Date().toISOString() });
  return null;
}
