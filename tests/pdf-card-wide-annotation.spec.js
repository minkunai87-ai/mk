const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pdf-card-wide-'));
const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
const browser = candidates.find(file => fs.existsSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if(!file.startsWith(root) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': file.endsWith('.json') ? 'application/json' : file.endsWith('.txt') ? 'text/plain' : 'text/html' });
    fs.createReadStream(file).pipe(response);
});

async function main() {
    if(!browser) throw new Error('Chromium browser unavailable');
    await new Promise(resolve => server.listen(8879, '127.0.0.1', resolve));
    const processHandle = childProcess.spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--js-flags=--expose-gc', `--user-data-dir=${profile}`, '--remote-debugging-port=9335', 'about:blank'], { stdio: 'ignore' });
    try {
        let target;
        for(let i = 0; i < 40 && !target; i++) {
            try { target = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find(item => item.type === 'page'); } catch {}
            if(!target) await delay(200);
        }
        if(!target) throw new Error('browser debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let id = 0; const pending = new Map();
        socket.onmessage = event => { const message = JSON.parse(event.data); if(message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
        const send = (method, params = {}) => new Promise(resolve => { const requestId = ++id; pending.set(requestId, resolve); socket.send(JSON.stringify({ id: requestId, method, params })); });
        await send('Runtime.enable');
        await send('Page.navigate', { url: 'http://127.0.0.1:8879/index.html' });
        let value;
        for(let attempt = 0; attempt < 100 && !value; attempt++) {
            await delay(400);
            const result = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(async () => {
                if(typeof library === 'undefined' || !library || !pdfAnnotationSourceIndex.size) return null;
                const cards = Object.values(library).flat();
                if(!cards.length) return null;
                const stats = { cards: cards.length, question: { found: 0, decorated: 0, handlers: 0, failed: 0 }, answer: { found: 0, decorated: 0, handlers: 0, failed: 0 }, outside: { found: 0, decorated: 0, handlers: 0, failed: 0 }, direct: { found: 0, decorated: 0, handlers: 0, failed: 0 }, area: { found: 0, decorated: 0, handlers: 0, failed: 0 }, refs: { total: 0, withUuid: 0, pdf: 0, decorated: 0, handlers: 0, failed: 0, ordinaryFalsePositives: 0 }, ordinaryDecorated: 0, deepLinkFailures: 0, metadataFailures: 0 };
                const scan = (card, position) => {
                    const rendered = createDOM(card, position === 'answer');
                    rendered.querySelectorAll('.block-ref').forEach(element => {
                        const link = extractBlockRefUuid(element); const source = link && link.uuid ? pdfAnnotationSourceIndex.get(link.uuid) : null;
                        const refRegion = element.closest('.mk-pdf-ref-text');
                        const isRefDisplay = !!refRegion || /(?:^|\s)ref\.\s*$/i.test(String(element.previousSibling?.nodeValue || ''));
                        if(isRefDisplay) { stats.refs.total++; if(link?.uuid) stats.refs.withUuid++; }
                        if(!source || source.lsType !== 'annotation') { if(element.classList.contains('mk-pdf-annotation-ref')) stats.ordinaryDecorated++; if(isRefDisplay && refRegion) stats.refs.ordinaryFalsePositives++; return; }
                        const occurrencePosition = element.closest('.mk-extra-content, .ls-header') ? 'outside' : position;
                        const group = stats[occurrencePosition]; group.found++;
                        const region = refRegion || element;
                        const icon = region.querySelector(':scope > .mk-pdf-annotation-icon');
                        const decorated = !!icon && region.dataset.mkPdfAnnotationDecorated === '1';
                        const handled = region.dataset.mkPdfRegionBound === '1';
                        if(decorated) group.decorated++; if(handled) group.handlers++; if(!decorated || !handled) group.failed++;
                        if(isRefDisplay) { stats.refs.pdf++; if(decorated) stats.refs.decorated++; if(handled) stats.refs.handlers++; if(!decorated || !handled) stats.refs.failed++; }
                        const data = icon && JSON.parse(icon.dataset.annotation || 'null');
                        if(!data || data.sourceUuid !== link.uuid || data.page !== source.page || data.pdfFileName !== source.pdfFileName) stats.metadataFailures++;
                        const deepLink = data && buildPdfHelperDeepLink(data); if(!deepLink || !deepLink.startsWith('mkpdf://open?')) stats.deepLinkFailures++;
                        if(source.annotationType === 'area') { stats.area.found++; if(decorated) stats.area.decorated++; if(handled) stats.area.handlers++; if(!decorated || !handled) stats.area.failed++; }
                    });
                    rendered.querySelectorAll('b[data-mk-pdf-annotation-decorated="1"]').forEach(page => {
                        stats.direct.found++; const wrapper = page.parentElement; const icon = wrapper && wrapper.querySelector(':scope > .mk-pdf-annotation-icon');
                        const decorated = !!icon; const handled = !!wrapper && wrapper.dataset.mkPdfRegionBound === '1';
                        if(decorated) stats.direct.decorated++; if(handled) stats.direct.handlers++; if(!decorated || !handled) stats.direct.failed++;
                        if(wrapper && wrapper.querySelector('.mk-pdf-annotation-content img')) { stats.area.found++; if(decorated) stats.area.decorated++; if(handled) stats.area.handlers++; if(!decorated || !handled) stats.area.failed++; }
                    });
                    rendered.querySelectorAll('.extra-annotation').forEach(element => {
                        const region = element.closest('.mk-pdf-ref-text');
                        const isRefDisplay = !!region || /(?:^|\s)ref\.\s*$/i.test(String(element.previousSibling?.nodeValue || ''));
                        if(!isRefDisplay) return;
                        stats.refs.total++;
                        const uuid = region?.dataset.sourceUuid || element.dataset.sourceUuid || null;
                        if(uuid) stats.refs.withUuid++;
                        const source = uuid ? pdfAnnotationSourceIndex.get(uuid) : null;
                        if(!source || source.lsType !== 'annotation') { if(region) stats.refs.ordinaryFalsePositives++; return; }
                        stats.refs.pdf++;
                        const icon = region?.querySelector(':scope > .mk-pdf-annotation-icon'); const decorated = !!icon; const handled = region?.dataset.mkPdfRegionBound === '1';
                        if(decorated) stats.refs.decorated++; if(handled) stats.refs.handlers++; if(!decorated || !handled) stats.refs.failed++;
                    });
                };
                const canContainAnnotation = html => /block-ref|extra-annotation|🔵/.test(html || '');
                for(let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
                    const card = cards[cardIndex];
                    if(canContainAnnotation(card.q) || canContainAnnotation(card.extra)) scan(card, 'question');
                    if(card.a && card.a !== card.q && (canContainAnnotation(card.a) || canContainAnnotation(card.extra))) scan(card, 'answer');
                    if(cardIndex % 500 === 499) { if(typeof gc === 'function') gc(); await new Promise(resolve => setTimeout(resolve, 0)); }
                }

                const ids = [...pdfAnnotationSourceIndex.keys()].slice(0, 3); const ref = uuid => '<span class="block-ref" onclick="window.open(\\'logseq://graph/logseq?block-id=' + uuid + '\\')">' + uuid.slice(0, 4) + '</span>';
                const fixture = (q, a = q, extra = '') => ({ id: crypto.randomUUID(), q, a, extra, breadcrumb: '', blockId: '', isLogseq: false });
                const fixtureCases = {
                    A: fixture('general :-> ' + ref(ids[0])),
                    B: fixture(ref(ids[0]) + ' :-> general'),
                    C: fixture(ref(ids[0]) + ' :-> ' + ref(ids[1])),
                    D: fixture('general ' + ref(ids[0]) + ' general'),
                    E: fixture(ref(ids[0]) + ' and ' + ref(ids[1]) + ' :-> ' + ref(ids[2])),
                    F: fixture('<a href="sample.pdf">source</a><span>🔵<b>P4</b> direct text</span>'),
                    G: fixture('<a href="sample.pdf">source</a><span>🔵<b>P4</b><img src="area.png"></span>')
                };
                const fixtures = {};
                for(const [name, card] of Object.entries(fixtureCases)) {
                    const rendered = createDOM(card, false); const icons = [...rendered.querySelectorAll('.mk-pdf-annotation-icon')];
                    fixtures[name] = { icons: icons.length, handlers: rendered.querySelectorAll('[data-mk-pdf-region-bound="1"]').length,
                        ids: icons.map(icon => JSON.parse(icon.dataset.annotation || '{}').sourceUuid || null), area: !!rendered.querySelector('.mk-pdf-annotation-content img') };
                }
                const repeated = createDOM(fixture(ref(ids[0]) + ' ' + ref(ids[0])), false);
                fixtures.repeated = { icons: repeated.querySelectorAll('.mk-pdf-annotation-icon').length, handlers: repeated.querySelectorAll('[data-mk-pdf-region-bound="1"]').length };
                const answerOnly = createDOM(fixture('general', ref(ids[0])), true);
                fixtures.answer = { icons: answerOnly.querySelectorAll('.mk-pdf-annotation-icon').length, handlers: answerOnly.querySelectorAll('[data-mk-pdf-region-bound="1"]').length };
                const outside = createDOM(fixture('general', 'general', ref(ids[0])), true);
                fixtures.outside = { icons: outside.querySelectorAll('.mk-extra-content .mk-pdf-annotation-icon').length, handlers: outside.querySelectorAll('.mk-extra-content[data-mk-pdf-region-bound="1"], .mk-extra-content [data-mk-pdf-region-bound="1"]').length };
                const visibleAreaUuid = '6a69ef21-c0f1-4182-a125-f34e23de8d0e';
                const visibleArea = createDOM(fixture('<img src="178_' + visibleAreaUuid + '_1785327393144.png">'), false);
                fixtures.visibleArea = { icons: visibleArea.querySelectorAll('.mk-pdf-annotation-icon').length, handlers: visibleArea.querySelectorAll('[data-mk-pdf-region-bound="1"]').length, uuid: visibleArea.querySelector('.mk-pdf-annotation')?.dataset.mkPdfAnnotationSourceUuid || null };
                const fireSafetyUuid = '6a69ea3c-f982-4696-9b6c-aac4c22c3cc0';
                const fireSafety = createDOM(fixture('ref. ' + ref(fireSafetyUuid)), false);
                const fireSafetyRegion = fireSafety.querySelector('.mk-pdf-ref-text'); const fireSafetyIcon = fireSafetyRegion?.querySelector(':scope > .mk-pdf-annotation-icon'); const fireSafetyData = fireSafetyIcon && JSON.parse(fireSafetyIcon.dataset.annotation || 'null');
                fixtures.fireSafety = { icons: fireSafety.querySelectorAll('.mk-pdf-annotation-icon').length, handlers: fireSafety.querySelectorAll('[data-mk-pdf-region-bound="1"]').length, uuid: fireSafetyRegion?.dataset.sourceUuid || null, text: fireSafetyRegion?.textContent.trim() || null, dom: fireSafetyRegion ? { tagName: fireSafetyRegion.tagName, className: fireSafetyRegion.className, href: fireSafetyRegion.getAttribute('href'), onclick: fireSafetyRegion.getAttribute('onclick'), dataset: {...fireSafetyRegion.dataset}, textContent: fireSafetyRegion.textContent, parentHTML: fireSafetyRegion.parentElement?.outerHTML || null } : null, annotation: fireSafetyData, deepLink: fireSafetyData && buildPdfHelperDeepLink(fireSafetyData) };
                const actualFireCard = cards.find(card => [card.q, card.a, card.extra].some(html => String(html || '').includes(fireSafetyUuid) && String(html || '').includes('화재안전조사')));
                const actualFireDom = actualFireCard && createDOM(actualFireCard, false); const actualFireRegion = actualFireDom?.querySelector('.mk-pdf-ref-text[data-source-uuid="' + fireSafetyUuid + '"]'); const actualFireIcon = actualFireRegion?.querySelector(':scope > .mk-pdf-annotation-icon'); const actualFireData = actualFireIcon && JSON.parse(actualFireIcon.dataset.annotation || 'null');
                fixtures.actualFireSafety = { found: !!actualFireCard, text: actualFireRegion?.textContent.trim() || null, uuid: actualFireRegion?.dataset.sourceUuid || null, icon: !!actualFireIcon, handler: actualFireRegion?.dataset.mkPdfRegionBound === '1', annotation: actualFireData, deepLink: actualFireData && buildPdfHelperDeepLink(actualFireData), dom: actualFireRegion ? { tagName: actualFireRegion.tagName, className: actualFireRegion.className, href: actualFireRegion.getAttribute('href'), onclick: actualFireRegion.getAttribute('onclick'), dataset: {...actualFireRegion.dataset}, textContent: actualFireRegion.textContent, parentHTML: actualFireRegion.parentElement?.outerHTML || null } : null };
                const exactFireUuid = '6a4f3b08-01d4-46e7-a855-092c846f6330'; const exactFire = createDOM(fixture('ref. ' + ref(exactFireUuid).replace('>' + exactFireUuid.slice(0, 4) + '<', '>화재안전조사<')), false); const exactFireRegion = exactFire.querySelector('.mk-pdf-ref-text'); const exactFireIcon = exactFireRegion?.querySelector(':scope > .mk-pdf-annotation-icon'); const exactFireData = exactFireIcon && JSON.parse(exactFireIcon.dataset.annotation || 'null');
                fixtures.exactFireSafety = { text: exactFireRegion?.textContent.trim() || null, uuid: exactFireRegion?.dataset.sourceUuid || null, icon: !!exactFireIcon, handler: exactFireRegion?.dataset.mkPdfRegionBound === '1', annotation: exactFireData, deepLink: exactFireData && buildPdfHelperDeepLink(exactFireData) };
                const dynamic = document.createElement('div'); dynamic.innerHTML = '<img src="178_' + visibleAreaUuid + '_dynamic.png">'; decorateDynamicPdfAnnotationSubtree(dynamic);
                fixtures.dynamic = { icons: dynamic.querySelectorAll('.mk-pdf-annotation-icon').length, handlers: dynamic.querySelectorAll('[data-mk-pdf-region-bound="1"]').length };
                const dynamicRef = document.createElement('div'); dynamicRef.innerHTML = 'ref. ' + ref(fireSafetyUuid); decorateDynamicPdfAnnotationSubtree(dynamicRef);
                fixtures.dynamicRef = { icons: dynamicRef.querySelectorAll('.mk-pdf-ref-text > .mk-pdf-annotation-icon').length, handlers: dynamicRef.querySelectorAll('.mk-pdf-ref-text[data-mk-pdf-region-bound="1"]').length };
                const screenCardId = '6a69e75e-a2a8-479f-9693-46066d02fdb5'; const screenUuid = '6a69e428-694f-489e-8a59-5b86f9306595'; const screenCard = cards.find(card => card.id === screenCardId); const screenDeck = Object.entries(library).find(([, deckCards]) => deckCards.some(card => card.id === screenCardId))?.[0] || null;
                const beforeHolder = document.createElement('div'); beforeHolder.innerHTML = [screenCard?.q, screenCard?.a].join(''); const beforeRef = [...beforeHolder.querySelectorAll('.extra-annotation')].find(element => /화재안전조사/.test(element.textContent) && !element.querySelector('img'));
                const before = beforeRef ? { outerHTML: beforeRef.outerHTML, parentHTML: beforeRef.parentElement?.outerHTML || null, previousSibling: beforeRef.previousSibling?.nodeValue || null, nextSibling: beforeRef.nextSibling?.outerHTML || beforeRef.nextSibling?.nodeValue || null, className: beforeRef.className, onclick: beforeRef.getAttribute('onclick'), dataset: {...beforeRef.dataset}, iconCount: beforeRef.querySelectorAll('.mk-pdf-annotation-icon').length } : null;
                activeDeck = [screenCard]; currentIndex = 0; currentDeckName = screenDeck; showCard(); revealAnswer(); await new Promise(resolve => setTimeout(resolve, 50));
                const screenRegion = document.querySelector('#question-section .mk-pdf-ref-text[data-source-uuid="' + screenUuid + '"]'); const screenIcon = screenRegion?.querySelector(':scope > .mk-pdf-annotation-icon'); const screenData = screenIcon && JSON.parse(screenIcon.dataset.annotation || 'null');
                fixtures.actualScreenCard = { card: { id: screenCard?.id || null, blockId: screenCard?.blockId || null, deck: screenDeck, q: screenCard?.q || null, a: screenCard?.a || null, extra: screenCard?.extra || null }, before, after: screenRegion ? { outerHTML: screenRegion.outerHTML, parentHTML: screenRegion.parentElement?.outerHTML || null, previousSibling: screenRegion.previousSibling?.outerHTML || screenRegion.previousSibling?.nodeValue || null, nextSibling: screenRegion.nextSibling?.outerHTML || screenRegion.nextSibling?.nodeValue || null, className: screenRegion.className, onclick: screenRegion.getAttribute('onclick'), dataset: {...screenRegion.dataset} } : null, uuid: screenRegion?.dataset.sourceUuid || null, lookup: pdfAnnotationSourceIndex.get(screenUuid) || null, iconCount: screenRegion?.querySelectorAll('.mk-pdf-annotation-icon').length || 0, handler: screenRegion?.dataset.mkPdfRegionBound === '1', deepLink: screenData && buildPdfHelperDeepLink(screenData), answerRevealed: document.getElementById('question-section').classList.contains('mode-answer'), survived: !!document.querySelector('#question-section .mk-pdf-ref-text[data-source-uuid="' + screenUuid + '"] > .mk-pdf-annotation-icon') };
                return { stats, fixtures };
            })()` });
            if(result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || 'evaluation failed');
            value = result.result?.result?.value;
        }
        socket.close();
        if(!value) throw new Error('MK library unavailable');
        const { stats, fixtures } = value;
        for(const position of ['question', 'answer']) if(stats[position].failed || stats[position].found !== stats[position].decorated || stats[position].found !== stats[position].handlers) throw new Error(`${position} failures: ${JSON.stringify(stats)}`);
        if(stats.ordinaryDecorated || stats.deepLinkFailures || stats.metadataFailures || stats.direct.failed || stats.area.failed || stats.refs.failed || stats.refs.ordinaryFalsePositives) throw new Error(`render failures: ${JSON.stringify(stats)}`);
        const expected = { A: 1, B: 1, C: 2, D: 1, E: 3, F: 1, G: 1 };
        for(const [name, count] of Object.entries(expected)) if(fixtures[name].icons !== count || fixtures[name].handlers !== count) throw new Error(`fixture ${name}: ${JSON.stringify(fixtures[name])}`);
        if(!fixtures.G.area || fixtures.repeated.icons !== 2 || fixtures.repeated.handlers !== 2 || fixtures.answer.icons !== 1 || fixtures.answer.handlers !== 1 || fixtures.outside.icons !== 1 || fixtures.outside.handlers !== 1 || fixtures.visibleArea.icons !== 1 || fixtures.visibleArea.handlers !== 1 || fixtures.visibleArea.uuid !== '6a69ef21-c0f1-4182-a125-f34e23de8d0e' || fixtures.fireSafety.icons !== 1 || fixtures.fireSafety.handlers !== 1 || fixtures.fireSafety.uuid !== '6a69ea3c-f982-4696-9b6c-aac4c22c3cc0' || fixtures.fireSafety.text !== 'ref. 6a69' || !fixtures.fireSafety.deepLink?.startsWith('mkpdf://open?') || !fixtures.actualFireSafety.found || !fixtures.actualFireSafety.icon || !fixtures.actualFireSafety.handler || fixtures.actualFireSafety.uuid !== '6a69ea3c-f982-4696-9b6c-aac4c22c3cc0' || !fixtures.actualFireSafety.text?.includes('ref.') || !fixtures.actualFireSafety.text?.includes('화재안전조사') || !fixtures.actualFireSafety.deepLink?.startsWith('mkpdf://open?') || fixtures.exactFireSafety.text !== 'ref. 화재안전조사' || fixtures.exactFireSafety.uuid !== '6a4f3b08-01d4-46e7-a855-092c846f6330' || !fixtures.exactFireSafety.icon || !fixtures.exactFireSafety.handler || !fixtures.exactFireSafety.deepLink?.startsWith('mkpdf://open?') || fixtures.dynamic.icons !== 1 || fixtures.dynamic.handlers !== 1 || fixtures.dynamicRef.icons !== 1 || fixtures.dynamicRef.handlers !== 1 || fixtures.actualScreenCard.before?.iconCount !== 0 || fixtures.actualScreenCard.uuid !== '6a69e428-694f-489e-8a59-5b86f9306595' || fixtures.actualScreenCard.iconCount !== 1 || !fixtures.actualScreenCard.handler || !fixtures.actualScreenCard.answerRevealed || !fixtures.actualScreenCard.survived || !fixtures.actualScreenCard.deepLink?.startsWith('mkpdf://open?')) throw new Error(`area/position/dynamic/repeated fixture: ${JSON.stringify(fixtures)}`);
        console.log(JSON.stringify(value, null, 2));
    } finally {
        processHandle.kill(); server.close(); await delay(300); fs.rmSync(profile, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
