const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-io-double-tap-'));
const browserPath = process.env.MK_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    const type = filePath.endsWith('.json') ? 'application/json; charset=utf-8' : filePath.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, {'Content-Type': type});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(8880, '127.0.0.1', resolve));
    const browser = childProcess.spawn(browserPath, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`, '--remote-debugging-port=9336', 'about:blank'], {stdio:'ignore'});
    const exceptions = [];
    const consoleEvents = [];
    try {
        let target;
        for (let i = 0; i < 40 && !target; i++) {
            try { target = (await (await fetch('http://127.0.0.1:9336/json/list')).json()).find(item => item.type === 'page'); } catch (_) {}
            if (!target) await delay(200);
        }
        if (!target) throw new Error('Chrome debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
            if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
            if (message.method === 'Runtime.consoleAPICalled') {
                const text = (message.params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ');
                if (/DOUBLE_TAP|IMAGE_ZOOM_ERROR|ZOOM_RESET_BY_ERROR|MK_IO_ZOOM_FIRST_ERROR/.test(text)) consoleEvents.push(text);
            }
        };
        const send = (method, params = {}) => new Promise(resolve => {
            const id = ++nextId;
            pending.set(id, resolve);
            socket.send(JSON.stringify({id, method, params}));
        });
        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true, includeCommandLineAPI:true});
            if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
            return response.result.result.value;
        };
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Performance.enable');
        await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:3,mobile:true});
        await send('Emulation.setUserAgentOverride', {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
        await send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
            const NativeResizeObserver = window.ResizeObserver;
            window.__mkResizeObserverDiagnostics = {created:0,observed:0,callbacks:0,disconnected:0};
            window.ResizeObserver = class {
                constructor(callback) {
                    window.__mkResizeObserverDiagnostics.created++;
                    this.inner = new NativeResizeObserver((...args) => { window.__mkResizeObserverDiagnostics.callbacks++; callback(...args); });
                }
                observe(target, options) { window.__mkResizeObserverDiagnostics.observed++; return this.inner.observe(target, options); }
                unobserve(target) { return this.inner.unobserve(target); }
                disconnect() { window.__mkResizeObserverDiagnostics.disconnected++; return this.inner.disconnect(); }
            };
        })()`});
        await send('Page.navigate', {url:process.env.MK_TEST_URL || 'http://127.0.0.1:8880/index.html'});
        for (let i = 0; i < 120; i++) {
            await delay(500);
            if (await evaluate('Object.values(library||{}).reduce((n,c)=>n+c.length,0)') > 0) break;
        }
        const setup = await evaluate(`(() => {
            const entry = Object.entries(library).map(([name,cards]) => ({name,cards,io:cards.filter(getImageOcclusionGroupKey),groupCount:new Set(cards.map(getImageOcclusionGroupKey).filter(Boolean)).size})).filter(item => item.groupCount >= 3).sort((a,b) => Math.max(...b.io.map(c=>String(c.q||'').length))-Math.max(...a.io.map(c=>String(c.q||'').length)))[0];
            currentDeckName=entry.name; originalDeck=entry.cards; activeDeck=entry.cards.slice(); ioImageGroupCache={cards:null,length:0,groups:[],cardToGroup:new Map()};
            const groups=getIOImageGroups().groups; currentIndex=groups[0].cardIndices[0]; showCard();
            const wrapper=document.querySelector('#question-section .mk-io-wrapper'); const rect=wrapper.getBoundingClientRect();
            return {deck:entry.name,groups:groups.length,x:rect.left+rect.width/2,y:Math.min(rect.bottom-4,rect.top+Math.min(180,rect.height/2)),cardId:String(activeDeck[currentIndex].id),group:getImageOcclusionGroupKey(activeDeck[currentIndex]),image:wrapper.dataset.mkIoImage};
        })()`);
        await delay(1000);
        const listenerCountsBefore = await evaluate(`(() => { const wrapper=document.querySelector('#question-section .mk-io-wrapper'); return {windowResize:(getEventListeners(window).resize||[]).length,touchstart:(getEventListeners(wrapper).touchstart||[]).length,resizeObservers:{...window.__mkResizeObserverDiagnostics},images:document.images.length,ioImages:wrapper.querySelectorAll('img').length,overlays:document.querySelectorAll('.mk-high-res-zoom-layer').length,nodes:document.querySelectorAll('*').length,trace:window.getMKIOZoomTrace().length}; })()`);
        const doubleTap = async () => {
            for (let tap = 0; tap < 2; tap++) {
                await evaluate(`(() => {
                    const wrapper=document.querySelector('#question-section .mk-io-wrapper');
                    const rect=wrapper.getBoundingClientRect();
                    const touch=new Touch({identifier:1,target:wrapper,clientX:rect.left+Math.min(rect.width/2,24),clientY:rect.top+Math.min(rect.height/2,120)});
                    wrapper.dispatchEvent(new TouchEvent('touchstart',{touches:[touch],targetTouches:[touch],changedTouches:[touch],bubbles:true,cancelable:true}));
                    wrapper.dispatchEvent(new TouchEvent('touchend',{touches:[],targetTouches:[],changedTouches:[touch],bubbles:true,cancelable:true}));
                })()`);
                await delay(70);
            }
        };
        for (let i = 0; i < 30; i++) { await doubleTap(); await delay(480); }
        const sameImageDoubleTapStarts = consoleEvents.filter(text => text.includes('DOUBLE_TAP_START')).length;
        const afterTaps = await evaluate(`({scale:document.querySelector('#question-section .mk-io-wrapper')._mediaZoomState.scale,touchstart:(getEventListeners(document.querySelector('#question-section .mk-io-wrapper')).touchstart||[]).length})`);
        for (let i = 0; i < 12; i++) {
            await evaluate(`document.getElementById(${JSON.stringify(i % 2 ? 'mk-io-image-prev' : 'mk-io-image-next')}).click()`);
            await delay(80);
            await doubleTap();
            await delay(480);
        }
        await evaluate(`(() => { const groups=getIOImageGroups().groups; currentIndex=groups[groups.length-1].cardIndices[0]; showCard(); })()`);
        await delay(100);
        await doubleTap();
        await delay(480);
        await send('Emulation.setDeviceMetricsOverride', {width:844,height:390,deviceScaleFactor:3,mobile:true});
        await evaluate(`window.dispatchEvent(new Event('orientationchange')); window.dispatchEvent(new Event('resize'));`);
        await delay(150);
        await doubleTap();
        await delay(480);
        await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:3,mobile:true});
        await evaluate(`document.dispatchEvent(new Event('visibilitychange'));`);
        await delay(100);
        await evaluate(`document.getElementById('scroll-area').scrollTop=800; const toggle=document.querySelector('.mk-io-other-masks-toggle'); if(toggle&&!toggle.classList.contains('active'))toggle.click(); window.dispatchEvent(new Event('resize'));`);
        await doubleTap();
        await delay(480);
        await evaluate(`(() => { const groups=getIOImageGroups().groups; const pair=groups.find(group=>group.cardIndices.length>1); currentIndex=pair.cardIndices[0]; showCard(); moveCard(pair.cardIndices[1]-pair.cardIndices[0]); })()`);
        await delay(100);
        await doubleTap();
        await delay(1000);
        const listenerCountsAfter = await evaluate(`(() => { const wrapper=document.querySelector('#question-section .mk-io-wrapper'); return {windowResize:(getEventListeners(window).resize||[]).length,touchstart:(getEventListeners(wrapper).touchstart||[]).length,resizeObservers:{...window.__mkResizeObserverDiagnostics},activeObservers:ioZoomDiagnostics.activeObservers,activeCard:String(activeDeck[currentIndex].id),activeImage:wrapper?.dataset.mkIoImage||'',domMatches:wrapper?.dataset.mkIoImage===getImageOcclusionGroupKey(activeDeck[currentIndex]).replace(/^image:/,''),images:document.images.length,ioImages:wrapper.querySelectorAll('img').length,overlays:document.querySelectorAll('.mk-high-res-zoom-layer').length,nodes:document.querySelectorAll('*').length,raf:wrapper._mediaZoomState.raf?1:0,timers:wrapper._mediaZoomState.doubleTapUnlockTimer?1:0,trace:window.getMKIOZoomTrace()}; })()`);
        await evaluate(`(() => { const wrapper=document.querySelector('#question-section .mk-io-wrapper'); const error=new Error('diagnostic-dedupe-test'); reportIOZoomError(error,'DIAGNOSTIC_TEST',wrapper,wrapper._mediaZoomState); reportIOZoomError(error,'DIAGNOSTIC_TEST',wrapper,wrapper._mediaZoomState); })()`);
        await delay(100);
        const metrics = await send('Performance.getMetrics');
        const metric = name => metrics.result.metrics.find(item => item.name === name)?.value || 0;
        console.log(JSON.stringify({setup,listenerCountsBefore,afterTaps,listenerCountsAfter,sameImageDoubleTapStarts,doubleTapStarts:consoleEvents.filter(text=>text.includes('DOUBLE_TAP_START')).length,diagnosticLogCount:consoleEvents.filter(text=>text.includes('MK_IO_ZOOM_FIRST_ERROR')).length,zoomErrors:consoleEvents.filter(text=>/DOUBLE_TAP_ERROR|IMAGE_ZOOM_ERROR|ZOOM_RESET_BY_ERROR/.test(text)),firstException:exceptions[0]||null,exceptionCount:exceptions.length,jsHeapUsed:metric('JSHeapUsedSize'),nodes:metric('Nodes')}));
        socket.close();
    } finally {
        browser.kill();
        server.close();
        await delay(500);
        try { fs.rmSync(profilePath,{recursive:true,force:true}); } catch (_) {}
    }
}

main().catch(error => { console.error(error); process.exitCode=1; });
