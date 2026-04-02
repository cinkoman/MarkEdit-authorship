# MarkEdit Authorship

iA Writer-style AI authorship highlighting for [MarkEdit](https://github.com/MarkEdit-app/MarkEdit). AI-written text glows with a rainbow gradient. Human text stays plain. Everything is tracked using the open [Markdown Annotations](https://github.com/iainc/Markdown-Annotations) format, so your files stay portable.

---

## Features

- **Rainbow gradient** on AI-authored text — static by default, optional shimmer animation
- **Light & dark mode** — separate color palettes for each
- **Paste detection** — any pasted text is automatically marked as AI
- **⌘⇧V** — explicitly paste clipboard as AI
- **⌘⇧A** — toggle selected text between AI and Human
- **Annotation pill** — the annotation block collapses to a tiny faded pill so it stays out of the way; click to reveal
- **Composition stats** — see your AI vs Human character breakdown at a glance
- **Human typing carves AI ranges** — type inside a rainbow span and only the new characters revert to human; the rest stays rainbow
- **iA Writer compatible** — uses the same [Markdown Annotations](https://github.com/iainc/Markdown-Annotations) format, so files open correctly in iA Writer too

---

## Installation

1. Download [`ai-rainbow.js`](ai-rainbow.js)
2. Move it to:
   ```
   ~/Library/Containers/app.cyan.markedit/Data/Documents/scripts/
   ```
3. Quit and reopen MarkEdit

The script loads automatically on next launch. No build step needed.

---

## Usage

### Marking text

| Action | Result |
|--------|--------|
| Paste anything | Automatically marked as AI |
| **⌘⇧V** | Paste clipboard and mark as AI |
| Select text → **⌘⇧A** | Toggle selected text AI ↔ Human |

### Menu

All commands are under **Extensions → AI Authorship**:

- **Paste as AI** `⌘⇧V`
- **Toggle AI/Human** `⌘⇧A`
- **Show Composition Stats**
- **Toggle Animation** — switch between static rainbow and shimmer
- **Toggle Annotations** — show/hide the annotation block

### Annotation block

The `---\nAnnotations:` block at the bottom of your file is hidden by default and replaced with a small faded pill. Click the pill to reveal it, or use **Toggle Annotations** from the menu.

---

## File format

Uses the [iA Writer Markdown Annotations](https://github.com/iainc/Markdown-Annotations) spec:

```markdown
Your document content here.

---
Annotations: 0,241 SHA-256 <hash>
&Claude: 46,81 163,54
...
```

- `&Name:` — AI-authored ranges
- `@Name:` — Human-authored ranges (supported for reading; manual editing only)
- Positions are grapheme cluster indices, not byte offsets

See [`example.md`](example.md) for a working sample.

---

## License

MIT
