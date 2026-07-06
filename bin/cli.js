#!/usr/bin/env node
/**
 * klaxel-check — free CLI domain-expiry checker (RDAP).
 * Thin entry point; all logic lives in ../lib/cli.js so it's testable.
 */
import { run } from "../lib/cli.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`klaxel-check: unexpected error: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  },
);
