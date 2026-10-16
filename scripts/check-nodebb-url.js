#!/usr/bin/env node
/**
 * Guard: NODEBB_URL must never point at a dead Docker-network address.
 *
 * Why this exists (2026-10-16, imrnes): after the Coolify/Traefik -> native Caddy
 * migration the bridge kept `NODEBB_URL=http://10.0.4.3:4567`. That address was a
 * docker bridge IP that ceased to exist, so every poll failed with
 * `connect ETIMEDOUT 10.0.4.3:4567` — while the unit stayed `active (running)` and
 * `systemctl is-active` kept reporting success. The mirror was silently dead.
 *
 * A same-class bug already shipped once in nodebb-plugin-bridge-upload (a hardcoded
 * `/usr/src/app` fallback). The class is "config references a pre-migration
 * container path/address". This check is the tripwire for that class.
 *
 * Rules:
 *   1. .env must define NODEBB_URL (fail loudly, never silently default).
 *   2. It must not be a 10.0.x.x address (docker bridge range on this host).
 *   3. It must not carry the retired container path /usr/src/app.
 *   4. A bare loopback/host must resolve to a LISTENING local port.
 *
 * Usage:  node scripts/check-nodebb-url.js
 * Env:    BRIDGE_ENV_FILE=<path>   override (default: <repo>/.env)
 * Exit:   0 = ok, 1 = violation (CI should fail), 2 = could not evaluate
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ENV_FILE =
  process.env.BRIDGE_ENV_FILE || path.join(__dirname, '..', '.env');

const failures = [];
const notes = [];

function parseEnv(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// Listen check without exec/spawn: a plain TCP connect is enough.
function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, why });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, 'listening'));
    sock.once('timeout', () => done(false, 'no response (timeout)'));
    sock.once('error', (e) => done(false, e.code || e.message));
    sock.connect(port, host);
  });
}

(async function main() {
  if (!fs.existsSync(ENV_FILE)) {
    // CI checkouts legitimately have no .env; the check must not block them.
    console.log(`skip: no env file at ${ENV_FILE} (nothing to verify here)`);
    process.exit(0);
  }

  const env = parseEnv(ENV_FILE);
  if (!env) {
    console.error(`fail: could not parse ${ENV_FILE}`);
    process.exit(2);
  }

  const url = env.NODEBB_URL;

  // Rule 1
  if (!url) {
    failures.push(
      'NODEBB_URL is not set. Do not rely on a default — an unset or wrong ' +
        'address produced a silently dead bridge on 2026-10-16.'
    );
    console.error(`\nFAIL: ${ENV_FILE}`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  notes.push(`NODEBB_URL = ${url}`);

  // Rule 2 — retired docker bridge range
  const m = /^(https?):\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/.exec(url);
  if (m) {
    const host = m[2];
    const port = Number(m[3] || (m[1] === 'https' ? 443 : 80));
    if (host.startsWith('10.0.')) {
      failures.push(
        `${url} points into the retired 10.0.x.x docker bridge range. On imrnes ` +
          `that range belonged to the Coolify compose networks; NodeBB is now ` +
          `native on 127.0.0.1:4567.`
      );
    }
    // Rule 4
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
      const r = await portOpen('127.0.0.1', port);
      if (r.ok) notes.push(`loopback target is live on :${port}`);
      else
        failures.push(
          `${url} — nothing is listening on 127.0.0.1:${port} ` +
            `(${r.why}). The bridge would poll into a dead socket.`
        );
    } else {
      notes.push(`remote target ${host}:${port} — not probed from CI`);
    }
  } else if (!/^https?:\/\//.test(url)) {
    failures.push(`NODEBB_URL is not an http(s) URL: ${url}`);
  }

  // Rule 3 — retired container path anywhere in config
  if (/usr\/src\/app/.test(JSON.stringify(env))) {
    failures.push(
      `NODEBB_URL/config still references the retired container path ` +
        `/usr/src/app. Native install lives at /opt/nodebb/app.`
    );
  }

  if (failures.length) {
    console.error(`\nFAIL: ${ENV_FILE}`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }

  console.log(`ok: ${ENV_FILE}`);
  for (const n of notes) console.log(`  - ${n}`);
  process.exit(0);
})();