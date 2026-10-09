import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bank = JSON.parse(readFileSync(join(root, 'data', 'bank.v1.json'), 'utf8'));
const errors = [];
const NAME_LEAK = /\b(openai|chatgpt|gpt|claude|sonnet|anthropic|gemini|glm|grok|llama-?[0-9]*|mistral|mixtral|deepseek|qwen-?[0-9.]*|command[ -]?r|phi-[0-9])\b/i;
const MODEL_COUNT = 4;

if (bank.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (typeof bank.bankVersion !== 'string' || !bank.bankVersion) errors.push('bankVersion missing');
if (bank.language !== 'en') errors.push('language must be "en"');
if (!bank.source || bank.source.provider !== 'pollinations') errors.push('source.provider must be "pollinations"');
if (bank.source && bank.source.runtimeApiCalls !== false) errors.push('source.runtimeApiCalls must be false');

const models = bank.models || [];
if (models.length !== MODEL_COUNT) errors.push(`need exactly ${MODEL_COUNT} models, got ${models.length}`);
const keys = new Set();
for (const m of models) {
  if (!m.key || keys.has(m.key)) errors.push('model key missing or duplicate: ' + m.key);
  keys.add(m.key);
  if (!m.displayName) errors.push('model displayName missing: ' + m.key);
  if (!Array.isArray(m.styleNotes) || m.styleNotes.length < 1) errors.push('styleNotes missing: ' + m.key);
}

const CATS = new Set(['explanation', 'advice', 'tradeoffs', 'creative', 'critique', 'rewrite']);
const DIFFS = new Set(['easy', 'medium', 'hard']);
const prompts = bank.prompts || [];
if (prompts.length < 15) errors.push('need at least 15 prompts, got ' + prompts.length);
const ids = new Set();
const ansIds = new Set();
const diffCount = { easy: 0, medium: 0, hard: 0 };
for (const p of prompts) {
  if (!p.id || ids.has(p.id)) errors.push('prompt id missing or duplicate: ' + p.id);
  ids.add(p.id);
  if (!CATS.has(p.category)) errors.push(`${p.id}: bad category ${p.category}`);
  if (!DIFFS.has(p.difficulty)) errors.push(`${p.id}: bad difficulty ${p.difficulty}`);
  else diffCount[p.difficulty] += 1;
  if (typeof p.text !== 'string' || p.text.length < 8 || p.text.length > 400) errors.push(`${p.id}: prompt text length`);
  if (NAME_LEAK.test(p.text || '')) errors.push(`${p.id}: possible model-name leak in prompt`);
  if (!Array.isArray(p.answers) || p.answers.length !== MODEL_COUNT) {
    errors.push(`${p.id}: expected ${MODEL_COUNT} answers`);
    continue;
  }
  const ansModels = new Set();
  for (const a of p.answers) {
    if (ansModels.has(a.modelKey)) errors.push(`${p.id}: duplicate answer modelKey ${a.modelKey}`);
    ansModels.add(a.modelKey);
    if (!keys.has(a.modelKey)) errors.push(`${p.id}: unknown modelKey ${a.modelKey}`);
    if (typeof a.text !== 'string' || a.text.length < 5 || a.text.length > 900) {
      errors.push(`${a.id || p.id}: answer text length ${a.text ? a.text.length : 0}`);
    }
    if (NAME_LEAK.test(a.text || '')) errors.push(`${a.id || p.id}: possible model-name leak`);
    if (typeof a.id !== 'string' || !a.id) errors.push(`${p.id}: answer id missing`);
    else if (ansIds.has(a.id)) errors.push(`${p.id}: duplicate answer id ${a.id}`);
    else ansIds.add(a.id);
  }
}
if (diffCount.easy < 2 || diffCount.medium < 2 || diffCount.hard < 1) {
  errors.push('difficulty buckets too small: ' + JSON.stringify(diffCount));
}

if (errors.length) {
  console.error('BANK VALIDATION FAILED:');
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}
console.log(`bank OK · prompts=${prompts.length} · models=${models.length} · buckets=${JSON.stringify(diffCount)} · version=${bank.bankVersion}`);
