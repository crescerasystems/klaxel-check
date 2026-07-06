/**
 * Presentation logic for the CLI — pure functions, no I/O.
 *
 * Mirrors the Klaxel app's checkResult.ts thresholds exactly so the
 * free CLI tells the same honest story as the hosted product:
 *   expired      -> red
 *   <= 7 days    -> red    (critical)
 *   <= 30 days   -> orange (renew soon)
 *   > 30 days    -> green  (healthy)
 */

/** ANSI colour helpers. Disabled automatically when stdout isn't a TTY or NO_COLOR is set. */
const COLORS_ENABLED =
  !process.env.NO_COLOR && (process.stdout && process.stdout.isTTY) === true;

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  orange: "\x1b[33m", // yellow == closest ANSI to "orange"
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
};

/**
 * @param {keyof typeof CODES} code
 * @param {string} s
 * @param {boolean} [enabled]
 */
export function color(code, s, enabled = COLORS_ENABLED) {
  if (!enabled) return s;
  return `${CODES[code]}${s}${CODES.reset}`;
}

/** @typedef {"ok"|"soon"|"critical"|"expired"|"unknown"} Severity */

/**
 * @param {number} days
 * @returns {Severity}
 */
export function severityForDays(days) {
  if (days < 0) return "expired";
  if (days <= 7) return "critical";
  if (days <= 30) return "soon";
  return "ok";
}

/** @type {Record<Severity, keyof typeof CODES>} */
const SEVERITY_COLOR = {
  ok: "green",
  soon: "orange",
  critical: "red",
  expired: "red",
  unknown: "gray",
};

/**
 * Human days-left phrase, e.g. "412 days left" / "Expired 3 days ago".
 * @param {number} days
 * @returns {string}
 */
export function daysHeadline(days) {
  if (days < 0) {
    const ago = Math.abs(days);
    return `expired ${ago} day${ago === 1 ? "" : "s"} ago`;
  }
  if (days === 0) return "expires today";
  return `${days.toLocaleString("en-US")} day${days === 1 ? "" : "s"} left`;
}

/** Format a Date as a plain, locale-stable YYYY-MM-DD (matches the dashboard). */
export function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Honest, human copy for every RDAP failure reason. Never blames the user for a
 * registry limitation. Short single-line variants suited to a CLI.
 * @param {string} reason
 * @param {string} [detail]
 * @returns {string}
 */
export function failureLine(reason, detail) {
  switch (reason) {
    case "UNSUPPORTED_TLD":
      return `no RDAP for .${detail ?? "?"} (registries like .io/.co/.so don't publish one)`;
    case "NOT_FOUND":
      return "not registered (registry has no record)";
    case "NO_EXPIRY":
      return "registry published no expiry date";
    case "NETWORK":
      return `registry didn't answer${detail ? ` (${detail})` : ""}`;
    case "PARSE":
      return "couldn't read the registry's response";
    case "INVALID_DOMAIN":
      return `not a valid domain: "${detail ?? ""}" — use a bare domain like example.com`;
    default:
      return "unexpected error";
  }
}

/**
 * Build one display row from a domain + its RDAP result + a reference `now`.
 * Returns the columns + the colour to apply to the days/status cell.
 * @param {string} inputDomain
 * @param {object} result  RDAP result union
 * @param {(d: Date, now?: Date) => number} daysUntil
 * @param {Date} now
 */
export function rowFor(inputDomain, result, daysUntil, now = new Date()) {
  if (result.ok) {
    const days = daysUntil(result.expiresAt, now);
    const severity = severityForDays(days);
    return {
      domain: inputDomain,
      ok: true,
      expiry: formatDate(result.expiresAt),
      days,
      daysText: daysHeadline(days),
      status: result.statuses[0] ?? "registered",
      severity,
      colorCode: SEVERITY_COLOR[severity],
    };
  }
  return {
    domain: inputDomain,
    ok: false,
    expiry: "—",
    days: null,
    daysText: failureLine(result.reason, result.detail),
    status: result.reason,
    severity: "unknown",
    colorCode: SEVERITY_COLOR.unknown,
  };
}

/**
 * Render an array of rows as a clean aligned, optionally colourized table.
 * @param {ReturnType<typeof rowFor>[]} rows
 * @param {boolean} [enabled] colour enabled
 * @returns {string}
 */
export function renderTable(rows, enabled = COLORS_ENABLED) {
  const domainW = Math.max(6, ...rows.map((r) => r.domain.length));
  const expiryW = Math.max(7, ...rows.map((r) => r.expiry.length));

  const header =
    "  " +
    color("dim", "DOMAIN".padEnd(domainW), enabled) +
    "  " +
    color("dim", "EXPIRY".padEnd(expiryW), enabled) +
    "  " +
    color("dim", "STATUS", enabled);

  const lines = rows.map((r) => {
    const dot = color(r.colorCode, "●", enabled);
    const domain = color("bold", r.domain.padEnd(domainW), enabled);
    const expiry = r.expiry.padEnd(expiryW);
    const detail = color(r.colorCode, r.daysText, enabled);
    const status = r.ok ? `${detail} ${color("gray", `(${r.status})`, enabled)}` : detail;
    return `${dot} ${domain}  ${expiry}  ${status}`;
  });

  return [header, ...lines].join("\n");
}
