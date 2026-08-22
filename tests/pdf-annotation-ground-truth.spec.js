const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const graphRoot = process.env.LOGSEQ_GRAPH_PATH || path.resolve(root, '..', 'logseq');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pdf-ground-truth-'));
const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
const browser = candidates.find(file => fs.existsSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const targetUuid = '6a7fa898-739b-4712-9b56-10054350ed9d';
const targetText = '위험물화재의 특수현상과 대처법';

function markdownFiles(directory) {
    if(!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        if(entry.isDirectory()) return markdownFiles(file);
        return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [file] : [];
    });
}

function buildSourceGroundTruth() {
    if(!fs.existsSync(graphRoot)) throw new Error(`Logseq graph unavailable: ${graphRoot}`);
    const payload = JSON.parse(fs.readFileSync(path.join(root, 'pdf-annotations.json'), 'utf8'));
    const annotationUuids = new Set(Object.keys(payload.annotations || {}).map(uuid => uuid.toLowerCase()));
    const references = [];
    for(const file of [...markdownFiles(path.join(graphRoot, 'pages')), ...markdownFiles(path.join(graphRoot, 'journals'))]) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            for(const match of line.matchAll(/\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)/ig)) {
                const uuid = match[1].toLowerCase();
                if(annotationUuids.has(uuid)) references.push({
                    uuid,
                    file: path.relative(graphRoot, file),
                    line: index + 1
                });
            }
        });
    }
    const referencedUuids = [...new Set(references.map(reference => reference.uuid))];
    return {
        annotationCount: annotationUuids.size,
        publishedAnnotationCount: payload.count,
        sourcePageAnnotationCount: payload.sourcePageAnnotationCount,
        referenceCount: references.length,
        referencedUuidCount: referencedUuids.length,
        referencedUuids,
        targetReferences: references.filter(reference => reference.uuid === targetUuid)
    };
}

const groundTruth = buildSourceGroundTruth();
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if(!file.startsWith(root) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': file.endsWith('.json') ? 'application/json' : file.endsWith('.txt') ? 'text/plain' : 'text/html' });
    fs.createReadStream(file).pipe(response);
});

async function main() {
    if(!browser) throw new Error('Chromium browser unavailable');
    if(groundTruth.annotationCount !== groundTruth.publishedAnnotationCount) throw new Error(`Annotation index count mismatch: ${groundTruth.annotationCount}/${groundTruth.publishedAnnotationCount}`);
    if(!groundTruth.targetReferences.length) throw new Error('Target source relation missing');

    await new Promise(resolve => server.listen(8881, '127.0.0.1', resolve));
    const processHandle = childProcess.spawn(browser, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
        '--remote-debugging-port=9337', 'about:blank'
    ], { stdio: 'ignore' });
    try {
        let target;
        for(let attempt = 0; attempt < 40 && !target; attempt++) {
            try { target = (await (await fetch('http://127.0.0.1:9337/json/list')).json()).find(item => item.type === 'page'); } catch {}
            if(!target) await delay(200);
        }
        if(!target) throw new Error('browser debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let id = 0;
        const pending = new Map();
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if(message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
            }
        };
        const send = (method, params = {}) => new Promise(resolve => {
            const requestId = ++id;
            pending.set(requestId, resolve);
            socket.send(JSON.stringify({ id: requestId, method, params }));
        });
        await send('Runtime.enable');
        await send('Page.addScriptToEvaluateOnNewDocument', { source: `{
            const originalFetch = window.fetch.bind(window);
            window.fetch = (input, init = {}) => {
                const url = String(input && input.url || input || '');
                const method = String(init.method || input && input.method || 'GET').toUpperCase();
                if(url.includes('firebaseio.com') && method !== 'GET') throw new Error('Firebase mutation blocked by PDF ground-truth test');
                return originalFetch(input, init);
            };
        }` });
        await send('Page.navigate', { url: 'http://127.0.0.1:8881/index.html' });

        let audit;
        for(let attempt = 0; attempt < 100 && !audit; attempt++) {
            await delay(400);
            const result = await send('Runtime.evaluate', {
                returnByValue: true,
                awaitPromise: true,
                expression: `(async () => {
                    if(typeof library === 'undefined' || !library || !pdfAnnotationSourceIndex.size) return null;
                    const cards = Object.values(library).flat();
                    if(!cards.length) return null;
                    const referencedUuids = new Set(${JSON.stringify(groundTruth.referencedUuids)});
                    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
                    const identityAttributes = [...PDF_ANNOTATION_IDENTITY_ATTRIBUTES, 'href', 'onclick', 'src'];
                    const directGroundTruthUuid = element => {
                        const values = identityAttributes.map(attribute => element.getAttribute(attribute)).filter(Boolean);
                        for(const value of values) {
                            const uuids = String(value).match(uuidPattern) || [];
                            for(const uuid of uuids) {
                                const normalized = uuid.toLowerCase();
                                const source = pdfAnnotationSourceIndex.get(normalized);
                                if(source && source.lsType === 'annotation') return normalized;
                            }
                        }
                        return null;
                    };
                    const normalizeHtml = value => {
                        let html = String(value || '').trim();
                        if(html.startsWith('"') && html.endsWith('"')) html = html.slice(1, -1).replace(/""/g, '"');
                        return html;
                    };
                    const stats = {
                        cards: cards.length,
                        fields: 0,
                        expected: 0,
                        actual: 0,
                        missing: 0,
                        falsePositives: 0,
                        sourceReferenceExpected: 0,
                        targetExpected: 0,
                        targetActual: 0,
                        targetTextMatches: 0,
                        metadataFailures: 0,
                        deepLinkFailures: 0,
                        failures: []
                    };
                    const auditHost = document.createElement('div');
                    const expectedEntries = [];
                    for(const card of cards) {
                        const fields = [['q', card.q], ['a', card.a], ['extra', card.extra]];
                        for(const [field, value] of fields) {
                            const html = normalizeHtml(value);
                            if(!html || !/data-|block-id=|<img/i.test(html)) continue;
                            const host = document.createElement('div');
                            host.innerHTML = html;
                            const expectedElements = [...host.querySelectorAll(PDF_ANNOTATION_IDENTITY_SELECTOR)]
                                .map(element => ({ element, uuid: directGroundTruthUuid(element) }))
                                .filter(entry => entry.uuid);
                            if(!expectedElements.length) continue;
                            stats.fields++;
                            stats.expected += expectedElements.length;
                            for(const entry of expectedElements) {
                                const { element, uuid } = entry;
                                if(referencedUuids.has(uuid)) stats.sourceReferenceExpected++;
                                if(uuid === ${JSON.stringify(targetUuid)}) stats.targetExpected++;
                                const container = document.createElement('div');
                                const previousText = element.previousSibling?.nodeType === Node.TEXT_NODE
                                    ? String(element.previousSibling.nodeValue || '')
                                    : '';
                                if(previousText) container.appendChild(document.createTextNode(previousText));
                                const clone = element.cloneNode(false);
                                if(clone.tagName !== 'IMG') clone.textContent = String(element.textContent || '').slice(0, 200);
                                container.appendChild(clone);
                                auditHost.appendChild(container);
                                expectedEntries.push({ element: clone, uuid, cardId: card.id, field });
                            }
                        }
                    }
                    decoratePdfAnnotations(auditHost, {});
                    for(const entry of expectedEntries) {
                                const { element, uuid, cardId, field } = entry;
                                const region = element.matches('[data-mk-pdf-annotation-decorated="1"]')
                                    ? element
                                    : element.closest('[data-mk-pdf-annotation-decorated="1"]');
                                const icon = region?.querySelector(':scope > .mk-pdf-annotation-icon');
                                const handled = region?.dataset.mkPdfRegionBound === '1';
                                const annotation = icon ? JSON.parse(icon.dataset.annotation || 'null') : null;
                                const linked = !!icon && handled && annotation?.sourceUuid === uuid;
                                if(linked) {
                                    stats.actual++;
                                    if(uuid === ${JSON.stringify(targetUuid)}) {
                                        stats.targetActual++;
                                        if(String(region.textContent || '').includes(${JSON.stringify(targetText)})) stats.targetTextMatches++;
                                    }
                                } else {
                                    stats.missing++;
                                    if(stats.failures.length < 20) stats.failures.push({ cardId, field, uuid, html: element.outerHTML, stage: !region ? 'decorate' : !icon ? 'icon' : !handled ? 'handler' : 'identity' });
                                }
                                const source = pdfAnnotationSourceIndex.get(uuid);
                                if(!annotation || annotation.page !== Number(source.page) || annotation.pdfFileName !== source.pdfFileName) stats.metadataFailures++;
                                const deepLink = annotation && buildPdfHelperDeepLink(annotation);
                                if(!deepLink || !deepLink.startsWith('mkpdf://open?')) stats.deepLinkFailures++;
                    }
                            for(const icon of auditHost.querySelectorAll('.mk-pdf-annotation-icon')) {
                                const annotation = JSON.parse(icon.dataset.annotation || 'null');
                                const uuid = String(annotation?.sourceUuid || annotation?.annotationId || '').toLowerCase();
                                if(!uuid || !pdfAnnotationSourceIndex.has(uuid)) stats.falsePositives++;
                            }
                    return stats;
                })()`
            });
            audit = result.result?.result?.value || null;
        }
        if(!audit) throw new Error('ground-truth audit did not load');
        if(audit.expected !== audit.actual || audit.missing !== 0 || audit.falsePositives !== 0) throw new Error(`Ground-truth mismatch: ${JSON.stringify(audit)}`);
        if(audit.metadataFailures !== 0 || audit.deepLinkFailures !== 0) throw new Error(`PDF metadata/link mismatch: ${JSON.stringify(audit)}`);
        if(!audit.targetExpected || audit.targetActual !== audit.targetExpected || audit.targetTextMatches !== audit.targetExpected) throw new Error(`Target regression mismatch: ${JSON.stringify(audit)}`);
        console.log(JSON.stringify({
            groundTruth: {
                annotations: groundTruth.annotationCount,
                sourcePageAnnotations: groundTruth.sourcePageAnnotationCount,
                sourceReferenceRelationships: groundTruth.referenceCount,
                sourceReferencedAnnotationUuids: groundTruth.referencedUuidCount,
                target: { uuid: targetUuid, text: targetText, references: groundTruth.targetReferences }
            },
            rendered: audit
        }, null, 2));
    } finally {
        const browserExited = new Promise(resolve => processHandle.once('exit', resolve));
        processHandle.kill();
        server.close();
        await Promise.race([browserExited, delay(3000)]);
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch(error) {}
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
