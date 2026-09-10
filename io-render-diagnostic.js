(() => {
    const IMAGE_NAME = 'io1-2_1780227484684_0.png';
    const IMAGE_URL = `https://raw.githubusercontent.com/minkunai87-ai/mk/main/images/${IMAGE_NAME}`;
    const WIDTHS = { '1':334, '1.7':568, '2.89':965, '5':1670 };
    const SOURCE_Y = 2400;
    const times = {};
    let currentCase = 'A';
    let currentZoom = '1.7';

    const now = () => Math.round(performance.now() * 10) / 10;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async predicate => {
        for(let i = 0; i < 120; i += 1) {
            const value = predicate();
            if(value) return value;
            await wait(250);
        }
        return null;
    };
    const styleSummary = (img, wrapper) => {
        const imageStyle = getComputedStyle(img);
        const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
        const rect = img.getBoundingClientRect();
        return {
            natural:`${img.naturalWidth}×${img.naturalHeight}`,
            client:`${img.clientWidth}×${img.clientHeight}`,
            rect:`${rect.width.toFixed(2)}×${rect.height.toFixed(2)}`,
            transform:imageStyle.transform,
            overflow:wrapperStyle ? wrapperStyle.overflow : imageStyle.overflow,
            created:times[currentCase]?.created ?? '-',
            src:times[currentCase]?.src ?? '-',
            appended:times[currentCase]?.appended ?? '-',
            loaded:times[currentCase]?.loaded ?? '-'
        };
    };
    const renderInfo = (img, wrapper) => {
        const info = document.getElementById('mk-render-diagnostic-info');
        const data = styleSummary(img, wrapper);
        info.textContent = Object.entries(data).map(([key,value]) => `${key}: ${value}`).join(' | ');
    };
    const createImage = () => {
        const caseKey = currentCase;
        times[caseKey] = { created:now() };
        const img = document.createElement('img');
        times[caseKey].src = now();
        img.src = IMAGE_URL;
        img.alt = `${currentCase} ${IMAGE_NAME}`;
        img.addEventListener('load', () => {
            times[caseKey].loaded = now();
            const wrapper = img.closest('.mk-io-wrapper, .mk-diag-overflow');
            if(currentCase === caseKey && img.isConnected) renderInfo(img, wrapper);
        }, { once:true });
        return img;
    };
    const placeDirectCase = caseName => {
        const stage = document.getElementById('mk-render-diagnostic-stage');
        stage.innerHTML = '';
        const width = WIDTHS[currentZoom];
        const height = width * 16433 / 2479;
        const top = 170 - SOURCE_Y * width / 2479;
        let parent = stage;
        if(caseName === 'C') {
            const wrapper = document.createElement('div');
            wrapper.className = 'mk-diag-overflow';
            wrapper.style.cssText = `position:absolute;left:12px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden`;
            stage.appendChild(wrapper);
            parent = wrapper;
        } else if(caseName === 'D') {
            stage.innerHTML = '<div class="mk-diag-card card"><div class="card-scroll-area"><div class="zoom-content"><div class="text-area mode-question"><span class="mk-io-wrapper"></span></div></div></div></div>';
            const card = stage.firstElementChild;
            card.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
            const scroll = card.querySelector('.card-scroll-area');
            scroll.style.cssText = 'position:absolute;inset:0;overflow-x:hidden;overflow-y:auto';
            const zoom = card.querySelector('.zoom-content');
            zoom.style.cssText = 'position:relative;width:100%;height:100%;padding:0;transform:none;will-change:auto';
            const text = card.querySelector('.text-area');
            text.style.cssText = 'position:relative;width:100%;height:100%;overflow-x:hidden;overflow-y:auto';
            parent = card.querySelector('.mk-io-wrapper');
            parent.style.cssText = `position:absolute;display:block;left:12px;top:${top}px;width:${width}px;height:${height}px;max-width:none;overflow:hidden`;
        }
        const img = createImage();
        img.style.cssText = `display:block;position:${caseName === 'B' ? 'absolute' : 'static'};left:${caseName === 'B' ? '12px' : '0'};top:${caseName === 'B' ? `${top}px` : '0'};width:${width}px!important;height:${height}px!important;max-width:none!important;margin:0!important;transform:none!important;border-radius:0;box-shadow:none`;
        parent.appendChild(img);
        times[currentCase].appended = now();
        renderInfo(img, parent === stage ? null : parent);
    };
    const showCase = caseName => {
        currentCase = caseName;
        document.querySelectorAll('[data-mk-diag-case]').forEach(button => button.classList.toggle('active', button.dataset.mkDiagCase === caseName));
        const stage = document.getElementById('mk-render-diagnostic-stage');
        const scrollArea = document.getElementById('scroll-area');
        if(caseName === 'A') {
            stage.style.display = 'none';
            scrollArea.style.visibility = 'visible';
            const wrapper = document.querySelector('#question-section .mk-io-wrapper');
            if(wrapper && wrapper._mediaZoomState?.setRenderDiagnosticView) {
                wrapper._mediaZoomState.setRenderDiagnosticView(Number(currentZoom), SOURCE_Y);
                requestAnimationFrame(() => renderInfo(wrapper.querySelector('img'), wrapper));
            }
            return;
        }
        scrollArea.style.visibility = 'hidden';
        stage.style.display = 'block';
        placeDirectCase(caseName);
    };
    const setZoom = value => {
        currentZoom = value;
        document.querySelectorAll('[data-mk-diag-zoom]').forEach(button => button.classList.toggle('active', button.dataset.mkDiagZoom === value));
        showCase(currentCase);
    };
    const buildUi = () => {
        const card = document.querySelector('.card');
        const panel = document.createElement('div');
        panel.id = 'mk-render-diagnostic-toolbar';
        panel.innerHTML = `
            <div><b>IO RENDER DIAGNOSTIC</b> · <a href="${IMAGE_URL}" target="_blank" rel="noopener">RAW PNG 열기</a></div>
            <div>${['A','B','C','D'].map(name => `<button data-mk-diag-case="${name}">${name}</button>`).join('')}</div>
            <div>${Object.keys(WIDTHS).map(value => `<button data-mk-diag-zoom="${value}">${value}×</button>`).join('')}</div>
            <div id="mk-render-diagnostic-info">loading…</div>`;
        const stage = document.createElement('div');
        stage.id = 'mk-render-diagnostic-stage';
        card.appendChild(stage);
        document.body.appendChild(panel);
        panel.querySelectorAll('[data-mk-diag-case]').forEach(button => button.onclick = () => showCase(button.dataset.mkDiagCase));
        panel.querySelectorAll('[data-mk-diag-zoom]').forEach(button => button.onclick = () => setZoom(button.dataset.mkDiagZoom));
    };
    const addCss = () => {
        const style = document.createElement('style');
        style.textContent = `
            #mk-render-diagnostic-toolbar{position:fixed;left:4px;right:4px;top:max(4px,env(safe-area-inset-top));z-index:2147483647;background:#111;color:#fff;border:1px solid #74c0fc;border-radius:8px;padding:6px;font:11px/1.3 -apple-system,sans-serif}
            #mk-render-diagnostic-toolbar>div{margin:2px 0}#mk-render-diagnostic-toolbar button{font-size:11px;padding:3px 7px;margin:1px;border:1px solid #777;border-radius:4px;background:#333;color:#fff}#mk-render-diagnostic-toolbar button.active{background:#1971c2;border-color:#74c0fc}
            #mk-render-diagnostic-toolbar a{color:#74c0fc}#mk-render-diagnostic-info{white-space:normal;word-break:break-all;color:#ced4da}
            #mk-render-diagnostic-stage{position:absolute;inset:0;z-index:100;background:#fff;overflow:hidden;display:none}
        `;
        document.head.appendChild(style);
    };
    const start = async () => {
        addCss();
        const ready = await waitFor(() => typeof library !== 'undefined' && Object.keys(library).length && typeof showCard === 'function');
        if(!ready) return;
        const entries = Object.entries(library);
        const found = entries.find(([,cards]) => cards.some(card => getImageOcclusionGroupKey(card) === `image:${IMAGE_NAME}`));
        if(!found) return;
        currentDeckName = found[0];
        originalDeck = found[1];
        activeDeck = found[1].slice();
        ioImageGroupCache = { cards:null, length:0, groups:[], cardToGroup:new Map() };
        const group = getIOImageGroups().groups.find(item => item.key === `image:${IMAGE_NAME}`);
        currentIndex = group.cardIndices[0];
        const renderStarted = now();
        showCard();
        const wrapper = await waitFor(() => document.querySelector('#question-section .mk-io-wrapper'));
        if(!wrapper) return;
        const img = wrapper.querySelector('img');
        times.A = { created:renderStarted, src:renderStarted, appended:now(), loaded:img.complete ? now() : '-' };
        if(!img.complete) img.addEventListener('load', () => {
            times.A.loaded = now();
            if(currentCase === 'A') renderInfo(img, wrapper);
        }, { once:true });
        buildUi();
        setZoom('1.7');
        showCase('A');
    };
    window.addEventListener('load', start, { once:true });
})();
