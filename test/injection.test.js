/**
 * 2. Injection: marker replacement, script-safe escaping, loud failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { inject, findSpan, scriptSafeJSON, InjectionError, TEMPLATE_PATH, START_MARKER, END_MARKER } from '../src/inject.js';

const HTML = fs.readFileSync(TEMPLATE_PATH, 'utf8');

test('injection replaces exactly the SNAPSHOT block and nothing else', () => {
  const snapshot = { meta: { generated: '2026-01-01' }, agents: [] };
  const out = inject(HTML, snapshot);

  const { start, end } = findSpan(HTML);
  const outStart = out.indexOf(START_MARKER);
  const outEnd = out.indexOf(END_MARKER);

  // Prefix and suffix must be byte-identical.
  assert.equal(out.slice(0, outStart), HTML.slice(0, start));
  assert.equal(out.slice(outEnd), HTML.slice(end));

  // The replaced region must be exactly `const SNAPSHOT = <json>;`
  const injected = out.slice(outStart, outEnd);
  assert.ok(injected.startsWith(START_MARKER));
  assert.equal(injected, `${START_MARKER}${scriptSafeJSON(snapshot)};`);
});

test('round-trip: the injected JSON parses back to the same object', () => {
  const snapshot = {
    meta: { generated: '2026-01-01', nested: { a: [1, 2, 3], b: null } },
    strings: ['quote"', "apos'", 'back\\slash', 'tab\tnewline\n'],
    unicode: 'héllo — ünïcode ✓ 中文',
  };
  const out = inject(HTML, snapshot);
  const start = out.indexOf(START_MARKER);
  const end = out.indexOf(END_MARKER);
  const region = out.slice(start + START_MARKER.length, end).replace(/;$/, '');
  assert.deepEqual(JSON.parse(region), snapshot);
});

test('script-safe: "<" is escaped so </script> cannot terminate the block', () => {
  const evil = '</script><script>alert(1)</script>';
  const out = inject(HTML, { x: evil });
  const start = out.indexOf(START_MARKER);
  const end = out.indexOf(END_MARKER);
  const region = out.slice(start, end);
  assert.ok(!region.includes('</script>'), 'raw </script> must not appear in the injected region');
  assert.ok(region.includes('\\u003c'), '< must be escaped as \\u003c');
  // And it must still round-trip to the original value.
  const json = region.slice(START_MARKER.length).replace(/;$/, '');
  assert.equal(JSON.parse(json).x, evil);
});

test('script-safe: U+2028 and U+2029 are escaped', () => {
  const tricky = 'a b c';
  const encoded = scriptSafeJSON({ tricky });
  assert.ok(!encoded.includes(' '), 'raw U+2028 must be escaped');
  assert.ok(!encoded.includes(' '), 'raw U+2029 must be escaped');
  assert.ok(encoded.includes('\\u2028'));
  assert.ok(encoded.includes('\\u2029'));
  assert.equal(JSON.parse(encoded).tricky, tricky);
});

test('script-safe: a BOM cannot sit at the very start of the injected script', () => {
  // The dangerous position is immediately after `const SNAPSHOT = `, where a BOM
  // could be read as leading trivia and mask the start of the expression.
  const out = inject(HTML, { x: '﻿alert(1)' });
  const start = out.indexOf(START_MARKER);
  const afterMarker = out.slice(start + START_MARKER.length);
  assert.ok(!afterMarker.startsWith('﻿'), 'injected script must not begin with a raw BOM');

  // A BOM elsewhere in a string value is harmless (not a script terminator) and
  // must still round-trip intact.
  const json = afterMarker.slice(0, afterMarker.indexOf(END_MARKER)).replace(/;$/, '');
  assert.equal(JSON.parse(json).x, '﻿alert(1)');
});

test('the injected page is valid JavaScript when evaluated', () => {
  const out = inject(HTML, { meta: { generated: '2026-01-01' }, evil: '</script>' });
  const m = /<script>\n([\s\S]*?)\n<\/script>/.exec(out);
  assert.ok(m, 'could not locate the main script block');
  // Syntax-check only: do not execute (it touches document).
  new vm.Script(m[1]);
});

test('missing start marker fails loudly', () => {
  const broken = HTML.replace(START_MARKER, 'const NOT_SNAPSHOT = ');
  assert.throws(() => inject(broken, {}), e => {
    assert.ok(e instanceof InjectionError);
    assert.match(e.message, /missing the start marker/);
    return true;
  });
});

test('missing end marker fails loudly', () => {
  const broken = HTML.replace(END_MARKER, '/* no marker here');
  assert.throws(() => inject(broken, {}), e => {
    assert.ok(e instanceof InjectionError);
    assert.match(e.message, /missing the end marker/);
    return true;
  });
});

test('empty template fails loudly rather than serving a blank page', () => {
  assert.throws(() => inject('', {}), InjectionError);
});
