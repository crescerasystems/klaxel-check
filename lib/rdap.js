/**
 * RDAP (Registration Data Access Protocol) lookup — plain-JS port of the
 * Klaxel app's verified lib/rdap.ts.
 *
 * RDAP is the modern, IANA-standardized JSON replacement for legacy WHOIS.
 * The IANA bootstrap registry (https://data.iana.org/rdap/dns.json) maps each
 * TLD to its authoritative RDAP server. We resolve the server per-TLD and read
 * the `expiration` event date — the structured, machine-readable expiry.
 *
 * Verified live against real domains (2026-06-16):
 *   google.com      -> 2028-09-14   (reliable)
 *   cloudflare.net  -> 2033-02-17   (reliable)
 *   example.org     -> 2026-08-30   (reliable)
 *   basecamp.io     -> NO RDAP SERVER (.io not in the IANA bootstrap)
 *   notion.so       -> NO RDAP SERVER (.so not in the IANA bootstrap)
 *
 * Result shape (mirrors the app's RdapResult union):
 *   { ok: true,  expiresAt: Date, registeredAt: Date|null, statuses: string[], source: string }
 *   { ok: false, reason: <RdapFailure>, detail?: string }
 *
 * RdapFailure: UNSUPPORTED_TLD | NOT_FOUND | NO_EXPIRY | NETWORK | PARSE | INVALID_DOMAIN
 */

const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000; // refresh the TLD->server map daily
const REQUEST_TIMEOUT_MS = 15_000;

/** @type {{ fetchedAt: number, map: Map<string, string[]> } | null} */
let bootstrapCache = null;

/**
 * Normalize and validate a domain string. Returns null if it doesn't look like a domain.
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeDomain(input) {
  const d = String(input).trim().toLowerCase();
  // Strip scheme, path, www, trailing dot.
  const cleaned = d
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/\.$/, "");
  // Basic domain shape: at least one dot, valid label chars, a TLD of 2+ letters.
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * @param {string} domain
 * @returns {string}
 */
export function tldOf(domain) {
  const parts = domain.split(".");
  return parts[parts.length - 1];
}

/**
 * Fetch (or return cached) IANA bootstrap mapping of TLD -> RDAP server URLs.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Map<string, string[]>>}
 */
export async function getBootstrap(fetchImpl = fetch) {
  const now = Date.now();
  if (bootstrapCache && now - bootstrapCache.fetchedAt < BOOTSTRAP_TTL_MS) {
    return bootstrapCache.map;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(IANA_BOOTSTRAP_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`);
    const json = await res.json();
    const map = new Map();
    for (const [tlds, urls] of json.services) {
      const normalizedUrls = urls.map((u) => (u.endsWith("/") ? u : `${u}/`));
      for (const tld of tlds) map.set(tld.toLowerCase(), normalizedUrls);
    }
    bootstrapCache = { fetchedAt: now, map };
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/** For tests: clear the in-memory bootstrap cache. */
export function _clearBootstrapCache() {
  bootstrapCache = null;
}

/**
 * Look up a domain's expiry via RDAP. Resolves the authoritative server from the
 * IANA bootstrap, queries it, and extracts the `expiration` event.
 * @param {string} rawDomain
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object>}
 */
export async function lookupExpiry(rawDomain, fetchImpl = fetch) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { ok: false, reason: "INVALID_DOMAIN", detail: String(rawDomain) };

  const tld = tldOf(domain);

  let servers;
  try {
    const map = await getBootstrap(fetchImpl);
    servers = map.get(tld);
  } catch (e) {
    return { ok: false, reason: "NETWORK", detail: `bootstrap: ${e.message}` };
  }
  if (!servers || servers.length === 0) {
    return { ok: false, reason: "UNSUPPORTED_TLD", detail: tld };
  }

  let lastErr;
  for (const base of servers) {
    const url = `${base}domain/${encodeURIComponent(domain)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/rdap+json" },
      });
      if (res.status === 404) return { ok: false, reason: "NOT_FOUND", detail: domain };
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      let json;
      try {
        json = await res.json();
      } catch {
        lastErr = "non-JSON response";
        continue;
      }
      if (json.errorCode === 404) return { ok: false, reason: "NOT_FOUND", detail: domain };

      const events = json.events ?? [];
      const expEvent = events.find((e) => e.eventAction === "expiration");
      const regEvent = events.find((e) => e.eventAction === "registration");
      if (!expEvent?.eventDate) {
        return { ok: false, reason: "NO_EXPIRY", detail: domain };
      }
      const expiresAt = new Date(expEvent.eventDate);
      if (Number.isNaN(expiresAt.getTime())) {
        return { ok: false, reason: "PARSE", detail: `bad date: ${expEvent.eventDate}` };
      }
      const registeredAt = regEvent?.eventDate ? new Date(regEvent.eventDate) : null;
      return {
        ok: true,
        expiresAt,
        registeredAt:
          registeredAt && !Number.isNaN(registeredAt.getTime()) ? registeredAt : null,
        statuses: json.status ?? [],
        source: base,
      };
    } catch (e) {
      lastErr = e.name === "AbortError" ? "timeout" : e.message;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "NETWORK", detail: lastErr };
}

/**
 * Days from `now` until expiry (negative if already expired).
 * @param {Date} expiresAt
 * @param {Date} [now]
 * @returns {number}
 */
export function daysUntil(expiresAt, now = new Date()) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.floor((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
}
