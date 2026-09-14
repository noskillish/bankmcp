// "Register for me" on the setup page: the server asks Enable Banking to send
// the user their one-time sign-in link, and when the link comes back it creates
// the application, generates the key pair and stores id and key. The Control
// Panel session is used for that one request and then forgotten.
import { randomBytes } from "node:crypto";
import { config, saveKeyFile, saveSettings } from "./config.ts";
import { completeSignIn, ControlPanelError, newKeyPair, registerApplication, requestSignInLink } from "./controlpanel.ts";
import { resetKeyCache } from "./enablebanking.ts";
import { CONSENT_DESCRIPTION } from "./pages.ts";

export interface RegistrationInput {
  email?: string;
  environment?: string;
  country?: string;
}

interface Pending {
  email: string;
  environment: "PRODUCTION" | "SANDBOX";
  country?: string;
  state: string;
  expires: number;
}

export interface Registered {
  appId: string;
  name: string;
  environment: "PRODUCTION" | "SANDBOX";
  email: string;
}

const PENDING_TTL_MS = 30 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One registration at a time: the server has one owner.
let pending: Pending | undefined;

export interface Deps {
  requestSignInLink: typeof requestSignInLink;
  completeSignIn: typeof completeSignIn;
  registerApplication: typeof registerApplication;
  newKeyPair: typeof newKeyPair;
}

const live: Deps = { requestSignInLink, completeSignIn, registerApplication, newKeyPair };

/** The application name shown in the user's Control Panel. */
export function applicationName(): string {
  return config.appName.replace(/[™®]/g, "").trim() || "BankMCP";
}

/** Step one: validate and send the sign-in link. Returns an error message for the form, or null. */
export async function startRegistration(input: RegistrationInput, baseUrl: string, deps: Deps = live): Promise<{ error: string } | { email: string }> {
  const email = (input.email ?? "").trim().toLowerCase();
  const environment = input.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
  const country = (input.country ?? "").trim().toUpperCase() || undefined;
  if (!EMAIL.test(email)) return { error: "Enter the email address of your Enable Banking account, or the one you want to create it with." };
  if (country && !/^[A-Z]{2}$/.test(country)) return { error: "Country should be a two-letter code such as DK." };

  const state = randomBytes(16).toString("base64url");
  const continueUrl = `${baseUrl.replace(/\/+$/, "")}/setup/complete?state=${state}`;
  try {
    await deps.requestSignInLink(email, continueUrl);
  } catch (err) {
    if (err instanceof ControlPanelError && /INVALID_EMAIL/.test(err.body)) return { error: "Enable Banking did not accept that email address." };
    if (err instanceof ControlPanelError) return { error: `Enable Banking answered ${err.status} when asked to send the sign-in link. You can still register by hand below.` };
    return { error: `Enable Banking could not be reached (${(err as Error).message}). You can still register by hand below.` };
  }
  pending = { email, environment, country, state, expires: Date.now() + PENDING_TTL_MS };
  return { email };
}

/** Step two, reached from the link in the email. Creates the application and stores id and key. */
export async function finishRegistration(query: { state?: string; oobCode?: string }, baseUrl: string, deps: Deps = live): Promise<{ error: string } | Registered> {
  const p = pending;
  if (!p || p.expires < Date.now()) return { error: "This sign-in link belongs to a registration that has expired or was never started here. Start again from the setup page." };
  if (!query.state || query.state !== p.state) return { error: "This sign-in link does not match the registration started on this server. Start again from the setup page." };
  if (!query.oobCode) return { error: "The link is missing its sign-in code. Open the link from the email again." };

  let idToken: string;
  try {
    const signIn = await deps.completeSignIn(p.email, query.oobCode);
    idToken = signIn.idToken;
  } catch (err) {
    if (err instanceof ControlPanelError) return { error: `Enable Banking did not accept the sign-in link (${err.status}). Links work once; request a new one from the setup page.` };
    return { error: `Enable Banking could not be reached (${(err as Error).message}). Try the link again in a moment.` };
  }

  const base = baseUrl.replace(/\/+$/, "");
  const keys = deps.newKeyPair();
  const name = applicationName();
  let appId: string;
  try {
    const r = await deps.registerApplication(idToken, keys.publicKey, {
      name,
      environment: p.environment,
      redirect_urls: [`${base}/callback`],
      description: CONSENT_DESCRIPTION,
      gdpr_email: p.email,
      privacy_url: `${base}/privacy`,
      terms_url: `${base}/terms`,
    });
    appId = r.app_id;
  } catch (err) {
    if (err instanceof ControlPanelError && err.status === 401) return { error: "Enable Banking signed you in but refused to create the application. If this is a new account, accept Enable Banking's terms at enablebanking.com first, then try again." };
    if (err instanceof ControlPanelError) return { error: `Enable Banking answered ${err.status} when creating the application: ${err.body.slice(0, 160)}` };
    return { error: `Enable Banking could not be reached (${(err as Error).message}). Try the link again in a moment.` };
  } finally {
    // The Control Panel session is not kept anywhere.
    idToken = "";
  }

  saveKeyFile(keys.privateKey);
  saveSettings({
    app_id: appId,
    country: p.country,
    registered_email: p.email,
    // Local mode has no password, so registration completes the setup.
    ...(config.localMode ? { setup_completed: new Date().toISOString() } : {}),
  });
  resetKeyCache();
  pending = undefined;
  return { appId, name, environment: p.environment, email: p.email };
}

/** Application registered through this flow but password still missing (hosted mode). */
export function registeredButUnfinished(): { appId: string; email?: string } | null {
  if (!config.appId || !(config.privateKey || config.privateKeyPath)) return null;
  if (config.localMode || config.adminPasswordHash || config.adminPassword) return null;
  return { appId: config.appId, email: config.registeredEmail };
}

/** For tests. */
export function _resetPending(): void {
  pending = undefined;
}
