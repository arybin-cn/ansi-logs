// Log Lens — WebView Script
// Virtual scrolling, ANSI rendering, inline editing, grep filter, search, tail-follow.
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ─── State ────────────────────────────────────────────────────────────────
    let totalLines   = 0;
    let lineHeight   = 22;
    let fontSize     = 13;
    let fontFamily   = '';
    let renderBuffer = 100;
    let copyOnClick  = true;
    let levelCounts  = {};
    let activeFilter = [];       // level filter: [] = all
    let grepActive   = false;    // true when grep filter is applied
    let filteredCount = 0;
    let filteredLines = [];      // virtual idx → physical line num (undefined = not yet loaded)
    let pendingBatches = new Set();
    let renderedRows = new Map(); // vIdx → DOM row element
    let rowCache = new Map();     // physIdx → {spans, level, raw}
    let tailMode = false;
    let searchQuery  = '';
    let searchResults = [];
    let searchIdx    = -1;
    let editingVIdx  = -1;       // vIdx currently being inline-edited (-1 = none)

    const BATCH = 200;

    // ─── DOM refs ─────────────────────────────────────────────────────────────
    const container  = document.getElementById('log-container');
    const innerEl    = document.getElementById('log-inner');
    const statusLeft = document.getElementById('status-left');
    const statusRight= document.getElementById('status-right');
    const lineCountEl= document.getElementById('line-count');
    const filenameEl = document.getElementById('filename');
    const searchInput= document.getElementById('search-input');
    const searchInfo = document.getElementById('search-results-info');
    const btnTail    = document.getElementById('btn-tail');
    const grepInput  = document.getElementById('grep-input');
    const grepClear  = document.getElementById('grep-clear');
    const grepCount  = document.getElementById('grep-count');
    const grepStatus = document.getElementById('grep-status');

    // ─── Bootstrap ────────────────────────────────────────────────────────────
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });

    // ─── Message handler ──────────────────────────────────────────────────────
    function handleMessage(event) {
        const msg = event.data;
        switch (msg.type) {
            case 'init':        hideScanOverlay(); onInit(msg);                 break;
            case 'lines':       onLines(msg);                                   break;
            case 'lineUpdated': onLineUpdated(msg);                             break;
            case 'docChanged':  hideScanOverlay(); onDocChanged(msg);           break;
            case 'searchResults': onSearchResults(msg.indices);                 break;
            case 'grepReady':   onGrepReady(msg);                               break;
            case 'grepScanning':grepStatus.textContent = 'Filtering…'; break;
            case 'scanning':    showScanOverlay(msg.filename);                  break;
            case 'progress':    updateScanProgress(msg.linesScanned);           break;
            case 'error':       showError(msg.message);                         break;
        }
    }

    // ─── Scanning overlay ─────────────────────────────────────────────────────
    let scanOverlay = null, scanLabel = null;

    function ensureOverlay() {
        if (scanOverlay) { return; }
        scanOverlay = document.createElement('div');
        scanOverlay.id = 'scan-overlay';
        const spinner = document.createElement('div');
        spinner.className = 'scan-spinner';
        scanLabel = document.createElement('div');
        scanLabel.className = 'scan-label';
        scanOverlay.appendChild(spinner);
        scanOverlay.appendChild(scanLabel);
        document.body.appendChild(scanOverlay);
    }
    function showScanOverlay(filename) {
        ensureOverlay();
        scanOverlay.classList.remove('hidden');
        scanLabel.textContent = 'Scanning ' + (filename || '') + '…';
        statusLeft.textContent = 'Scanning…';
    }
    function updateScanProgress(n) {
        if (scanLabel) { scanLabel.textContent = 'Scanning… ' + (n / 1000 | 0) + 'k lines'; }
        statusLeft.textContent = (n / 1000 | 0) + 'k lines scanned…';
    }
    function hideScanOverlay() {
        if (scanOverlay) { scanOverlay.classList.add('hidden'); }
    }
    function showError(msg) {
        hideScanOverlay();
        statusLeft.textContent = '⚠ ' + msg;
    }

    // ─── Init ─────────────────────────────────────────────────────────────────
    function onInit(msg) {
        totalLines   = msg.totalLines;
        lineHeight   = msg.lineHeight  ?? 22;
        fontSize     = msg.fontSize    ?? 13;
        fontFamily   = msg.fontFamily  || '';
        renderBuffer = msg.renderBuffer ?? 100;
        copyOnClick  = msg.copyOnClick !== false;
        levelCounts  = msg.levelCounts || {};

        document.documentElement.style.setProperty('--line-height', lineHeight + 'px');
        document.documentElement.style.setProperty('--font-size', fontSize + 'px');
        if (fontFamily) {
            document.documentElement.style.setProperty('--font-family', fontFamily);
        }
        // Dynamic gutter width based on digits in totalLines
        const digits = String(totalLines).length;
        const gw = Math.max(44, digits * 9 + 14);
        document.documentElement.style.setProperty('--gutter-width', gw + 'px');

        filenameEl.textContent = msg.filename;
        filenameEl.title = msg.filePath;
        updateLevelCountsUI();

        filteredLines = [];
        filteredCount = totalLines;
        grepActive = false;
        grepCount.textContent = '';
        grepStatus.textContent = '';

        updateLayout();
        statusLeft.textContent = 'Ready';
    }

    // ─── Lines received ────────────────────────────────────────────────────────
    function onLines(msg) {
        msg.lines.forEach(function (lineData, i) {
            const vIdx = msg.start + i;
            filteredLines[vIdx] = lineData.lineNum;
            rowCache.set(lineData.lineNum, lineData);
        });
        pendingBatches.delete(msg.start);
        renderVisible();
        updateStatus();
    }

    // ─── Optimistic single-line update after inline edit ──────────────────────
    function onLineUpdated(msg) {
        rowCache.set(msg.lineNum, { lineNum: msg.lineNum, spans: msg.spans, level: msg.level, raw: msg.raw });
        // Find its vIdx and re-render just that row
        const vIdx = filteredLines.indexOf(msg.lineNum);
        if (vIdx >= 0 && renderedRows.has(vIdx)) {
            const old = renderedRows.get(vIdx);
            const newRow = buildRow(vIdx, msg.lineNum, rowCache.get(msg.lineNum));
            old.replaceWith(newRow);
            renderedRows.set(vIdx, newRow);
        }
        cancelEdit(); // ensure edit UI is cleaned up
    }

    // ─── Doc changed (external) ────────────────────────────────────────────────
    function onDocChanged(msg) {
        totalLines = msg.totalLines;
        levelCounts = msg.levelCounts || {};
        updateLevelCountsUI();

        // Recompute gutter width
        const digits = String(totalLines).length;
        document.documentElement.style.setProperty('--gutter-width', Math.max(44, digits * 9 + 14) + 'px');

        // Full reset
        renderedRows.forEach(function (el) { el.remove(); });
        renderedRows.clear();
        rowCache.clear();
        pendingBatches.clear();
        filteredLines = [];
        filteredCount = grepActive ? 0 : computeFilteredCount();
        grepActive = false;
        grepCount.textContent = '';
        grepStatus.textContent = '';
        updateLayout();
        requestRender();

        if (tailMode) { setTimeout(scrollToBottom, 80); }
    }

    // ─── Layout ───────────────────────────────────────────────────────────────
    function computeFilteredCount() {
        if (activeFilter.length === 0) { return totalLines; }
        return activeFilter.reduce(function (sum, lvl) { return sum + (levelCounts[lvl] || 0); }, 0);
    }

    function updateLayout() {
        innerEl.style.height = (filteredCount * lineHeight) + 'px';
        lineCountEl.textContent = filteredCount.toLocaleString() + ' lines';
    }

    // ─── Scroll & Virtual Render ──────────────────────────────────────────────
    var scrollRAF = null;
    container.addEventListener('scroll', function () {
        if (scrollRAF) { cancelAnimationFrame(scrollRAF); }
        scrollRAF = requestAnimationFrame(function () {
            scrollRAF = null;
            requestRender();
            if (tailMode && !isNearBottom()) {
                tailMode = false;
                updateTailButton();
            }
        });
    }, { passive: true });

    function requestRender() {
        const scrollTop = container.scrollTop;
        const clientH   = container.clientHeight;
        const firstVis  = Math.max(0, Math.floor(scrollTop / lineHeight));
        const lastVis   = Math.min(filteredCount - 1, Math.ceil((scrollTop + clientH) / lineHeight));
        const rStart    = Math.max(0, firstVis - renderBuffer);
        const rEnd      = Math.min(filteredCount - 1, lastVis + renderBuffer);

        // Request missing batches
        for (var bStart = Math.floor(rStart / BATCH) * BATCH; bStart <= rEnd; bStart += BATCH) {
            maybeRequestBatch(bStart);
        }

        renderRange(rStart, rEnd);
        evictRows(rStart, rEnd);
    }

    function maybeRequestBatch(bStart) {
        if (pendingBatches.has(bStart)) { return; }
        const bEnd = Math.min(bStart + BATCH - 1, filteredCount - 1);
        // Check if already fully cached
        var allCached = true;
        for (var i = bStart; i <= bEnd; i++) {
            var physIdx = filteredLines[i];
            if (physIdx === undefined || physIdx === null || !rowCache.has(physIdx)) {
                allCached = false;
                break;
            }
        }
        if (allCached) { return; }
        pendingBatches.add(bStart);
        vscode.postMessage({ type: 'requestLines', start: bStart, end: bEnd, filter: activeFilter, grepActive: grepActive });
    }

    function renderRange(start, end) {
        for (var vIdx = start; vIdx <= end; vIdx++) {
            if (renderedRows.has(vIdx)) { continue; }
            if (vIdx === editingVIdx) { continue; } // don't overwrite active edit
            var physIdx = filteredLines[vIdx];
            if (physIdx === undefined || physIdx === null) { continue; }
            var data = rowCache.get(physIdx);
            if (!data) { continue; }
            var row = buildRow(vIdx, physIdx, data);
            innerEl.appendChild(row);
            renderedRows.set(vIdx, row);
        }
    }

    function evictRows(keepStart, keepEnd) {
        var evictBuffer = renderBuffer * 3;
        renderedRows.forEach(function (el, vIdx) {
            if (vIdx < keepStart - evictBuffer || vIdx > keepEnd + evictBuffer) {
                if (vIdx === editingVIdx) { return; } // never evict the row being edited
                el.remove();
                renderedRows.delete(vIdx);
            }
        });
    }

    function renderVisible() {
        var scrollTop = container.scrollTop;
        var clientH   = container.clientHeight;
        var rStart = Math.max(0, Math.floor(scrollTop / lineHeight) - renderBuffer);
        var rEnd   = Math.min(filteredCount - 1, Math.ceil((scrollTop + clientH) / lineHeight) + renderBuffer);
        renderRange(rStart, rEnd);
    }

    // ─── Row building ─────────────────────────────────────────────────────────
    function buildRow(vIdx, physIdx, data) {
        var row = document.createElement('div');
        row.className = 'log-row' + (data.level ? ' level-' + data.level : '');
        row.style.top = (vIdx * lineHeight) + 'px';
        row.dataset.vidx = vIdx;

        // Gutter
        var gutter = document.createElement('span');
        gutter.className = 'gutter';
        gutter.textContent = (physIdx + 1).toString();
        row.appendChild(gutter);

        // Colored content
        var content = document.createElement('span');
        content.className = 'row-content';
        var spans = data.spans || [];
        if (spans.length === 0) {
            content.appendChild(document.createTextNode('\u00a0'));
        } else {
            for (var i = 0; i < spans.length; i++) {
                var span = spans[i];
                if (!span.text) { continue; }
                if (span.style) {
                    var s = document.createElement('span');
                    s.setAttribute('style', span.style);
                    s.textContent = span.text;
                    content.appendChild(s);
                } else {
                    content.appendChild(document.createTextNode(span.text));
                }
            }
        }

        // Search highlight
        if (searchQuery) {
            var isMatch = searchResults.indexOf(physIdx) !== -1;
            if (isMatch) { row.classList.add('search-match'); }
            if (searchResults[searchIdx] === physIdx) { row.classList.add('search-current'); }
        }

        row.appendChild(content);

        // Click → copy plain text
        if (copyOnClick) {
            row.addEventListener('click', function () {
                vscode.postMessage({ type: 'copyText', text: data.raw || '' });
                row.classList.add('copied');
                setTimeout(function () { row.classList.remove('copied'); }, 800);
            });
        }

        // Double-click → inline edit
        row.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            enterEditMode(vIdx, physIdx, data, row);
        });

        return row;
    }

    // ─── Inline editing ───────────────────────────────────────────────────────
    var currentEditInput = null;

    function enterEditMode(vIdx, physIdx, data, row) {
        // Cancel any existing edit
        cancelEdit();
        editingVIdx = vIdx;

        var content = row.querySelector('.row-content');
        if (content) { content.style.visibility = 'hidden'; }

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'row-edit-input';
        input.value = data.raw || '';
        input.style.left = 'var(--gutter-width)';
        row.appendChild(input);
        currentEditInput = input;

        row.classList.add('editing');

        // Focus at end
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);

        function commit() {
            var newText = input.value;
            cleanup();
            vscode.postMessage({ type: 'editLine', lineNum: physIdx, newText: newText });
            // Optimistic: show plain text immediately while server processes
            rowCache.set(physIdx, { lineNum: physIdx, spans: [{ text: newText, style: '' }], level: data.level, raw: newText });
            if (content) { content.style.visibility = ''; }
            var newRow = buildRow(vIdx, physIdx, rowCache.get(physIdx));
            row.replaceWith(newRow);
            renderedRows.set(vIdx, newRow);
        }

        function cancel() {
            cleanup();
            if (content) { content.style.visibility = ''; }
            row.classList.remove('editing');
        }

        function cleanup() {
            if (input.parentNode) { input.remove(); }
            currentEditInput = null;
            editingVIdx = -1;
            row.classList.remove('editing');
        }

        input.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });

        // Blur → cancel (don't auto-save, too risky for log files)
        input.addEventListener('blur', function () {
            setTimeout(cancel, 150); // delay so Enter click doesn't race
        });
    }

    function cancelEdit() {
        if (currentEditInput && currentEditInput.parentNode) {
            var parent = currentEditInput.parentNode;
            parent.classList.remove('editing');
            var hidden = parent.querySelector('.row-content');
            if (hidden) { hidden.style.visibility = ''; }
            currentEditInput.remove();
        }
        currentEditInput = null;
        editingVIdx = -1;
    }

    // ─── Filter buttons ────────────────────────────────────────────────────────
    document.querySelectorAll('.filter-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var level = btn.dataset.level;
            var allBtn = document.querySelector('.filter-btn[data-level="all"]');
            if (level === 'all') {
                activeFilter = [];
                document.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
            } else {
                if (allBtn) { allBtn.classList.remove('active'); }
                btn.classList.toggle('active');
                var levels = [];
                document.querySelectorAll('.filter-btn.active').forEach(function (b) {
                    if (b.dataset.level !== 'all') { levels.push(b.dataset.level); }
                });
                activeFilter = levels;
                if (activeFilter.length === 0) {
                    activeFilter = [];
                    if (allBtn) { allBtn.classList.add('active'); }
                }
            }
            applyFilter();
        });
    });

    function applyFilter() {
        renderedRows.forEach(function (el) { el.remove(); });
        renderedRows.clear();
        rowCache.clear();
        pendingBatches.clear();
        filteredLines = [];
        filteredCount = computeFilteredCount();
        updateLayout();
        requestRender();
    }

    // ─── Grep / line filter ────────────────────────────────────────────────────
    var grepDebounce = null;

    grepInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            clearTimeout(grepDebounce);
            runGrep();
        }
        if (e.key === 'Escape') {
            clearGrepFilter();
        }
    });

    grepInput.addEventListener('input', function () {
        clearTimeout(grepDebounce);
        if (!grepInput.value) { clearGrepFilter(); return; }
        grepDebounce = setTimeout(runGrep, 400);
    });

    grepClear.addEventListener('click', function () {
        grepInput.value = '';
        clearGrepFilter();
    });

    function runGrep() {
        var q = grepInput.value.trim();
        if (!q) { clearGrepFilter(); return; }
        grepStatus.textContent = 'Filtering…';
        grepCount.textContent = '';
        vscode.postMessage({ type: 'grepFilter', query: q });
    }

    function clearGrepFilter() {
        grepActive = false;
        grepStatus.textContent = '';
        grepCount.textContent = '';
        renderedRows.forEach(function (el) { el.remove(); });
        renderedRows.clear();
        rowCache.clear();
        pendingBatches.clear();
        filteredLines = [];
        filteredCount = computeFilteredCount();
        updateLayout();
        requestRender();
        vscode.postMessage({ type: 'grepFilter', query: '' });
    }

    function onGrepReady(msg) {
        grepActive = msg.query !== '';
        filteredLines = [];
        filteredCount = msg.count;
        grepStatus.textContent = grepActive ? '✓' : '';
        grepCount.textContent = grepActive ? msg.count.toLocaleString() + ' matches' : '';
        renderedRows.forEach(function (el) { el.remove(); });
        renderedRows.clear();
        rowCache.clear();
        pendingBatches.clear();
        updateLayout();
        requestRender();
    }

    // ─── Level count UI ────────────────────────────────────────────────────────
    function updateLevelCountsUI() {
        Object.keys(levelCounts).forEach(function (lvl) {
            var el = document.getElementById('cnt-' + lvl);
            if (el) { el.textContent = (levelCounts[lvl] || 0).toLocaleString(); }
        });
    }

    // ─── Tail ─────────────────────────────────────────────────────────────────
    btnTail.addEventListener('click', function () {
        tailMode = !tailMode;
        updateTailButton();
        if (tailMode) { scrollToBottom(); }
    });

    function updateTailButton() {
        btnTail.classList.toggle('active', tailMode);
        btnTail.textContent = tailMode ? '\u2B07 Tail ON' : '\u2B07 Tail';
    }

    function scrollToBottom() { container.scrollTop = container.scrollHeight; }
    function isNearBottom() { return container.scrollTop + container.clientHeight >= container.scrollHeight - lineHeight * 5; }

    // ─── Edit Raw ─────────────────────────────────────────────────────────────
    document.getElementById('btn-raw').addEventListener('click', function () {
        vscode.postMessage({ type: 'editRaw' });
    });

    // ─── Search ───────────────────────────────────────────────────────────────
    var searchDebounce = null;

    searchInput.addEventListener('input', function () {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(function () {
            searchQuery = searchInput.value;
            if (!searchQuery) { clearSearch(); return; }
            vscode.postMessage({ type: 'search', query: searchQuery, filter: activeFilter, grepActive: grepActive });
        }, 300);
    });

    document.getElementById('search-prev').addEventListener('click', function () { navigateSearch(-1); });
    document.getElementById('search-next').addEventListener('click', function () { navigateSearch(1); });

    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
        if (e.key === 'Escape' && document.activeElement !== grepInput) { clearSearch(); searchInput.value = ''; }
        if (e.key === 'F3' || (e.key === 'Enter' && document.activeElement === searchInput)) {
            e.preventDefault(); navigateSearch(e.shiftKey ? -1 : 1);
        }
    });

    function onSearchResults(indices) {
        searchResults = indices;
        searchIdx = indices.length > 0 ? 0 : -1;
        updateSearchInfo();
        if (searchIdx >= 0) { scrollToPhysLine(searchResults[searchIdx]); }
        redrawAllRows();
    }

    function navigateSearch(dir) {
        if (!searchResults.length) { return; }
        searchIdx = (searchIdx + dir + searchResults.length) % searchResults.length;
        updateSearchInfo();
        scrollToPhysLine(searchResults[searchIdx]);
        redrawAllRows();
    }

    function updateSearchInfo() {
        if (!searchQuery || !searchResults.length) { searchInfo.textContent = searchQuery ? 'No results' : ''; return; }
        searchInfo.textContent = (searchIdx + 1) + ' / ' + searchResults.length;
    }

    function clearSearch() {
        searchQuery = '';
        searchResults = [];
        searchIdx = -1;
        searchInfo.textContent = '';
        redrawAllRows();
    }

    function scrollToPhysLine(physIdx) {
        var vIdx = filteredLines.indexOf(physIdx);
        if (vIdx < 0) { return; }
        container.scrollTop = Math.max(0, vIdx * lineHeight - container.clientHeight / 2 + lineHeight / 2);
    }

    function redrawAllRows() {
        renderedRows.forEach(function (el) { el.remove(); });
        renderedRows.clear();
        renderVisible();
    }

    // ─── Status ───────────────────────────────────────────────────────────────
    function updateStatus() {
        statusLeft.textContent = rowCache.size.toLocaleString() + ' lines loaded';
        statusRight.textContent = (activeFilter.length ? 'Level: ' + activeFilter.join('+') : '') +
                                  (grepActive ? ' | Grep active' : '');
    }

}());
