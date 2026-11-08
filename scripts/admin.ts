#!/usr/bin/env node
// Farmstand operator tool. Runs SQL through `wrangler d1 execute`, so it needs no secrets of its own.
//
//   npm run admin -- list
//   npm run admin -- seller add "Hillside Farm"
//   npm run admin -- stand add --seller 1 --slug hillside --name "Hillside Farm" --mode unattended
//   npm run admin -- link add --seller 1 --label "Mary's phone"
//   npm run admin -- link revoke 3
//   npm run admin -- stand off hillside      (stand on hillside)
//
// Add --remote to work on the deployed database instead of the local one.
// Set FARMSTAND_URL (for example https://farmstand.example.org) to print full links.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--remote") continue;
  if (a.startsWith("--")) flags[a.slice(2)] = args[++i] ?? "";
  else positional.push(a);
}

const RESERVED = new Set(["admin", "o"]);
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const int = (s: string | undefined, what: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) fail(`${what} must be a whole number.`);
  return n;
};

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function sql(command: string): Record<string, unknown>[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "farmstand", remote ? "--remote" : "--local", "--json", "--command", command],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(out) as { results?: Record<string, unknown>[] }[];
  return parsed.flatMap((r) => r.results ?? []);
}

function baseUrl(): string {
  return process.env.FARMSTAND_URL ?? (remote ? "" : "http://localhost:8787");
}

const now = Date.now();
const [what, verb, arg] = positional;

switch (`${what} ${verb ?? ""}`.trim()) {
  case "list": {
    console.table(sql("SELECT id, name, active FROM sellers ORDER BY id"));
    console.table(sql("SELECT id, seller_id, slug, name, mode, active, paused FROM stands ORDER BY id"));
    console.table(sql("SELECT id, seller_id, label, revoked_at IS NOT NULL AS revoked FROM seller_links ORDER BY id"));
    break;
  }
  case "seller add": {
    if (!arg) fail('Give the seller a name: seller add "Hillside Farm"');
    const [row] = sql(`INSERT INTO sellers (name, created_at) VALUES (${q(arg)}, ${now}) RETURNING id`);
    console.log(`Seller ${row?.id} added: ${arg}`);
    break;
  }
  case "stand add": {
    const seller = int(flags.seller, "--seller");
    const slug = flags.slug ?? "";
    const name = flags.name ?? "";
    const mode = flags.mode ?? "unattended";
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) || RESERVED.has(slug)) {
      fail("--slug must be lowercase letters, digits and dashes (for example hillside), and not 'admin' or 'o'.");
    }
    if (!name) fail("--name is required.");
    if (mode !== "staffed" && mode !== "unattended") fail("--mode must be staffed or unattended.");
    const [row] = sql(
      `INSERT INTO stands (seller_id, slug, name, mode, created_at) VALUES (${seller}, ${q(slug)}, ${q(name)}, ${q(mode)}, ${now}) RETURNING id`,
    );
    console.log(`Stand ${row?.id} added. Customers use ${baseUrl() || ""}/${slug}`);
    break;
  }
  case "link add": {
    const seller = int(flags.seller, "--seller");
    const token = randomBytes(24).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    sql(
      `INSERT INTO seller_links (seller_id, token_hash, label, created_at) VALUES (${seller}, ${q(hash)}, ${q(flags.label ?? "")}, ${now})`,
    );
    const base = baseUrl();
    console.log("Seller link (shown once; send it privately):");
    console.log(base ? `${base}/admin/${token}` : `/admin/${token}   (set FARMSTAND_URL to print the full link)`);
    break;
  }
  case "link revoke": {
    const id = int(arg, "Link id");
    sql(`UPDATE seller_links SET revoked_at = ${now} WHERE id = ${id}`);
    console.log(`Link ${id} revoked.`);
    break;
  }
  case "stand off":
  case "stand on": {
    if (!arg) fail("Give the stand's slug.");
    sql(`UPDATE stands SET active = ${verb === "on" ? 1 : 0} WHERE slug = ${q(arg)}`);
    console.log(`Stand ${arg} switched ${verb}.`);
    break;
  }
  default:
    console.log("Commands: list | seller add NAME | stand add --seller ID --slug SLUG --name NAME [--mode staffed|unattended]");
    console.log("          link add --seller ID [--label TEXT] | link revoke ID | stand off SLUG | stand on SLUG   [--remote]");
    process.exit(what ? 1 : 0);
}
