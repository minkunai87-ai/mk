const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ad-render-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const types = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json', '.txt':'text/plain', '.png':'image/png' };
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if(!file.startsWith(root) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type':`${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    fs.createReadStream(file).pipe(response);
});

(async () => {
    await new Promise(resolve => server.listen(8891, '127.0.0.1', resolve));
    const chrome = childProcess.spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=9341','about:blank'], { stdio:'ignore' });
    try {
        let target;
        for(let index = 0; index < 50 && !target; index += 1) {
            try { target = (await (await fetch('http://127.0.0.1:9341/json/list')).json()).find(item => item.type === 'page'); } catch (_) {}
            if(!target) await delay(200);
        }
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let id = 0;
        const pending = new Map();
        socket.onmessage = event => { const message=JSON.parse(event.data); if(message.id && pending.has(message.id)){ pending.get(message.id)(message); pending.delete(message.id); } };
        const send = (method, params={}) => new Promise(resolve => { const callId=++id; pending.set(callId, resolve); socket.send(JSON.stringify({ id:callId, method, params })); });
        const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true })).result.result.value;
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:3, mobile:true });
        await send('Page.navigate', { url:'http://127.0.0.1:8891/index.html' });
        for(let index = 0; index < 120; index += 1) { await delay(500); if(await evaluate('!!window.__mkADDiagnostic && !!document.querySelector("#mk-render-diagnostic-toolbar")')) break; }
        const results = {};
        const styleKeys = ['display','position','width','height','min-width','max-width','min-height','max-height','overflow','object-fit','object-position','image-rendering','transform','transform-origin','translate','scale','filter','opacity','backface-visibility','will-change','contain','content-visibility','isolation','mix-blend-mode','perspective','clip','clip-path','visibility','pointer-events','margin','padding','left','top'];
        for(const zoom of ['1.7','2.89','5']) {
            for(const name of ['A-original','A-fixed','D']) {
                await evaluate(`window.__mkADDiagnostic.setZoom('${zoom}');window.__mkADDiagnostic.showCase('${name}')`);
                await delay(900);
                results[`${name}-${zoom}`] = await evaluate(`(() => {const s=window.__mkADDiagnostic.snapshots.get('${name}'),keys=${JSON.stringify(styleKeys)},pick=o=>Object.fromEntries(keys.map(k=>[k,o[k]]));return s&&{img:{attributes:Object.fromEntries(Array.from(document.querySelector('${name === 'D' ? '#mk-render-diagnostic-stage img' : '#question-section .mk-io-wrapper img'}').attributes).map(a=>[a.name,a.value])),natural:s.img.natural,client:s.img.client,rect:s.img.rect,computed:pick(s.img.computed)},wrapper:{attributes:Object.fromEntries(Array.from(document.querySelector('${name === 'D' ? '#mk-render-diagnostic-stage .mk-io-wrapper' : '#question-section .mk-io-wrapper'}').attributes).map(a=>[a.name,a.value])),client:s.wrapper.client,rect:s.wrapper.rect,computed:pick(s.wrapper.computed)}};})()`);
                const shot = await send('Page.captureScreenshot', { format:'png', clip:{ x:0, y:180, width:390, height:500, scale:1 }, captureBeyondViewport:false });
                fs.writeFileSync(path.join(root, `ad-${name}-${zoom}.png`), Buffer.from(shot.result.data, 'base64'));
            }
        }
        const summary = await evaluate(`(() => {const d=window.__mkADDiagnostic;return {lifecycle:d.lifecycle.map(x=>x.label),mutations:d.mutations.map(x=>({node:x.node,attribute:x.attribute,value:x.value,connected:x.connected})).slice(0,40),images:document.images.length,masks:document.querySelectorAll('.mk-io-layer').length,overlays:document.querySelectorAll('.mk-high-res-zoom-layer').length};})()`);
        console.log(JSON.stringify({ results, summary }, null, 2));
        socket.close();
    } finally {
        chrome.kill(); server.close(); await delay(1000); try { fs.rmSync(profile, { recursive:true, force:true, maxRetries:3, retryDelay:300 }); } catch (_) {}
    }
})().catch(error => { console.error(error); process.exitCode=1; });
