// ai-rainbow.js — AI Authorship for MarkEdit
// Version: 1.0.0
// Features: animated rainbow text, Cmd+Shift+V paste-as-AI, Cmd+Shift+A marking, composition stats
// Format: iA Writer Markdown Annotations (https://github.com/iainc/Markdown-Annotations)

(function () {
  'use strict';
  try {
    const { EditorView, Decoration, keymap } = MarkEdit.codemirror.view;
    const { StateField, Transaction } = MarkEdit.codemirror.state;

    // ── CSS ───────────────────────────────────────────────────────────────────
    // Static mode (default): background-size 100%, gradient spans each span's
    // full width — every character gets a different hue.
    // Animated mode: background-size 200%, --ai-pos shifts via rAF so ALL spans
    // (including multi-line wrapping splits) animate in perfect sync.

    const style = document.createElement('style');
    style.textContent = `
      .ai-rainbow {
        background-size: var(--ai-bg-size, 20em) auto;
        background-position: var(--ai-pos, 0em) center;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      @media (prefers-color-scheme: dark) {
        .ai-rainbow {
          background-image: linear-gradient(90deg,
            hsl(0,  100%, 70%),
            hsl(40, 100%, 65%),
            hsl(80, 100%, 60%),
            hsl(140,100%, 55%),
            hsl(180,100%, 60%),
            hsl(220,100%, 70%),
            hsl(260,100%, 70%),
            hsl(300,100%, 70%),
            hsl(0,  100%, 70%)
          );
        }
      }
      @media (prefers-color-scheme: light) {
        .ai-rainbow {
          background-image: linear-gradient(90deg,
            hsl(0,   75%, 55%),
            hsl(30,  80%, 50%),
            hsl(45,  75%, 45%),
            hsl(140, 60%, 40%),
            hsl(180, 65%, 42%),
            hsl(220, 65%, 52%),
            hsl(260, 55%, 52%),
            hsl(300, 55%, 50%),
            hsl(0,   75%, 55%)
          );
        }
      }
    `;
    document.head.appendChild(style);

    // ── View reference ─────────────────────────────────────────────────────────
    // Captured from an EditorView.updateListener so we never depend on
    // MarkEdit.editorView (undocumented); only MarkEdit.codemirror.* is used.
    let editorView = null;
    const viewCapture = EditorView.updateListener.of(update => {
      editorView = update.view;
    });

    // ── Animation driver ──────────────────────────────────────────────────────

    const CYCLE_MS = 5000;
    let rafId = null;
    let hasDecos = false;
    // Default: static. Toggle persists across sessions via localStorage.
    let animated = localStorage.getItem('ai-rainbow-animated') === 'true';

    function startAnim() {
      // Only run when animation is enabled AND decorations are visible
      if (!animated || !hasDecos || rafId !== null) return;
      document.documentElement.style.setProperty('--ai-bg-size', '40em');
      (function tick() {
        const em = ((Date.now() % CYCLE_MS) / CYCLE_MS * 40).toFixed(2);
        document.documentElement.style.setProperty('--ai-pos', em + 'em');
        rafId = requestAnimationFrame(tick);
      })();
    }

    function stopAnim() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      document.documentElement.style.removeProperty('--ai-pos');
      document.documentElement.style.removeProperty('--ai-bg-size');
    }

    function toggleAnim() {
      animated = !animated;
      localStorage.setItem('ai-rainbow-animated', animated);
      if (animated) {
        startAnim(); // will no-op if no decorations are visible
      } else {
        stopAnim();  // drops back to static CSS gradient
      }
      MarkEdit.showAlert({
        title: 'AI Rainbow',
        message: animated ? 'Shimmer animation on.' : 'Static rainbow (no animation).',
      });
    }

    // ── Grapheme utilities ────────────────────────────────────────────────────
    // Markdown Annotations positions are grapheme cluster indices; CM6 uses
    // UTF-16 code unit offsets. buildGMap bridges the two.

    function buildGMap(text) {
      // Safety fallback for very large documents: 1:1 code-unit mapping.
      // Correct for ASCII/Latin text; slightly off only for emoji/combining chars.
      if (text.length > 100000) {
        const m = new Array(text.length + 1);
        for (let i = 0; i <= text.length; i++) m[i] = i;
        return m;
      }
      const seg = new Intl.Segmenter();
      const map = [];
      for (const { index } of seg.segment(text)) map.push(index);
      map.push(text.length); // sentinel
      return map;
    }

    // Binary search: code unit offset → grapheme index
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

    // ── Markdown Annotations format ───────────────────────────────────────────

    const DELIM = '\n---\nAnnotations:';

    function splitDoc(text) {
      const i = text.lastIndexOf(DELIM);
      return i === -1
        ? { content: text,          block: null,             di: -1 }
        : { content: text.slice(0, i), block: text.slice(i + 1), di: i  };
    }

    function parseRanges(str) {
      const out = [];
      for (const tok of str.trim().split(/\s+/)) {
        if (!tok) continue;
        const ci  = tok.indexOf(',');
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

    // Merge overlapping/adjacent ranges and sort by position
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

    // ── Decoration builder ────────────────────────────────────────────────────

    function buildDecos(fullText) {
      const { content, block } = splitDoc(fullText);
      if (!block) { hasDecos = false; stopAnim(); return Decoration.none; }

      const { ai: rawAI } = parseBlock(block);
      if (!rawAI.length) { hasDecos = false; stopAnim(); return Decoration.none; }

      const ai   = mergeRanges(rawAI); // guarantee non-overlapping
      const gmap = buildGMap(content);
      const maxG = gmap.length - 1;
      const marks = [];

      for (const { loc, len } of ai) {
        if (loc < 0 || loc >= maxG) continue;
        const from = gmap[loc];
        const to   = gmap[Math.min(loc + len, maxG)];
        if (from < to) marks.push(Decoration.mark({ class: 'ai-rainbow' }).range(from, to));
      }

      if (!marks.length) { hasDecos = false; stopAnim(); return Decoration.none; }
      marks.sort((a, b) => a.from - b.from || a.to - b.to);
      hasDecos = true;
      startAnim();
      return Decoration.set(marks);
    }

    // ── StateField ────────────────────────────────────────────────────────────

    // Track the annotation block text so we only rebuild decorations when it
    // actually changes (e.g. after writeAnnotations or a paste).  Normal typing
    // inside the content area updates the annotation block to split AI ranges
    // around newly typed text — human-typed characters never get rainbow.

    function getAnnotationBlock(text) {
      const i = text.lastIndexOf(DELIM);
      return i === -1 ? null : text.slice(i);
    }

    // When the user types inside an AI range, update the annotations to split
    // that range so the newly typed characters are excluded from rainbow.
    // We schedule this asynchronously so the current transaction completes first.
    let splitPending = false;
    // Suppresses split logic during paste operations that will be marked as AI
    let suppressSplit = false;
    // Debounced sync: keep annotation block offsets up-to-date even when typing
    // outside AI ranges, so that a later rebuild doesn't use stale positions.
    let syncTimer = null;

    function scheduleAnnotationSplit(view) {
      if (splitPending) return;
      splitPending = true;
      setTimeout(() => {
        splitPending = false;
        try { rewriteAnnotationsFromDecos(view); } catch (e) {
          console.error('[ai-rainbow] annotation split error:', e);
        }
      }, 0);
    }

    // Debounced annotation block sync for content-only edits (typing outside
    // AI ranges). Keeps the stored grapheme offsets current so that any later
    // full rebuild doesn't place decorations at stale positions.
    function scheduleAnnotationSync(view) {
      if (syncTimer !== null) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = null;
        if (splitPending) return; // a split rewrite will handle it
        try { rewriteAnnotationsFromDecos(view); } catch (e) {
          console.error('[ai-rainbow] annotation sync error:', e);
        }
      }, 800);
    }

    // Reads the current decoration ranges from the StateField and rewrites
    // the annotation block to match, so the split persists in the file.
    async function rewriteAnnotationsFromDecos(view) {
      // Read decorations and convert to grapheme ranges
      const snap1 = view.state.doc.toString();
      const { content: c1, block: b1 } = splitDoc(snap1);
      if (!b1) return;

      const existing = parseBlock(b1);
      const gmap1  = buildGMap(c1);
      const totalG1 = gmap1.length - 1;
      if (totalG1 <= 0) return;

      const fieldVal = view.state.field(decoField);
      const aiRanges = [];
      const iter = fieldVal.decos.iter();
      while (iter.value) {
        const gFrom = cuToGi(gmap1, iter.from);
        const gTo   = cuToGi(gmap1, iter.to);
        if (gFrom < gTo) aiRanges.push({ loc: gFrom, len: gTo - gFrom });
        iter.next();
      }

      const merged = mergeRanges(aiRanges);
      const hash   = await computeHash(c1);

      // Re-read state after async gap — document may have changed
      const fullText = view.state.doc.toString();
      const { content, block, di } = splitDoc(fullText);
      if (!block) return;

      // If content changed during await, re-derive grapheme ranges from
      // the current decorations against the current content
      const gmap   = buildGMap(content);
      const totalG = gmap.length - 1;
      if (totalG <= 0) return;

      let finalMerged = merged;
      if (content !== c1) {
        const curField = view.state.field(decoField);
        const curRanges = [];
        const it = curField.decos.iter();
        while (it.value) {
          const gF = cuToGi(gmap, it.from);
          const gT = cuToGi(gmap, it.to);
          if (gF < gT) curRanges.push({ loc: gF, len: gT - gF });
          it.next();
        }
        finalMerged = mergeRanges(curRanges);
      }

      const curExisting = content !== c1 ? parseBlock(block) : existing;
      const ranges = finalMerged.length ? finalMerged.map(r => `${r.loc},${r.len}`).join(' ') : '';
      // Re-hash if content changed
      const finalHash = content !== c1 ? await computeHash(content) : hash;
      const newBlock = ranges
        ? `\n---\nAnnotations: 0,${totalG} SHA-256 ${finalHash}\n&${curExisting.aiName}: ${ranges}\n...`
        : `\n---\nAnnotations: 0,${totalG} SHA-256 ${finalHash}\n...`;

      // Re-read one final time to get correct offsets for dispatch
      const finalText = view.state.doc.toString();
      const { di: finalDi } = splitDoc(finalText);

      if (finalText.slice(finalDi) === newBlock) return; // no change needed

      view.dispatch({
        changes: finalDi === -1
          ? { from: finalText.length, insert: newBlock }
          : { from: finalDi, to: finalText.length, insert: newBlock },
        annotations: Transaction.addToHistory.of(false),
      });
    }

    // Collect insertion positions from a transaction so we can exclude them
    // from AI decoration ranges (human-typed text should not be rainbow).
    function getInsertionPoints(tr) {
      const pts = [];
      tr.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (fromB < toB) pts.push({ from: fromB, len: toB - fromB });
      });
      return pts;
    }

    // Shrink a DecorationSet by carving out inserted character positions.
    // Returns a new array of {from, to} ranges, or null if nothing changed.
    function shrinkDecoRanges(decoSet, insertions) {
      if (!insertions.length) return null;

      const ranges = [];
      const iter = decoSet.iter();
      while (iter.value) {
        ranges.push({ from: iter.from, to: iter.to });
        iter.next();
      }
      if (!ranges.length) return null;

      let result = ranges;
      for (const ins of insertions) {
        const next = [];
        for (const r of result) {
          if (ins.from >= r.from && ins.from + ins.len <= r.to) {
            // Insertion is inside this range — split around it
            if (r.from < ins.from) next.push({ from: r.from, to: ins.from });
            if (ins.from + ins.len < r.to) next.push({ from: ins.from + ins.len, to: r.to });
          } else {
            next.push(r);
          }
        }
        result = next;
      }

      // Check if anything actually changed
      if (result.length === ranges.length &&
          result.every((r, i) => r.from === ranges[i].from && r.to === ranges[i].to)) {
        return null;
      }
      return result;
    }

    const decoField = StateField.define({
      create(s) {
        const text = s.doc.toString();
        return { decos: buildDecos(text), annoBlock: getAnnotationBlock(text) };
      },
      update({ decos, annoBlock }, tr) {
        if (!tr.docChanged) return { decos, annoBlock };

        const text = tr.state.doc.toString();
        const newAnnoBlock = getAnnotationBlock(text);

        // Annotation block changed → full rebuild (e.g. writeAnnotations ran)
        if (newAnnoBlock !== annoBlock) {
          return { decos: buildDecos(text), annoBlock: newAnnoBlock };
        }

        // Content-only edit → map decorations, then shrink to exclude insertions
        // (unless suppressed during paste-as-AI or undo/redo operations).
        // Undo/redo should restore previous state without carving out ranges —
        // re-inserted text from undo was originally AI and should stay AI.
        const mapped = decos.map(tr.changes);
        const isUndoRedo = tr.isUserEvent('undo') || tr.isUserEvent('redo');
        if (suppressSplit || isUndoRedo) {
          // Still sync annotation block offsets after undo/redo
          if (isUndoRedo && hasDecos && editorView) {
            scheduleAnnotationSync(editorView);
          }
          return { decos: mapped, annoBlock };
        }
        const insertions = getInsertionPoints(tr);
        const shrunk = shrinkDecoRanges(mapped, insertions);

        if (shrunk) {
          // Rebuild decoration set from shrunk ranges
          const marks = [];
          for (const r of shrunk) {
            if (r.from < r.to) marks.push(Decoration.mark({ class: 'ai-rainbow' }).range(r.from, r.to));
          }
          marks.sort((a, b) => a.from - b.from || a.to - b.to);
          const newDecos = marks.length ? Decoration.set(marks) : Decoration.none;

          // Schedule async annotation block rewrite to persist the split
          scheduleAnnotationSplit(editorView);

          return { decos: newDecos, annoBlock };
        }

        // Content changed but no split needed — schedule debounced sync to
        // keep annotation block offsets current for persistence/rebuild.
        if (hasDecos && editorView) {
          scheduleAnnotationSync(editorView);
        }

        return { decos: mapped, annoBlock };
      },
      provide: f => EditorView.decorations.from(f, val => val.decos),
    });

    // ── Hide annotation block ────────────────────────────────────────────────
    // Replace the annotation block with a tiny faded pill so it doesn't
    // distract the writer. Click the pill or use the menu to toggle visibility.

    let blockRevealed = false;

    const pillStyle = document.createElement('style');
    pillStyle.textContent = `
      .ai-anno-pill {
        display: inline-block;
        font-size: 10px;
        color: rgba(128,128,128,0.35);
        cursor: pointer;
        user-select: none;
        padding: 1px 6px;
        vertical-align: baseline;
      }
      .ai-anno-pill:hover {
        color: rgba(128,128,128,0.65);
      }
      .ai-anno-revealed {
        opacity: 0.25;
      }
    `;
    document.head.appendChild(pillStyle);

    class PillWidget extends MarkEdit.codemirror.view.WidgetType {
      toDOM() {
        const pill = document.createElement('span');
        pill.className = 'ai-anno-pill';
        pill.textContent = '\u2B2C annotations';
        pill.title = 'Click to reveal annotation block';
        pill.addEventListener('mousedown', (e) => {
          e.preventDefault();
          toggleBlockVisibility();
        });
        return pill;
      }
      ignoreEvent() { return false; }
    }

    function toggleBlockVisibility() {
      blockRevealed = !blockRevealed;
      const v = editorView;
      v.dispatch({ effects: [] });
    }

    function buildHideDecos(fullText) {
      const { di } = splitDoc(fullText);
      if (di === -1 || blockRevealed) return Decoration.none;
      const deco = Decoration.replace({ widget: new PillWidget() });
      return Decoration.set([deco.range(di, fullText.length)]);
    }

    function buildDimDecos(fullText) {
      const { di } = splitDoc(fullText);
      if (di === -1 || !blockRevealed) return Decoration.none;
      return Decoration.set([
        Decoration.mark({ class: 'ai-anno-revealed' }).range(di, fullText.length),
      ]);
    }

    const hideField = StateField.define({
      create: s => buildHideDecos(s.doc.toString()),
      update(d, tr) { return buildHideDecos(tr.state.doc.toString()); },
      provide: f => EditorView.decorations.from(f),
    });

    const dimField = StateField.define({
      create: s => buildDimDecos(s.doc.toString()),
      update(d, tr) { return buildDimDecos(tr.state.doc.toString()); },
      provide: f => EditorView.decorations.from(f),
    });

    // ── Annotation writer ─────────────────────────────────────────────────────
    // Merges new AI grapheme ranges with any existing ones and rewrites the block.

    async function computeHash(text) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function writeAnnotations(view, newAI) {
      const fullText = view.state.doc.toString();
      const { content, block, di } = splitDoc(fullText);
      const existing = parseBlock(block);

      const allAI = mergeRanges([...existing.ai, ...newAI]);
      if (!allAI.length) return;

      const gmap   = buildGMap(content);
      const totalG = gmap.length - 1;
      const hash   = await computeHash(content);

      // Re-read state after async gap — document may have changed
      const curText = view.state.doc.toString();
      const { di: curDi } = splitDoc(curText);

      const ranges = allAI.map(r => `${r.loc},${r.len}`).join(' ');
      const newBlock = `\n---\nAnnotations: 0,${totalG} SHA-256 ${hash}\n&${existing.aiName}: ${ranges}\n...`;

      view.dispatch({
        changes: curDi === -1
          ? { from: curText.length, insert: newBlock }
          : { from: curDi, to: curText.length, insert: newBlock },
      });
    }

    // ── Paste as AI: Cmd+Shift+V ───────────────────────────────────────────────
    // Explicit command to paste clipboard content and mark it as AI-authored.

    async function pasteAsAI(view) {
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch (e) {
        MarkEdit.showAlert({ title: 'Paste as AI', message: 'Cannot read clipboard. Check permissions.' });
        return true;
      }
      if (!text) {
        MarkEdit.showAlert({ title: 'Paste as AI', message: 'Clipboard is empty.' });
        return true;
      }

      const { from, to } = view.state.selection.main;
      suppressSplit = true;
      view.dispatch({ changes: { from, to, insert: text } });

      // After inserting, mark the pasted range as AI
      setTimeout(() => {
        suppressSplit = false;
        try {
          const { content } = splitDoc(view.state.doc.toString());
          const pasteEnd = from + text.length;
          if (from >= content.length) return;

          const gmap  = buildGMap(content);
          const gFrom = cuToGi(gmap, from);
          const gTo   = cuToGi(gmap, Math.min(pasteEnd, content.length));
          if (gFrom < gTo) writeAnnotations(view, [{ loc: gFrom, len: gTo - gFrom }]);
        } catch (e) {
          console.error('[ai-rainbow] paste-as-AI annotation error:', e);
        }
      }, 50);

      return true;
    }

    const pasteAIKm = keymap.of([{ key: 'Mod-Shift-v', run: pasteAsAI }]);

    // ── Manual marking: Cmd+Shift+A (toggle) ───────────────────────────────────

    function markSelectionAsAI(view) {
      const { from, to } = view.state.selection.main;
      if (from === to) {
        MarkEdit.showAlert({ title: 'No Selection', message: 'Select text first, then press ⌘⇧A to toggle AI/Human.' });
        return true;
      }
      const { content } = splitDoc(view.state.doc.toString());
      const gmap  = buildGMap(content);
      const gFrom = cuToGi(gmap, Math.min(from, content.length));
      const gTo   = cuToGi(gmap, Math.min(to,   content.length));
      if (gFrom < gTo) writeAnnotations(view, [{ loc: gFrom, len: gTo - gFrom }]);
      return true;
    }

    // Check whether the selected range overlaps any AI annotation ranges
    function selectionIsAI(view) {
      const { from, to } = view.state.selection.main;
      if (from === to) return false;
      const fullText = view.state.doc.toString();
      const { content, block } = splitDoc(fullText);
      if (!block) return false;
      const { ai } = parseBlock(block);
      if (!ai.length) return false;
      const gmap  = buildGMap(content);
      const gFrom = cuToGi(gmap, Math.min(from, content.length));
      const gTo   = cuToGi(gmap, Math.min(to,   content.length));
      for (const r of ai) {
        const rEnd = r.loc + r.len;
        if (r.loc < gTo && rEnd > gFrom) return true;
      }
      return false;
    }

    function toggleSelectionAuthorship(view) {
      const { from, to } = view.state.selection.main;
      if (from === to) {
        MarkEdit.showAlert({ title: 'No Selection', message: 'Select text first, then press ⌘⇧A to toggle AI/Human.' });
        return true;
      }
      if (selectionIsAI(view)) {
        return markSelectionAsHuman(view);
      } else {
        return markSelectionAsAI(view);
      }
    }

    const markKm = keymap.of([{ key: 'Mod-Shift-a', run: toggleSelectionAuthorship }]);

    // ── Mark selection as Human ──────────────────────────────────────────────
    // Removes the selected range from AI annotations (carves it out).

    async function markSelectionAsHuman(view) {
      const { from, to } = view.state.selection.main;
      if (from === to) return true;

      const fullText = view.state.doc.toString();
      const { content, block, di } = splitDoc(fullText);
      if (!block) return true;

      const existing = parseBlock(block);
      const gmap  = buildGMap(content);
      const totalG = gmap.length - 1;
      const gFrom = cuToGi(gmap, Math.min(from, content.length));
      const gTo   = cuToGi(gmap, Math.min(to,   content.length));
      if (gFrom >= gTo) return true;

      // Subtract selected range from AI ranges
      const carved = [];
      for (const r of existing.ai) {
        const rEnd = r.loc + r.len;
        // No overlap — keep as-is
        if (rEnd <= gFrom || r.loc >= gTo) { carved.push(r); continue; }
        // Left portion survives
        if (r.loc < gFrom) carved.push({ loc: r.loc, len: gFrom - r.loc });
        // Right portion survives
        if (rEnd > gTo) carved.push({ loc: gTo, len: rEnd - gTo });
      }

      const hash   = await computeHash(content);
      const ranges = carved.length ? carved.map(r => `${r.loc},${r.len}`).join(' ') : '';
      const newBlock = ranges
        ? `\n---\nAnnotations: 0,${totalG} SHA-256 ${hash}\n&${existing.aiName}: ${ranges}\n...`
        : `\n---\nAnnotations: 0,${totalG} SHA-256 ${hash}\n...`;

      view.dispatch({
        changes: di === -1
          ? { from: fullText.length, insert: newBlock }
          : { from: di, to: fullText.length, insert: newBlock },
      });
      return true;
    }

    // ── Composition stats ─────────────────────────────────────────────────────

    function showStats() {
      const fullText = editorView.state.doc.toString();
      const { content, block } = splitDoc(fullText);

      if (!block) {
        MarkEdit.showAlert({ title: 'No Authorship Data', message: 'No Markdown Annotations block found in this document.\n\nPaste AI text or select text and press ⌘⇧A to start tracking.' });
        return;
      }

      const { ai } = parseBlock(block);
      const gmap  = buildGMap(content);
      const total = gmap.length - 1;
      if (total === 0) { MarkEdit.showAlert({ title: 'Empty Document', message: 'Nothing to measure.' }); return; }

      const sumG  = rs => rs.reduce((s, { loc, len }) => s + Math.min(len, Math.max(0, total - loc)), 0);
      const aiG   = sumG(ai);
      const humG  = Math.max(0, total - aiG);
      const pct   = n => Math.round(n / total * 100);

      MarkEdit.showAlert({
        title: 'Document Composition',
        message: [
          `Total: ${total} characters`,
          ``,
          `AI: ${pct(aiG)}% (${aiG} chars)`,
          `Human: ${pct(humG)}% (${humG} chars)`,
        ].join('\n'),
      });
    }

    // ── Menu items ────────────────────────────────────────────────────────────

    MarkEdit.addMainMenuItem({
      title: 'AI Authorship',
      icon: 'sparkles',
      children: [
        { title: 'Paste as AI', action: () => pasteAsAI(editorView), key: 'V', modifiers: ['Command', 'Shift'] },
        { title: 'Toggle AI/Human', action: () => toggleSelectionAuthorship(editorView), key: 'A', modifiers: ['Command', 'Shift'] },
        { separator: true },
        { title: 'Show Composition Stats', action: showStats },
        { title: 'Toggle Animation', action: toggleAnim },
        { title: 'Toggle Annotations', action: toggleBlockVisibility },
      ],
    });

    // ── Register ──────────────────────────────────────────────────────────────

    MarkEdit.addExtension([viewCapture, decoField, hideField, dimField, pasteAIKm, markKm]);
    console.log('[ai-rainbow] Loaded: rainbow text · ⌘⇧V paste-as-AI · ⌘⇧A toggle AI/Human · stats');

  } catch (err) {
    console.error('[ai-rainbow] Init error:', err);
  }
})();
