import * as fs from 'fs';
import { detectLevel } from './ansiParser';

/* ------------------------------------------------------------------ */
/*  Public interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface LevelIndex {
    fatal: number[];
    error: number[];
    warn: number[];
    info: number[];
    debug: number[];
    trace: number[];
    verbose: number[];
    other: number[];
}

export interface LevelCounts {
    fatal: number;
    error: number;
    warn: number;
    info: number;
    debug: number;
    trace: number;
    verbose: number;
    other: number;
}

export function buildLevelCounts(index: LevelIndex): LevelCounts {
    return {
        fatal: index.fatal.length,
        error: index.error.length,
        warn: index.warn.length,
        info: index.info.length,
        debug: index.debug.length,
        trace: index.trace.length,
        verbose: index.verbose.length,
        other: index.other.length,
    };
}

/* ------------------------------------------------------------------ */
/*  LRU line cache                                                     */
/* ------------------------------------------------------------------ */

const LRU_CAPACITY = 20_000;

/**
 * Simple LRU cache keyed by line number, storing raw line strings.
 * Uses a Map (insertion-ordered) for O(1) get/set/evict.
 */
class LineCache {
    private map = new Map<number, string>();

    get(lineNum: number): string | undefined {
        const val = this.map.get(lineNum);
        if (val === undefined) { return undefined; }
        // Move to end (most recently used)
        this.map.delete(lineNum);
        this.map.set(lineNum, val);
        return val;
    }

    set(lineNum: number, value: string): void {
        if (this.map.has(lineNum)) {
            this.map.delete(lineNum);
        }
        this.map.set(lineNum, value);
        if (this.map.size > LRU_CAPACITY) {
            // Evict oldest (first key)
            const first = this.map.keys().next().value;
            if (first !== undefined) {
                this.map.delete(first);
            }
        }
    }

    clear(): void {
        this.map.clear();
    }
}

/* ------------------------------------------------------------------ */
/*  Offset storage abstraction                                         */
/* ------------------------------------------------------------------ */

/**
 * Wrapper over Uint32Array or BigInt64Array so the rest of the code
 * can use a uniform API regardless of file size.
 */
interface OffsetArray {
    length: number;
    get(index: number): number;
    push(value: number): void;
    /** Freeze into a compact typed array (no further pushes). */
    compact(): void;
}

function createSmallOffsets(): OffsetArray {
    let arr: number[] = [];
    let frozen: Uint32Array | null = null;
    return {
        get length() { return frozen ? frozen.length : arr.length; },
        get(i: number): number { return frozen ? frozen[i] : arr[i]; },
        push(v: number) { arr.push(v); },
        compact() { frozen = new Uint32Array(arr); arr = []; },
    };
}

function createLargeOffsets(): OffsetArray {
    let arr: number[] = [];
    let frozen: Float64Array | null = null; // Float64 holds integers up to 2^53 exactly
    return {
        get length() { return frozen ? frozen.length : arr.length; },
        get(i: number): number { return frozen ? frozen[i] : arr[i]; },
        push(v: number) { arr.push(v); },
        compact() { frozen = new Float64Array(arr); arr = []; },
    };
}

/* ------------------------------------------------------------------ */
/*  FileReader                                                         */
/* ------------------------------------------------------------------ */

const CHUNK_SIZE = 64 * 1024; // 64 KB
const PROGRESS_INTERVAL = 50_000;
const MAX_UINT32 = 0xFFFFFFFF; // 4 GB - 1 byte

export class FileReader {
    private readonly filePath: string;
    private fd: number | null = null;
    private offsets: OffsetArray | null = null;
    private _levelIndex: LevelIndex | null = null;
    private _levelCounts: LevelCounts | null = null;
    private cache = new LineCache();
    private _totalLines = 0;
    private fileSize = 0;
    private _crlf = false;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /* -------------------------------------------------------------- */
    /*  Scan                                                           */
    /* -------------------------------------------------------------- */

    async scan(onProgress?: (n: number) => void): Promise<void> {
        const stat = fs.statSync(this.filePath);
        this.fileSize = stat.size;

        // Choose offset storage based on file size
        const offsets = this.fileSize > MAX_UINT32
            ? createLargeOffsets()
            : createSmallOffsets();

        const levelIdx: LevelIndex = {
            fatal: [], error: [], warn: [], info: [],
            debug: [], trace: [], verbose: [], other: [],
        };

        // Open file handle (kept open for later reads)
        this.fd = fs.openSync(this.filePath, 'r');

        const buf = Buffer.alloc(CHUNK_SIZE);
        let filePos = 0;
        let lineCount = 0;
        let lineStart = 0; // byte offset where current line begins

        // First line always starts at offset 0
        offsets.push(0);

        // Accumulator for partial line at end of chunk (bytes)
        let partial = Buffer.alloc(0);

        while (filePos < this.fileSize) {
            const toRead = Math.min(CHUNK_SIZE, this.fileSize - filePos);
            const bytesRead = fs.readSync(this.fd, buf, 0, toRead, filePos);
            if (bytesRead === 0) { break; }

            // Prepend leftover from previous chunk
            const chunk = partial.length > 0
                ? Buffer.concat([partial, buf.subarray(0, bytesRead)])
                : buf.subarray(0, bytesRead);

            const chunkBaseOffset = filePos - partial.length;
            partial = Buffer.alloc(0);

            let i = 0;
            while (i < chunk.length) {
                const byte = chunk[i];
                if (byte === 0x0A) { // \n
                    // Complete line: from lineStart to just before LF
                    // Extract line text for level detection
                    const lineEndInChunk = i;
                    const lineStartInChunk = lineStart - chunkBaseOffset;

                    if (lineStartInChunk >= 0 && lineStartInChunk <= chunk.length) {
                        let endIdx = lineEndInChunk;
                        // Strip trailing \r if CRLF
                        if (endIdx > lineStartInChunk && chunk[endIdx - 1] === 0x0D) {
                            endIdx--;
                            this._crlf = true;
                        }
                        const lineText = chunk.toString('utf8', lineStartInChunk, endIdx);
                        const level = detectLevel(lineText) || 'other';
                        levelIdx[level as keyof LevelIndex].push(lineCount);
                    }

                    lineCount++;
                    lineStart = chunkBaseOffset + i + 1; // byte after \n
                    offsets.push(lineStart);

                    if (lineCount % PROGRESS_INTERVAL === 0 && onProgress) {
                        onProgress(lineCount);
                    }

                    i++;
                } else {
                    i++;
                }
            }

            // If the last line in this chunk is incomplete, save it as partial
            const processedUpTo = chunkBaseOffset + chunk.length;
            if (lineStart < processedUpTo) {
                const unprocessedStart = lineStart - chunkBaseOffset;
                if (unprocessedStart >= 0 && unprocessedStart < chunk.length) {
                    partial = Buffer.from(chunk.subarray(unprocessedStart));
                }
            }

            filePos += bytesRead;
        }

        // Handle final line (no trailing newline)
        if (partial.length > 0) {
            // There's content after the last newline — it's the last line
            let lineText = partial.toString('utf8');
            // Strip trailing \r
            if (lineText.endsWith('\r')) {
                lineText = lineText.slice(0, -1);
            }
            const level = detectLevel(lineText) || 'other';
            levelIdx[level as keyof LevelIndex].push(lineCount);
            lineCount++;

            if (lineCount % PROGRESS_INTERVAL === 0 && onProgress) {
                onProgress(lineCount);
            }
        } else if (this.fileSize > 0) {
            // File ended with a newline — the last offset points past EOF.
            // Remove that trailing empty-line offset if the last byte was \n,
            // since there's no actual content line there.
            // Actually keep the offset array as-is; the "last offset" serves
            // as the upper bound for reading the final real line.
        }

        // For empty files, lineCount stays 0 and offsets has just [0]
        if (this.fileSize === 0) {
            lineCount = 0;
            // offsets already has [0], that's fine — we just report 0 lines
        }

        offsets.compact();
        this.offsets = offsets;
        this._levelIndex = levelIdx;
        this._levelCounts = buildLevelCounts(levelIdx);
        this._totalLines = lineCount;

        // Final progress callback
        if (onProgress) {
            onProgress(lineCount);
        }
    }

    /* -------------------------------------------------------------- */
    /*  Accessors                                                      */
    /* -------------------------------------------------------------- */

    get totalLines(): number {
        return this._totalLines;
    }

    get levelIndex(): LevelIndex {
        if (!this._levelIndex) {
            throw new Error('FileReader: scan() must be called before accessing levelIndex');
        }
        return this._levelIndex;
    }

    get levelCounts(): LevelCounts {
        if (!this._levelCounts) {
            throw new Error('FileReader: scan() must be called before accessing levelCounts');
        }
        return this._levelCounts;
    }

    /** Byte offset where line N starts in the file. */
    getLineOffset(lineNum: number): number {
        if (!this.offsets || lineNum < 0 || lineNum >= this._totalLines) { return -1; }
        return this.offsets.get(lineNum);
    }

    /** Byte offset of the first byte AFTER line N (i.e. start of line N+1, or EOF). */
    getLineEnd(lineNum: number): number {
        if (!this.offsets) { return this.fileSize; }
        if (lineNum + 1 < this.offsets.length) {
            return this.offsets.get(lineNum + 1);
        }
        return this.fileSize;
    }

    get fileByteSize(): number { return this.fileSize; }
    get lineEnding(): '\r\n' | '\n' { return this._crlf ? '\r\n' : '\n'; }

    /* -------------------------------------------------------------- */
    /*  On-demand line reads                                           */
    /* -------------------------------------------------------------- */

    async readLines(start: number, end: number): Promise<string[]> {
        if (!this.offsets || this.fd === null) {
            throw new Error('FileReader: scan() must be called before readLines()');
        }

        // Clamp to valid range
        const s = Math.max(0, start);
        const e = Math.min(end, this._totalLines - 1);
        if (s > e) { return []; }

        // Check cache for all requested lines
        const result: (string | null)[] = new Array(e - s + 1).fill(null);
        let allCached = true;
        for (let i = s; i <= e; i++) {
            const cached = this.cache.get(i);
            if (cached !== undefined) {
                result[i - s] = cached;
            } else {
                allCached = false;
            }
        }
        if (allCached) {
            return result as string[];
        }

        // Determine byte range to read
        const byteStart = this.offsets.get(s);
        let byteEnd: number;
        if (e + 1 < this.offsets.length) {
            byteEnd = this.offsets.get(e + 1);
        } else {
            byteEnd = this.fileSize;
        }
        const length = byteEnd - byteStart;
        if (length <= 0) {
            // All lines are empty
            const empties: string[] = new Array(e - s + 1).fill('');
            for (let i = s; i <= e; i++) {
                this.cache.set(i, '');
            }
            return empties;
        }

        // Read the byte range
        const readBuf = Buffer.alloc(length);
        const bytesRead = fs.readSync(this.fd, readBuf, 0, length, byteStart);

        // Decode and split
        const text = readBuf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');

        // Remove trailing empty element if text ended with \n
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        // Strip \r from each line (CRLF handling)
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].endsWith('\r')) {
                lines[i] = lines[i].slice(0, -1);
            }
        }

        // Populate cache and result
        const output: string[] = [];
        for (let i = 0; i < e - s + 1; i++) {
            const line = i < lines.length ? lines[i] : '';
            this.cache.set(s + i, line);
            output.push(line);
        }

        return output;
    }

    /** Directly update the LRU cache for a line (used after an in-place edit). */
    updateCachedLine(lineNum: number, text: string): void {
        this.cache.set(lineNum, text);
    }

    /* -------------------------------------------------------------- */
    /*  Cleanup                                                        */
    /* -------------------------------------------------------------- */

    dispose(): void {
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
            } catch {
                // Ignore close errors
            }
            this.fd = null;
        }
        this.cache.clear();
        this.offsets = null;
        this._levelIndex = null;
        this._levelCounts = null;
    }
}
