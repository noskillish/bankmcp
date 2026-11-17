// Diagnostic lines for the OAuth handshake. Fields are hosts, short id
// prefixes, booleans, and OAuth error codes. Never a password, authorization
// code, token, verifier, or client secret.
import { AsyncLocalStorage } from "node:async_hooks";

export interface TokenDiag {
  code: "n/a" | "found" | "expired" | "used" | "missing";
  pkce: "n/a" | "pending" | "ok" | "fail";
  redirect_match: true | false | "absent" | "n/a";
  resource_match: true | false | null;
  error?: string;
}

export interface RegisterDiag {
  logged: boolean;
}

export const tokenDiag = new AsyncLocalStorage<TokenDiag>();
export const registerDiag = new AsyncLocalStorage<RegisterDiag>();

export function oauthLog(event: string, fields: Record<string, unknown>): void {
  console.log(`[bank ${new Date().toISOString()}] oauth ${event} ${JSON.stringify(fields)}`);
}

export function idPrefix(id: string | undefined): string {
  if (!id) return "none";
  const clean = id.replace(/[^A-Za-z0-9]/g, "");
  return clean.slice(0, 8) || "none";
}

export function redirectHost(uri: string | undefined): string {
  if (!uri) return "none";
  try {
    return new URL(uri).hostname.toLowerCase() || "none";
  } catch {
    return "invalid";
  }
}

export function clipName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "none";
  return value.replace(/[\r\n]/g, " ").slice(0, 80);
}

/** Resource indicator with userinfo and fragment removed. */
export function resourceForLog(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return (url.origin + url.pathname).slice(0, 200);
  } catch {
    return "invalid";
  }
}

export function grantForLog(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,40}$/i.test(value) ? value : "invalid";
}

/** Keep a fixed OAuth error phrase; drop anything that could carry a credential. */
export function safeReason(text: string | undefined): string {
  if (!text) return "rejected";
  const stripped = text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (match) => {
      try {
        return new URL(match).host || "[url]";
      } catch {
        return "[url]";
      }
    })
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 160)
    .trim();
  return stripped || "rejected";
}

export function hostsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => (typeof item === "string" ? redirectHost(item) : "invalid"));
}
