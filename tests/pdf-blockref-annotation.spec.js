const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const externalBaseUrl = process.env.MK_TEST_BASE_URL || '';
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pdf-blockref-'));
const browserPaths = process.platform === 'darwin'
    ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
const edgePath = browserPaths.find(candidate => fs.existsSync(candidate));
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
    if(!edgePath) throw new Error('Chromium browser unavailable');
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
                    const pdfFileNameCases = [
                        '2027+정태성+말랑말랑+소방학개론+기본서.pdf',
                        '2027 정태성 말랑말랑 소방학개론 기본서.pdf',
                        '2027%20정태성%20기본서.pdf',
                        '소방학개론.pdf'
                    ].map(pdfFileName => buildPdfAnnotationIOSUrl({
                        pdfFileName,
                        page: 37,
                        annotationId: '6a58769d-6bdc-454b-b744-ef8e39bc9354'
                    }));
                    const allCards = Object.values(library || {}).flat();
                    const ordinaryUuid = crypto.randomUUID();
                    const ordinaryRoot = createDOM({
                        id: ordinaryUuid,
                        q: '<span class="block-ref" onclick="window.open(\\\'logseq://graph/logseq?block-id=' + ordinaryUuid + '\\\')">ordinary</span>',
                        a: '', extra: '', breadcrumb: '', blockId: ordinaryUuid, isLogseq: false
                    }, false);
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
                        pdfFileNameCases,
                        ordinaryBlockRefIconCount: ordinaryRoot.querySelectorAll('.block-ref > .mk-pdf-annotation-icon').length,
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
        if(result.width !== '16px' || result.height !== '16px') throw new Error(`final icon style mismatch: ${JSON.stringify(result)}`);
        const deepLink = new URL(result.iosDeepLink);
        if(deepLink.protocol !== 'mkpdf:' || deepLink.hostname !== 'open' || deepLink.searchParams.get('page') !== '40' || Math.abs(Number(deepLink.searchParams.get('sourceWidth')) - 944) > 0.001) throw new Error(`iOS deep link mismatch: ${JSON.stringify(result)}`);
        const expectedEncodedKoreanFileName = '2027%20%EC%A0%95%ED%83%9C%EC%84%B1%20%EB%A7%90%EB%9E%91%EB%A7%90%EB%9E%91%20%EC%86%8C%EB%B0%A9%ED%95%99%EA%B0%9C%EB%A1%A0%20%EA%B8%B0%EB%B3%B8%EC%84%9C.pdf';
        if(!result.pdfFileNameCases[0].includes(`file=${expectedEncodedKoreanFileName}&`)) throw new Error(`raw PDF filename is not percent-20 encoded: ${result.pdfFileNameCases[0]}`);
        if(result.pdfFileNameCases[0].includes('file=2027+')) throw new Error(`raw PDF filename still contains plus separators: ${result.pdfFileNameCases[0]}`);
        const pdfFileNameResults = result.pdfFileNameCases.map(url => {
            const parsed = new URL(url);
            return {
                file: parsed.searchParams.get('file'),
                page: parsed.searchParams.get('page'),
                annotation: parsed.searchParams.get('annotation')
            };
        });
        const expectedPdfFileNames = [
            '2027 정태성 말랑말랑 소방학개론 기본서.pdf',
            '2027 정태성 말랑말랑 소방학개론 기본서.pdf',
            '2027%20정태성%20기본서.pdf',
            '소방학개론.pdf'
        ];
        pdfFileNameResults.forEach((item, index) => {
            if(item.file !== expectedPdfFileNames[index]) throw new Error(`PDF filename case ${index + 1} mismatch: ${JSON.stringify(result)}`);
            if(item.page !== '37' || item.annotation !== '6a58769d-6bdc-454b-b744-ef8e39bc9354') throw new Error(`PDF query parameter regression in case ${index + 1}: ${JSON.stringify(result)}`);
        });
        if(result.ordinaryBlockRefIconCount !== 0) throw new Error(`ordinary block-ref false positive: ${JSON.stringify(result)}`);
        if(!result.directAnnotationIconCount) throw new Error(`direct annotation regression: ${JSON.stringify(result)}`);
        console.log(JSON.stringify(result, null, 2));
    } finally {
        edge.kill(); if(!externalBaseUrl) server.close(); await delay(500);
        try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
