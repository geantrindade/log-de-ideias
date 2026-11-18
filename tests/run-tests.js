// Tests for the pure logic in index.html (crypto + score formula).
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
vm.runInContext(core + '\n;globalThis.__core = { textToB64, b64ToText, newKeyMaterial, encryptWith, parseEnvelope, decryptWithPassword, decryptWithKey, scoreIdea, rankIdeas, normalizeIdea, normalizeData, fold, ITERATIONS };', ctx);
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

  // ---- formula (spec section 6) ----
  const idea = o => C.normalizeIdea({ title: 'Teste', ...o });
  const ctxA = { horizon: 4, budget: 1, wNov: 2 };

  await test('formula: fits everything', () => {
    // base = (2*3 + 2*4)/4/5 = 0.7 -> 70
    const s = C.scoreIdea(idea({ novelty: 3, excitement: 4, effortWeeks: 2, cost: 1 }), ctxA);
    assert.equal(s.tfit, 1); assert.equal(s.rfit, 1); assert.equal(s.score, 70);
  });

  await test('formula: time does not fit', () => {
    // base = (2*5 + 2*5)/4/5 = 1; tfit = 4/12 = 0.333 -> 33
    const s = C.scoreIdea(idea({ novelty: 5, excitement: 5, effortWeeks: 12, cost: 0 }), ctxA);
    assert.equal(s.score, 33);
  });

  await test('formula: time floor 0.25', () => {
    const s = C.scoreIdea(idea({ novelty: 5, excitement: 5, effortWeeks: 52, cost: 0 }), { horizon: 0.5, budget: 3, wNov: 1 });
    assert.equal(s.tfit, 0.25); assert.equal(s.score, 25);
  });

  await test('formula: resources over by 1 and by 2+', () => {
    const i = idea({ novelty: 5, excitement: 5, effortWeeks: 1, cost: 3 });
    assert.equal(C.scoreIdea(i, { horizon: 4, budget: 2, wNov: 2 }).score, 60);
    assert.equal(C.scoreIdea(i, { horizon: 4, budget: 1, wNov: 2 }).score, 30);
    assert.equal(C.scoreIdea(i, { horizon: 4, budget: 0, wNov: 2 }).score, 30);
  });

  await test('formula: novelty weight 1 and 4', () => {
    const i = idea({ novelty: 5, excitement: 1, effortWeeks: 1, cost: 0 });
    // wNov=1: (5 + 2)/3/5 = 0.4667 -> 47 ; wNov=4: (20 + 2)/6/5 = 0.7333 -> 73
    assert.equal(C.scoreIdea(i, { horizon: 4, budget: 0, wNov: 1 }).score, 47);
    assert.equal(C.scoreIdea(i, { horizon: 4, budget: 0, wNov: 4 }).score, 73);
  });

  await test('formula: combined penalties', () => {
    // base = (2*4 + 2*3)/4/5 = 0.7 ; tfit = 12/26 ; rfit 0.6 -> 100*0.7*0.4615*0.6 = 19.38 -> 19
    const s = C.scoreIdea(idea({ novelty: 4, excitement: 3, effortWeeks: 26, cost: 2 }), { horizon: 12, budget: 1, wNov: 2 });
    assert.equal(s.score, 19);
  });

  await test('ranking reorders when context changes', () => {
    const quick = idea({ id: 'q', title: 'Rápida', novelty: 2, excitement: 3, effortWeeks: 0.5, cost: 0 });
    const big = idea({ id: 'b', title: 'Grande', novelty: 5, excitement: 5, effortWeeks: 26, cost: 3 });
    assert.deepEqual(C.rankIdeas([quick, big], { horizon: 0.5, budget: 0, wNov: 2 }).map(r => r.idea.id), ['q', 'b']);
    assert.deepEqual(C.rankIdeas([quick, big], { horizon: 26, budget: 3, wNov: 2 }).map(r => r.idea.id), ['b', 'q']);
  });

  await test('defaults when only title is given', () => {
    const i = C.normalizeIdea({ title: 'Só título' });
    assert.equal(i.category, 'outro'); assert.equal(i.phase, 'inbox');
    assert.equal(i.cost, 1); assert.equal(i.novelty, 3); assert.equal(i.excitement, 3);
    assert.equal(i.effortWeeks, 4); assert.deepEqual([...i.tags], []);
    assert.ok(i.id && i.createdAt && i.updatedAt);
  });

  await test('accent-insensitive search fold', () => {
    assert.equal(C.fold('Ação Música'), 'acao musica');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
