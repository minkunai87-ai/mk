const MK_SW_VERSION = 'v18.5.301 PAGES SHELL CACHE';
const MK_SHELL_CACHE = 'mk-pages-shell-v1';
const MK_SHELL_URL = new URL('./index.html', self.registration.scope).href;

async function cacheShellFromNetwork() {
    const request = new Request(MK_SHELL_URL, { cache:'reload', credentials:'same-origin' });
    const response = await fetch(request);
    if(!response || !response.ok) {
        const error = new Error(`shell status ${response ? response.status : 0}`);
        error.status = response ? response.status : 0;
        throw error;
    }
    const cache = await caches.open(MK_SHELL_CACHE);
    await cache.put(MK_SHELL_URL, response.clone());
    return response;
}

async function getCachedShell() {
    const cache = await caches.open(MK_SHELL_CACHE);
    return await cache.match(MK_SHELL_URL);
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        try { await cacheShellFromNetwork(); }
        catch(error) { console.warn('[MK_PAGES_SHELL] install cache failed', error); }
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('mk-pages-shell-') && name !== MK_SHELL_CACHE).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if(request.method !== 'GET') return;
    const url = new URL(request.url);
    if(url.origin !== self.location.origin) return;
    if(request.mode !== 'navigate') return;

    // Cache-first navigation is deliberate: opening MK on another device or repeatedly
    // reopening a PWA no longer has to hit GitHub Pages just to obtain index.html.
    event.respondWith((async () => {
        const cached = await getCachedShell();
        if(cached) return cached;
        try {
            const response = await fetch(request);
            if(response && response.ok) {
                const cache = await caches.open(MK_SHELL_CACHE);
                await cache.put(MK_SHELL_URL, response.clone());
            }
            return response;
        } catch(error) {
            return new Response('MK app shell is temporarily unavailable.', {
                status:503,
                headers:{ 'Content-Type':'text/plain; charset=utf-8' }
            });
        }
    })());
});

self.addEventListener('message', event => {
    if(!event.data || event.data.type !== 'MK_FORCE_REFRESH_SHELL') return;
    const port = event.ports && event.ports[0];
    event.waitUntil((async () => {
        try {
            const response = await cacheShellFromNetwork();
            if(port) port.postMessage({ ok:true, status:response.status, version:MK_SW_VERSION });
        } catch(error) {
            if(port) port.postMessage({ ok:false, status:Number(error && error.status) || 0, reason:String(error && error.message || error) });
        }
    })());
});
