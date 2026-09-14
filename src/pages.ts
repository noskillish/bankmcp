// The few HTML pages this server shows a human: the OAuth sign-in, the
// result of a bank connection, and a status page. No external assets.
import { config } from "./config.ts";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Kind = "ok" | "error" | "neutral";

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
};

export function shell(title: string, body: string, opts: { kind?: Kind; pill?: string; head?: string } = {}): string {
  const name = config.appName;
  const tab = title === name ? name : `${title} · ${name}`;
  const pill = opts.pill ? `<div class="pill ${opts.kind ?? "neutral"}">${esc(opts.pill)}</div>` : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(tab)}</title>${opts.head ?? ""}
<style>
  :root{--bg:#f4f3ef;--card:#fff;--ink:#141414;--muted:#6f6e69;--line:#e6e4dd;--ok:#1f7a4d;--err:#b3261e}
  @media (prefers-color-scheme:dark){:root{--bg:#111110;--card:#1b1b1a;--ink:#f2f1ec;--muted:#9b9a94;--line:#2c2b29;--ok:#5cc08a;--err:#ff8a7a}}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  .wrap{max-width:460px;margin:0 auto;padding:12vh 20px 48px}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 22px;font-weight:800;font-size:20px;letter-spacing:-.02em}
  .brand .mark{width:28px;height:28px;border-radius:8px;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-size:15px;font-weight:900}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 28px 26px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 12px}
  .pill::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--muted)}
  .pill.ok{color:var(--ok)}.pill.ok::before{background:var(--ok)}
  .pill.error{color:var(--err)}.pill.error::before{background:var(--err)}
  h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 12px}
  p{margin:0 0 12px}.muted{color:var(--muted)}.error{color:var(--err)}
  ul.rows{list-style:none;padding:0;margin:18px 0 6px}
  ul.rows li{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--line)}
  ul.rows li:last-child{border-bottom:1px solid var(--line)}
  ul.rows .r{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  label{display:block;font-weight:600;font-size:14px;margin:18px 0 6px}
  input,textarea{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
  textarea{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:8px;resize:vertical}
  input[type=file]{padding:9px 12px;font-size:14px}
  input:focus,textarea:focus{outline:2px solid var(--ink);outline-offset:1px;border-color:transparent}
  button{width:100%;margin-top:14px;font:inherit;font-weight:700;padding:13px 16px;border:0;border-radius:10px;background:var(--ink);color:var(--bg);cursor:pointer}
  button:hover{opacity:.92}
  code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);padding:6px 10px;border-radius:8px;display:inline-block;word-break:break-all}
  .copy{margin:14px 0 0}.copy p{margin:0 0 4px}
  .copyrow{display:flex;gap:8px;align-items:flex-start}.copyrow code{flex:1}
  .copybtn{width:auto;margin:0;padding:6px 10px;font-size:13px;font-weight:600;border-radius:8px;background:transparent;color:var(--ink);border:1px solid var(--line);white-space:nowrap}
  .copybtn:hover{background:var(--bg);opacity:1}
  h2{font-size:17px;letter-spacing:-.01em;margin:0 0 6px}
  .stepblock{padding:18px 0 4px;border-top:1px solid var(--line);margin-top:14px}
  .stepblock:first-of-type{border-top:0;margin-top:4px}
  .stepno{font-size:12px;font-weight:700;color:var(--muted);border:1px solid var(--line);border-radius:999px;width:24px;height:24px;display:inline-grid;place-items:center;margin:0 0 8px}
  .hint{font-size:13px;color:var(--muted);margin:6px 0 0;min-height:1em}.hint.ok{color:var(--ok)}.hint.err{color:var(--err)}.hint.center{text-align:center;margin-top:10px}
  .small{font-size:13px}.banner{padding:10px 12px;border:1px solid var(--err);border-radius:10px;background:color-mix(in srgb,var(--err) 8%,transparent)}
  code.inline{padding:1px 6px;display:inline;word-break:normal;white-space:nowrap}
  .pwrow{display:flex;gap:8px}.pwrow input{flex:1}
  button.ghost{width:auto;margin:0;padding:0 14px;font-size:13px;font-weight:600;background:transparent;color:var(--ink);border:1px solid var(--line)}
  button[disabled]{opacity:.45;cursor:default}button[disabled]:hover{opacity:.45}
  .copybtn.done{color:var(--ok);border-color:var(--ok)}
  ul.rows.checks{margin-top:8px}.r.ok{color:var(--ok)}.r.err{color:var(--err)}
  footer{margin-top:20px;font-size:12px;color:var(--muted)}
  footer a{color:inherit}
</style>
<body><div class="wrap">
  <div class="brand"><span class="mark">${esc(name.replace(/[™®]/g, "").trim().charAt(0).toUpperCase() || "B")}</span><span>${esc(name)}</span></div>
  <div class="card">${pill}<h1>${esc(title)}</h1>${body}</div>
  <footer>${esc(name)} · read-only · self-hosted · <a href="/privacy">privacy</a> · <a href="/terms">terms</a></footer>
</div></body></html>`;
}

export function loginPage(opts: { requestId: string; clientName?: string; returnTo?: string; error?: string }): string {
  const who = opts.clientName ? `<b>${esc(opts.clientName)}</b>` : "An app";
  const back = opts.returnTo ? `<p class="muted">After signing in you are sent back to <b>${esc(opts.returnTo)}</b>. Stop if that is not where you came from.</p>` : "";
  return shell(
    "Allow access?",
    `<p>${who} wants read-only access to your bank accounts through this server. It reads balances and transactions. It has no payment tools.</p>${back}
     ${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ""}
     <form method="post" action="/login">
       <input type="hidden" name="request" value="${esc(opts.requestId)}">
       <label for="pw">Password</label>
       <input id="pw" type="password" name="password" autofocus autocomplete="current-password" required>
       <button type="submit">Allow access</button>
     </form>
     <p class="muted small" style="margin-top:14px">Forgot the password? Set <code class="inline">ADMIN_PASSWORD</code> on your host and restart the server; <a href="https://bankmcp.dk/questions/#password" target="_blank" rel="noopener">how</a>.</p>`,
    { kind: "neutral", pill: "Sign-in request" },
  );
}

export function connectedPage(session: { aspsp: { name: string }; access: { valid_until: string }; accounts: Array<{ uid: string; name?: string; product?: string; currency: string }> }): string {
  const n = session.accounts.length;
  return shell(
    `${session.aspsp.name} is linked`,
    `<p>${n} account${n === 1 ? "" : "s"} shared, read-only.</p>
     <ul class="rows">${session.accounts.map((a) => `<li><span>${esc([a.name, a.product].filter(Boolean).join(" · ") || a.uid)}</span><span class="r">${esc(a.currency)}</span></li>`).join("")}</ul>
     <p class="muted">Consent valid until ${esc(fmtDate(session.access.valid_until))}. You can close this tab and go back to your assistant.</p>`,
    { kind: "ok", pill: "Connected" },
  );
}

export function failedPage(message: string): string {
  return shell("Bank not connected", `<p class="error">${esc(message)}</p><p class="muted">Go back to your assistant and start again.</p>`, { kind: "error", pill: "Not connected" });
}

export function returningPage(url: string): string {
  const host = new URL(url).host;
  return shell(
    "Signed in",
    `<p>Taking you back to <b>${esc(host)}</b>.</p>
     <p class="muted">If nothing happens, <a href="${esc(url)}">continue to ${esc(host)}</a>.</p>`,
    { kind: "ok", pill: "Signed in", head: `<meta http-equiv="refresh" content="0;url=${esc(url)}">` },
  );
}

export function signedInPage(): string {
  return shell(
    "Signed in",
    `<p>This sign-in already went through. Your assistant has access. You can close this tab.</p>
     <p class="muted">If your assistant still shows the connector as not connected, click Connect there once more and sign in again.</p>`,
    { kind: "ok", pill: "Signed in" },
  );
}

export function signInFailedPage(message: string): string {
  return shell("Sign-in failed", `<p class="error">${esc(message)}</p>`, { kind: "error", pill: "Not signed in" });
}

export function statusPage(input: { problems: string[]; mcpUrl: string; callbackUrl: string }): string {
  if (input.problems.length) {
    return shell(
      "Not configured yet",
      `<ul class="rows">${input.problems.map((p) => `<li><span>${esc(p)}</span></li>`).join("")}</ul><p class="muted">Set the environment variables and restart. The README has the list.</p>`,
      { kind: "error", pill: "Setup incomplete" },
    );
  }
  const row = (label: string, value: string) =>
    `<div class="copy"><p class="muted">${esc(label)}</p><div class="copyrow"><code>${esc(value)}</code><button type="button" class="copybtn" data-copy="${esc(value)}">Copy</button></div></div>`;
  const script = `<script>
       for (const b of document.querySelectorAll(".copybtn")) b.addEventListener("click", async () => {
         try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied ✓"; b.classList.add("done"); setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1600); }
         catch { b.textContent = "Select and copy"; }
       });
     </script>`;
  // Deliberately says nothing about which banks or accounts are connected:
  // this page is reachable without a password. Ask consent_status through the connector.
  if (config.localMode) {
    return shell(
      config.appName,
      `<p>Running on this machine. Your MCP client is connected to it over stdio.</p>
       ${row("Redirect URL for the application at Enable Banking", input.callbackUrl)}
       <p class="muted" style="margin-top:14px">To link a bank, ask your assistant to connect it. The browser opens for the bank login and returns here.</p>${script}`,
      { kind: "ok", pill: "Running locally" },
    );
  }
  return shell(
    config.appName,
    `<p>Running. Two addresses you may need again:</p>
     ${row("Connector address for your assistant (sign in with your password)", input.mcpUrl)}
     ${row("Redirect URL that must be among your Enable Banking application's redirect URLs", input.callbackUrl)}
     <p class="muted small" style="margin-top:14px">If a bank login fails, check the redirect URL first. Forgot the password? Set <code class="inline">ADMIN_PASSWORD</code> on your host and restart; <a href="https://bankmcp.dk/questions/#password" target="_blank" rel="noopener">how</a>.</p>${script}`,
    { kind: "ok", pill: "Running" },
  );
}

export const CONSENT_DESCRIPTION = `${config.appName} lets you ask your AI assistant about your own accounts. It reads balances and transactions. It has no payment tools, and only the holder of the password can use it. You can revoke access at your bank at any time.`;

export function setupPage(opts: { error?: string; values?: { app_id?: string; country?: string }; baseUrl?: string } = {}): string {
  const v = opts.values ?? {};
  const base = (opts.baseUrl ?? config.baseUrl).replace(/\/+$/, "");
  const row = (label: string, value: string) =>
    `<div class="copy"><p class="muted">${esc(label)}</p><div class="copyrow"><code>${esc(value)}</code><button type="button" class="copybtn" data-copy="${esc(value)}">Copy</button></div></div>`;
  const password = config.localMode
    ? ""
    : `<div class="stepblock">
       <div class="stepno">3</div>
       <h2>Choose a password</h2>
       <p class="muted">Your assistant signs in with it once. It is the only thing between the internet and your accounts, so make it long.</p>
       <label for="password">Password, 12 characters or more</label>
       <div class="pwrow"><input id="password" type="password" name="password" required minlength="12" autocomplete="new-password"><button type="button" class="ghost" id="showpw">Show</button></div>
       <p class="hint" id="pwhint"></p>
       <label for="password2">Repeat password</label>
       <input id="password2" type="password" name="password2" required minlength="12" autocomplete="new-password">
       <p class="hint" id="pw2hint"></p>
     </div>`;
  return shell(
    `Set up ${config.appName}`,
    `<p>Three steps, about ten minutes. Everything you enter stays on this server.</p>
     ${opts.error ? `<p class="error banner">${esc(opts.error)}</p>` : ""}
     <form method="post" action="/setup" id="setup" novalidate>
     <div class="stepblock">
       <div class="stepno">1</div>
       <h2>Register at Enable Banking</h2>
       <p class="muted">Create an application at <a href="https://enablebanking.com/cp/applications" target="_blank" rel="noopener">enablebanking.com</a>. Free for your own accounts. Its form asks for these values:</p>
       ${row("Allowed redirect URL", `${base}/callback`)}
       ${row("Application description", CONSENT_DESCRIPTION)}
       ${row("Privacy URL", `${base}/privacy`)}
       ${row("Terms URL", `${base}/terms`)}
       <p class="muted" style="margin-top:14px">Environment: <b>Production</b> for your real accounts, <b>Sandbox</b> to try with test data. Keep <b>generate private key</b> selected. When you save, a <code class="inline">.pem</code> file downloads once and the application id appears.</p>
     </div>
     <div class="stepblock">
       <div class="stepno">2</div>
       <h2>Enter what Enable Banking gave you</h2>
       <label for="app_id">Application id</label>
       <input id="app_id" name="app_id" required autocomplete="off" spellcheck="false" placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" value="${esc(v.app_id ?? "")}">
       <p class="hint" id="idhint"></p>
       <label for="pemfile">Private key file</label>
       <input id="pemfile" type="file" accept=".pem,.key,.txt,application/x-pem-file">
       <p class="hint" id="pemhint">The <code class="inline">.pem</code> file that downloaded when you saved the application. It is read here in your browser and stored on this server only.</p>
       <p class="muted small"><a href="#" id="pastelink">Paste the key instead</a></p>
       <textarea id="pem" name="pem" rows="4" placeholder="-----BEGIN PRIVATE KEY-----" spellcheck="false" hidden></textarea>
       <label for="country">Country of your banks</label>
       <input id="country" name="country" maxlength="2" placeholder="DK" value="${esc(v.country ?? "")}" style="width:6em;text-transform:uppercase">
       <p class="hint">Two letters. Used as the default when you ask for a bank.</p>
     </div>
     ${password}
     <button type="submit" id="submit">Check with Enable Banking and finish</button>
     <p class="hint center" id="submithint">The id and key are checked against Enable Banking before anything is saved.</p>
     </form>
     <script>
       const $ = (id) => document.getElementById(id);
       const hint = (el, text, state) => { el.textContent = text; el.className = "hint" + (state ? " " + state : ""); };
       for (const b of document.querySelectorAll(".copybtn")) b.addEventListener("click", async () => {
         try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied ✓"; b.classList.add("done"); setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1600); }
         catch { b.textContent = "Select and copy"; }
       });
       const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
       const state = { id: false, pem: false, pw: ${config.localMode ? "true" : "false"} };
       const update = () => { $("submit").disabled = !(state.id && state.pem && state.pw); };
       $("app_id").addEventListener("input", (e) => {
         const val = e.target.value.trim(); state.id = uuid.test(val);
         hint($("idhint"), !val ? "" : state.id ? "Looks like an application id ✓" : "An application id is a UUID: 8-4-4-4-12 characters, shown on the application after you save it.", !val ? "" : state.id ? "ok" : "err");
         update();
       });
       const checkPem = (text, source) => {
         state.pem = /PRIVATE KEY/.test(text);
         hint($("pemhint"), state.pem ? source + " read: a private key ✓" : source + " does not contain a private key. Choose the .pem that downloaded from Enable Banking.", state.pem ? "ok" : "err");
         update();
       };
       $("pemfile").addEventListener("change", (e) => {
         const f = e.target.files[0]; if (!f) return;
         const r = new FileReader(); r.onload = () => { $("pem").value = r.result; checkPem(String(r.result), f.name); }; r.readAsText(f);
       });
       $("pastelink").addEventListener("click", (e) => { e.preventDefault(); $("pem").hidden = false; $("pem").focus(); e.target.parentElement.hidden = true; });
       $("pem").addEventListener("input", (e) => checkPem(e.target.value, "Pasted key"));
       if (!${config.localMode}) {
         const pw = $("password"), pw2 = $("password2");
         const checkPw = () => {
           const n = pw.value.length;
           hint($("pwhint"), n === 0 ? "" : n < 12 ? (12 - n) + " more character" + (12 - n === 1 ? "" : "s") : n < 16 ? "Long enough ✓" : "Good ✓", n === 0 ? "" : n < 12 ? "err" : "ok");
           const same = pw2.value.length > 0 && pw.value === pw2.value;
           hint($("pw2hint"), pw2.value.length === 0 ? "" : same ? "Matches ✓" : "Does not match yet", pw2.value.length === 0 ? "" : same ? "ok" : "err");
           state.pw = n >= 12 && same; update();
         };
         pw.addEventListener("input", checkPw); pw2.addEventListener("input", checkPw);
         $("showpw").addEventListener("click", () => { const t = pw.type === "password" ? "text" : "password"; pw.type = t; pw2.type = t; $("showpw").textContent = t === "text" ? "Hide" : "Show"; });
       }
       $("setup").addEventListener("submit", () => {
         $("submit").disabled = true; $("submit").textContent = "Checking with Enable Banking…";
         hint($("submithint"), "Signing a request with your key and asking Enable Banking about the application. A few seconds.", "");
       });
       if ($("app_id").value) $("app_id").dispatchEvent(new Event("input"));
       update();
     </script>`,
    { kind: "neutral", pill: "First run" },
  );
}

export function welcomePage(input: { application?: { name: string; environment: string; active: boolean; redirect_urls: string[] }; mcpUrl: string; callbackUrl: string }): string {
  const a = input.application;
  const row = (label: string, value: string) =>
    `<div class="copy"><p class="muted">${esc(label)}</p><div class="copyrow"><code>${esc(value)}</code><button type="button" class="copybtn" data-copy="${esc(value)}">Copy</button></div></div>`;
  const registered = a ? a.redirect_urls.includes(input.callbackUrl) : undefined;
  const checks = a
    ? `<ul class="rows checks">
         <li><span>Application</span><span class="r">${esc(a.name)} · ${a.environment === "SANDBOX" ? "sandbox" : "production"}</span></li>
         <li><span>Key and id</span><span class="r ok">accepted ✓</span></li>
         <li><span>Redirect URL registered</span><span class="r ${registered ? "ok" : "err"}">${registered ? "yes ✓" : "not yet"}</span></li>
         <li><span>Application status</span><span class="r ${a.active ? "ok" : "err"}">${a.active ? "active ✓" : "inactive"}</span></li>
       </ul>
       ${registered ? "" : `<p class="error small">Add this redirect URL to the application in the Control Panel, or bank logins will fail:</p>${row("Allowed redirect URL", input.callbackUrl)}`}
       ${a.active ? "" : `<p class="muted small" style="margin-top:12px">${a.environment === "SANDBOX" ? "Sandbox applications activate on their own." : "A production application for your own accounts is activated with <b>Activate by linking accounts</b> on the application page in the Control Panel. Do that before connecting a bank."}</p>`}`
    : `<p class="muted">Saved. Enable Banking could not be asked about the application right now; the status page will tell you if something is off.</p>`;
  return shell(
    "Ready",
    `<p>Your key, application id and password are stored on this server.</p>
     ${checks}
     <h2 style="margin-top:22px">Next</h2>
     <div class="stepblock">
       <div class="stepno">1</div>
       <p><b>Add the connector to your assistant.</b> In claude.ai: Settings → Connectors → Add custom connector, paste this address, keep the detected options, then Connect and sign in with your password. Other MCP clients take the same address as a remote server.</p>
       ${row("Connector address", input.mcpUrl)}
     </div>
     <div class="stepblock">
       <div class="stepno">2</div>
       <p><b>Connect your bank.</b> In a chat, say <code class="inline">connect my bank</code>. You get a link, log in at your bank, and the accounts appear.</p>
     </div>
     <p class="muted small" style="margin-top:18px">This page is at <a href="/">${esc(input.mcpUrl.replace(/\/mcp$/, "/"))}</a> whenever you need the addresses again.</p>
     <script>
       for (const b of document.querySelectorAll(".copybtn")) b.addEventListener("click", async () => {
         try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied ✓"; b.classList.add("done"); setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1600); }
         catch { b.textContent = "Select and copy"; }
       });
     </script>`,
    { kind: "ok", pill: "Set up" },
  );
}

export const privacyPage = () =>
  shell(
    "Privacy",
    `<p>This server is operated by the person who deployed it, to access their own bank accounts. It is not offered as a service to anyone else.</p>
     <p>Account identifiers and consent references from Enable Banking are stored on the server so the operator's assistant can fetch balances and transactions on request. Transactions and balances themselves are not stored. No data is shared with third parties and nothing is collected about visitors.</p>
     <p>The software is open source. Its authors do not operate this server, receive no data from it, and are not affiliated with Enable Banking, Anthropic or any bank.</p>`,
  );

export const termsPage = () =>
  shell(
    "Terms",
    `<p>Personal software run by the person who deployed it, for their own non-commercial use, under Enable Banking's terms for individual use of their production environment. The operator is solely responsible for this instance.</p>
     <p>Use at your own risk. The software is provided as is, without warranty of any kind, under the MIT licence. Its authors accept no liability for its use and are not a party to the operator's agreements with Enable Banking or any bank.</p>`,
  );
