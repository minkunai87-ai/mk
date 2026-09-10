(() => {
    const IMAGE_NAME = 'io1-2_1780227484684_0.png';
    const IMAGE_URL = `https://raw.githubusercontent.com/minkunai87-ai/mk/main/images/${IMAGE_NAME}`;
    const WIDTHS = { '1':334, '1.7':568, '2.89':965, '5':1670 };
    const SOURCE_Y = 2400;
    const lifecycle = [];
    const mutations = [];
    const snapshots = new Map();
    let currentCase = 'A-old';
    let currentZoom = '1.7';

    const now = () => Math.round(performance.now() * 10) / 10;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async predicate => {
        for(let index = 0; index < 120; index += 1) {
            const value = predicate();
            if(value) return value;
            await wait(250);
        }
        return null;
    };
    const rectOf = element => {
        const rect = element.getBoundingClientRect();
        return { left:rect.left, top:rect.top, width:rect.width, height:rect.height };
    };
    const computedOf = element => {
        const style = getComputedStyle(element);
        const result = {};
        for(let index = 0; index < style.length; index += 1) {
            const key = style[index];
            result[key] = style.getPropertyValue(key);
        }
        return result;
    };
    const ancestorsOf = element => {
        const result = [];
        let node = element?.parentElement;
        for(let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
            result.push({ tag:node.tagName, class:node.className, style:node.getAttribute('style') || '', rect:rectOf(node), computed:computedOf(node) });
        }
        return result;
    };
    const snapshot = (label, wrapper, img) => ({
        label,
        at:now(),
        img:img ? {
            outerHTML:img.outerHTML,
            natural:[img.naturalWidth, img.naturalHeight],
            client:[img.clientWidth, img.clientHeight],
            rect:rectOf(img),
            computed:computedOf(img)
        } : null,
        wrapper:wrapper ? {
            outerHTML:wrapper.outerHTML,
            client:[wrapper.clientWidth, wrapper.clientHeight],
            rect:rectOf(wrapper),
            computed:computedOf(wrapper)
        } : null,
        ancestors:ancestorsOf(wrapper)
    });

    window.__mkIoRenderDiagnosticEvent = (stage, wrapper, img) => {
        lifecycle.push(snapshot(stage, wrapper, img));
        if(stage !== 'render-found') return;
        [wrapper, img].forEach(node => {
            const observer = new MutationObserver(records => records.forEach(record => mutations.push({
                at:now(), node:node === img ? 'img' : 'wrapper', attribute:record.attributeName,
                value:record.attributeName ? node.getAttribute(record.attributeName) : '', connected:node.isConnected
            })));
            observer.observe(node, { attributes:true, attributeFilter:['style','class','src','width','height','loading','decoding','draggable','srcset','sizes'] });
            setTimeout(() => observer.disconnect(), 3000);
        });
    };

    const info = (img, wrapper) => {
        const imageStyle = getComputedStyle(img);
        const wrapperStyle = getComputedStyle(wrapper);
        const imageRect = img.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        document.getElementById('mk-render-diagnostic-info').textContent = [
            `natural ${img.naturalWidth}×${img.naturalHeight}`,
            `client ${img.clientWidth}×${img.clientHeight}`,
            `img rect ${imageRect.width.toFixed(2)}×${imageRect.height.toFixed(2)}`,
            `wrapper rect ${wrapperRect.width.toFixed(2)}×${wrapperRect.height.toFixed(2)}`,
            `img transform ${imageStyle.transform}`,
            `wrapper transform ${wrapperStyle.transform}`,
            `overflow ${wrapperStyle.overflow}`
        ].join(' | ');
    };

    const renderD = () => {
        const stage = document.getElementById('mk-render-diagnostic-stage');
        const live = snapshots.get('A-old');
        const stageRect = stage.getBoundingClientRect();
        const width = live?.zoom === currentZoom ? live.img.rect.width : WIDTHS[currentZoom];
        const height = live?.zoom === currentZoom ? live.img.rect.height : width * 16433 / 2479;
        const left = live?.zoom === currentZoom ? live.img.rect.left - stageRect.left : 16;
        const top = live?.zoom === currentZoom ? live.img.rect.top - stageRect.top : 170 - SOURCE_Y * width / 2479;
        stage.innerHTML = '<div class="mk-diag-card card"><div class="card-scroll-area"><div class="zoom-content"><div class="text-area mode-question"><span class="mk-io-wrapper"></span></div></div></div></div>';
        const card = stage.firstElementChild;
        card.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        const scroll = card.querySelector('.card-scroll-area');
        scroll.style.cssText = 'position:absolute;inset:0;overflow-x:hidden;overflow-y:auto';
        const zoom = card.querySelector('.zoom-content');
        zoom.style.cssText = 'position:relative;width:100%;height:100%;padding:0;transform:none;will-change:auto';
        const text = card.querySelector('.text-area');
        text.style.cssText = 'position:relative;width:100%;height:100%;overflow-x:hidden;overflow-y:auto';
        const wrapper = card.querySelector('.mk-io-wrapper');
        wrapper.style.cssText = `position:absolute;display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px;max-width:none;overflow:hidden`;
        const img = document.createElement('img');
        img.alt = `D ${IMAGE_NAME}`;
        img.src = IMAGE_URL;
        img.style.cssText = `display:block;position:static;left:0;top:0;width:${width}px!important;height:${height}px!important;max-width:none!important;margin:0!important;transform:none!important;border-radius:0;box-shadow:none`;
        wrapper.appendChild(img);
        img.addEventListener('load', () => { if(currentCase === 'D' && img.isConnected) captureCurrent('D', wrapper, img); }, { once:true });
        if(img.complete) captureCurrent('D', wrapper, img);
    };

    const captureCurrent = (name, wrapper, img) => {
        const captured = snapshot(name, wrapper, img);
        captured.zoom = currentZoom;
        snapshots.set(name, captured);
        info(img, wrapper);
    };
    const prepareLive = async directLayout => {
        showCard();
        const wrapper = await waitFor(() => document.querySelector('#question-section .mk-io-wrapper'));
        if(!wrapper) return;
        wrapper._mediaZoomState?.setRenderDiagnosticView(Number(currentZoom), SOURCE_Y, directLayout);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const img = wrapper.querySelector('img.mk-io-image');
            const expected = directLayout ? 'A-new' : 'A-old';
            if(currentCase === expected && wrapper.isConnected && img) captureCurrent(expected, wrapper, img);
        }));
    };
    const showCase = name => {
        currentCase = name;
        document.querySelectorAll('[data-mk-diag-case]').forEach(button => button.classList.toggle('active', button.dataset.mkDiagCase === name));
        const stage = document.getElementById('mk-render-diagnostic-stage');
        const scrollArea = document.getElementById('scroll-area');
        if(name === 'D') {
            scrollArea.style.visibility = 'hidden';
            stage.style.display = 'block';
            renderD();
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const img = stage.querySelector('img');
                const wrapper = stage.querySelector('.mk-io-wrapper');
                if(currentCase === 'D' && img?.isConnected && wrapper) captureCurrent('D', wrapper, img);
            }));
        } else {
            stage.style.display = 'none';
            scrollArea.style.visibility = 'visible';
            prepareLive(name === 'A-new');
        }
    };
    const setZoom = value => {
        currentZoom = value;
        document.querySelectorAll('[data-mk-diag-zoom]').forEach(button => button.classList.toggle('active', button.dataset.mkDiagZoom === value));
        showCase(currentCase);
    };
    const diff = (left = {}, right = {}) => Object.fromEntries(
        [...new Set([...Object.keys(left), ...Object.keys(right)])]
            .filter(key => left[key] !== right[key])
            .map(key => [key, { A:left[key], D:right[key] }])
    );
    const copyReport = async () => {
        const a = snapshots.get('A-old');
        const fixed = snapshots.get('A-new');
        const d = snapshots.get('D');
        const report = {
            lifecycle, mutations,
            dom:{ AOld:a, ANew:fixed, D:d },
            computedDiff:{
                A_vs_D:{ img:diff(a?.img?.computed, d?.img?.computed), wrapper:diff(a?.wrapper?.computed, d?.wrapper?.computed) },
                new_vs_D:{ img:diff(fixed?.img?.computed, d?.img?.computed), wrapper:diff(fixed?.wrapper?.computed, d?.wrapper?.computed) }
            }
        };
        const text = JSON.stringify(report, null, 2);
        try { await navigator.clipboard.writeText(text); } catch (_) { prompt('진단 JSON 복사', text); }
    };
    const addUi = () => {
        const style = document.createElement('style');
        style.textContent = '#mk-render-diagnostic-toolbar{position:fixed;left:4px;right:4px;top:max(4px,env(safe-area-inset-top));z-index:2147483647;background:#111;color:#fff;border:1px solid #74c0fc;border-radius:8px;padding:6px;font:11px/1.3 -apple-system,sans-serif}#mk-render-diagnostic-toolbar>div{margin:2px 0}#mk-render-diagnostic-toolbar button{font-size:11px;padding:3px 7px;margin:1px;border:1px solid #777;border-radius:4px;background:#333;color:#fff}#mk-render-diagnostic-toolbar button.active{background:#1971c2;border-color:#74c0fc}#mk-render-diagnostic-toolbar a{color:#74c0fc}#mk-render-diagnostic-info{word-break:break-all;color:#ced4da}#mk-render-diagnostic-stage{position:fixed;inset:0;z-index:100;background:#fff;overflow:hidden;display:none}';
        document.head.appendChild(style);
        const panel = document.createElement('div');
        panel.id = 'mk-render-diagnostic-toolbar';
        panel.innerHTML = `<div><b>A-OLD / A-NEW / D</b> · <a href="${IMAGE_URL}" target="_blank" rel="noopener">RAW</a></div><div>${['A-old','A-new','D'].map(name => `<button data-mk-diag-case="${name}">${name}</button>`).join('')}</div><div>${Object.keys(WIDTHS).map(value => `<button data-mk-diag-zoom="${value}">${value}×</button>`).join('')}</div><div><button id="mk-copy-render-diff">DOM/STYLE DIFF 복사</button></div><div id="mk-render-diagnostic-info">loading…</div>`;
        const stage = document.createElement('div');
        stage.id = 'mk-render-diagnostic-stage';
        document.body.appendChild(stage);
        document.body.appendChild(panel);
        panel.querySelectorAll('[data-mk-diag-case]').forEach(button => button.onclick = () => showCase(button.dataset.mkDiagCase));
        panel.querySelectorAll('[data-mk-diag-zoom]').forEach(button => button.onclick = () => setZoom(button.dataset.mkDiagZoom));
        panel.querySelector('#mk-copy-render-diff').onclick = copyReport;
    };
    const start = async () => {
        const ready = await waitFor(() => typeof library !== 'undefined' && Object.keys(library).length && typeof showCard === 'function');
        if(!ready) return;
        const found = Object.entries(library).find(([,cards]) => cards.some(card => getImageOcclusionGroupKey(card) === `image:${IMAGE_NAME}`));
        if(!found) return;
        currentDeckName = found[0];
        originalDeck = found[1];
        activeDeck = found[1].slice();
        ioImageGroupCache = { cards:null, length:0, groups:[], cardToGroup:new Map() };
        currentIndex = getIOImageGroups().groups.find(group => group.key === `image:${IMAGE_NAME}`).cardIndices[0];
        addUi();
        showCase('A-old');
    };
    window.__mkADDiagnostic = { snapshots, lifecycle, mutations, showCase, setZoom };
    window.addEventListener('load', start, { once:true });
})();
