#!/usr/bin/env node
/**
 * Security gate for Udara. Enforces the S1-S12 invariants documented in
 * docs/SECURITY.md. Dependency-free so it can run before install completes
 * in any environment.
 *
 * Waive a genuine false positive with `security-check:allow <reason>` on the
 * offending line or the line above it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'build',
  '.next',
]);
const TEXT_EXT = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdc',
  '.yml',
  '.yaml',
  '.env',
  '.example',
  '.sql',
  '.prisma',
  '.txt',
]);
const WAIVER = 'security-check:allow';

const findings = [];

function fail(id, message) {
  findings.push({ id, message });
}

function repoPath(...parts) {
  return path.join(ROOT, ...parts);
}

function rel(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

function readIfExists(relative) {
  const full = repoPath(relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function isScannable(name) {
  return TEXT_EXT.has(path.extname(name)) || name.startsWith('.env');
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (isScannable(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Scan everything that could reach the remote: tracked files plus untracked
 * ones git is not ignoring. A developer's real .env is expected to hold live
 * keys, so ignored files stay out. Fall back to a plain walk that skips the
 * well-known local env files when git is unavailable.
 */
function collectFiles() {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const tracked = output
      .split('\0')
      .filter(Boolean)
      .map((p) => path.join(ROOT, p))
      .filter((full) => isScannable(path.basename(full)) && fs.existsSync(full));
    if (tracked.length) return tracked;
  } catch {
    // git missing or not a repository — fall through
  }
  const localEnv = new Set(['.env', '.env.e2e', '.env.local']);
  return walk(ROOT).filter((full) => !localEnv.has(path.basename(full)));
}

/** A finding is waived if its line, or the line before it, opts out. */
function isWaived(lines, index) {
  const current = lines[index] || '';
  const previous = index > 0 ? lines[index - 1] : '';
  return current.includes(WAIVER) || previous.includes(WAIVER);
}

const ALL_FILES = collectFiles();

// ---------------------------------------------------------------------------
// S1-S9: invariants that must still be present
// ---------------------------------------------------------------------------

const INVARIANTS = [
  {
    id: 'S1',
    file: 'src/main.ts',
    pattern: /rawBody:\s*true/,
    message: 'Nest must boot with rawBody: true or webhook HMAC cannot be verified',
  },
  {
    id: 'S2',
    file: 'src/whatsapp/whatsapp.controller.ts',
    pattern: /@UseGuards\(\s*WhatsappSignatureGuard\s*\)/,
    message: 'the WhatsApp webhook route must keep WhatsappSignatureGuard',
  },
  {
    id: 'S3',
    file: 'src/rubies/rubies-webhook.controller.ts',
    pattern: /@UseGuards\(\s*RubiesSignatureGuard\s*\)/,
    message: 'the Rubies webhook route must keep RubiesSignatureGuard',
  },
  {
    id: 'S3',
    file: 'src/rubies/rubies-signature.guard.ts',
    pattern: /MAX_CLOCK_SKEW_SECONDS/,
    message: 'the Rubies guard must keep timestamp replay protection',
  },
  {
    id: 'S4',
    file: 'src/whatsapp/whatsapp-signature.guard.ts',
    pattern: /timingSafeEqual/,
    message: 'signature comparison must stay constant-time',
  },
  {
    id: 'S4',
    file: 'src/rubies/rubies-signature.guard.ts',
    pattern: /timingSafeEqual/,
    message: 'signature comparison must stay constant-time',
  },
  {
    id: 'S5',
    file: 'src/whatsapp/whatsapp-message.service.ts',
    pattern: /redactRawPayload/,
    message: 'inbound raw payloads must be redacted before persistence',
  },
  {
    id: 'S5',
    file: 'src/whatsapp/whatsapp-message.service.ts',
    pattern: /redactSensitive/,
    message: 'inbound Flow responses must be redacted before persistence',
  },
  {
    id: 'S7',
    file: 'src/whatsapp/transfer-confirmation.service.ts',
    pattern: /PENDING_PIN/,
    message: 'transfers must stay gated behind PIN verification',
  },
  {
    id: 'S8',
    file: 'src/orchestrator/orchestrator.service.ts',
    pattern: /validator\.validate\(/,
    message: 'every model turn must pass through ActionValidatorService',
  },
];

for (const invariant of INVARIANTS) {
  const source = readIfExists(invariant.file);
  if (source === null) {
    fail(invariant.id, `${invariant.file} is missing — ${invariant.message}`);
    continue;
  }
  if (!invariant.pattern.test(source)) {
    fail(invariant.id, `${invariant.file}: ${invariant.message}`);
  }
}

// S9 — the orchestrator module must not gain send or banking providers.
const orchestratorModule = readIfExists('src/orchestrator/orchestrator.module.ts');
if (orchestratorModule === null) {
  fail('S9', 'src/orchestrator/orchestrator.module.ts is missing');
} else {
  for (const provider of ['WhatsappService', 'RubiesService', 'ActionExecutorService']) {
    if (orchestratorModule.includes(provider)) {
      fail(
        'S9',
        `src/orchestrator/orchestrator.module.ts must not wire ${provider} — the model-facing module stays unable to move money or send messages`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// S6: every sensitive WhatsApp Flow field must be redacted
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_NAMES = new Set([
  'pin',
  'pin_confirm',
  'new_pin',
  'current_pin',
  'passcode',
  'password',
  'otp',
  'bvn',
  'nin',
  'id_number',
  'date_of_birth',
  'dob',
  'cvv',
  'card_number',
  'account_number',
  'secret',
  'token',
]);

const sensitiveUtil = readIfExists('src/whatsapp/sensitive-fields.util.ts');
if (sensitiveUtil === null) {
  fail('S6', 'src/whatsapp/sensitive-fields.util.ts is missing');
} else {
  const listMatch = sensitiveUtil.match(
    /SENSITIVE_FLOW_FIELDS\s*=\s*\[([\s\S]*?)\]/,
  );
  if (!listMatch) {
    fail('S6', 'could not read SENSITIVE_FLOW_FIELDS from sensitive-fields.util.ts');
  } else {
    const redacted = new Set(
      [...listMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
    );
    const flowsDir = repoPath('docs', 'whatsapp-flows');
    const flowFiles = fs.existsSync(flowsDir)
      ? fs.readdirSync(flowsDir).filter((f) => f.endsWith('.json'))
      : [];
    for (const flowFile of flowFiles) {
      let flow;
      try {
        flow = JSON.parse(fs.readFileSync(path.join(flowsDir, flowFile), 'utf8'));
      } catch (err) {
        fail('S6', `docs/whatsapp-flows/${flowFile} is not valid JSON: ${String(err)}`);
        continue;
      }
      const names = new Set();
      const collect = (node) => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (!node || typeof node !== 'object') return;
        if (typeof node.name === 'string') names.add(node.name);
        Object.values(node).forEach(collect);
      };
      collect(flow);
      for (const name of names) {
        if (SENSITIVE_FIELD_NAMES.has(name) && !redacted.has(name)) {
          fail(
            'S6',
            `docs/whatsapp-flows/${flowFile} collects "${name}" but SENSITIVE_FLOW_FIELDS does not redact it — it would be persisted in clear text`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// S10: request-path code must not shell out or disable TLS verification
// ---------------------------------------------------------------------------

const DANGEROUS = [
  {
    id: 'S10',
    pattern: /\brequire\(['"]child_process['"]\)|from\s+['"]child_process['"]/,
    message: 'request-path code must not spawn processes',
  },
  {
    id: 'S10',
    pattern: /rejectUnauthorized\s*:\s*false/,
    message: 'TLS certificate verification must stay on',
  },
  {
    id: 'S10',
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED/,
    message: 'TLS certificate verification must stay on',
  },
  {
    id: 'S10',
    pattern: /(^|[^.\w])eval\s*\(/,
    message: 'eval is not allowed',
  },
];

// Dev-only tooling is exempt from the shell-out rule: it never serves a request.
const REQUEST_PATH_EXEMPT = ['src/cli/'];

for (const file of ALL_FILES) {
  const relative = rel(file);
  if (!relative.startsWith('src/')) continue;
  if (REQUEST_PATH_EXEMPT.some((prefix) => relative.startsWith(prefix))) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of DANGEROUS) {
      if (rule.pattern.test(line) && !isWaived(lines, index)) {
        fail(rule.id, `${relative}:${index + 1} ${rule.message}`);
      }
    }
  });
}

// Focused tests only would silently shrink a "passing" suite.
for (const file of ALL_FILES) {
  const relative = rel(file);
  if (!/\.(spec|scenario)\.ts$/.test(relative)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/\b(describe|it|test)\.only\s*\(/.test(line) && !isWaived(lines, index)) {
      fail('S10', `${relative}:${index + 1} remove .only before merging`);
    }
  });
}

// ---------------------------------------------------------------------------
// S11: no credentials in the repository
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { name: 'webhook signing secret', re: /\bwhsec_[A-Za-z0-9]{12,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_\-]{30,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
];

const SELF = rel(__filename);

for (const file of ALL_FILES) {
  const relative = rel(file);
  if (relative === SELF) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const secret of SECRET_PATTERNS) {
      if (secret.re.test(line) && !isWaived(lines, index)) {
        fail('S11', `${relative}:${index + 1} looks like a committed ${secret.name}`);
      }
    }
  });
}

// Committed env files must never carry a real value for a secret-shaped key.
const PLACEHOLDERS = /^(|changeme|change_me|replace_me|placeholder|xxx+|todo|your[-_].*|<.*>)$/i;
const SECRET_KEY_NAME = /(_KEY|_SECRET|_TOKEN|_PASSWORD|PASSWORD)$/;

/** Long, mixed-case-or-numeric, unbroken strings are what real keys look like. */
function looksLikeRealCredential(value) {
  if (SECRET_PATTERNS.some((s) => s.re.test(value))) return true;
  return value.length >= 24 && /^\S+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

for (const file of ALL_FILES) {
  const relative = rel(file);
  const base = path.basename(relative);
  if (!base.startsWith('.env')) continue;
  // Templates carry documented local-dev values (e.g. an e2e verify token);
  // only credential-shaped values are a problem there.
  const isTemplate = base.endsWith('.example') || base.endsWith('.sample');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) return;
    const [, key, rawValue] = match;
    if (!SECRET_KEY_NAME.test(key)) return;
    const value = rawValue.trim().replace(/^["']|["']$/g, '');
    if (PLACEHOLDERS.test(value)) return;
    if (isTemplate && !looksLikeRealCredential(value)) return;
    if (isWaived(lines, index)) return;
    fail(
      'S11',
      `${relative}:${index + 1} ${key} has a real-looking value — committed env files must ship without credentials`,
    );
  });
}

// Real env files must stay ignored.
const gitignore = readIfExists('.gitignore') || '';
for (const ignored of ['.env', '.env.e2e']) {
  const listed = gitignore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(ignored);
  if (!listed) fail('S11', `.gitignore must list ${ignored}`);
}

// ---------------------------------------------------------------------------
// S12: security-critical files need unit tests
// ---------------------------------------------------------------------------

const NEEDS_TESTS = [
  'src/whatsapp/whatsapp-signature.guard.ts',
  'src/rubies/rubies-signature.guard.ts',
  'src/whatsapp/sensitive-fields.util.ts',
  'src/whatsapp/transfer-confirmation.service.ts',
  'src/whatsapp/pin-gate.service.ts',
  'src/pin/pin.service.ts',
  'src/orchestrator/action-validator.service.ts',
  'src/orchestrator/transfer-hints.util.ts',
  'src/allowance/fee-calculator.service.ts',
  'src/allowance/window.service.ts',
];

for (const target of NEEDS_TESTS) {
  if (!fs.existsSync(repoPath(target))) {
    fail('S12', `${target} is missing — update scripts/check-security.js if it moved`);
    continue;
  }
  const spec = target.replace(/\.ts$/, '.spec.ts');
  if (!fs.existsSync(repoPath(spec))) {
    fail('S12', `${target} is security-critical and has no ${path.basename(spec)}`);
  }
}

// ---------------------------------------------------------------------------

if (findings.length) {
  console.error(`security:check failed (${findings.length}):`);
  for (const finding of findings) {
    console.error(`  - [${finding.id}] ${finding.message}`);
  }
  console.error('\nSee docs/SECURITY.md. Waive a false positive with a');
  console.error(`"${WAIVER} <reason>" comment and explain it in the pull request.`);
  process.exit(1);
}

console.log(`security:check passed (${ALL_FILES.length} files scanned)`);
