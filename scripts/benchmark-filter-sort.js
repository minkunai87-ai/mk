const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-filter-sort-'));
const edgePath = process.env.MK_BENCH_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const baselineIndex = process.env.MK_BENCH_BASELINE === '1'
    ? childProcess.execFileSync('git', ['show', 'HEAD:index.html'], {cwd: repoRoot})
    : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    if (relative === 'index.html' && baselineIndex) {
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(baselineIndex);
        return;
    }
    const filePath = path.resolve(repoRoot, relative);
    if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    const type = filePath.endsWith('.json') ? 'application/json; charset=utf-8' : filePath.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, {'Content-Type': type});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(8878, '127.0.0.1', resolve));
    const edge = childProcess.spawn(edgePath, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`, '--remote-debugging-port=9334', 'about:blank'], {stdio: 'ignore'});
    try {
        let target;
        for (let i = 0; i < 40 && !target; i++) {
            try { target = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(item => item.type === 'page'); } catch (_) {}
            if (!target) await delay(200);
        }
        if (!target) throw new Error('Edge debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
        const send = (method, params = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); socket.send(JSON.stringify({id, method, params})); });
        await send('Runtime.enable');
        if (process.env.MK_BENCH_MOBILE === '1') {
            await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:3,mobile:true});
            await send('Emulation.setUserAgentOverride', {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
        }
        await send('Page.navigate', {url: 'http://127.0.0.1:8878/index.html'});
        for (let i = 0; i < 120; i++) {
            await delay(500);
            const ready = await send('Runtime.evaluate', {expression: `Object.values(library||{}).reduce((n,c)=>n+c.length,0)`, returnByValue: true});
            if (ready.result?.result?.value > 0) break;
        }
        const evaluated = await send('Runtime.evaluate', {expression: `
            (async () => {
                const allCards = Object.values(library).flat();
                const syntheticStats = {};
                const syntheticHistory = {};
                allCards.forEach((card, index) => {
                    syntheticStats[card.id] = {correct:index%7,total:(index%9)+1,lastDate:index%5?Date.now()-index*100000:0,dueDate:index%3?Date.now()-86400000:Date.now()+86400000,mem:index%4===0,cmp:index%5===0,fav:index%6===0,num:index%7===0,date:index%8===0,pen:index%9===0};
                    syntheticHistory[card.id] = [{score:index%4,time:Date.now()}];
                });
                restoredStats = syntheticStats;
                localStorage.setItem(STORAGE_KEY_REVIEW_HISTORY, JSON.stringify(syntheticHistory));
                const functionNames = ['findStatsForCard','getAccuracyStats','extractNumber','renderDeckTree','showCard','resolveIndexForDeck'];
                const originals = {};
                const metrics = {};
                functionNames.forEach(name => {
                    originals[name] = window[name];
                    window[name] = function(...args) { const start=performance.now(); try{return originals[name].apply(this,args);} finally { const item=metrics[name]||(metrics[name]={calls:0,ms:0}); item.calls++; item.ms+=performance.now()-start; } };
                });
                const cases = [
                    {name:'original',filter:'default',primary:'original',secondary:'none'},
                    {name:'unlearned',filter:'default',primary:'unlearned',secondary:'none'},
                    {name:'wrong_recent',filter:'default',primary:'wrong',secondary:'recent'},
                    {name:'number',filter:'default',primary:'number',secondary:'none'},
                    {name:'oldest',filter:'default',primary:'oldest',secondary:'none'},
                    {name:'recent',filter:'default',primary:'recent',secondary:'none'},
                    {name:'original_wrong_secondary',filter:'default',primary:'original',secondary:'wrong'},
                    {name:'multi_filter_wrong',filter:['due','mem','fav'],primary:'wrong',secondary:'original'},
                    {name:'recent_oldest',filter:'default',primary:'recent',secondary:'oldest'},
                    ...['due','mem','cmp','fav','num','date','pen'].map(filter => ({name:'filter_'+filter,filter,primary:'original',secondary:'none'}))
                ];
                const results = [];
                const requestedSizes = ${JSON.stringify((process.env.MK_BENCH_SIZES || '100,1000,2000,all').split(',').map(value => value === 'all' ? 'all' : Number(value)))};
                for (const requestedSize of requestedSizes) {
                    const size = requestedSize === 'all' ? allCards.length : Math.min(requestedSize, allCards.length);
                    for (const testCase of cases.filter(item => size !== allCards.length || item.name === 'original')) {
                        originalDeck = allCards.slice(0,size); currentDeckName='__benchmark__'; currentIndex=Math.min(10,size-1);
                        const startingCardId = String(originalDeck[currentIndex] && originalDeck[currentIndex].id || '');
                        currentFilterMode=testCase.filter; currentSortMode=testCase.primary; currentSecondarySortMode=testCase.secondary;
                        const runs=[];
                        const runCount = ${Math.max(1, Number(process.env.MK_BENCH_RUNS || 0)) || 0} || (size === allCards.length ? 1 : 3);
                        for(let run=0;run<runCount;run++) { Object.keys(metrics).forEach(key=>delete metrics[key]); const start=performance.now(); applyFilterAndSort(false); runs.push({totalMs:performance.now()-start,metrics:JSON.parse(JSON.stringify(metrics))}); }
                        results.push({size,name:testCase.name,runs,uuids:activeDeck.map(card=>String(card.id)),startingCardId,currentIndex,currentCardId:String(activeDeck[currentIndex] && activeDeck[currentIndex].id || '')});
                    }
                }
                functionNames.forEach(name => window[name]=originals[name]);
                const referenceApply = (cards, testCase) => {
                    const today = new Date(); today.setHours(0,0,0,0);
                    const statFor = card => syntheticStats[card.id] || {};
                    const accuracyFor = card => {
                        const stat = statFor(card), items = syntheticHistory[card.id] || [];
                        if(!items.length) return {correct:Number(stat.correct)||0,total:Number(stat.total)||0};
                        return items.reduce((acc,item)=>{if(isConfirmHistoryItem(item))return acc;const score=Number(item.score);acc.total++;if(score===2)acc.correct++;else if(score===1)acc.correct+=0.5;return acc;},{correct:0,total:0});
                    };
                    const order = new Map(cards.map((card,index)=>[String(card.id),index]));
                    const original = card => order.has(String(card.id)) ? order.get(String(card.id)) : 999999;
                    const filters = testCase.filter === 'default' ? [] : (Array.isArray(testCase.filter)?testCase.filter:[testCase.filter]);
                    const filtered = filters.length ? cards.filter(card=>filters.some(mode=>{const stat=statFor(card);return mode==='due'?(stat.dueDate&&stat.dueDate<=today.getTime()):!!stat[mode];})) : cards.slice();
                    const unlearned = card => {const accuracy=accuracyFor(card),history=syntheticHistory[card.id];return accuracy.total===0||!Array.isArray(history)||history.length===0;};
                    const compare=(a,b,mode)=>{if(mode==='unlearned'){const av=unlearned(a),bv=unlearned(b);if(av!==bv)return av?-1:1;}else if(mode==='wrong'){const aa=accuracyFor(a),ba=accuracyFor(b),av=aa.total===0?1:aa.correct/aa.total,bv=ba.total===0?1:ba.correct/ba.total;if(av!==bv)return av-bv;}else if(mode==='number'){const diff=extractNumber(a)-extractNumber(b);if(diff)return diff;}else if(mode==='oldest'){const av=Number(statFor(a).lastDate)||0,bv=Number(statFor(b).lastDate)||0,diff=(av||Number.MAX_SAFE_INTEGER)-(bv||Number.MAX_SAFE_INTEGER);if(diff)return diff;}else if(mode==='recent'){const diff=(Number(statFor(b).lastDate)||0)-(Number(statFor(a).lastDate)||0);if(diff)return diff;}else if(mode==='original'){const diff=original(a)-original(b);if(diff)return diff;}return 0;};
                    filtered.sort((a,b)=>{const primary=testCase.primary==='original'&&testCase.secondary!=='none'?0:compare(a,b,testCase.primary);if(primary)return primary;if(testCase.primary==='unlearned'&&unlearned(a)&&unlearned(b))return original(a)-original(b);if(testCase.secondary!=='none'&&testCase.secondary!==testCase.primary){const secondary=compare(a,b,testCase.secondary);if(secondary)return secondary;}return original(a)-original(b);});
                    return filtered;
                };
                const equivalence = [];
                const searchInput=document.getElementById('search-input');
                const searchQuery=String(allCards.find(card=>String(card.q||'').length>8)?.q||'').replace(/<[^>]*>/g,' ').trim().slice(0,4).toLowerCase();
                if (${process.env.MK_BENCH_SKIP_EQUIVALENCE !== '1'}) {
                    for(const testCase of cases){originalDeck=allCards;currentDeckName='__equivalence__';currentFilterMode=testCase.filter;currentSortMode=testCase.primary;currentSecondarySortMode=testCase.secondary;applyFilterAndSort(false);const expected=referenceApply(allCards,testCase).map(card=>String(card.id)),actual=activeDeck.map(card=>String(card.id));equivalence.push({name:testCase.name,equal:JSON.stringify(expected)===JSON.stringify(actual),count:actual.length});}
                    originalDeck=allCards;currentDeckName='__search__';currentFilterMode=['due','fav'];currentSortMode='wrong';currentSecondarySortMode='recent';searchInput.value=searchQuery;filterCards();const searchExpected=allCards.filter(card=>String(card.q||'').toLowerCase().includes(searchQuery)||String(card.a||'').toLowerCase().includes(searchQuery)).map(card=>String(card.id));equivalence.push({name:'search_with_filter_state',equal:JSON.stringify(searchExpected)===JSON.stringify(activeDeck.map(card=>String(card.id))),count:activeDeck.length});
                    originalDeck=allCards;currentDeckName='__context__';currentFilterMode='default';currentSortMode='wrong';currentSecondarySortMode='recent';applyFilterAndSort(false);currentIndex=Math.min(25,activeDeck.length-1);const contextIds=activeDeck.map(card=>String(card.id)),contextCard=String(activeDeck[currentIndex]?.id||'');enterOriginalOrderContext();exitOriginalOrderContext();equivalence.push({name:'original_context_restore',equal:JSON.stringify(contextIds)===JSON.stringify(activeDeck.map(card=>String(card.id)))&&contextCard===String(activeDeck[currentIndex]?.id||''),count:activeDeck.length});
                }
                const uiFunctionNames=['applyFilterAndSort','showCard','renderDeckTree','filterCards','persistCurrentViewState'];
                const uiOriginals={},uiCounts={};
                uiFunctionNames.forEach(name=>{uiOriginals[name]=window[name];window[name]=function(...args){uiCounts[name]=(uiCounts[name]||0)+1;return uiOriginals[name].apply(this,args);};});
                const measurePaint = action => new Promise(resolve=>{Object.keys(uiCounts).forEach(key=>delete uiCounts[key]);requestAnimationFrame(()=>{const start=performance.now();action();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({ms:performance.now()-start,counts:{...uiCounts},cardId:getCurrentCardId(),count:activeDeck.length})));});});
                const uiTimings=[];
                const primarySelect=document.getElementById('sort-primary-select'),secondarySelect=document.getElementById('sort-secondary-select');
                const uiCards=allCards.slice(0,Math.min(${Math.max(1, Number(process.env.MK_BENCH_UI_SIZE || 0)) || Number.MAX_SAFE_INTEGER},allCards.length));
                const prepare=(filter='default',primary='original',secondary='none')=>{originalDeck=uiCards;currentDeckName='__ui__';currentFilterMode=filter;currentSortMode=primary;currentSecondarySortMode=secondary;activeDeck=uiCards.slice();currentIndex=Math.min(25,activeDeck.length-1);highlightFilter();};
                const measureCase=async(name,prepareCase,action)=>{const runs=[];for(let run=0;run<${Math.max(1, Number(process.env.MK_BENCH_UI_RUNS || 3))};run++){prepareCase();runs.push(await measurePaint(action));}uiTimings.push({name,runs});};
                await measureCase('wrong',()=>prepare('default','original','none'),()=>{primarySelect.value='wrong';primarySelect.dispatchEvent(new Event('change',{bubbles:true}));});
                await measureCase('recent',()=>prepare('default','original','none'),()=>{primarySelect.value='recent';primarySelect.dispatchEvent(new Event('change',{bubbles:true}));});
                await measureCase('number',()=>prepare('default','original','none'),()=>{primarySelect.value='number';primarySelect.dispatchEvent(new Event('change',{bubbles:true}));});
                await measureCase('primary_secondary',()=>prepare('default','wrong','none'),()=>{secondarySelect.value='recent';secondarySelect.dispatchEvent(new Event('change',{bubbles:true}));});
                await measureCase('multi_filter',()=>prepare(['due','mem'],'wrong','recent'),()=>document.getElementById('filter-fav').click());
                await measureCase('search_filter',()=>{prepare(['due','fav'],'wrong','recent');searchInput.value=searchQuery;},()=>searchInput.dispatchEvent(new KeyboardEvent('keyup',{key:'a',bubbles:true})));
                await measureCase('original_restore',()=>prepare('default','wrong','recent'),()=>{primarySelect.value='original';primarySelect.dispatchEvent(new Event('change',{bubbles:true}));});
                uiFunctionNames.forEach(name=>window[name]=uiOriginals[name]);
                return {version:APP_VERSION,deckCount:Object.keys(library).length,cardCount:allCards.length,results,equivalence,uiTimings};
            })()
        `, awaitPromise: true, returnByValue: true});
        if (evaluated.result?.exceptionDetails) throw new Error(JSON.stringify(evaluated.result.exceptionDetails));
        const output = evaluated.result.result.value;
        if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
        process.stdout.write(JSON.stringify(output) + '\n');
        socket.close();
    } finally {
        edge.kill(); server.close(); await delay(500);
        try { fs.rmSync(profilePath, {recursive:true,force:true}); } catch (_) {}
    }
}
main().catch(error => { console.error(error); process.exitCode=1; });
