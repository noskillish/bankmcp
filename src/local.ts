// Local mode helper: a small https server on localhost that serves the setup
// page and receives the bank redirect. Enable Banking requires https redirect
// URLs, so a self-signed certificate is created on first run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpsServer, type Server } from "node:https";
import selfsigned from "selfsigned";
import { config } from "./config.ts";
import { createApp } from "./app.ts";

let server: Server | undefined;
let starting: Promise<string> | undefined;

async function certificate(): Promise<{ cert: string; key: string }> {
  const certPath = join(config.dataDir, "localhost-cert.pem");
  const keyPath = join(config.dataDir, "localhost-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
  // Apple caps TLS server certificate lifetime at 398 days; Chrome on macOS
  // defers to the system verifier and rejects anything longer as ERR_CERT_INVALID,
  // which offers no click-through. Stay just under the limit.
  const notAfterDate = new Date();
  notAfterDate.setDate(notAfterDate.getDate() + 397);
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    notAfterDate,
    // selfsigned defaults to sha1, which browsers reject outright as
    // ERR_CERT_INVALID with no click-through. macOS additionally requires
    // basicConstraints and an extendedKeyUsage of serverAuth.
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
    ],
  });
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(certPath, pems.cert, { mode: 0o600 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

/** Starts the local https server if it is not running. Resolves to the base URL. */
export function ensureLocalServer(): Promise<string> {
  if (server) return Promise.resolve(config.baseUrl);
  starting ??= new Promise(async (resolve, reject) => {
    const app = createApp({ remote: false });
    const s = createHttpsServer(await certificate(), app);
    s.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another BankMCP process (or an earlier one) already serves this port; use it.
        server = undefined; starting = undefined; resolve(config.baseUrl);
      } else reject(err);
    });
    s.listen(config.port, "127.0.0.1", () => {
      server = s;
      console.error(`[bank] local server on ${config.baseUrl}`);
      resolve(config.baseUrl);
    });
  });
  return starting;
}
