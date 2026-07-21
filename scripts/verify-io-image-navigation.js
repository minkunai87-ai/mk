const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-io-nav-'));
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
    await new Promise(resolve => server.listen(8879, '127.0.0.1', resolve));
    const browser = childProcess.spawn(browserPath, ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`, '--remote-debugging-port=9335', 'about:blank'], {stdio: 'ignore'});
    try {
        let target;
        for (let i = 0; i < 40 && !target; i++) {
            try { target = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find(item => item.type === 'page'); } catch (_) {}
            if (!target) await delay(200);
        }
        if (!target) throw new Error('Chrome debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
        };
        const send = (method, params = {}) => new Promise(resolve => {
            const id = ++nextId;
            pending.set(id, resolve);
            socket.send(JSON.stringify({id, method, params}));
        });
        await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:3,mobile:true});
        await send('Page.navigate', {url:'http://127.0.0.1:8879/index.html'});
        for (let i = 0; i < 120; i++) {
            await delay(500);
            const ready = await send('Runtime.evaluate', {expression:'Object.values(library||{}).reduce((n,c)=>n+c.length,0)', returnByValue:true});
            if (ready.result?.result?.value > 0) break;
        }
        const result = await send('Runtime.evaluate', {expression:`
            (async () => {
                const deckEntry = Object.entries(library).find(([, cards]) => {
                    const keys = cards.map(getImageOcclusionGroupKey).filter(Boolean);
                    return new Set(keys).size >= 3;
                });
                if(!deckEntry) throw new Error('No deck with three image-occlusion groups');
                currentDeckName = deckEntry[0];
                originalDeck = deckEntry[1];
                activeDeck = originalDeck.slice();
                ioImageGroupCache = { cards:null, length:0, groups:[], cardToGroup:new Map() };
                ioImageLastVisitedCard.clear();
                const groups = getIOImageGroups().groups;
                const statsBefore = localStorage.getItem(STORAGE_KEY_STATS);
                const historyBefore = localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY);
                const updatedBefore = localStorage.getItem(STORAGE_KEY_LOCAL_DATA_UPDATED_AT);
                const firstStart = groups[0].cardIndices[Math.min(1, groups[0].cardIndices.length - 1)];
                currentIndex = firstStart;
                showCard();
                await new Promise(resolve => setTimeout(resolve, 800));
                const prevButton = document.getElementById('mk-io-image-prev');
                const nextButton = document.getElementById('mk-io-image-next');
                const masksToggle = document.querySelector('.mk-io-other-masks-toggle');
                let masksToggleWorks = false;
                if(masksToggle) {
                    masksToggle.click();
                    masksToggleWorks = !!document.querySelector('.mk-io-wrapper.mk-io-show-other-content');
                }
                const firstDisabled = prevButton.disabled;
                nextButton.click();
                const nextFirst = currentIndex === groups[1].cardIndices[0];
                const skippedStatsUnchanged = statsBefore === localStorage.getItem(STORAGE_KEY_STATS) && historyBefore === localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY) && updatedBefore === localStorage.getItem(STORAGE_KEY_LOCAL_DATA_UPDATED_AT);
                goToPreviousCard();
                const backRestored = currentIndex === firstStart;

                ioImageLastVisitedCard.clear();
                currentIndex = groups[1].cardIndices[0];
                showCard();
                prevButton.click();
                const unvisitedUsesFirst = currentIndex === groups[0].cardIndices[0];

                const visitedTarget = groups[1].cardIndices[groups[1].cardIndices.length - 1];
                currentIndex = visitedTarget;
                showCard();
                currentIndex = groups[2].cardIndices[0];
                showCard();
                prevButton.click();
                const visitedRestored = currentIndex === visitedTarget;

                currentIndex = groups[groups.length - 1].cardIndices[0];
                showCard();
                const lastDisabled = nextButton.disabled;
                const lastIndex = currentIndex;
                nextButton.click();
                const disabledNoop = currentIndex === lastIndex;

                currentIndex = groups[0].cardIndices[0];
                showCard();
                const rectBefore = prevButton.getBoundingClientRect();
                document.getElementById('scroll-area').scrollTop = 500;
                const rectAfter = prevButton.getBoundingClientRect();
                const fixedOnScroll = rectBefore.top === rectAfter.top && getComputedStyle(prevButton).position === 'fixed';
                const headerBottom = document.querySelector('.header-container').getBoundingClientRect().bottom;
                const edgePlacement = rectBefore.left <= 16 && nextButton.getBoundingClientRect().right >= 374 && rectBefore.top >= headerBottom + 7;
                const avoidsFooter = rectBefore.bottom < document.querySelector('.footer').getBoundingClientRect().top;

                const normalDeckEntry = Object.entries(library).find(([, cards]) => cards.some(card => !getImageOcclusionGroupKey(card)));
                activeDeck = normalDeckEntry[1];
                currentDeckName = normalDeckEntry[0];
                currentIndex = activeDeck.findIndex(card => !getImageOcclusionGroupKey(card));
                showCard();
                const hiddenOnNormal = !prevButton.classList.contains('visible') && !nextButton.classList.contains('visible');
                const navigationStatsUnchanged = statsBefore === localStorage.getItem(STORAGE_KEY_STATS);
                const navigationHistoryUnchanged = historyBefore === localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY);
                const gradeCard = activeDeck[currentIndex];
                const gradeMatchBefore = findStatsForCard(gradeCard, getStatsStore(), gradeCard.id);
                const gradeTotalBefore = Number(gradeMatchBefore.stat && gradeMatchBefore.stat.total) || 0;
                await grade(2);
                const gradeMatchAfter = findStatsForCard(gradeCard, getStatsStore(), gradeCard.id);
                const gradeHistory = getReviewHistory()[gradeMatchAfter.key || gradeCard.id];
                const gradingStillWorks = Number(gradeMatchAfter.stat && gradeMatchAfter.stat.total) === gradeTotalBefore + 1 && Array.isArray(gradeHistory) && gradeHistory.length > 0;

                return {
                    version:APP_VERSION, deck:currentDeckName, groups:groups.length,
                    checks:{firstDisabled,nextFirst,skippedStatsUnchanged,backRestored,unvisitedUsesFirst,visitedRestored,lastDisabled,disabledNoop,fixedOnScroll,edgePlacement,avoidsFooter,masksToggleWorks,hiddenOnNormal,gradingStillWorks},
                    statsWrites:!navigationStatsUnchanged,
                    historyWrites:!navigationHistoryUnchanged
                };
            })()
        `, returnByValue:true, awaitPromise:true});
        if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
        const value = result.result.result.value;
        console.log(JSON.stringify(value));
        if (!Object.values(value.checks).every(Boolean) || value.statsWrites || value.historyWrites) process.exitCode = 1;
        socket.close();
    } finally {
        browser.kill();
        server.close();
        await delay(500);
        try { fs.rmSync(profilePath, {recursive:true, force:true}); } catch (_) {}
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
