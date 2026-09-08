#!/usr/bin/env node
// Runs BankMCP™ locally over stdio for an MCP client. Requires Node 24 or newer.
const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  console.error(`BankMCP needs Node 24 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
// A bare `bankmcp` is the stdio server an MCP client launches. Anything with
// arguments is a command for the person at the keyboard, and those look in the
// same place the local server keeps its state.
if (process.argv.length > 2) {
  process.env.BANKMCP_LOCAL ??= "1";
  await import("../dist/lib/cli.js");
} else {
  await import("../dist/lib/stdio.js");
}
