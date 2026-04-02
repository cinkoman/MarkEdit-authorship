#!/usr/bin/env node
// test-annotation-offsets.js — Hands-on verification of annotation offset logic
// Tests that AI-highlighted text stays at correct positions through various
// editing workflows (insert before, after, inside, delete, mixed sequences).

'use strict';

// ── Extract pure functions from ai-rainbow.js ─────────────────────────────

function buildGMap(text) {
  if (text.length > 100000) {
    const m = new Array(text.length + 1);
    for (let i = 0; i <= text.length; i++) m[i] = i;
    return m;
  }
  const seg = new Intl.Segmenter();
  const map = [];
  for (const { index } of seg.segment(text)) map.push(index);
  map.push(text.length);
  return map;
}

function cuToGi(map, cu) {
  if (cu <= 0) return 0;
  if (cu >= map[map.length - 1]) return map.length - 1;
  let lo = 0, hi = map.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    map[mid] <= cu ? (lo = mid) : (hi = mid - 1);
  }
  return lo;
}

const DELIM = '\n---\nAnnotations:';

function splitDoc(text) {
  const i = text.lastIndexOf(DELIM);
  return i === -1
    ? { content: text, block: null, di: -1 }
    : { content: text.slice(0, i), block: text.slice(i + 1), di: i };
}

function parseRanges(str) {
  const out = [];
  for (const tok of str.trim().split(/\s+/)) {
    if (!tok) continue;
    const ci = tok.indexOf(',');
    const loc = parseInt(ci < 0 ? tok : tok.slice(0, ci), 10);
    const len = ci < 0 ? 1 : parseInt(tok.slice(ci + 1), 10);
    if (!isNaN(loc) && !isNaN(len) && loc >= 0 && len > 0) out.push({ loc, len });
  }
  return out;
}

function parseBlock(block) {
  const r = { ai: [], human: [], aiName: 'Claude' };
  if (!block) return r;
  for (const line of block.split('\n')) {
    if (line.trim() === '...') break;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    if (line[0] === '&') { r.aiName = line.slice(1, ci).trim() || 'Claude'; r.ai.push(...parseRanges(line.slice(ci + 1))); }
    else if (line[0] === '@') r.human.push(...parseRanges(line.slice(ci + 1)));
  }
  return r;
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const spans = ranges.map(r => [r.loc, r.loc + r.len]).sort((a, b) => a[0] - b[0]);
  const merged = [[...spans[0]]];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    spans[i][0] <= last[1] ? (last[1] = Math.max(last[1], spans[i][1])) : merged.push([...spans[i]]);
  }
  return merged.map(([a, b]) => ({ loc: a, len: b - a }));
}

// ── Simulation helpers ────────────────────────────────────────────────────

// Build a full document with annotation block
function buildDoc(content, aiRanges, aiName = 'Claude') {
  const gmap = buildGMap(content);
  const totalG = gmap.length - 1;
  const ranges = aiRanges.map(r => `${r.loc},${r.len}`).join(' ');
  const block = ranges
    ? `\n---\nAnnotations: 0,${totalG} SHA-256 placeholder\n&${aiName}: ${ranges}\n...`
    : `\n---\nAnnotations: 0,${totalG} SHA-256 placeholder\n...`;
  return content + block;
}

// Get the actual text covered by AI annotations (via grapheme map)
function getAIText(fullDoc) {
  const { content, block } = splitDoc(fullDoc);
  if (!block) return [];
  const { ai } = parseBlock(block);
  const gmap = buildGMap(content);
  const maxG = gmap.length - 1;
  const result = [];
  for (const { loc, len } of ai) {
    if (loc < 0 || loc >= maxG) continue;
    const from = gmap[loc];
    const to = gmap[Math.min(loc + len, maxG)];
    result.push(content.slice(from, to));
  }
  return result;
}

// Simulate inserting text at a code-unit position in the content area.
// Returns the new full document with updated annotation block.
// This simulates what the debounced sync does: re-derive grapheme offsets
// from the "mapped" decoration positions.
function simulateInsert(fullDoc, insertPos, insertText) {
  const { content, block } = splitDoc(fullDoc);
  if (!block) return fullDoc;

  const { ai } = parseBlock(block);
  const gmap = buildGMap(content);
  const maxG = gmap.length - 1;

  // Convert AI grapheme ranges to code-unit ranges (the "decorations")
  const decoRanges = [];
  for (const { loc, len } of ai) {
    if (loc < 0 || loc >= maxG) continue;
    const from = gmap[loc];
    const to = gmap[Math.min(loc + len, maxG)];
    if (from < to) decoRanges.push({ from, to });
  }

  // Simulate CM6 map: shift decoration positions for the insertion
  const mapped = decoRanges.map(r => {
    let from = r.from, to = r.to;
    if (insertPos <= from) {
      // Insertion before decoration — shift both ends
      from += insertText.length;
      to += insertText.length;
    } else if (insertPos > from && insertPos < to) {
      // Insertion inside decoration — expand end (CM6 default for marks)
      to += insertText.length;
    }
    // Insertion at or after end — no change
    return { from, to };
  });

  // Simulate shrink: if insertion was inside a decoration, carve it out
  let shrunk = mapped;
  if (insertPos >= 0) {
    const newInsFrom = insertPos; // in new-doc coordinates
    const newInsTo = insertPos + insertText.length;
    const result = [];
    for (const r of mapped) {
      if (newInsFrom >= r.from && newInsTo <= r.to) {
        // Insertion is inside — split
        if (r.from < newInsFrom) result.push({ from: r.from, to: newInsFrom });
        if (newInsTo < r.to) result.push({ from: newInsTo, to: r.to });
      } else {
        result.push(r);
      }
    }
    shrunk = result;
  }

  // Build new content
  const newContent = content.slice(0, insertPos) + insertText + content.slice(insertPos);

  // Convert mapped+shrunk code-unit ranges back to grapheme ranges (the "sync")
  const newGmap = buildGMap(newContent);
  const newMaxG = newGmap.length - 1;
  const newAIRanges = [];
  for (const r of shrunk) {
    const gFrom = cuToGi(newGmap, r.from);
    const gTo = cuToGi(newGmap, r.to);
    if (gFrom < gTo) newAIRanges.push({ loc: gFrom, len: gTo - gFrom });
  }

  return buildDoc(newContent, mergeRanges(newAIRanges));
}

// Simulate deleting text at a code-unit range in the content area.
function simulateDelete(fullDoc, delFrom, delTo) {
  const { content, block } = splitDoc(fullDoc);
  if (!block) return fullDoc;

  const { ai } = parseBlock(block);
  const gmap = buildGMap(content);
  const maxG = gmap.length - 1;

  const decoRanges = [];
  for (const { loc, len } of ai) {
    if (loc < 0 || loc >= maxG) continue;
    const from = gmap[loc];
    const to = gmap[Math.min(loc + len, maxG)];
    if (from < to) decoRanges.push({ from, to });
  }

  // Simulate CM6 map for deletion
  const delLen = delTo - delFrom;
  const mapped = [];
  for (const r of decoRanges) {
    let from = r.from, to = r.to;
    if (delTo <= from) {
      // Deletion entirely before — shift back
      from -= delLen;
      to -= delLen;
    } else if (delFrom >= to) {
      // Deletion entirely after — no change
    } else if (delFrom <= from && delTo >= to) {
      // Deletion covers entire decoration — remove it
      continue;
    } else if (delFrom <= from) {
      // Deletion overlaps start
      from = delFrom;
      to -= delLen;
    } else if (delTo >= to) {
      // Deletion overlaps end
      to = delFrom;
    } else {
      // Deletion inside decoration
      to -= delLen;
    }
    if (from < to) mapped.push({ from, to });
  }

  const newContent = content.slice(0, delFrom) + content.slice(delTo);
  const newGmap = buildGMap(newContent);
  const newAIRanges = [];
  for (const r of mapped) {
    const gFrom = cuToGi(newGmap, r.from);
    const gTo = cuToGi(newGmap, r.to);
    if (gFrom < gTo) newAIRanges.push({ loc: gFrom, len: gTo - gFrom });
  }

  return buildDoc(newContent, mergeRanges(newAIRanges));
}

// ── Test framework ────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertAIText(fullDoc, expected, label) {
  const actual = getAIText(fullDoc);
  const match = actual.length === expected.length && actual.every((t, i) => t === expected[i]);
  if (match) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${label}]: expected AI text ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Test scenarios ────────────────────────────────────────────────────────

console.log('=== Test Scenario 1: Type human text BEFORE AI text ===');
{
  // "Hello " is human, "world from AI" is AI (graphemes 6-18)
  let doc = buildDoc('Hello world from AI', [{ loc: 6, len: 13 }]);
  assertAIText(doc, ['world from AI'], 'initial');

  // Type "Dear " at position 0 (before everything)
  doc = simulateInsert(doc, 0, 'Dear ');
  assertAIText(doc, ['world from AI'], 'after insert before');

  // Type "XXX" at position 5 (inside "Dear ", still before AI)
  doc = simulateInsert(doc, 5, 'XXX');
  assertAIText(doc, ['world from AI'], 'after second insert before');

  console.log('  Scenario 1 complete.');
}

console.log('\n=== Test Scenario 2: Type human text AFTER AI text ===');
{
  let doc = buildDoc('Hello world from AI', [{ loc: 6, len: 13 }]);
  assertAIText(doc, ['world from AI'], 'initial');

  // Type " - end" at position 19 (after AI text)
  doc = simulateInsert(doc, 19, ' - end');
  assertAIText(doc, ['world from AI'], 'after insert after');

  // Type more at the very end
  doc = simulateInsert(doc, 25, '!!!');
  assertAIText(doc, ['world from AI'], 'after second insert after');

  console.log('  Scenario 2 complete.');
}

console.log('\n=== Test Scenario 3: Type human text INSIDE AI text (split) ===');
{
  let doc = buildDoc('Hello world from AI', [{ loc: 6, len: 13 }]);
  assertAIText(doc, ['world from AI'], 'initial');

  // Type "HUMAN" at position 12 (inside "world from AI", between "world " and "from AI")
  doc = simulateInsert(doc, 12, 'HUMAN');
  assertAIText(doc, ['world ', 'from AI'], 'after insert inside — split');

  console.log('  Scenario 3 complete.');
}

console.log('\n=== Test Scenario 4: Mixed workflow — paste AI, type human, paste more AI ===');
{
  // Start with all human text
  let doc = buildDoc('Introduction here. Conclusion here.', []);
  assertAIText(doc, [], 'initial — no AI');

  // "Paste" AI text: mark positions 19-34 as AI ("Conclusion here.")
  // Wait — we need to mark it. Let's build with AI range directly.
  doc = buildDoc('Introduction here. AI explains things. Conclusion here.', [{ loc: 19, len: 19 }]);
  assertAIText(doc, ['AI explains things.'], 'after AI paste');

  // Type human text before the AI section (at position 0)
  doc = simulateInsert(doc, 0, 'NOTE: ');
  assertAIText(doc, ['AI explains things.'], 'after human before AI');

  // Type human text after the AI section
  doc = simulateInsert(doc, 50, ' [edited]');  // rough position after "things."
  // The AI text should still be the same
  const aiText = getAIText(doc);
  assert(aiText.length === 1 && aiText[0] === 'AI explains things.', 'AI text preserved after human typing after');

  // Type inside the AI section
  doc = simulateInsert(doc, 30, ' (my note) ');
  const aiText2 = getAIText(doc);
  assert(aiText2.length === 2, 'AI text split into 2 after typing inside');
  assert(aiText2.join('') === 'AI explains things.', 'combined AI text unchanged');

  console.log('  Scenario 4 complete.');
}

console.log('\n=== Test Scenario 5: Multiple AI ranges with human text between ===');
{
  // "Human " + "AI block one" + " human " + "AI block two" + " human end"
  const content = 'Human AI block one human AI block two human end';
  let doc = buildDoc(content, [{ loc: 6, len: 12 }, { loc: 25, len: 12 }]);
  assertAIText(doc, ['AI block one', 'AI block two'], 'initial two AI ranges');

  // Type before first AI range
  let doc2 = simulateInsert(doc, 0, 'START ');
  assertAIText(doc2, ['AI block one', 'AI block two'], 'insert before first range');

  // Type between the two AI ranges
  doc2 = simulateInsert(doc2, 25, '***');
  assertAIText(doc2, ['AI block one', 'AI block two'], 'insert between ranges');

  // Type after second AI range
  doc2 = simulateInsert(doc2, 55, ' END');
  assertAIText(doc2, ['AI block one', 'AI block two'], 'insert after second range');

  console.log('  Scenario 5 complete.');
}

console.log('\n=== Test Scenario 6: Delete text near AI ranges ===');
{
  let doc = buildDoc('AAA BBB CCC DDD', [{ loc: 4, len: 3 }]);
  assertAIText(doc, ['BBB'], 'initial');

  // Delete "AAA " (before AI range)
  doc = simulateDelete(doc, 0, 4);
  assertAIText(doc, ['BBB'], 'after delete before');

  // Delete " DDD" (after AI range) — content is now "BBB CCC"
  const { content: c1 } = splitDoc(doc);
  doc = simulateDelete(doc, c1.indexOf(' DDD'), c1.indexOf(' DDD') + 4);
  assertAIText(doc, ['BBB'], 'after delete after');

  console.log('  Scenario 6 complete.');
}

console.log('\n=== Test Scenario 7: Rapid sequential inserts (simulates fast typing) ===');
{
  let doc = buildDoc('The quick brown fox jumps over the lazy dog', [{ loc: 10, len: 9 }]);
  assertAIText(doc, ['brown fox'], 'initial');

  // Type 5 characters one at a time before AI text
  for (let i = 0; i < 5; i++) {
    doc = simulateInsert(doc, 0, 'x');
  }
  assertAIText(doc, ['brown fox'], 'after 5 rapid inserts before');

  // Type 5 characters one at a time after AI text
  const { content: c } = splitDoc(doc);
  for (let i = 0; i < 5; i++) {
    const { content: cur } = splitDoc(doc);
    doc = simulateInsert(doc, cur.length, 'y');
  }
  assertAIText(doc, ['brown fox'], 'after 5 rapid inserts after');

  console.log('  Scenario 7 complete.');
}

console.log('\n=== Test Scenario 8: Roundtrip grapheme conversion fidelity ===');
{
  // Test that cu -> grapheme -> cu roundtrip is lossless for ASCII
  const text = 'Hello world from AI assistant';
  const gmap = buildGMap(text);

  let roundtripOk = true;
  for (let cu = 0; cu < text.length; cu++) {
    const gi = cuToGi(gmap, cu);
    const backCu = gmap[gi];
    // For ASCII, every char boundary should roundtrip exactly
    if (backCu !== cu) {
      roundtripOk = false;
      console.error(`  Roundtrip fail at cu=${cu}: gi=${gi}, back=${backCu}`);
    }
  }
  assert(roundtripOk, 'ASCII roundtrip cu->gi->cu is lossless');

  // Test with emoji
  const emojiText = 'Hello 🌍 world 🎉 end';
  const emojiGmap = buildGMap(emojiText);
  const emojiMaxG = emojiGmap.length - 1;

  // Verify grapheme boundaries roundtrip
  let emojiOk = true;
  for (let gi = 0; gi <= emojiMaxG; gi++) {
    const cu = emojiGmap[gi];
    const backGi = cuToGi(emojiGmap, cu);
    if (backGi !== gi) {
      emojiOk = false;
      console.error(`  Emoji roundtrip fail at gi=${gi}: cu=${cu}, back=${backGi}`);
    }
  }
  assert(emojiOk, 'Emoji roundtrip gi->cu->gi is lossless at boundaries');

  console.log('  Scenario 8 complete.');
}

console.log('\n=== Test Scenario 9: Annotation block parse/rebuild consistency ===');
{
  const content = 'Line one.\nLine two with AI content.\nLine three.';
  const aiRanges = [{ loc: 10, len: 25 }];
  const doc = buildDoc(content, aiRanges);

  // Parse what we just built
  const { content: c, block } = splitDoc(doc);
  assert(c === content, 'content preserved through buildDoc');

  const parsed = parseBlock(block);
  assert(parsed.ai.length === 1, 'one AI range parsed');
  assert(parsed.ai[0].loc === 10, 'AI range loc correct');
  assert(parsed.ai[0].len === 25, 'AI range len correct');

  // Verify the AI text
  const gmap = buildGMap(c);
  const from = gmap[parsed.ai[0].loc];
  const to = gmap[Math.min(parsed.ai[0].loc + parsed.ai[0].len, gmap.length - 1)];
  assert(c.slice(from, to) === 'Line two with AI content.', 'AI range covers correct text');

  console.log('  Scenario 9 complete.');
}

console.log('\n=== Test Scenario 10: Real-world editing flow (blog post simulation) ===');
{
  // Simulates: user writes intro, pastes AI paragraph, writes transition,
  // pastes another AI paragraph, then goes back and edits throughout.

  // Step 1: User writes intro (all human)
  let content = 'Welcome to my blog post about technology.';
  let doc = buildDoc(content, []);

  // Step 2: User pastes AI paragraph after intro
  const aiPara1 = ' Artificial intelligence is transforming how we work and live.';
  content = content + aiPara1;
  const gmap1 = buildGMap(content);
  const aiStart1 = 41; // grapheme pos after "technology."
  const aiLen1 = aiPara1.length;
  doc = buildDoc(content, [{ loc: aiStart1, len: aiLen1 }]);
  assertAIText(doc, [aiPara1], 'after first AI paste');

  // Step 3: User types transition after AI text
  doc = simulateInsert(doc, content.length, ' Here is my take:');
  assertAIText(doc, [aiPara1], 'after human transition');

  // Step 4: User pastes second AI block at the end
  const { content: c4 } = splitDoc(doc);
  const aiPara2 = ' Machine learning models continue to improve.';
  const insertPos4 = c4.length;
  // Insert the AI text
  const c4new = c4 + aiPara2;
  const gmap4 = buildGMap(c4new);
  // Existing AI range needs to be preserved + new one added
  const existingAI = getAIText(doc);
  // Re-derive existing AI grapheme range in new content
  const existGmap = buildGMap(c4);
  const { block: b4 } = splitDoc(doc);
  const parsedExist = parseBlock(b4);
  // New AI range
  const newAIStart = buildGMap(c4).length - 1; // grapheme index at end of old content
  const newAILen = buildGMap(aiPara2).length - 1;
  doc = buildDoc(c4new, [...parsedExist.ai, { loc: newAIStart, len: newAILen }]);
  const aiTexts4 = getAIText(doc);
  assert(aiTexts4.length === 2, 'two AI ranges after second paste');
  assert(aiTexts4[0] === aiPara1, 'first AI range preserved');
  assert(aiTexts4[1] === aiPara2, 'second AI range correct');

  // Step 5: Go back and type at the very beginning
  doc = simulateInsert(doc, 0, 'EDIT: ');
  const aiTexts5 = getAIText(doc);
  assert(aiTexts5.length === 2, 'still two AI ranges after edit at start');
  assert(aiTexts5[0] === aiPara1, 'first AI range stable after edit at start');
  assert(aiTexts5[1] === aiPara2, 'second AI range stable after edit at start');

  // Step 6: Type inside the first AI range
  doc = simulateInsert(doc, 55, '[NOTE]');
  const aiTexts6 = getAIText(doc);
  assert(aiTexts6.length >= 2, 'AI ranges split/preserved after typing inside first range');
  // The first AI range should be split, second should be untouched
  assert(aiTexts6[aiTexts6.length - 1] === aiPara2, 'second AI range untouched after edit inside first');

  console.log('  Scenario 10 complete.');
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('SOME TESTS FAILED — see errors above');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
