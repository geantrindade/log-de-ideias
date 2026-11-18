// Tests for the pure logic in index.html (crypto, score, filters, import).
// Run with Node 20+:  node tests/run-tests.js
// Uses only fictitious data.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const core = html.slice(html.indexOf('/* CORE-START'), html.indexOf('/* CORE-END */'));
if (!core) throw new Error('CORE block not found');

const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa, Uint8Array, JSON, Math, Number, String, Array, Set, Date, Error });
vm.runInContext(core + '\n;globalThis.__core = { textToB64, b64ToText, newKeyMaterial, encryptWith, parseEnvelope, decryptWithPassword, decryptWithKey, scoreIdea, arrangeQueue, parseImport, feas, feasRated, normalizeIdea, normalizeData, fold, ITERATIONS };', ctx);
const C = ctx.__core;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
}

(async () => {
  const PASS = 'cavalo bateria grampo correto azul';
  const ACCENTED = 'Ação, coração, pão, maçã, ü, ñ, 日本語, emoji 🧪 — “aspas”';

  await test('base64 round trip with accents and emoji', () => {
    assert.equal(C.b64ToText(C.textToB64(ACCENTED)), ACCENTED);
    assert.equal(C.b64ToText(C.textToB64('')), '');
  });

  await test('base64 accepts GitHub-style line breaks', () => {
    const b = C.textToB64(ACCENTED.repeat(10));
    const wrapped = b.replace(/(.{60})/g, '$1\n');
    assert.equal(C.b64ToText(wrapped), ACCENTED.repeat(10));
  });

  let material, envText;
  await test('encrypt/decrypt round trip with accents', async () => {
    material = await C.newKeyMaterial(PASS);
    const payload = JSON.stringify({ version: 1, ideas: [{ title: ACCENTED }] });
    envText = await C.encryptWith(material, payload);
    const r = await C.decryptWithPassword(PASS, envText);
    assert.equal(r.plaintext, payload);
  });

  await test('envelope format matches spec', () => {
    const e = JSON.parse(envText);
    assert.deepEqual(Object.keys(e).sort(), ['ct', 'iter', 'iv', 'kdf', 'salt', 'v']);
    assert.equal(e.v, 1);
    assert.equal(e.kdf, 'PBKDF2-SHA256');
    assert.ok(e.iter >= 600000);
    assert.equal(Buffer.from(e.salt, 'base64').length, 16);
    assert.equal(Buffer.from(e.iv, 'base64').length, 12);
    assert.ok(!envText.includes('Ação'));
  });

  await test('wrong password fails with WRONG_PASSWORD', async () => {
    await assert.rejects(C.decryptWithPassword(PASS + 'x', envText), /WRONG_PASSWORD/);
  });

  await test('tampered ciphertext fails authentication', async () => {
    const e = JSON.parse(envText);
    const ct = Buffer.from(e.ct, 'base64'); ct[0] ^= 1; e.ct = ct.toString('base64');
    await assert.rejects(C.decryptWithPassword(PASS, JSON.stringify(e)), /WRONG_PASSWORD/);
  });

  await test('new IV on every write, same salt per file', async () => {
    const a = JSON.parse(await C.encryptWith(material, 'x'));
    const b = JSON.parse(await C.encryptWith(material, 'x'));
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
    assert.equal(a.salt, b.salt);
  });

  await test('two files get different salts', async () => {
    const m2 = await C.newKeyMaterial(PASS);
    assert.notEqual(Buffer.from(m2.salt).toString('hex'), Buffer.from(material.salt).toString('hex'));
  });

  await test('derived key decrypts without password (remember-device path)', async () => {
    const env = C.parseEnvelope(envText);
    const pt = await C.decryptWithKey(material.key, env);
    assert.ok(pt.includes(ACCENTED));
  });

  await test('malformed envelopes are rejected', () => {
    assert.throws(() => C.parseEnvelope('not json'), /BAD_ENVELOPE/);
    assert.throws(() => C.parseEnvelope('{"v":2}'), /BAD_ENVELOPE/);
    const e = JSON.parse(envText); e.iter = 1000;
    assert.throws(() => C.parseEnvelope(JSON.stringify(e)), /BAD_ENVELOPE/);
  });

  // ---- score (handover v2, section 4) ----
  const idea = o => C.normalizeIdea({ title: 'Teste', ...o });
  const EQ = { wNov: 5, wExc: 5, wFeas: 5 };

  await test('score: equal weights is the plain mean', () => {
    // (4 + 3 + 2) / 15 = 0.6 -> 60
    assert.equal(C.scoreIdea(idea({ novelty: 4, excitement: 3, feasibility: 2 }), EQ).score, 60);
    assert.equal(C.scoreIdea(idea({ novelty: 5, excitement: 5, feasibility: 5 }), EQ).score, 100);
    assert.equal(C.scoreIdea(idea({ novelty: 1, excitement: 1, feasibility: 1 }), EQ).score, 20);
  });

  await test('score: unequal weights', () => {
    // 100 * (10*5 + 5*1 + 0*1) / (5 * 15) = 5500/75 = 73.3 -> 73
    assert.equal(C.scoreIdea(idea({ novelty: 5, excitement: 1, feasibility: 1 }), { wNov: 10, wExc: 5, wFeas: 0 }).score, 73);
  });

  await test('score: a zero weight removes that criterion', () => {
    const w = { wNov: 5, wExc: 5, wFeas: 0 };
    const a = C.scoreIdea(idea({ novelty: 4, excitement: 4, feasibility: 1 }), w).score;
    const b = C.scoreIdea(idea({ novelty: 4, excitement: 4, feasibility: 5 }), w).score;
    assert.equal(a, b); assert.equal(a, 80);
  });

  await test('score: all weights zero falls back to 1,1,1', () => {
    const s = C.scoreIdea(idea({ novelty: 5, excitement: 2, feasibility: 2 }), { wNov: 0, wExc: 0, wFeas: 0 });
    assert.deepEqual({ ...s.w }, { wNov: 1, wExc: 1, wFeas: 1 });
    assert.equal(s.score, 60);   // 9/15
  });

  await test('score: missing feasibility counts as 3 and is not stored', () => {
    const i = idea({ novelty: 3, excitement: 3 });
    assert.equal('feasibility' in i, false);
    assert.equal(C.feas(i), 3); assert.equal(C.feasRated(i), false);
    assert.equal(C.scoreIdea(i, EQ).score, 60);
  });

  await test('score: time does not change the score', () => {
    const a = C.scoreIdea(idea({ novelty: 4, excitement: 4, feasibility: 4, effortWeeks: 0.5 }), EQ).score;
    const b = C.scoreIdea(idea({ novelty: 4, excitement: 4, feasibility: 4, effortWeeks: 52 }), EQ).score;
    assert.equal(a, b);
  });

  // ---- filters and ordering (section 5) ----
  const NONE = { time: null, nov: null, exc: null, feas: null };
  const pool = () => [
    idea({ id: 'a', title: 'Alfa', createdAt: '2026-01-01', effortWeeks: 0.5, novelty: 2, excitement: 3, feasibility: 5 }),
    idea({ id: 'b', title: 'Beta', createdAt: '2026-01-02', effortWeeks: 12, novelty: 5, excitement: 5, feasibility: 2 }),
    idea({ id: 'c', title: 'Gama', createdAt: '2026-01-03', effortWeeks: 4, novelty: 4, excitement: 2, feasibility: 4 }),
    idea({ id: 'd', title: 'Delta', createdAt: '2026-01-04', effortWeeks: 0.5, novelty: 4, excitement: 4 }),
  ];
  const ids = r => r.items.map(x => x.idea.id).join('');
  const meets = r => r.items.filter(x => x.meets).map(x => x.idea.id).join('');

  await test('no filter: not grouped, ordered by score', () => {
    // scores: a 67, b 80, c 67, d 73 ; tie a/c broken by createdAt
    const r = C.arrangeQueue(pool(), EQ, NONE, 'score');
    assert.equal(r.grouped, false);
    assert.equal(ids(r), 'bdac');
    assert.equal(meets(r), 'bdac');
  });

  await test('time filter alone: groups and sorts by shortest time', () => {
    const r = C.arrangeQueue(pool(), EQ, { ...NONE, time: 0.5 }, 'time');
    assert.equal(r.grouped, true);
    assert.equal(meets(r), 'da');          // both 0.5 weeks; score breaks the tie (73 > 67)
    assert.equal(ids(r), 'dacb');          // then non-meeting by time: 4 < 12
    assert.equal(r.items.find(x => x.idea.id === 'b').checks.time, false);
  });

  await test('novelty filter alone', () => {
    const r = C.arrangeQueue(pool(), EQ, { ...NONE, nov: 4 }, 'nov');
    assert.equal(meets(r), 'bdc');         // 5, 4 (score 73), 4 (score 67)
    assert.equal(ids(r), 'bdca');
  });

  await test('excitement filter "only 5"', () => {
    const r = C.arrangeQueue(pool(), EQ, { ...NONE, exc: 5 }, 'exc');
    assert.equal(meets(r), 'b');
    assert.equal(ids(r), 'bdac');          // non-meeting by excitement: 4, 3, 2
  });

  await test('feasibility filter uses 3 for unrated ideas', () => {
    const r = C.arrangeQueue(pool(), EQ, { ...NONE, feas: 3 }, 'feas');
    assert.equal(meets(r), 'acd');         // 5, 4, 3 (unrated d)
    const r4 = C.arrangeQueue(pool(), EQ, { ...NONE, feas: 4 }, 'feas');
    assert.equal(meets(r4), 'ac');
  });

  await test('two filters together require both', () => {
    const r = C.arrangeQueue(pool(), EQ, { ...NONE, time: 0.5, nov: 4 }, 'nov');
    assert.equal(meets(r), 'd');
    const a = r.items.find(x => x.idea.id === 'a');
    assert.equal(a.meets, false); assert.equal(a.checks.time, true); assert.equal(a.checks.nov, false);
  });

  await test('weights change scores but not who meets the filters', () => {
    const f = { ...NONE, time: 4 };
    const r1 = C.arrangeQueue(pool(), EQ, f, 'score');
    const r2 = C.arrangeQueue(pool(), { wNov: 0, wExc: 10, wFeas: 0 }, f, 'score');
    assert.equal([...meets(r1)].sort().join(''), [...meets(r2)].sort().join(''));
    assert.notEqual(r1.items[0].s.score, r2.items.find(x => x.idea.id === r1.items[0].idea.id).s.score);
  });

  await test('tie on criterion and score falls back to creation order', () => {
    const t = [idea({ id: 'x', title: 'X', createdAt: '2026-02-02', novelty: 3, excitement: 3, feasibility: 3 }),
               idea({ id: 'y', title: 'Y', createdAt: '2026-02-01', novelty: 3, excitement: 3, feasibility: 3 })];
    assert.equal(ids(C.arrangeQueue(t, EQ, NONE, 'nov')), 'yx');
  });

  // ---- data model and import (section 3, 8) ----
  await test('normalize keeps unknown fields such as cost', () => {
    const i = C.normalizeIdea({ title: 'Antiga', cost: 2, extra: { a: 1 } });
    assert.equal(i.cost, 2); assert.deepEqual({ ...i.extra }, { a: 1 });
  });

  await test('phases: archived accepted, unknown becomes inbox', () => {
    assert.equal(C.normalizeIdea({ title: 'x', phase: 'archived' }).phase, 'archived');
    assert.equal(C.normalizeIdea({ title: 'x', phase: 'whatever' }).phase, 'inbox');
    assert.equal(C.normalizeIdea({ title: 'x', phase: 'done' }).phase, 'done');
  });

  await test('feasibility is clamped to 1..5', () => {
    assert.equal(C.normalizeIdea({ title: 'x', feasibility: 9 }).feasibility, 5);
    assert.equal(C.normalizeIdea({ title: 'x', feasibility: 0 }).feasibility, 1);
  });

  await test('import: old format (cost, no feasibility) works', () => {
    const old = JSON.stringify({ version: 1, ideas: [
      { title: 'Ideia fictícia antiga', category: 'app', cost: 3, novelty: 4, excitement: 2, phase: 'eval', effortWeeks: 2 },
      { title: 'Arquivada fictícia', phase: 'archived', feasibility: 4 },
      { title: 'Fase estranha', phase: 'blah' },
    ] });
    const { fresh, skipped } = C.parseImport(old, []);
    assert.equal(skipped, 0); assert.equal(fresh.length, 3);
    assert.equal('cost' in fresh[0], false);
    assert.equal('feasibility' in fresh[0], false);
    assert.equal(fresh[0].phase, 'eval');
    assert.equal(fresh[1].phase, 'archived'); assert.equal(fresh[1].feasibility, 4);
    assert.equal(fresh[2].phase, 'inbox');
  });

  await test('import: skips duplicates (accent/case-insensitive), empty titles and bad JSON', () => {
    const existing = [C.normalizeIdea({ id: 'e1', title: 'Ação Teste' })];
    const { fresh, skipped } = C.parseImport(JSON.stringify([{ title: 'acao teste' }, { title: '' }, null, { id: 'e1', title: 'Nova' }]), existing);
    assert.equal(fresh.length, 1); assert.equal(skipped, 3);
    assert.notEqual(fresh[0].id, 'e1');
    assert.throws(() => C.parseImport('{', existing), /JSON/);
    assert.throws(() => C.parseImport('{"x":1}', existing), /Formato/);
  });

  await test('defaults when only title is given', () => {
    const i = C.normalizeIdea({ title: 'Só título' });
    assert.equal(i.category, 'outro'); assert.equal(i.phase, 'inbox');
    assert.equal(i.novelty, 3); assert.equal(i.excitement, 3);
    assert.equal(i.effortWeeks, 4); assert.deepEqual([...i.tags], []);
    assert.ok(i.id && i.createdAt && i.updatedAt);
  });

  await test('accent-insensitive search fold', () => {
    assert.equal(C.fold('Ação Música'), 'acao musica');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
