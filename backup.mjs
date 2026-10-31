// Owner backup: downloads every order record through the admin endpoint and saves it to ../../private/ (git-ignored).
// Usage:  ADMIN_TOKEN=... API_URL=https://zyvtron-api.<you>.workers.dev node scripts/backup.mjs
// The file contains customer emails: keep it private, encrypted if possible, and delete it when no longer needed.
import { mkdirSync, writeFileSync } from "node:fs";
const { ADMIN_TOKEN, API_URL } = process.env;
if (!ADMIN_TOKEN || !API_URL) { console.error("Set ADMIN_TOKEN and API_URL"); process.exit(1); }
const r = await fetch(API_URL.replace(/\/+$/, "") + "/api/admin", { method: "POST", headers: { authorization: "Bearer " + ADMIN_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ action: "export" }) });
if (!r.ok) { console.error("Export failed:", r.status); process.exit(1); }
const data = await r.json(); const dir = new URL("../../private/", import.meta.url); mkdirSync(dir, { recursive: true });
const file = new URL(`orders-backup-${new Date().toISOString().slice(0, 10)}.json`, dir); writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log(`Saved ${data.orders.length} orders to ${file.pathname}`);
