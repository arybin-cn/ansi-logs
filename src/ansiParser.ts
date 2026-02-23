export interface AnsiSpan {
    text: string;
    style: string;
}

// Standard 4-bit foreground colors (One Dark / terminal standard palette)
const FG_COLORS: Record<number, string> = {
    30: '#3c3c3c',
    31: '#e06c75',
    32: '#98c379',
    33: '#e5c07b',
    34: '#61afef',
    35: '#c678dd',
    36: '#56b6c2',
    37: '#abb2bf',
    90: '#5c6370',
    91: '#ff7b87',
    92: '#b5e890',
    93: '#f5d08a',
    94: '#7ec7ff',
    95: '#d98fff',
    96: '#63d4e0',
    97: '#ffffff',
};

// Standard 4-bit background colors
const BG_COLORS: Record<number, string> = {
    40: '#3c3c3c',
    41: '#e06c75',
    42: '#98c379',
    43: '#e5c07b',
    44: '#61afef',
    45: '#c678dd',
    46: '#56b6c2',
    47: '#abb2bf',
    100: '#5c6370',
    101: '#ff7b87',
    102: '#b5e890',
    103: '#f5d08a',
    104: '#7ec7ff',
    105: '#d98fff',
    106: '#63d4e0',
    107: '#ffffff',
};

// 256-color xterm palette lookup
const _256Cache = new Map<number, string>();
function get256Color(n: number): string {
    if (_256Cache.has(n)) { return _256Cache.get(n)!; }
    let result: string;
    if (n < 16) {
        const std = ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0',
                     '#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'];
        result = std[n] ?? '#ffffff';
    } else if (n < 232) {
        const idx = n - 16;
        const b = idx % 6;
        const g = Math.floor(idx / 6) % 6;
        const r = Math.floor(idx / 36);
        const c = (v: number) => Math.round(v === 0 ? 0 : 95 + (v - 1) * 40).toString(16).padStart(2, '0');
        result = `#${c(r)}${c(g)}${c(b)}`;
    } else {
        const level = Math.round((n - 232) * 255 / 23);
        const h = level.toString(16).padStart(2, '0');
        result = `#${h}${h}${h}`;
    }
    _256Cache.set(n, result);
    return result;
}

interface State {
    fg: string | null;
    bg: string | null;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    blink: boolean;
    inverse: boolean;
}

function freshState(): State {
    return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, blink: false, inverse: false };
}

function stateToStyle(s: State): string {
    const parts: string[] = [];
    let fg = s.fg, bg = s.bg;
    if (s.inverse) { [fg, bg] = [bg ?? '#abb2bf', fg ?? '#1e2127']; }
    if (fg) { parts.push(`color:${fg}`); }
    if (bg) { parts.push(`background:${bg}`); }
    if (s.bold) { parts.push('font-weight:bold'); }
    if (s.dim) { parts.push('opacity:0.6'); }
    if (s.italic) { parts.push('font-style:italic'); }
    const deco: string[] = [];
    if (s.underline) { deco.push('underline'); }
    if (s.strike) { deco.push('line-through'); }
    if (deco.length) { parts.push(`text-decoration:${deco.join(' ')}`); }
    if (s.blink) { parts.push('animation:blink 1s step-end infinite'); }
    return parts.join(';');
}

const ANSI_RE = /\x1b\[([\d;]*)m|\x1b\][\s\S]*?(?:\x1b\\|\x07)|\x1b[A-Z]/g;

export function parseAnsiLine(line: string): AnsiSpan[] {
    const spans: AnsiSpan[] = [];
    let state = freshState();
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    ANSI_RE.lastIndex = 0;

    while ((m = ANSI_RE.exec(line)) !== null) {
        // Push text before this escape
        if (m.index > lastIdx) {
            const text = line.slice(lastIdx, m.index);
            if (text) {
                spans.push({ text, style: stateToStyle(state) });
            }
        }
        lastIdx = m.index + m[0].length;

        // Only process SGR (CSI ... m) sequences
        if (!m[1] && m[1] !== '') { continue; }

        const params = m[1] ? m[1].split(';').map(Number) : [0];
        let i = 0;
        while (i < params.length) {
            const p = params[i];
            if (p === 0) {
                state = freshState();
            } else if (p === 1) {
                state.bold = true;
            } else if (p === 2) {
                state.dim = true;
            } else if (p === 3) {
                state.italic = true;
            } else if (p === 4) {
                state.underline = true;
            } else if (p === 5 || p === 6) {
                state.blink = true;
            } else if (p === 7) {
                state.inverse = true;
            } else if (p === 9) {
                state.strike = true;
            } else if (p === 22) {
                state.bold = false; state.dim = false;
            } else if (p === 23) {
                state.italic = false;
            } else if (p === 24) {
                state.underline = false;
            } else if (p === 25) {
                state.blink = false;
            } else if (p === 27) {
                state.inverse = false;
            } else if (p === 29) {
                state.strike = false;
            } else if (p === 38) {
                if (params[i + 1] === 5 && i + 2 < params.length) {
                    state.fg = get256Color(params[i + 2]);
                    i += 2;
                } else if (params[i + 1] === 2 && i + 4 < params.length) {
                    state.fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
                    i += 4;
                }
            } else if (p === 39) {
                state.fg = null;
            } else if (p === 48) {
                if (params[i + 1] === 5 && i + 2 < params.length) {
                    state.bg = get256Color(params[i + 2]);
                    i += 2;
                } else if (params[i + 1] === 2 && i + 4 < params.length) {
                    state.bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
                    i += 4;
                }
            } else if (p === 49) {
                state.bg = null;
            } else if (FG_COLORS[p] !== undefined) {
                state.fg = FG_COLORS[p];
            } else if (BG_COLORS[p] !== undefined) {
                state.bg = BG_COLORS[p];
            }
            i++;
        }
    }

    if (lastIdx < line.length) {
        const text = line.slice(lastIdx);
        if (text) {
            spans.push({ text, style: stateToStyle(state) });
        }
    }

    return spans;
}

export function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[\d;]*[A-Za-z]|\x1b\][\s\S]*?(?:\x1b\\|\x07)|\x1b./g, '');
}

/** Detect log level from a raw line (before or after ANSI stripping) */
export function detectLevel(rawLine: string): string {
    const plain = stripAnsi(rawLine).trimStart();
    if (/^error[\s:]/i.test(plain)) { return 'error'; }
    if (/^warn(?:ing)?[\s:]/i.test(plain)) { return 'warn'; }
    if (/^info[\s:]/i.test(plain)) { return 'info'; }
    if (/^debug[\s:]/i.test(plain)) { return 'debug'; }
    if (/^trace[\s:]/i.test(plain)) { return 'trace'; }
    if (/^verbose[\s:]/i.test(plain)) { return 'verbose'; }
    if (/^fatal[\s:]/i.test(plain)) { return 'fatal'; }
    // Also check embedded level patterns like [ERROR] or ERROR:
    if (/\[error\]|level[=:"']\s*error/i.test(plain)) { return 'error'; }
    if (/\[warn\]|level[=:"']\s*warn/i.test(plain)) { return 'warn'; }
    if (/\[info\]|level[=:"']\s*info/i.test(plain)) { return 'info'; }
    if (/\[debug\]|level[=:"']\s*debug/i.test(plain)) { return 'debug'; }
    if (/\[trace\]|level[=:"']\s*trace/i.test(plain)) { return 'trace'; }
    return '';
}
