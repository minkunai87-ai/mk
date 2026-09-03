const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-image-zoom-icon-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const annotationUuid = '6a69ef21-c0f1-4182-a125-f34e23de8d0e';
const baselineHtml = childProcess.execFileSync('git', ['show', 'HEAD:index.html'], {cwd:repoRoot, encoding:'utf8'});
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if(pathname === '/baseline.html') {
        response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        return response.end(baselineHtml);
    }
    if(pathname === '/decks-manifest.json') {
        response.writeHead(200, {'Content-Type':'application/json'});
        return response.end(JSON.stringify({schemaVersion:1, version:'zoom-icon-test', files:['fixture.txt']}));
    }
    if(pathname === '/fixture.txt') {
        response.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
        return response.end('fixture\tquestion\tanswer\n');
    }
    if(pathname === '/pdf-annotations.json') {
        response.writeHead(200, {'Content-Type':'application/json'});
        return response.end(JSON.stringify({schemaVersion:2, annotations:{}}));
    }
    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if(!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    response.writeHead(200, {'Content-Type':filePath.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8'});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const debugPort = 9800 + Math.floor(Math.random() * 100);
    const edge = childProcess.spawn(edgePath, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`,
        `--remote-debugging-port=${debugPort}`, 'about:blank'
    ], {stdio:'ignore', windowsHide:true});
    let socket;
    try {
        let target;
        for(let attempt = 0; attempt < 50 && !target; attempt++) {
            try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(100);
        }
        if(!target) throw new Error('Edge debugging target unavailable');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
            pending.set(id, message => { clearTimeout(timer); resolve(message); });
            socket.send(JSON.stringify({id, method, params}));
        });
        const post = (method, params = {}) => socket.send(JSON.stringify({id:++nextId, method, params}));
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if(message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
                return;
            }
            if(message.method !== 'Fetch.requestPaused') return;
            const request = message.params.request;
            if(!/firebaseio\.com/i.test(request.url)) return post('Fetch.continueRequest', {requestId:message.params.requestId});
            post('Fetch.fulfillRequest', {
                requestId:message.params.requestId,
                responseCode:200,
                responseHeaders:[{name:'Content-Type', value:'application/json'}],
                body:Buffer.from(request.method === 'GET' ? 'null' : '{}').toString('base64')
            });
        };
        await send('Runtime.enable');
        await send('Fetch.enable', {patterns:[{urlPattern:'*firebaseio.com/*', requestStage:'Request'}]});
        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
            if(response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'browser evaluation failed');
            return response.result?.result?.value;
        };
        const loadApp = async pathname => {
            await send('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/${pathname}`});
            for(let attempt = 0; attempt < 100; attempt++) {
                try {
                    if(await evaluate(`typeof bindImageZoomHandlers === 'function' && document.getElementById('loading')?.style.display === 'none'`)) break;
                } catch(error) {}
                await delay(50);
            }
            for(let attempt = 0; attempt < 100; attempt++) {
                if(await evaluate(`getMkStartupTiming().backgroundSyncCompleted`)) break;
                await delay(20);
            }
        };
        const runScenario = () => evaluate(`(async () => {
            const uuid=${JSON.stringify(annotationUuid)};
            pdfAnnotationSourceIndex=new Map([[uuid,{lsType:'annotation',pdfFileName:'fixture.pdf',page:1,annotationId:uuid,sourceUuid:uuid}]]);
            pdfAnnotationResolveCache.clear();
            observeDynamicPdfAnnotations();
            const source=new URL('images/178_'+uuid+'_1785327393144.png',document.baseURI).href;
            currentDeckName='zoom__fixture';
            originalDeck=[
                {id:'zoom-image-card',q:'<img src="'+source+'">',a:'',deck:currentDeckName,sourceOrder:0},
                {id:'zoom-other-card',q:'other card',a:'',deck:currentDeckName,sourceOrder:1}
            ];
            activeDeck=originalDeck;
            currentIndex=0;
            showCard();
            let image=document.querySelector('#question-section img');
            await image.decode();
            const countBottomIcons=() => document.querySelectorAll('body > .mk-pdf-annotation').length;
            const iconCounts=[countBottomIcons()];
            const originalNow=Date.now;
            let clock=1000;
            Date.now=() => clock;
            const tap=element => {
                const event=new Event('touchstart',{bubbles:true,cancelable:true});
                Object.defineProperty(event,'touches',{value:[{clientX:80,clientY:80}]});
                Object.defineProperty(event,'changedTouches',{value:[{clientX:80,clientY:80}]});
                element.dispatchEvent(event);
            };
            const doubleTap=async element => {
                clock+=500;
                element._mediaZoomState.lastTap=clock;
                clock+=100;
                tap(element);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            };
            const zoomScales=[];
            const overlayTags=[];
            for(let cycle=0; cycle<10; cycle++) {
                await doubleTap(image);
                zoomScales.push(image._mediaZoomState.scale);
                overlayTags.push(document.querySelector('.mk-high-res-zoom-layer')?.tagName || '');
                await doubleTap(image);
                zoomScales.push(image._mediaZoomState.scale);
                iconCounts.push(countBottomIcons());
            }
            const accumulated=document.querySelector('body > .mk-pdf-annotation');
            const accumulatedIcon=accumulated?.querySelector('.mk-pdf-annotation-icon');
            const addedNode=accumulated ? {
                tag:accumulated.tagName,
                className:accumulated.className,
                parent:accumulated.parentElement?.tagName || '',
                iconTag:accumulatedIcon?.tagName || '',
                iconClass:accumulatedIcon?.getAttribute('class') || '',
                wrapper:accumulated.outerHTML
            } : null;
            moveCard(1);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const afterOtherCard=countBottomIcons();
            moveCard(-1);
            await new Promise(resolve => requestAnimationFrame(resolve));
            image=document.querySelector('#question-section img');
            await image.decode();
            const afterReturn=countBottomIcons();
            for(let cycle=0; cycle<5; cycle++) {
                await doubleTap(image);
                zoomScales.push(image._mediaZoomState.scale);
                overlayTags.push(document.querySelector('.mk-high-res-zoom-layer')?.tagName || '');
                await doubleTap(image);
                zoomScales.push(image._mediaZoomState.scale);
                iconCounts.push(countBottomIcons());
            }
            const normalPdfIcon=document.querySelector('#question-section .mk-pdf-annotation-icon');
            let normalPdfNavigation=0;
            window.__mkPdfNavigationTestHook=() => normalPdfNavigation++;
            normalPdfIcon?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
            delete window.__mkPdfNavigationTestHook;
            Date.now=originalNow;
            return {iconCounts,afterOtherCard,afterReturn,addedNode,zoomScales,overlayTags,overlayCount:document.querySelectorAll('.mk-high-res-zoom-layer').length,zoomBound:image.dataset.mediaZoomBound,normalPdfIcon:!!normalPdfIcon,normalPdfHref:normalPdfIcon?.getAttribute('href') || '',normalPdfNavigation};
        })()`);
        await loadApp('baseline.html');
        const before=await runScenario();
        assert.deepStrictEqual(before.iconCounts.slice(0,4), [0,1,2,3], JSON.stringify(before));
        assert.strictEqual(before.iconCounts.at(-1), 15, JSON.stringify(before));
        assert.deepStrictEqual({tag:before.addedNode?.tag,className:before.addedNode?.className,parent:before.addedNode?.parent,iconTag:before.addedNode?.iconTag,iconClass:before.addedNode?.iconClass}, {tag:'SPAN',className:'mk-pdf-annotation mk-pdf-image-annotation',parent:'BODY',iconTag:'svg',iconClass:'mk-pdf-annotation-icon'});
        await loadApp('index.html');
        const after=await runScenario();
        assert(after.iconCounts.every(count => count === 0), JSON.stringify(after));
        assert.strictEqual(after.afterOtherCard, 0, JSON.stringify(after));
        assert.strictEqual(after.afterReturn, 0, JSON.stringify(after));
        assert.strictEqual(after.overlayCount, 0, JSON.stringify(after));
        assert.strictEqual(after.zoomBound, '1', JSON.stringify(after));
        assert(after.zoomScales.every((scale, index) => index % 2 === 0 ? scale > 1 : scale === 1), JSON.stringify(after));
        assert(after.overlayTags.every(tagName => tagName === 'DIV'), JSON.stringify(after));
        assert.strictEqual(after.normalPdfIcon, true, JSON.stringify(after));
        assert(after.normalPdfHref.startsWith('mkpdf://open?'), JSON.stringify(after));
        assert.strictEqual(after.normalPdfNavigation, 1, JSON.stringify(after));
        process.stdout.write(JSON.stringify({before,after}, null, 2) + '\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close();
        const browserExited = new Promise(resolve => edge.once('exit', resolve));
        edge.kill();
        server.close();
        await Promise.race([browserExited, delay(3000)]);
        fs.rmSync(profilePath, {recursive:true, force:true, maxRetries:5, retryDelay:100});
    }
}

main().catch(error => { console.error(error); process.exitCode=1; });
