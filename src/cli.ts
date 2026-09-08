// Helpers for setting up and checking a deployment:
//   node src/cli.ts hash-password       → value for ADMIN_PASSWORD_HASH
//   node src/cli.ts check               → verifies config and the Enable Banking application
//   node src/cli.ts watch [--force]     → runs all watches once and prints what fired
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, setupProblems } from "./config.ts";
import { eb, EnableBankingError } from "./enablebanking.ts";
import { hashPassword } from "./auth.ts";
import { store } from "./store.ts";
import { daysLeft } from "./data.ts";
import { runWatches } from "./watcher.ts";

const [command, ...args] = process.argv.slice(2);

const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";

async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) return line;
    return "";
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === CTRL_C) process.exit(1);
        if (c === BACKSPACE || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

switch (command) {
  case "hash-password": {
    const pw = args[0] ?? (await askHidden("Password: "));
    if (pw.length < 8) {
      console.error("Use at least 8 characters.");
      process.exit(1);
    }
    console.log(hashPassword(pw));
    break;
  }
  case "check": {
    const problems = setupProblems();
    if (problems.length) {
      console.log("Configuration problems:");
      for (const p of problems) console.log(`  - ${p}`);
      process.exit(1);
    }
    console.log(`Config OK. Public URL: ${config.baseUrl}`);
    try {
      const appInfo = await eb.getApplication();
      console.log(`Enable Banking application: ${appInfo.name} (${appInfo.environment}, ${appInfo.active ? "active" : "INACTIVE"})`);
      const cb = `${config.baseUrl}/callback`;
      if (appInfo.redirect_urls.includes(cb)) console.log(`Redirect URL registered: ${cb}`);
      else console.log(`WARNING: ${cb} is not among the application's redirect URLs (${appInfo.redirect_urls.join(", ") || "none"}). Add it in the Control Panel.`);
      if (!appInfo.active) console.log("The application is inactive. For your own accounts, click 'Activate by linking accounts' in the Control Panel.");
    } catch (err) {
      console.log(`Enable Banking call failed: ${err instanceof EnableBankingError ? `${err.status} ${err.body.slice(0, 200)}` : (err as Error).message}`);
      process.exit(1);
    }
    const s = store();
    console.log(`Store: ${s.path}`);
    for (const x of s.sessions()) console.log(`  ${x.bank.name}: ${s.accounts().filter((a) => a.session_id === x.id).length} account(s), consent ${daysLeft(x.valid_until)} days left`);
    if (!s.sessions().length) console.log("  no banks connected yet");
    console.log(`Watches: ${s.watches().length}, webhook ${config.notifyWebhookUrl ? "configured" : "not set"}`);
    break;
  }
  case "watch": {
    console.log(JSON.stringify(await runWatches({ force: args.includes("--force") }), null, 2));
    break;
  }
  // The generated certificate is valid but self-signed, so a browser still
  // warns about the issuer on every visit. Trusting it is a deliberate step
  // the account holder takes for their own machine, never something the
  // server should do to a trust store on its own.
  case "trust": {
    const certPath = join(config.dataDir, "localhost-cert.pem");
    if (!existsSync(certPath)) {
      console.error(`No certificate at ${certPath} yet. Start the server once so it can generate one.`);
      process.exit(1);
    }
    if (process.platform !== "darwin") {
      console.log(`This shortcut only knows macOS. The certificate is at:\n  ${certPath}`);
      console.log("On Linux add it with `certutil -d sql:$HOME/.pki/nssdb -A -t P -n bankmcp -i <cert>`, on Windows with `certutil -addstore -user Root <cert>`.");
      process.exit(1);
    }
    const remove = args.includes("--remove");
    const argv = remove
      ? ["remove-trusted-cert", certPath]
      : ["add-trusted-cert", "-r", "trustRoot", "-k", join(homedir(), "Library/Keychains/login.keychain-db"), certPath];
    console.log(remove ? "Removing the certificate from your login keychain..." : "Adding the certificate to your login keychain. macOS will ask for your password.");
    const res = spawnSync("security", argv, { stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`security exited with ${res.status ?? res.error?.message}.`);
      process.exit(1);
    }
    console.log(remove ? "Removed. The browser will warn about the certificate again." : "Trusted. Restart the browser, then https://localhost:8080 loads without a warning.");
    console.log("Re-run this after regenerating the certificate: trust follows the certificate, not the file name.");
    break;
  }
  default:
    console.log("Usage: node src/cli.ts <hash-password [password] | check | watch [--force] | trust [--remove]>");
    process.exit(command ? 1 : 0);
}
