---
name: deploy
description: Deploy BankMCP™ to a small server so it works in claude.ai and on the phone: Railway or Fly.io, volume, domain, setup page, connector. Use when the user says "deploy bankmcp", "host it", "/deploy", "use it on my phone", or "add it to claude.ai".
---

# Deploy BankMCP™ to a server

Guide one person through a hosted deployment. Prefer Railway unless the user names another host. Run what you can with the CLI; the user does the dashboard clicks, their bank login and their claude.ai settings.

## 1. Choose the host

Ask which they have: Railway, Fly.io, Render, or their own box with Docker. If none, recommend Railway (https://railway.com) and wait until they have an account.

## 2. Railway

If the `railway` CLI is installed and logged in (`railway whoami`), do it from the terminal:

```
railway init
railway add --service bankmcp --repo noskillish/bankmcp --branch main
railway volume add -m /data
railway domain --port 8080
```

Otherwise, in the Railway dashboard: New Project, Deploy from GitHub repo `noskillish/bankmcp`; add a Volume mounted at `/data`; Settings, Networking, Generate Domain on port 8080.

Report the public address. No variables are needed; the server detects its own address on Railway.

## 3. Fly.io or Docker

Fly: from a clone of the repo, `fly launch --copy-config --no-deploy` (the repo's `fly.toml` already mounts `/data` and checks `/healthz`), `fly volumes create data --size 1`, `fly deploy`. Render: the Deploy to Render button in the README uses `render.yaml`; a persistent disk needs a paid instance. Docker: `docker run -d --name bankmcp --restart unless-stopped -p 8080:8080 -v bankmcp-data:/data ghcr.io/noskillish/bankmcp:latest` (or `docker compose up -d` from a clone), then a TLS proxy in front and `BASE_URL` set to the public https address.

## 4. Setup page

Tell the user to open the public address. It shows a setup page with the values for Enable Banking's form. Walk them through registering the application as in the `setup` skill (environment, redirect URL, description, privacy and terms URLs, key download), then entering the application id, the `.pem` file and a password of twelve characters or more. The status page then shows the connector URL.

## 5. Connector

claude.ai (personal Pro or Max account): Settings, Connectors, Add custom connector, name `BankMCP™`, URL `https://<address>/mcp`, leave OAuth fields empty, Add, Connect, enter the password.

Team or Enterprise workspaces only allow Owners to add custom connectors; say so if the button is missing.

Claude Code: `claude mcp add --transport http bankmcp https://<address>/mcp`, then `/mcp` to sign in.

## 6. Bank

In the connected client: "connect my bank". Same flow as locally; the redirect returns to the server's `/callback`.

## Notes

- Changing the password later logs every client out; that is the kill switch.
- Set `NOTIFY_WEBHOOK_URL` to a Slack incoming webhook for sign-in alerts and watch notifications.
