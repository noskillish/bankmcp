import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.ts";
import { registerPrompts } from "./prompts.ts";

export const VERSION = "0.1.5";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "bank", version: VERSION },
    {
      instructions: [
        "Read-only access to the owner's own bank accounts via Enable Banking (PSD2). It has no payment tools.",
        "Accounts can be referred to by uid or by their label. Call list_accounts first when unsure.",
        "Transaction amounts are signed: negative is money out. Use the `booked` balance for totals and net worth; `available` may include credit lines.",
        "Banks return a limited history (often 90 days, some up to 2 years). If a date range comes back empty, say so rather than assuming there were no transactions.",
        "If a tool says a consent is no longer valid, use start_consent for that bank; nothing else is lost.",
      ].join(" "),
    },
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}
