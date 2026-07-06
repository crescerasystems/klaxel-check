/**
 * CLI orchestration: parse args, run lookups, print results + upsell.
 * Kept separate from bin/cli.js so it's unit-testable.
 */

import { lookupExpiry, daysUntil } from "./rdap.js";
import { color, rowFor, renderTable } from "./format.js";

const PRODUCT_URL = "https://klaxel.com";

const HELP = `klaxel-check — free domain expiry checker (RDAP, the modern WHOIS)

USAGE
  klaxel-check <domain> [more-domains...]
  npx klaxel-check google.com cloudflare.net

OPTIONS
  --json        Machine-readable JSON output (one object per domain)
  -h, --help    Show this help

EXAMPLES
  klaxel-check google.com
  klaxel-check google.com stripe.com example.org
  klaxel-check --json mydomain.com

Reads each domain's real expiry from its registry via RDAP — no scraping,
no rate-limited WHOIS. Unsupported TLDs (.io, .co, .so and some ccTLDs don't
publish RDAP) are reported honestly rather than guessed.

Watch domains automatically (daily checks + email before any lapse):
  ${PRODUCT_URL}`;

/**
 * Parse argv (without node + script). Returns { domains, json, help, error }.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const domains = [];
  let json = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else if (arg.startsWith("-")) return { domains, json, help, error: `unknown option: ${arg}` };
    else domains.push(arg);
  }
  return { domains, json, help };
}

/** One- or two-line tasteful upsell. */
export function upsellLines() {
  return [
    color(
      "cyan",
      "Checking client domains by hand? Klaxel watches them all daily and",
    ),
    color("cyan", `emails you before any one lapses — ${PRODUCT_URL}`),
  ];
}

/**
 * Run the CLI. Returns an exit code. Side-effects via the injected `out`/`err` writers.
 * @param {string[]} argv argv without [node, script]
 * @param {object} [deps]
 * @param {(s: string) => void} [deps.out]
 * @param {(s: string) => void} [deps.err]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {Date} [deps.now]
 * @returns {Promise<number>}
 */
export async function run(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s + "\n"));
  const err = deps.err ?? ((s) => process.stderr.write(s + "\n"));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();

  const parsed = parseArgs(argv);

  if (parsed.error) {
    err(parsed.error);
    err("");
    err(HELP);
    return 2;
  }
  if (parsed.help || parsed.domains.length === 0) {
    out(HELP);
    // No-args is a usage prompt, not an error the user can "fix" by retrying:
    // exit 0 for --help, exit 2 when invoked with nothing at all.
    return parsed.help ? 0 : 2;
  }

  const results = await Promise.all(
    parsed.domains.map(async (d) => ({ domain: d, result: await lookupExpiry(d, fetchImpl) })),
  );

  if (parsed.json) {
    const payload = results.map(({ domain, result }) => {
      if (result.ok) {
        const days = daysUntil(result.expiresAt, now);
        return {
          domain,
          ok: true,
          expiresAt: result.expiresAt.toISOString(),
          daysLeft: days,
          registeredAt: result.registeredAt ? result.registeredAt.toISOString() : null,
          statuses: result.statuses,
          source: result.source,
        };
      }
      return { domain, ok: false, reason: result.reason, detail: result.detail ?? null };
    });
    out(JSON.stringify({ results: payload, product: PRODUCT_URL }, null, 2));
    return 0;
  }

  const rows = results.map(({ domain, result }) => rowFor(domain, result, daysUntil, now));
  out("");
  out(renderTable(rows));
  out("");
  for (const line of upsellLines()) out(line);

  // A domain that's expired / unsupported / not-found is a VALID result, not a
  // CLI failure. Only usage errors (handled above) exit non-zero.
  return 0;
}
