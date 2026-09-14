// The Enable Banking Control Panel has a small API that their own command-line
// tool uses (github.com/enablebanking/enablebanking-cli): a one-time sign-in
// link by email, and application registration. The setup page uses it to
// register the application for the user instead of walking them through the
// form. It is not part of Enable Banking's documented API, so every call here
// fails soft: the manual path on the setup page always remains.
import { generateKeyPairSync } from "node:crypto";

const CP = process.env.EB_CP_BASE ?? "https://enablebanking.com";

export class ControlPanelError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Enable Banking Control Panel ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export interface SignIn {
  idToken: string;
  refreshToken?: string;
  localId?: string;
  email?: string;
  isNewUser?: boolean;
}

// The Control Panel lists applications from a per-user profile document, created a moment
// after a brand-new account first signs in. The Control Panel web app reads it the same way.
const PROFILES = process.env.EB_PROFILE_BASE ?? "https://firestore.googleapis.com/v1/projects/enablebanking/databases/(default)/documents/users";

interface ProfileDoc {
  fields?: { applications?: { arrayValue?: { values?: { stringValue?: string; mapValue?: { fields?: { kid?: { stringValue?: string } } } }[] } } };
}

/** Application ids the Control Panel lists for this user, or null while the profile does not exist yet. */
export async function profileApplications(idToken: string, uid: string, doFetch: Fetch = fetch): Promise<string[] | null> {
  const res = await doFetch(`${PROFILES}/${encodeURIComponent(uid)}`, { headers: { authorization: `Bearer ${idToken}`, accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new ControlPanelError(res.status, await res.text());
  const doc = (await res.json()) as ProfileDoc;
  const values = doc.fields?.applications?.arrayValue?.values ?? [];
  return values.map((v) => v.stringValue ?? v.mapValue?.fields?.kid?.stringValue ?? "").filter(Boolean);
}

export interface Registration {
  name: string;
  environment: "PRODUCTION" | "SANDBOX";
  redirect_urls: string[];
  description?: string;
  gdpr_email?: string;
  privacy_url?: string;
  terms_url?: string;
}

type Fetch = typeof fetch;

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}, doFetch: Fetch = fetch): Promise<T> {
  const res = await doFetch(new URL(path, CP), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new ControlPanelError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Sends the one-time sign-in link. The link ends at `continueUrl` with an `oobCode` query parameter. */
export function requestSignInLink(email: string, continueUrl: string, doFetch: Fetch = fetch): Promise<unknown> {
  return post("/api/relyingparty/getOobConfirmationCode", { requestType: "EMAIL_SIGNIN", email, continueUrl, canHandleCodeInApp: true }, {}, doFetch);
}

/** Exchanges the clicked link for a Control Panel session. */
export function completeSignIn(email: string, oobCode: string, doFetch: Fetch = fetch): Promise<SignIn> {
  return post<SignIn>("/api/relyingparty/emailLinkSignin", { oobCode, email }, {}, doFetch);
}

/** Creates an application under the signed-in account. `certificate` is the public key, PEM. */
export function registerApplication(idToken: string, certificate: string, reg: Registration, doFetch: Fetch = fetch): Promise<{ app_id: string }> {
  const body: Record<string, unknown> = { certificate, ...reg };
  for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === "") delete body[k];
  return post<{ app_id: string }>("/api/applications", body, { authorization: `Bearer ${idToken}` }, doFetch);
}

/** A fresh RSA key pair for the application. The private key never leaves the server. */
export function newKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKey: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}
