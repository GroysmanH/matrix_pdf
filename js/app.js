/* ===== Matrix Builder — Main Application ===== */

(function () {
    'use strict';

    // ===== State =====
    const state = {
        pdfFile: null,
        pdfText: '',
        blocks: [],          // { id, label, text }
        matrixConfig: null,   // { title, xLabel, yLabel, cols, rows, theme, cellSize }
        cellData: {},         // { "row-col": [blockId, ...] }
        apiKey: localStorage.getItem('claude_api_key') || '',
        model: localStorage.getItem('claude_model') || 'claude-sonnet-4-6',
        currentStep: 1
    };

    // ===== DOM Refs =====
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ===== Toast =====
    function toast(msg, type = '') {
        const el = $('#toast');
        el.textContent = msg;
        el.className = 'toast show' + (type ? ' ' + type : '');
        setTimeout(() => el.className = 'toast', 3000);
    }

    // ===== Step Navigation =====
    function goToStep(step) {
        state.currentStep = step;
        $$('.step-content').forEach(s => s.classList.remove('active'));
        $(`#step-${step}`).classList.add('active');

        $$('.steps-bar .step').forEach(s => {
            const sNum = +s.dataset.step;
            s.classList.remove('active', 'done');
            if (sNum === step) s.classList.add('active');
            else if (sNum < step) s.classList.add('done');
        });
    }

    // ===== PDF Parsing =====
    async function extractPdfText(file) {
        const arrayBuffer = await file.arrayBuffer();
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map(item => item.str).join(' ') + '\n\n';
        }
        return text;
    }

    // ===== Claude API =====
    async function callClaude(pdfText, userPrompt) {
        if (!state.apiKey) {
            throw new Error('Please set your Claude API key first (click "API Key" in the header).');
        }

        const systemPrompt = `You are a document analysis assistant. The user will provide text extracted from a PDF and a prompt describing what text blocks they want extracted.

Your job is to extract distinct blocks of text from the document that match the user's request. Return ONLY valid JSON — no markdown, no code fences.

Return a JSON array of objects with this structure:
[
  { "label": "Short descriptive label", "text": "The actual extracted text content" },
  ...
]

Rules:
- Each block should be a meaningful, self-contained piece of text
- Labels should be concise (2-5 words)
- Extract between 3 and 20 blocks depending on content
- Keep the original text as faithfully as possible
- If you can't find relevant content, return an empty array []`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': state.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: state.model,
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{
                    role: 'user',
                    content: `Here is the PDF text:\n\n---\n${pdfText.substring(0, 80000)}\n---\n\nUser's extraction request: ${userPrompt}`
                }]
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `API error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.content[0].text;

        // Parse JSON from response (handle potential markdown wrapping)
        let jsonStr = content;
        const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1];

        const blocks = JSON.parse(jsonStr.trim());
        if (!Array.isArray(blocks)) throw new Error('Invalid response format');
        return blocks.map((b, i) => ({
            id: 'block-' + i,
            label: b.label || `Block ${i + 1}`,
            text: b.text || ''
        }));
    }

    // ===== File Upload =====
    function initUpload() {
        const dropZone = $('#drop-zone');
        const fileInput = $('#file-input');

        dropZone.addEventListener('click', () => fileInput.click());

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') handleFile(file);
            else toast('Please upload a PDF file', 'error');
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) handleFile(fileInput.files[0]);
        });
    }

    function handleFile(file) {
        state.pdfFile = file;
        $('#file-name').textContent = file.name + ` (${(file.size / 1024).toFixed(0)} KB)`;
        $('#drop-zone').classList.add('has-file');
        updateAnalyzeBtn();
    }

    function updateAnalyzeBtn() {
        $('#btn-analyze').disabled = !(state.pdfFile && $('#user-prompt').value.trim());
    }

    // ===== Analyze =====
    async function handleAnalyze() {
        const prompt = $('#user-prompt').value.trim();
        if (!state.pdfFile || !prompt) return;

        $('#btn-analyze').disabled = true;
        $('#loading-state').style.display = 'block';

        try {
            state.pdfText = await extractPdfText(state.pdfFile);
            const blocks = await callClaude(state.pdfText, prompt);
            if (!blocks.length) {
                toast('No relevant blocks found. Try a different prompt.', 'error');
                return;
            }
            state.blocks = blocks;
            toast(`Extracted ${blocks.length} blocks!`, 'success');
            goToStep(2);
        } catch (err) {
            toast(err.message, 'error');
            console.error(err);
        } finally {
            $('#btn-analyze').disabled = false;
            $('#loading-state').style.display = 'none';
            updateAnalyzeBtn();
        }
    }

    // ===== Matrix Config =====
    function buildMatrix() {
        const cols = $('#col-headers').value.trim().split('\n').filter(Boolean);
        const rows = $('#row-headers').value.trim().split('\n').filter(Boolean);

        if (cols.length < 1 || rows.length < 1) {
            toast('Please add at least 1 column and 1 row header.', 'error');
            return;
        }

        state.matrixConfig = {
            title: $('#matrix-title').value.trim() || 'My Matrix',
            xLabel: $('#x-axis-label').value.trim(),
            yLabel: $('#y-axis-label').value.trim(),
            cols,
            rows,
            theme: $('#color-theme').value,
            cellSize: $('#cell-size').value
        };

        state.cellData = {};
        renderBlocks();
        renderMatrix();
        goToStep(3);
    }

    // ===== Render Blocks Panel =====
    function renderBlocks() {
        const list = $('#blocks-list');
        list.innerHTML = '';

        const placedBlockIds = new Set();
        Object.values(state.cellData).forEach(ids => ids.forEach(id => placedBlockIds.add(id)));

        const searchTerm = ($('#block-search')?.value || '').toLowerCase();

        state.blocks.forEach(block => {
            if (searchTerm && !block.text.toLowerCase().includes(searchTerm) && !block.label.toLowerCase().includes(searchTerm)) {
                return;
            }

            const el = document.createElement('div');
            el.className = 'block-item' + (placedBlockIds.has(block.id) ? ' placed' : '');
            el.draggable = true;
            el.dataset.blockId = block.id;
            el.innerHTML = `
                <div class="block-label">${escapeHtml(block.label)}</div>
                <div class="block-text">${escapeHtml(block.text)}</div>
            `;

            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', block.id);
                el.classList.add('dragging');
            });

            el.addEventListener('dragend', () => {
                el.classList.remove('dragging');
            });

            list.appendChild(el);
        });

        $('#block-count').textContent = `${state.blocks.length} blocks`;
    }

    // ===== Render Matrix =====
    function renderMatrix() {
        const { title, xLabel, yLabel, cols, rows, theme, cellSize } = state.matrixConfig;
        const container = $('#matrix-container');

        $('#matrix-title-display').textContent = title;

        const maxHeat = cols.length + rows.length - 2;

        let html = `<div class="matrix-wrapper theme-${theme}">`;

        if (xLabel) html += `<div class="matrix-x-label">${escapeHtml(xLabel)}</div>`;
        if (yLabel) html += `<div class="matrix-y-label">${escapeHtml(yLabel)}</div>`;

        html += '<table class="matrix-table">';

        // Header row
        html += '<thead><tr><th class="corner"></th>';
        cols.forEach(col => {
            html += `<th>${escapeHtml(col)}</th>`;
        });
        html += '</tr></thead>';

        // Body
        html += '<tbody>';
        rows.forEach((row, ri) => {
            html += '<tr>';
            html += `<th class="row-header">${escapeHtml(row)}</th>`;
            cols.forEach((col, ci) => {
                const key = `${ri}-${ci}`;
                const heat = Math.min(5, Math.round(((ri + ci) / Math.max(maxHeat, 1)) * 5) + 1);
                const cellBlocks = (state.cellData[key] || []).map(id => state.blocks.find(b => b.id === id)).filter(Boolean);

                html += `<td class="matrix-cell cell-${cellSize}" data-cell="${key}" data-heat="${heat}">`;
                html += '<div class="cell-blocks">';
                cellBlocks.forEach(b => {
                    html += `<div class="cell-block" draggable="true" data-block-id="${b.id}" data-source-cell="${key}">
                        ${escapeHtml(b.text.substring(0, 120))}${b.text.length > 120 ? '...' : ''}
                        <button class="cell-block-remove" data-block-id="${b.id}" data-cell="${key}">&times;</button>
                    </div>`;
                });
                html += '</div></td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';

        container.innerHTML = html;

        // Setup drag & drop on cells
        container.querySelectorAll('.matrix-cell').forEach(cell => {
            cell.addEventListener('dragover', (e) => {
                e.preventDefault();
                cell.classList.add('drag-over');
            });

            cell.addEventListener('dragleave', () => {
                cell.classList.remove('drag-over');
            });

            cell.addEventListener('drop', (e) => {
                e.preventDefault();
                cell.classList.remove('drag-over');
                const blockId = e.dataTransfer.getData('text/plain');
                const sourceCell = e.dataTransfer.getData('source-cell');
                const cellKey = cell.dataset.cell;

                if (!blockId) return;

                // Remove from source cell if moving between cells
                if (sourceCell) {
                    state.cellData[sourceCell] = (state.cellData[sourceCell] || []).filter(id => id !== blockId);
                }

                // Remove from any other cell (a block can only be in one cell)
                Object.keys(state.cellData).forEach(key => {
                    state.cellData[key] = state.cellData[key].filter(id => id !== blockId);
                });

                // Add to target cell
                if (!state.cellData[cellKey]) state.cellData[cellKey] = [];
                state.cellData[cellKey].push(blockId);

                renderMatrix();
                renderBlocks();
            });
        });

        // Cell block drag (for moving between cells)
        container.querySelectorAll('.cell-block[draggable]').forEach(el => {
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', el.dataset.blockId);
                e.dataTransfer.setData('source-cell', el.dataset.sourceCell);
            });
        });

        // Remove buttons
        container.querySelectorAll('.cell-block-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const blockId = btn.dataset.blockId;
                const cellKey = btn.dataset.cell;
                state.cellData[cellKey] = (state.cellData[cellKey] || []).filter(id => id !== blockId);
                renderMatrix();
                renderBlocks();
            });
        });
    }

    // ===== Export Preview =====
    function renderExportPreview() {
        const { title, xLabel, yLabel, cols, rows, theme, cellSize } = state.matrixConfig;
        const preview = $('#export-preview');
        const maxHeat = cols.length + rows.length - 2;

        let html = `<div class="export-matrix-title">${escapeHtml(title)}</div>`;
        html += `<div class="matrix-wrapper theme-${theme}" id="export-matrix-content">`;

        if (xLabel) html += `<div class="matrix-x-label">${escapeHtml(xLabel)}</div>`;
        if (yLabel) html += `<div class="matrix-y-label">${escapeHtml(yLabel)}</div>`;

        html += '<table class="matrix-table">';
        html += '<thead><tr><th class="corner"></th>';
        cols.forEach(col => html += `<th>${escapeHtml(col)}</th>`);
        html += '</tr></thead><tbody>';

        rows.forEach((row, ri) => {
            html += '<tr>';
            html += `<th class="row-header">${escapeHtml(row)}</th>`;
            cols.forEach((col, ci) => {
                const key = `${ri}-${ci}`;
                const heat = Math.min(5, Math.round(((ri + ci) / Math.max(maxHeat, 1)) * 5) + 1);
                const cellBlocks = (state.cellData[key] || []).map(id => state.blocks.find(b => b.id === id)).filter(Boolean);
                html += `<td class="matrix-cell cell-${cellSize}" data-heat="${heat}">`;
                html += '<div class="cell-blocks">';
                cellBlocks.forEach(b => {
                    html += `<div class="cell-block">${escapeHtml(b.text.substring(0, 200))}${b.text.length > 200 ? '...' : ''}</div>`;
                });
                html += '</div></td>';
            });
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        preview.innerHTML = html;
    }

    // ===== PDF Export =====
    async function exportPdf() {
        const btn = $('#btn-download-pdf');
        btn.disabled = true;
        btn.textContent = 'Generating PDF...';

        try {
            const orientation = $('#export-orientation').value;
            const pageSize = $('#export-size').value;
            const preview = $('#export-preview');

            const canvas = await html2canvas(preview, {
                scale: 2,
                useCORS: true,
                backgroundColor: '#ffffff',
                logging: false
            });

            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({
                orientation,
                unit: 'mm',
                format: pageSize
            });

            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const margin = 10;
            const maxW = pageWidth - margin * 2;
            const maxH = pageHeight - margin * 2;

            const imgRatio = canvas.width / canvas.height;
            let w = maxW;
            let h = w / imgRatio;

            if (h > maxH) {
                h = maxH;
                w = h * imgRatio;
            }

            const x = (pageWidth - w) / 2;
            const y = (pageHeight - h) / 2;

            pdf.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, w, h);

            const fileName = (state.matrixConfig?.title || 'matrix').replace(/[^a-z0-9]/gi, '_').toLowerCase();
            pdf.save(`${fileName}.pdf`);

            toast('PDF downloaded!', 'success');
        } catch (err) {
            toast('Export failed: ' + err.message, 'error');
            console.error(err);
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download PDF`;
        }
    }

    // ===== API Key Modal =====
    function initApiModal() {
        $('#btn-api-settings').addEventListener('click', () => {
            $('#api-key-input').value = state.apiKey;
            $('#model-select').value = state.model;
            $('#api-modal').style.display = 'flex';
        });

        $('#btn-cancel-api').addEventListener('click', () => {
            $('#api-modal').style.display = 'none';
        });

        $('#btn-save-api').addEventListener('click', () => {
            state.apiKey = $('#api-key-input').value.trim();
            state.model = $('#model-select').value;
            localStorage.setItem('claude_api_key', state.apiKey);
            localStorage.setItem('claude_model', state.model);
            $('#api-modal').style.display = 'none';
            toast(state.apiKey ? 'API key saved!' : 'API key cleared.', 'success');
        });

        // Close on overlay click
        $('#api-modal').addEventListener('click', (e) => {
            if (e.target === $('#api-modal')) $('#api-modal').style.display = 'none';
        });
    }

    // ===== Helpers =====
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ===== Init =====
    function init() {
        initUpload();
        initApiModal();

        // Prompt input -> enable button
        $('#user-prompt').addEventListener('input', updateAnalyzeBtn);

        // Analyze
        $('#btn-analyze').addEventListener('click', handleAnalyze);

        // Step 2 -> Build Matrix
        $('#btn-build-matrix').addEventListener('click', buildMatrix);

        // Back buttons
        $('#btn-back-1').addEventListener('click', () => goToStep(1));
        $('#btn-back-2').addEventListener('click', () => goToStep(2));
        $('#btn-back-3').addEventListener('click', () => goToStep(3));

        // Block search
        $('#block-search').addEventListener('input', renderBlocks);

        // Clear matrix
        $('#btn-clear-matrix').addEventListener('click', () => {
            state.cellData = {};
            renderMatrix();
            renderBlocks();
            toast('Matrix cleared');
        });

        // To export
        $('#btn-to-export').addEventListener('click', () => {
            renderExportPreview();
            goToStep(4);
        });

        // Download PDF
        $('#btn-download-pdf').addEventListener('click', exportPdf);
    }

    // Start
    document.addEventListener('DOMContentLoaded', init);
})();
