// HTTP entry point for a hosted deployment: OAuth + /mcp + bank callback + status page.
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { config, setupProblems, tlsOptions } from "./config.ts";
import { createApp } from "./app.ts";
import { setupAvailable } from "./setup.ts";

const app = createApp({ remote: true });
const tls = tlsOptions();
// In local mode config.baseUrl is https://localhost:PORT, but this entry point
// only speaks TLS when a certificate is configured. Serving plain http while
// advertising https leaves the setup page and the bank redirect unreachable,
// so say what is wrong instead of starting into a broken state.
if (config.localMode && !tls) {
  console.error(
    `[bank] BANKMCP_LOCAL=1 makes the public URL ${config.baseUrl}, but no TLS certificate is configured, so this process can only serve http.\n` +
      `[bank] Run the stdio entry point instead (npx bankmcp), which terminates TLS itself, or set TLS_CERT_PATH and TLS_KEY_PATH.`,
  );
  process.exit(1);
}
const httpServer = tls ? createHttpsServer(tls, app) : createHttpServer(app);
httpServer.listen(config.port, () => {
  console.log(`[bank ${new Date().toISOString()}] listening on ${tls ? "https" : "http"}://0.0.0.0:${config.port}, public URL ${config.baseUrl}`);
  const problems = setupProblems();
  if (problems.length) console.log(`[bank] ${setupAvailable() ? `not configured yet: open ${config.baseUrl} to finish setup` : "not configured:"}`, problems);
  else app.startWatcherOnce();
});
