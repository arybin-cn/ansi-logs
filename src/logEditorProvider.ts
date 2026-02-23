import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseAnsiLine, stripAnsi, AnsiSpan } from './ansiParser';
import { FileReader, LevelIndex } from './fileReader';

// ─── Custom Document ──────────────────────────────────────────────────────────
class LogDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

interface ParsedLine {
    spans: AnsiSpan[];
    level: string;
    raw: string;
}

interface PanelState {
    fileReader: FileReader;
    parsedCache: Map<number, ParsedLine>;
    panel: vscode.WebviewPanel;
    filePath: string;
    scanning: boolean;
    /** When non-null, restricts visible lines to these physical indices (grep filter). */
    grepIndices: number[] | null;
    grepQuery: string;
    fileWatcher: vscode.FileSystemWatcher | null;
    /** Timestamp of our last programmatic file write — suppress file-watcher re-scan. */
    lastEditTime: number;
}

// ─── Provider ─────────────────────────────────────────────────────────────────
export class LogEditorProvider implements vscode.CustomEditorProvider<LogDocument> {
    public static readonly viewType = 'logLens.logViewer';

    private readonly _onDidChangeCustomDocument =
        new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<LogDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly panels = new Map<string, PanelState>();

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new LogEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            LogEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    async openCustomDocument(uri: vscode.Uri, _ctx: vscode.CustomDocumentOpenContext, _t: vscode.CancellationToken): Promise<LogDocument> {
        return new LogDocument(uri);
    }

    async resolveCustomEditor(document: LogDocument, webviewPanel: vscode.WebviewPanel, _t: vscode.CancellationToken): Promise<void> {
        const key = document.uri.toString();
        const filePath = document.uri.fsPath;

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

        const state: PanelState = {
            fileReader: new FileReader(filePath),
            parsedCache: new Map(),
            panel: webviewPanel,
            filePath,
            scanning: true,
            grepIndices: null,
            grepQuery: '',
            fileWatcher: null,
            lastEditTime: 0,
        };
        this.panels.set(key, state);

        state.fileWatcher = this.setupFileWatcher(document.uri, state);

        const msgDisp = webviewPanel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg, document, state),
            undefined,
            this.context.subscriptions
        );

        webviewPanel.onDidDispose(() => {
            msgDisp.dispose();
            state.fileWatcher?.dispose();
            state.fileReader.dispose();
            this.panels.delete(key);
        });

        this.startScan(document, state);
    }

    // No-op save/backup (read-only provider for large files — editing done via editLine message)
    async saveCustomDocument(_d: LogDocument, _c: vscode.CancellationToken): Promise<void> {}
    async saveCustomDocumentAs(_d: LogDocument, _dest: vscode.Uri, _c: vscode.CancellationToken): Promise<void> {}
    async revertCustomDocument(_d: LogDocument, _c: vscode.CancellationToken): Promise<void> {}
    async backupCustomDocument(_d: LogDocument, _ctx: vscode.CustomDocumentBackupContext, _c: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return { id: '', delete: () => {} };
    }

    // ─── File watcher ───────────────────────────────────────────────────────────
    private setupFileWatcher(uri: vscode.Uri, state: PanelState): vscode.FileSystemWatcher {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath))
        );
        let debounce: ReturnType<typeof setTimeout> | null = null;
        watcher.onDidChange(() => {
            // Suppress re-scan for our own writes (inline line edit)
            if (Date.now() - state.lastEditTime < 1500) { return; }
            if (debounce) { clearTimeout(debounce); }
            debounce = setTimeout(() => this.reScan(state), 400);
        });
        return watcher;
    }

    // ─── Scan ───────────────────────────────────────────────────────────────────
    private async startScan(document: LogDocument, state: PanelState): Promise<void> {
        const filename = path.basename(document.uri.fsPath);
        state.scanning = true;
        state.parsedCache.clear();
        state.panel.webview.postMessage({ type: 'scanning', filename, filePath: document.uri.fsPath });

        try {
            let lastReport = 0;
            await state.fileReader.scan((n) => {
                const now = Date.now();
                if (now - lastReport > 120) {
                    lastReport = now;
                    state.panel.webview.postMessage({ type: 'progress', linesScanned: n });
                }
            });
        } catch (err) {
            state.panel.webview.postMessage({ type: 'error', message: String(err) });
            return;
        }

        state.scanning = false;
        this.sendInit(document.uri, state);
    }

    private async reScan(state: PanelState): Promise<void> {
        if (state.scanning) { return; }
        state.scanning = true;
        state.fileReader.dispose();
        state.fileReader = new FileReader(state.filePath);
        state.parsedCache.clear();
        state.grepIndices = null;

        state.panel.webview.postMessage({
            type: 'scanning',
            filename: path.basename(state.filePath),
            filePath: state.filePath,
        });

        try { await state.fileReader.scan(); } catch (err) {
            state.panel.webview.postMessage({ type: 'error', message: String(err) });
            return;
        }

        state.scanning = false;
        state.panel.webview.postMessage({
            type: 'docChanged',
            totalLines: state.fileReader.totalLines,
            levelCounts: state.fileReader.levelCounts,
        });

        // Re-apply grep if active
        if (state.grepQuery) {
            this.runGrepFilter(state, state.grepQuery);
        }
    }

    // ─── Message dispatch ───────────────────────────────────────────────────────
    private handleMessage(msg: any, document: LogDocument, state: PanelState): void {
        switch (msg.type) {
            case 'ready':
                if (!state.scanning) { this.sendInit(document.uri, state); }
                break;

            case 'requestLines':
                this.handleRequestLines(state, msg.start, msg.end, msg.filter ?? [], msg.grepActive ?? false);
                break;

            case 'editRaw':
                vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                break;

            case 'editLine':
                this.handleEditLine(state, document.uri, msg.lineNum as number, msg.newText as string);
                break;

            case 'copyText':
                vscode.env.clipboard.writeText(msg.text as string ?? '');
                break;

            case 'search':
                this.handleSearch(state, (msg.query as string ?? '').toLowerCase(), msg.filter ?? [], msg.grepActive ?? false);
                break;

            case 'grepFilter':
                this.runGrepFilter(state, msg.query as string ?? '');
                break;
        }
    }

    private sendInit(uri: vscode.Uri, state: PanelState): void {
        const cfg = vscode.workspace.getConfiguration('logLens');
        const fr = state.fileReader;
        state.panel.webview.postMessage({
            type: 'init',
            totalLines: fr.totalLines,
            filename: path.basename(uri.fsPath),
            filePath: uri.fsPath,
            levelCounts: fr.levelCounts,
            lineHeight: cfg.get<number>('lineHeight', 22),
            fontSize: cfg.get<number>('fontSize', 13),
            fontFamily: cfg.get<string>('fontFamily', ''),
            renderBuffer: cfg.get<number>('renderBuffer', 100),
        });
        this.handleRequestLines(state, 0, 199, [], false);
    }

    // ─── Inline line editing ────────────────────────────────────────────────────
    private async handleEditLine(state: PanelState, uri: vscode.Uri, lineNum: number, newText: string): Promise<void> {
        if (state.scanning) { return; }
        const filePath = uri.fsPath;

        try {
            // Read the whole file, replace the target line, write back.
            // Pitfalls addressed:
            // • Detect actual line ending (CRLF vs LF) and preserve it
            // • Handle last line (no trailing newline)
            // • Don't add/remove trailing newline accidentally
            const raw = await fs.promises.readFile(filePath);
            const hasCRLF = raw.includes('\r\n' as any) ||
                            state.fileReader.lineEnding === '\r\n';
            const eol = hasCRLF ? '\r\n' : '\n';
            const text = raw.toString('utf8');

            const lineStart = state.fileReader.getLineOffset(lineNum);
            const lineEnd   = state.fileReader.getLineEnd(lineNum);

            if (lineStart < 0) { return; }

            // The bytes [lineStart, lineEnd) cover the line content + its newline.
            // We replace only the content part, keeping the original newline byte(s).
            const before     = text.slice(0, lineStart);
            const afterBlock = text.slice(lineEnd); // everything after the line's newline
            const originalLine = text.slice(lineStart, lineEnd);

            // Detect and preserve trailing newline of THIS line
            let trailingEOL = '';
            if (originalLine.endsWith('\r\n')) { trailingEOL = '\r\n'; }
            else if (originalLine.endsWith('\n')) { trailingEOL = '\n'; }

            const newContent = before + newText + trailingEOL + afterBlock;
            state.lastEditTime = Date.now(); // suppress file watcher re-scan
            await fs.promises.writeFile(filePath, newContent, 'utf8');
        } catch (err) {
            state.panel.webview.postMessage({ type: 'error', message: `Edit failed: ${err}` });
            return;
        }

        // Optimistic update: push new line content to WebView immediately (no re-scan needed)
        state.parsedCache.delete(lineNum);
        state.fileReader.updateCachedLine(lineNum, newText);
        const spans = parseAnsiLine(newText);
        const raw = stripAnsi(newText);
        const level = this.levelOf(raw);
        state.parsedCache.set(lineNum, { spans, level, raw });
        state.panel.webview.postMessage({ type: 'lineUpdated', lineNum, spans, level, raw });
    }

    // ─── Grep filter ─────────────────────────────────────────────────────────────
    private async runGrepFilter(state: PanelState, query: string): Promise<void> {
        state.grepQuery = query;

        if (!query) {
            state.grepIndices = null;
            state.panel.webview.postMessage({ type: 'grepReady', count: state.fileReader.totalLines, query: '' });
            return;
        }

        if (state.scanning) { return; }

        state.panel.webview.postMessage({ type: 'grepScanning', query });

        const fr = state.fileReader;
        const results: number[] = [];
        const q = query.toLowerCase();
        const CHUNK = 5000;

        for (let i = 0; i < fr.totalLines; i += CHUNK) {
            const end = Math.min(i + CHUNK - 1, fr.totalLines - 1);
            try {
                const raws = await fr.readLines(i, end);
                for (let j = 0; j < raws.length; j++) {
                    if (stripAnsi(raws[j]).toLowerCase().includes(q)) {
                        results.push(i + j);
                    }
                }
            } catch { /* skip chunk on error */ }
        }

        state.grepIndices = results;
        state.panel.webview.postMessage({ type: 'grepReady', count: results.length, query });
    }

    // ─── Line requests ──────────────────────────────────────────────────────────
    private async handleRequestLines(
        state: PanelState,
        start: number,
        end: number,
        levelFilter: string[],
        grepActive: boolean
    ): Promise<void> {
        if (state.scanning) { return; }

        const physIndices = this.resolvePhysical(state, levelFilter, grepActive);
        const slice = physIndices.slice(start, end + 1);
        if (slice.length === 0) {
            state.panel.webview.postMessage({ type: 'lines', start, lines: [] });
            return;
        }

        let rawLines: string[];
        try {
            rawLines = await state.fileReader.readLines(slice[0], slice[slice.length - 1]);
        } catch {
            rawLines = slice.map(() => '');
        }

        const lines = slice.map((physIdx, i) => {
            const raw = rawLines[physIdx - slice[0]] ?? '';
            const parsed = this.getParsed(state, physIdx, raw);
            return { lineNum: physIdx, spans: parsed.spans, level: parsed.level, raw: parsed.raw };
        });

        state.panel.webview.postMessage({ type: 'lines', start, lines });
    }

    // ─── Search ─────────────────────────────────────────────────────────────────
    private async handleSearch(state: PanelState, query: string, levelFilter: string[], grepActive: boolean): Promise<void> {
        if (!query || state.scanning) {
            state.panel.webview.postMessage({ type: 'searchResults', indices: [] });
            return;
        }
        const physIndices = this.resolvePhysical(state, levelFilter, grepActive);
        const results: number[] = [];
        const CHUNK = 5000;

        for (let i = 0; i < physIndices.length; i += CHUNK) {
            const batch = physIndices.slice(i, i + CHUNK);
            try {
                const raws = await state.fileReader.readLines(batch[0], batch[batch.length - 1]);
                for (let j = 0; j < batch.length; j++) {
                    const text = stripAnsi(raws[batch[j] - batch[0]] ?? '').toLowerCase();
                    if (text.includes(query)) { results.push(batch[j]); }
                }
            } catch { /* skip */ }
        }
        state.panel.webview.postMessage({ type: 'searchResults', indices: results });
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────────
    private resolvePhysical(state: PanelState, levelFilter: string[], grepActive: boolean): number[] {
        const fr = state.fileReader;
        // Start with level filter
        let base: number[];
        if (!levelFilter || levelFilter.length === 0) {
            base = Array.from({ length: fr.totalLines }, (_, i) => i);
        } else {
            const sets = levelFilter.map((lvl) => (fr.levelIndex as any)[lvl] as number[] ?? []);
            base = sets.length === 1 ? sets[0].slice()
                : Array.from(new Set(sets.flat())).sort((a, b) => a - b);
        }

        // Intersect with grep results if active
        if (grepActive && state.grepIndices) {
            const grepSet = new Set(state.grepIndices);
            base = base.filter((n) => grepSet.has(n));
        }
        return base;
    }

    private getParsed(state: PanelState, physIdx: number, rawLine: string): ParsedLine {
        const hit = state.parsedCache.get(physIdx);
        if (hit) { return hit; }
        const spans = parseAnsiLine(rawLine);
        const raw = stripAnsi(rawLine);
        const level = this.levelOf(raw);
        const parsed: ParsedLine = { spans, level, raw };
        state.parsedCache.set(physIdx, parsed);
        if (state.parsedCache.size > 30_000) {
            const first = state.parsedCache.keys().next().value;
            if (first !== undefined) { state.parsedCache.delete(first); }
        }
        return parsed;
    }

    private levelOf(plain: string): string {
        const t = plain.trimStart();
        if (/^fatal[\s:]/i.test(t))   { return 'fatal'; }
        if (/^error[\s:]/i.test(t))   { return 'error'; }
        if (/^warn[\s:]/i.test(t))    { return 'warn'; }
        if (/^info[\s:]/i.test(t))    { return 'info'; }
        if (/^debug[\s:]/i.test(t))   { return 'debug'; }
        if (/^trace[\s:]/i.test(t))   { return 'trace'; }
        if (/^verbose[\s:]/i.test(t)) { return 'verbose'; }
        return '';
    }

    // ─── HTML ─────────────────────────────────────────────────────────────────────
    private buildHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'logViewer.js'));
        const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'logViewer.css'));
        const nonce = getNonce();

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Log Lens</title>
</head>
<body>
<div id="toolbar">
  <div id="toolbar-left">
    <span id="filename" class="filename" title="">…</span>
    <span id="line-count" class="meta"></span>
  </div>
  <div id="toolbar-center">
    <div id="filter-group">
      <button class="filter-btn active" data-level="all">ALL</button>
      <button class="filter-btn level-fatal" data-level="fatal">FATAL <span class="count" id="cnt-fatal">0</span></button>
      <button class="filter-btn level-error" data-level="error">ERROR <span class="count" id="cnt-error">0</span></button>
      <button class="filter-btn level-warn"  data-level="warn">WARN  <span class="count" id="cnt-warn">0</span></button>
      <button class="filter-btn level-info"  data-level="info">INFO  <span class="count" id="cnt-info">0</span></button>
      <button class="filter-btn level-debug" data-level="debug">DEBUG <span class="count" id="cnt-debug">0</span></button>
      <button class="filter-btn level-trace" data-level="trace">TRACE <span class="count" id="cnt-trace">0</span></button>
    </div>
  </div>
  <div id="toolbar-right">
    <div id="search-wrap">
      <input id="search-input" type="text" placeholder="Search… (Ctrl+F)" spellcheck="false" autocomplete="off">
      <span id="search-results-info"></span>
      <button id="search-prev" class="icon-btn" title="Prev (Shift+F3)">▲</button>
      <button id="search-next" class="icon-btn" title="Next (F3)">▼</button>
    </div>
    <button id="btn-tail" class="icon-btn" title="Follow tail">⬇ Tail</button>
    <button id="btn-raw"  class="icon-btn" title="Open as editable text">✏ Edit Raw</button>
  </div>
</div>

<div id="filter-bar">
  <span class="filter-bar-label">Filter lines:</span>
  <input id="grep-input" type="text" placeholder="Contains text… (Enter to apply)" spellcheck="false" autocomplete="off">
  <button id="grep-clear" class="icon-btn small" title="Clear filter">✕</button>
  <span id="grep-count"></span>
  <span id="grep-status"></span>
</div>

<div id="log-container">
  <div id="log-inner">
    <!-- virtual rows appended here by JS -->
  </div>
</div>

<div id="status-bar">
  <span id="status-left">Scanning…</span>
  <span id="status-right"></span>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) { t += c.charAt(Math.floor(Math.random() * c.length)); }
    return t;
}
