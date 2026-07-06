# klaxel-check

**Check any domain's expiry date from your terminal — free, zero dependencies, no signup.**

A tiny CLI that tells you exactly when a domain expires and how many days are
left, color-coded so an expiring domain jumps out. It reads the registry's
**RDAP** record (the modern, official replacement for WHOIS), so the dates are
real and machine-accurate — not scraped, not guessed.

```sh
npx klaxel-check google.com
```

## Why this exists

Letting a domain lapse is one of the most expensive, most avoidable mistakes in
software. The site goes dark, email stops, SSL breaks, and a squatter can grab
it the moment it drops. If you run an agency or manage clients' domains, you're
tracking renewal dates across dozens of registrars by hand. This is the fast,
free way to spot-check any of them.

- **Monitor domain expiration** for your own and your clients' domains
- **RDAP, not WHOIS** — structured JSON straight from the registry, no rate-limited screen-scraping
- **Honest about gaps** — TLDs that don't publish RDAP (.io, .co, .so, some ccTLDs) are reported plainly, never faked
- **Zero runtime dependencies** — pure Node 18+ (built-in `fetch`), instant `npx`
- **`--json`** for scripts, CI, and LLM/agent use

## Install / run

No install needed:

```sh
npx klaxel-check example.com
```

Or install globally:

```sh
npm install -g klaxel-check
klaxel-check example.com
```

Requires **Node.js 18 or newer** (uses the built-in global `fetch`).

## Usage

```text
klaxel-check <domain> [more-domains...]

Options
  --json        Machine-readable JSON output (one object per domain)
  -h, --help    Show help
```

### Check one domain

```sh
$ npx klaxel-check google.com

  DOMAIN      EXPIRY      STATUS
● google.com  2028-09-14  819 days left (client transfer prohibited)

Checking client domains by hand? Klaxel watches them all daily and
emails you before any one lapses — https://klaxel.com
```

The status dot and days-left text are color-coded:

| Color | Meaning |
| --- | --- |
| 🟢 green | more than 30 days left — plenty of runway |
| 🟠 orange | 30 days or fewer — renew soon |
| 🔴 red | 7 days or fewer, or already expired — act now |

### Check several at once

```sh
$ npx klaxel-check google.com stripe.com basecamp.io

  DOMAIN       EXPIRY      STATUS
● google.com   2028-09-14  819 days left (client transfer prohibited)
● stripe.com   2027-09-11  451 days left (clienttransferprohibited)
● basecamp.io  —           no RDAP for .io (registries like .io/.co/.so don't publish one)
```

### JSON output (scripts / CI / agents)

```sh
$ npx klaxel-check --json google.com
```

```json
{
  "results": [
    {
      "domain": "google.com",
      "ok": true,
      "expiresAt": "2028-09-14T04:00:00.000Z",
      "daysLeft": 819,
      "registeredAt": "1997-09-15T04:00:00.000Z",
      "statuses": ["client transfer prohibited"],
      "source": "https://rdap.verisign.com/com/v1/"
    }
  ],
  "product": "https://klaxel.com"
}
```

## RDAP vs WHOIS — why the dates are trustworthy

Legacy WHOIS returns free-form text that differs by registrar and is heavily
rate-limited, so most "domain expiry" tools scrape and guess. **RDAP**
(Registration Data Access Protocol) is the IANA-standardized JSON successor.
This tool:

1. Fetches the official IANA bootstrap registry (`https://data.iana.org/rdap/dns.json`) to find the authoritative RDAP server for the TLD.
2. Queries that server for the domain.
3. Reads the structured `expiration` event date.

If a TLD isn't in the IANA bootstrap (notably `.io`, `.co`, `.so`, and some
country-code TLDs), there's no reliable RDAP record to read — and this tool says
so honestly rather than inventing a date.

## Exit codes

- `0` — checks ran successfully. An expired, unregistered, or unsupported-TLD domain is a **valid result**, not a CLI failure.
- `2` — usage error (no domain given, or an unknown flag).

This makes it safe to use in scripts: a non-zero exit means *you called it
wrong*, not *the domain is in trouble*. Parse `--json` to act on the actual
status.

## Watch them automatically

This CLI is a spot-check — you have to run it. If you'd rather **never think
about it again**, the hosted product does the watching for you:

### [Klaxel →](https://klaxel.com)

- Checks all your domains every day, automatically
- Emails you well before any domain lapses (configurable lead time)
- One dashboard for every client and every registrar
- Same RDAP engine that powers this CLI

Built for agencies and anyone managing more than a couple of domains.

## Development

```sh
npm test    # node:test, fully offline (fetch is mocked — never hits the network)
```

## License

MIT © Crescera Systems
