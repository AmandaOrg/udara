#!/usr/bin/env node
/**
 * Structure + link check for Udara docs/initiatives/agent guidance.
 * No extra dependencies — uses Node fs only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_STATUS = new Set([
  'not started',
  'in progress',
  'blocked',
  'completed',
  'deleted',
]);
const PLAN_HEADINGS = [
  'How to use this document',
  'Problem',
  'Evidence',
  'Scope',
  'Non-goals',
  'Tracking table',
];
const REQUIRED_FILES = [
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/SECURITY.md',
  'docs/PRODUCT_BEHAVIOR.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  'docs/TESTING.md',
  'docs/specs/README.md',
  'docs/tech-design/README.md',
  'docs/decisions/README.md',
  'initiatives/README.md',
  'initiatives/_template/plan.md',
  '.cursor/project/summary.md',
  '.cursor/rules/working-agreement.mdc',
  '.cursor/rules/project-summary.mdc',
  '.cursor/rules/orchestrator-and-whatsapp.mdc',
  '.cursor/rules/security.mdc',
  'scripts/check-security.js',
];

const errors = [];

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function exists(repoRelative) {
  return fs.existsSync(path.join(ROOT, repoRelative));
}

function read(repoRelative) {
  return fs.readFileSync(path.join(ROOT, repoRelative), 'utf8');
}

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist' || name.name === '.git') {
      continue;
    }
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, acc);
    else if (/\.(md|mdc)$/i.test(name.name)) acc.push(full);
  }
  return acc;
}

function hasHeading(markdown, title) {
  const re = new RegExp(`^#{1,6}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
  return re.test(markdown);
}

for (const file of REQUIRED_FILES) {
  if (!exists(file)) errors.push(`missing required file: ${file}`);
}

const initiativesDir = path.join(ROOT, 'initiatives');
const initiativeIndex = exists('initiatives/README.md') ? read('initiatives/README.md') : '';
const specsIndex = exists('docs/specs/README.md') ? read('docs/specs/README.md') : '';
const techIndex = exists('docs/tech-design/README.md') ? read('docs/tech-design/README.md') : '';

if (fs.existsSync(initiativesDir)) {
  for (const name of fs.readdirSync(initiativesDir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('_')) continue;
    const slug = name.name;
    const planRel = `initiatives/${slug}/plan.md`;
    if (!exists(planRel)) {
      errors.push(`initiative "${slug}" has no plan.md`);
      continue;
    }
    const plan = read(planRel);
    for (const heading of PLAN_HEADINGS) {
      if (!hasHeading(plan, heading)) {
        errors.push(`${planRel} missing heading "${heading}"`);
      }
    }
    const statuses = [...plan.matchAll(/\|\s*[^|\n]+\|\s*[^|\n]+\|\s*([^|\n]+)\|/g)].map((m) =>
      m[1].trim().toLowerCase(),
    );
    const foundStatus = statuses.filter((s) => ALLOWED_STATUS.has(s));
    if (foundStatus.length === 0) {
      errors.push(`${planRel} tracking table has no allowed status (${[...ALLOWED_STATUS].join(' | ')})`);
    }
    if (!initiativeIndex.includes(slug)) {
      errors.push(`initiatives/README.md does not register "${slug}"`);
    }
    const specMatch = plan.match(/docs\/specs\/[A-Za-z0-9_.-]+\.md/);
    const techMatch = plan.match(/docs\/tech-design\/[A-Za-z0-9_.-]+\.md/);
    if (!specMatch) errors.push(`${planRel} must link to docs/specs/*.md`);
    else if (!exists(specMatch[0])) errors.push(`${planRel} spec missing on disk: ${specMatch[0]}`);
    else if (!specsIndex.includes(path.basename(specMatch[0]))) {
      errors.push(`docs/specs/README.md does not index ${path.basename(specMatch[0])}`);
    }
    if (!techMatch) errors.push(`${planRel} must link to docs/tech-design/*.md`);
    else if (!exists(techMatch[0])) errors.push(`${planRel} tech design missing on disk: ${techMatch[0]}`);
    else if (!techIndex.includes(path.basename(techMatch[0]))) {
      errors.push(`docs/tech-design/README.md does not index ${path.basename(techMatch[0])}`);
    }
  }
}

const LINK_RE = /!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^)]+)\)/g;

for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  const fromDir = path.dirname(file);
  let m;
  while ((m = LINK_RE.exec(text))) {
    const raw = (m[1] || m[2] || '').trim();
    if (!raw) continue;
    if (/^(https?:|mailto:|tel:)/i.test(raw)) continue;
    if (raw.startsWith('#')) continue;
    const noHash = raw.split('#')[0];
    if (!noHash) continue;
    if (/^[a-z]+:/i.test(noHash)) continue;
    const target = path.resolve(fromDir, noHash);
    const relToRoot = path.relative(ROOT, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      errors.push(`${rel(file)} link escapes repo: ${raw}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      errors.push(`${rel(file)} broken link: ${raw}`);
    }
  }
}

if (errors.length) {
  console.error(`docs:check failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('docs:check passed');
