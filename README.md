# Log Lens

**High-performance ANSI log viewer for VS Code** — beautifully renders colored log files, handles 2M+ line files without breaking a sweat.

## Features

- **ANSI color rendering** — full support for 4-bit (16 colors), 256-color, and RGB truecolor escape codes. Bold, italic, dim, underline, strikethrough, blink, inverse.
- **Virtual scrolling** — only renders the visible rows. Opens a 62 MB / 310k-line log file instantly; scales to 2M+ lines.
- **Log-level filter buttons** — one-click filter by FATAL / ERROR / WARN / INFO / DEBUG / TRACE.
- **Grep / contains filter** — type in the filter bar to show only lines matching a substring (case-insensitive). Runs asynchronously so the UI stays responsive.
- **Inline editing** — double-click any row to edit the raw log text inline. Press Enter to save, Escape to cancel. The file is updated surgically (single-line byte replace) without a full re-read.
- **Search** — Ctrl+F opens search; F3 / Shift+F3 navigate results; search results are highlighted.
- **Tail-follow** — click ⬇ Tail to auto-scroll to the bottom as the log grows.
- **Edit Raw** — open the file in VS Code's native text editor any time via the toolbar button.
- **Dynamic gutter** — line number column width adapts to the number of digits, so there's no layout shift between 1-line and 2M-line files.

## Usage

Open any `.log` file — Log Lens activates automatically as the default viewer.

| Action | How |
|--------|-----|
| Filter by log level | Click FATAL / ERROR / WARN / INFO / DEBUG / TRACE buttons |
| Grep lines | Type in the **Filter lines** bar |
| Search text | Ctrl+F, then F3 / Shift+F3 to navigate |
| Edit a line | Double-click the row, type, press **Enter** |
| Copy line | Single-click the row |
| Follow tail | Click **⬇ Tail** |
| Open as raw text | Click **✏ Edit Raw** |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `logLens.lineHeight` | `22` | Row height in pixels |
| `logLens.fontSize` | `13` | Font size in pixels |
| `logLens.fontFamily` | `""` | Font family (empty = VS Code editor font) |
| `logLens.renderBuffer` | `100` | Extra rows rendered outside visible area |

## Performance

Log Lens uses a streaming file scanner that builds a byte-offset index without loading the entire file into memory:

- A 62 MB log file scans in ~1 second
- Memory usage: ~8 MB per million lines (offset index only)
- DOM nodes: ~200 at any time, regardless of file size

## Requirements

VS Code 1.74.0 or newer.

## License

MIT
