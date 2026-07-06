import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeDomain, lookupExpiry, daysUntil, _clearBootstrapCache } from "../lib/rdap.js";
import { severityForDays, daysHeadline, formatDate, failureLine, rowFor } from "../lib/format.js";
import { parseArgs, run } from "../lib/cli.js";

// --- A fake fetch that serves the IANA bootstrap + a per-domain RDAP record. ---
const BOOTSTRAP = {
  services: [
    [["com", "net"], ["https://rdap.verisign.com/com/v1"]],
    [["org"], ["https://rdap.publicinterestregistry.org/rdap/"]],
  ],
};

function makeFetch(domainRecords) {
  return async function fakeFetch(url) {
    if (url === "https://data.iana.org/rdap/dns.json") {
      return { ok: true, status: 200, json: async () => BOOTSTRAP };
    }
    // domain lookups: ".../domain/<name>"
    const m = url.match(/\/domain\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const rec = domainRecords[name];
      if (!rec) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => rec };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

const RDAP_GOOGLE = {
  status: ["client transfer prohibited", "server delete prohibited"],
  events: [
    { eventAction: "registration", eventDate: "1997-09-15T04:00:00Z" },
    { eventAction: "expiration", eventDate: "2028-09-14T04:00:00Z" },
  ],
};

// --- daysUntil / formatting ---
test("daysUntil computes whole days, negative when expired", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(daysUntil(new Date("2026-01-11T00:00:00Z"), now), 10);
  assert.equal(daysUntil(new Date("2025-12-29T00:00:00Z"), now), -3);
  assert.equal(daysUntil(new Date("2026-01-01T00:00:00Z"), now), 0);
});

test("severityForDays mirrors the app thresholds (30/7/expired)", () => {
  assert.equal(severityForDays(-1), "expired");
  assert.equal(severityForDays(0), "critical");
  assert.equal(severityForDays(7), "critical");
  assert.equal(severityForDays(8), "soon");
  assert.equal(severityForDays(30), "soon");
  assert.equal(severityForDays(31), "ok");
});

test("daysHeadline pluralizes and handles expired/today", () => {
  assert.equal(daysHeadline(412), "412 days left");
  assert.equal(daysHeadline(1), "1 day left");
  assert.equal(daysHeadline(0), "expires today");
  assert.equal(daysHeadline(-3), "expired 3 days ago");
  assert.equal(daysHeadline(-1), "expired 1 day ago");
});

test("formatDate emits stable YYYY-MM-DD", () => {
  assert.equal(formatDate(new Date("2028-09-14T04:00:00Z")), "2028-09-14");
});

test("normalizeDomain strips scheme/www/path and rejects junk", () => {
  assert.equal(normalizeDomain("https://www.Google.com/search?q=x"), "google.com");
  assert.equal(normalizeDomain("example.org."), "example.org");
  assert.equal(normalizeDomain("not a domain"), null);
  assert.equal(normalizeDomain("localhost"), null);
});

// --- RDAP parsing against mocked responses (no network) ---
test("lookupExpiry parses the expiration event from RDAP JSON", async () => {
  _clearBootstrapCache();
  const res = await lookupExpiry("google.com", makeFetch({ "google.com": RDAP_GOOGLE }));
  assert.equal(res.ok, true);
  assert.equal(formatDate(res.expiresAt), "2028-09-14");
  assert.equal(formatDate(res.registeredAt), "1997-09-15");
  assert.deepEqual(res.statuses, RDAP_GOOGLE.status);
});

test("lookupExpiry -> UNSUPPORTED_TLD for a TLD absent from the bootstrap", async () => {
  _clearBootstrapCache();
  const res = await lookupExpiry("basecamp.io", makeFetch({}));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "UNSUPPORTED_TLD");
  assert.equal(res.detail, "io");
});

test("lookupExpiry -> NOT_FOUND on registry 404", async () => {
  _clearBootstrapCache();
  const res = await lookupExpiry("nope-not-real.com", makeFetch({}));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NOT_FOUND");
});

test("lookupExpiry -> NO_EXPIRY when registry omits the expiration event", async () => {
  _clearBootstrapCache();
  const rec = { status: ["active"], events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }] };
  const res = await lookupExpiry("noexpiry.com", makeFetch({ "noexpiry.com": rec }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_EXPIRY");
});

test("lookupExpiry -> INVALID_DOMAIN for junk input (no network)", async () => {
  _clearBootstrapCache();
  let called = false;
  const res = await lookupExpiry("not a domain", async () => {
    called = true;
    throw new Error("should not fetch");
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "INVALID_DOMAIN");
  assert.equal(called, false);
});

// --- failure copy + rows ---
test("failureLine gives honest, user-safe copy per reason", () => {
  assert.match(failureLine("UNSUPPORTED_TLD", "io"), /no RDAP for \.io/);
  assert.match(failureLine("NOT_FOUND"), /not registered/);
  assert.match(failureLine("NETWORK", "timeout"), /didn't answer.*timeout/);
});

test("rowFor builds a colour-coded row from a successful result", () => {
  const now = new Date("2027-09-14T04:00:00Z"); // ~365 days before google expiry
  const row = rowFor("google.com", { ok: true, expiresAt: new Date("2028-09-14T04:00:00Z"), registeredAt: null, statuses: ["ok"], source: "x" }, daysUntil, now);
  assert.equal(row.ok, true);
  assert.equal(row.expiry, "2028-09-14");
  assert.equal(row.severity, "ok");
  assert.equal(row.colorCode, "green");
});

// --- arg parsing ---
test("parseArgs collects domains and flags", () => {
  assert.deepEqual(parseArgs(["a.com", "b.com"]), { domains: ["a.com", "b.com"], json: false, help: false });
  assert.deepEqual(parseArgs(["--json", "a.com"]), { domains: ["a.com"], json: true, help: false });
  assert.deepEqual(parseArgs(["--help"]), { domains: [], json: false, help: true });
  assert.equal(parseArgs(["--bogus"]).error, "unknown option: --bogus");
});

// --- run(): end-to-end with mocked fetch + captured output ---
function capture() {
  const lines = [];
  return { lines, write: (s) => lines.push(s) };
}

test("run prints a table + upsell and exits 0 for a valid lookup", async () => {
  _clearBootstrapCache();
  const o = capture();
  const code = await run(["google.com"], {
    out: o.write,
    err: o.write,
    fetchImpl: makeFetch({ "google.com": RDAP_GOOGLE }),
    now: new Date("2027-09-14T04:00:00Z"),
  });
  const text = o.lines.join("\n");
  assert.equal(code, 0);
  assert.match(text, /google\.com/);
  assert.match(text, /2028-09-14/);
  assert.match(text, /klaxel\.com/);
});

test("run --json emits machine-readable output, exit 0", async () => {
  _clearBootstrapCache();
  const o = capture();
  const code = await run(["--json", "google.com"], {
    out: o.write,
    err: o.write,
    fetchImpl: makeFetch({ "google.com": RDAP_GOOGLE }),
    now: new Date("2027-09-14T04:00:00Z"),
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(o.lines.join("\n"));
  assert.equal(parsed.results[0].domain, "google.com");
  assert.equal(parsed.results[0].ok, true);
  assert.equal(parsed.results[0].daysLeft, 366);
  assert.equal(parsed.product, "https://klaxel.com");
});

test("run with no args shows help and exits 2 (usage error)", async () => {
  const o = capture();
  const code = await run([], { out: o.write, err: o.write });
  assert.equal(code, 2);
  assert.match(o.lines.join("\n"), /USAGE/);
});

test("run --help exits 0", async () => {
  const o = capture();
  const code = await run(["--help"], { out: o.write, err: o.write });
  assert.equal(code, 0);
});

test("run with unsupported TLD still exits 0 (valid result, not a CLI error)", async () => {
  _clearBootstrapCache();
  const o = capture();
  const code = await run(["basecamp.io"], { out: o.write, err: o.write, fetchImpl: makeFetch({}) });
  assert.equal(code, 0);
  assert.match(o.lines.join("\n"), /no RDAP for \.io/);
});
