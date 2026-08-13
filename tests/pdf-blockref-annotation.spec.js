const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const externalBaseUrl = process.env.MK_TEST_BASE_URL || '';
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pdf-blockref-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    const type = filePath.endsWith('.json') ? 'application/json; charset=utf-8' : filePath.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    if(!externalBaseUrl) await new Promise(resolve => server.listen(8878, '127.0.0.1', resolve));
    const edge = childProcess.spawn(edgePath, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`, '--remote-debugging-port=9334', 'about:blank'], { stdio: 'ignore' });
    try {
        let target;
        for (let attempt = 0; attempt < 30 && !target; attempt++) {
            try { target = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(200);
        }
        if(!target) throw new Error('Edge debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if(message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
        };
        const send = (method, params = {}) => new Promise(resolve => {
            const id = ++nextId; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
        });
        await send('Runtime.enable');
        await send('Page.navigate', { url: externalBaseUrl || 'http://127.0.0.1:8878/index.html' });
        let result;
        for(let attempt = 0; attempt < 80; attempt++) {
            await delay(500);
            const response = await send('Runtime.evaluate', {
                expression: `(() => {
                    const card = Object.values(library || {}).flat().find(item => item.id === '6a17f7fc-a7e0-401a-b698-93f6d9499341');
                    if(!card || !pdfAnnotationSourceIndex.size) return null;
                    const root = createDOM(card, false);
                    document.getElementById('question-section').replaceChildren(root);
                    const ref = document.querySelector('.block-ref.mk-pdf-annotation-ref');
                    const icon = ref && ref.querySelector(':scope > .mk-pdf-annotation-icon');
                    const style = icon && getComputedStyle(icon);
                    const iosDeepLink = icon && buildPdfAnnotationIOSUrl(JSON.parse(icon.dataset.annotation));
                    const allCards = Object.values(library || {}).flat();
                    const ordinaryCard = allCards.find(item => {
                        const holder = document.createElement('div'); holder.innerHTML = item.q || '';
                        const refElement = holder.querySelector('.block-ref');
                        const data = extractBlockRefUuid(refElement);
                        return data && data.uuid && !pdfAnnotationSourceIndex.has(data.uuid);
                    });
                    const ordinaryRoot = ordinaryCard && createDOM(ordinaryCard, false);
                    const directCard = allCards.find(item => /(?:📌|🟡|🔵|🟢|🟣|🔴|🟠)\\s*<b>P\\d+<\\/b>/i.test(item.q || ''));
                    const directRoot = directCard && createDOM(directCard, false);
                    return {
                        cardId: card.id,
                        sourceCount: pdfAnnotationSourceIndex.size,
                        refHTML: ref && ref.outerHTML,
                        onclick: ref && ref.getAttribute('onclick'),
                        iconCount: document.querySelectorAll('#question-section .mk-pdf-annotation-icon').length,
                        annotation: icon && JSON.parse(icon.dataset.annotation),
                        color: style && style.color,
                        width: style && style.width,
                        height: style && style.height,
                        iosDeepLink,
                        ordinaryBlockRefIconCount: ordinaryRoot ? ordinaryRoot.querySelectorAll('.block-ref > .mk-pdf-annotation-icon').length : null,
                        directAnnotationIconCount: directRoot ? directRoot.querySelectorAll('.mk-pdf-annotation-icon').length : null
                    };
                })()`, returnByValue: true
            });
            if(response.result && response.result.exceptionDetails) throw new Error(`browser evaluation failed: ${response.result.exceptionDetails.exception && response.result.exceptionDetails.exception.description}`);
            result = response.result && response.result.result && response.result.result.value;
            if(result) break;
        }
        socket.close();
        if(!result || result.cardId !== '6a17f7fc-a7e0-401a-b698-93f6d9499341') throw new Error(`target card unavailable: ${JSON.stringify(result)}`);
        if(result.iconCount < 1 || !result.refHTML.includes('mk-pdf-annotation-icon')) throw new Error(`icon missing: ${JSON.stringify(result)}`);
        if(result.annotation.annotationId !== '6a58769d-6bdc-454b-b744-ef8e39bc9354' || result.annotation.page !== 40) throw new Error(`metadata mismatch: ${JSON.stringify(result)}`);
        if(!result.annotation.pdfFileName.endsWith('.pdf')) throw new Error(`PDF filename missing: ${JSON.stringify(result)}`);
        if(!result.onclick || !result.onclick.includes('block-id=6a58769d-6bdc-454b-b744-ef8e39bc9354')) throw new Error(`block-ref click changed: ${JSON.stringify(result)}`);
        if(result.color !== 'rgb(255, 59, 48)' || result.width !== '18px' || result.height !== '18px') throw new Error(`debug style mismatch: ${JSON.stringify(result)}`);
        const deepLink = new URL(result.iosDeepLink);
        if(deepLink.protocol !== 'mkpdf:' || deepLink.hostname !== 'open' || deepLink.searchParams.get('page') !== '40' || Math.abs(Number(deepLink.searchParams.get('sourceWidth')) - 944) > 0.001) throw new Error(`iOS deep link mismatch: ${JSON.stringify(result)}`);
        if(result.ordinaryBlockRefIconCount !== 0) throw new Error(`ordinary block-ref false positive: ${JSON.stringify(result)}`);
        if(!result.directAnnotationIconCount) throw new Error(`direct annotation regression: ${JSON.stringify(result)}`);
        console.log(JSON.stringify(result, null, 2));
    } finally {
        edge.kill(); if(!externalBaseUrl) server.close(); await delay(500);
        try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
