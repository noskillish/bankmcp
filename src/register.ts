// "Register for me" on the setup page: the server asks Enable Banking to send
// the user their one-time sign-in link, and when the link comes back it creates
// the application, generates the key pair and stores id and key. The Control
// Panel session is used for that one request and then forgotten.
import { randomBytes } from "node:crypto";
import { config, saveKeyFile, saveSettings } from "./config.ts";
import { completeSignIn, ControlPanelError, newKeyPair, profileApplications, registerApplication, requestSignInLink } from "./controlpanel.ts";
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
  /** false when the Control Panel profile does not list the new application; undefined when unknown. */
  visible?: boolean;
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
  profileApplications?: typeof profileApplications;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const live: Deps = { requestSignInLink, completeSignIn, registerApplication, newKeyPair, profileApplications, sleep: wait };

/**
 * The Control Panel profile of a brand-new account appears a moment after its first sign-in.
 * Returns the application ids it lists, or null when it is still missing after `maxMs`.
 * Reading it is a courtesy: any failure here is treated as "unknown".
 */
async function profileAfter(deps: Deps, idToken: string, uid: string | undefined, maxMs: number): Promise<string[] | null> {
  if (!deps.profileApplications || !uid) return null;
  const started = Date.now();
  for (;;) {
    let apps: string[] | null;
    try {
      apps = await deps.profileApplications(idToken, uid);
    } catch {
      return null;
    }
    if (apps !== null || Date.now() - started >= maxMs) return apps;
    await (deps.sleep ?? wait)(1500);
  }
}

/** Enable Banking's own reason from an error body, when there is one. */
function reason(err: ControlPanelError): string {
  try {
    const msg = (JSON.parse(err.body) as { error?: { message?: string } }).error?.message;
    return msg ? ` (${msg.slice(0, 120)})` : "";
  } catch {
    return "";
  }
}

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
  if (!config.localMode && !/^https:\/\//.test(baseUrl)) {
    return { error: `This server does not know its public https address yet (it believes it is ${baseUrl}), and Enable Banking only accepts https redirect URLs. Set BASE_URL on the host, or on Railway generate the domain and redeploy, then try again.` };
  }
  if (country && !/^[A-Z]{2}$/.test(country)) return { error: "Country should be a two-letter code such as DK." };

  const state = randomBytes(16).toString("base64url");
  // Enable Banking's sign-in system only lets the link return to localhost. On a local server the
  // click lands here directly; on a hosted server the user pastes the link from the email instead,
  // and the return address is a harmless placeholder.
  const returnBase = config.localMode ? baseUrl.replace(/\/+$/, "") : "http://localhost:8080";
  const continueUrl = `${returnBase}/setup/complete?state=${state}`;
  try {
    await deps.requestSignInLink(email, continueUrl);
  } catch (err) {
    if (err instanceof ControlPanelError && /INVALID_EMAIL/.test(err.body)) return { error: "Enable Banking did not accept that email address." };
    if (err instanceof ControlPanelError && /TOO_MANY|QUOTA|RATE/i.test(err.body)) return { error: "Enable Banking is holding back sign-in emails to that address for the moment, after several requests. Wait a few minutes and try again, or register by hand below." };
    if (err instanceof ControlPanelError) return { error: `Enable Banking answered ${err.status} when asked to send the sign-in link${reason(err)}. Wait a moment and try again, or register by hand below.` };
    return { error: `Enable Banking could not be reached (${(err as Error).message}). You can still register by hand below.` };
  }
  pending = { email, environment, country, state, expires: Date.now() + PENDING_TTL_MS };
  return { email };
}

/** Pulls the sign-in code (and our state, if present) out of a pasted email link, however it is wrapped. */
export function parseSignInLink(link: string): { oobCode?: string; state?: string } {
  let text = link.trim();
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  const oobCode = /[?&]oobCode=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const state = /[?&]state=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  return { oobCode, state };
}

/** Step two: the emailed link, clicked (local) or pasted (hosted). Creates the application and stores id and key. */
export async function finishRegistration(query: { state?: string; oobCode?: string; link?: string }, baseUrl: string, deps: Deps = live): Promise<{ error: string } | Registered> {
  const p = pending;
  if (!p || p.expires < Date.now()) return { error: "This sign-in link belongs to a registration that has expired or was never started here. Start again from the setup page." };
  if (query.link) {
    const parsed = parseSignInLink(query.link);
    if (!parsed.oobCode) return { error: "That does not look like the sign-in link. Copy the whole link from Enable Banking's email; it contains oobCode=… somewhere in it." };
    query = { oobCode: parsed.oobCode, state: parsed.state ?? p.state };
  }
  if (!query.state || query.state !== p.state) return { error: "This sign-in link does not match the registration started on this server. Start again from the setup page." };
  if (!query.oobCode) return { error: "The link is missing its sign-in code. Open the link from the email again." };

  let idToken: string;
  let uid: string | undefined;
  try {
    const signIn = await deps.completeSignIn(p.email, query.oobCode);
    idToken = signIn.idToken;
    uid = signIn.localId;
  } catch (err) {
    if (err instanceof ControlPanelError) return { error: `Enable Banking did not accept the sign-in link (${err.status}). Links work once; request a new one from the setup page.` };
    return { error: `Enable Banking could not be reached (${(err as Error).message}). Try the link again in a moment.` };
  }

  // Registering before the profile exists leaves an application the Control Panel never lists.
  await profileAfter(deps, idToken, uid, 20_000);

  const base = baseUrl.replace(/\/+$/, "");
  const keys = deps.newKeyPair();
  const name = applicationName();
  let appId: string;
  let visible: boolean | undefined;
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
    // Confirm the Control Panel lists it; give the listing a few seconds to catch up.
    for (let i = 0; i < 6; i++) {
      const apps = await profileAfter(deps, idToken, uid, 0);
      if (apps === null) break;
      visible = apps.includes(appId);
      if (visible) break;
      await (deps.sleep ?? wait)(1500);
    }
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
    registered_visible: visible,
    // Local mode has no password, so registration completes the setup.
    ...(config.localMode ? { setup_completed: new Date().toISOString() } : {}),
  });
  resetKeyCache();
  pending = undefined;
  return { appId, name, environment: p.environment, email: p.email, visible };
}

/** Application registered through this flow but password still missing (hosted mode). */
export function registeredButUnfinished(): { appId: string; email?: string } | null {
  if (!config.appId || !(config.privateKey || config.privateKeyPath)) return null;
  if (config.localMode || config.adminPasswordHash || config.adminPassword) return null;
  return { appId: config.appId, email: config.registeredEmail };
}

/** The email a registration is waiting on, if any. */
export function pendingEmail(): string | undefined {
  return pending && pending.expires > Date.now() ? pending.email : undefined;
}

/** For tests. */
export function _resetPending(): void {
  pending = undefined;
}
