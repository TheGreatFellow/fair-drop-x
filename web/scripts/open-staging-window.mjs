// Opens World ID's 24h staging verification window for our app and stores the token it issues in
// ../.env as WORLD_STAGING_TOKEN, without printing it. Needs WORLD_TEAM_API_KEY (portal → team
// settings → API keys) in ../.env. Re-run before a demo: each run replaces the previous token.
//
//   node scripts/open-staging-window.mjs          open (or reopen) the window
//   node scripts/open-staging-window.mjs close    close it now
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const envPath = path.resolve(import.meta.dirname, "../../.env");
let env = readFileSync(envPath, "utf8");
const get = (k) => env.match(new RegExp(`^${k}=["']?([^"'\\n]*)`, "m"))?.[1];
const apiKey = get("WORLD_TEAM_API_KEY");
const appId = get("WORLD_APP_ID");
if (!apiKey || !appId) throw new Error("WORLD_TEAM_API_KEY and WORLD_APP_ID must be set in .env");
const enabled = process.argv[2] !== "close";

const res = await fetch("https://developer.world.org/api/mcp", {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "set_world_id_staging_verification", arguments: { app_id: appId, enabled } },
  }),
});
const raw = await res.text();
// Streamable HTTP may answer as JSON or as a single SSE `data:` event.
const msg = JSON.parse(raw.startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data:")).slice(5));
if (msg.error) throw new Error(`World MCP error ${msg.error.code}: ${msg.error.message}`);
const content = msg.result?.structuredContent ?? JSON.parse(msg.result?.content?.[0]?.text ?? "{}");
if (msg.result?.isError) throw new Error(`World MCP tool error: ${JSON.stringify(content)}`);

const token = content.staging_verification_token;
env = env.replace(/^WORLD_STAGING_TOKEN=.*\n?/m, "");
if (token) env = `${env.replace(/\n?$/, "\n")}WORLD_STAGING_TOKEN=${token}\n`;
writeFileSync(envPath, env);
console.log(enabled ? `Staging window open until ${content.staging_verification_expires_at}; token saved to .env.` : "Staging window closed.");
