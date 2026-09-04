const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

function extractFunction(name) {
    const markers = [`async function ${name}(`, `function ${name}(`];
    const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0);
    if (start === undefined) throw new Error(`Function not found: ${name}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Function not closed: ${name}`);
}

const context = {
    URL,
    document: { baseURI: 'https://example.test/mk/' },
    repoOwner: 'minkunai87-ai',
    repoName: 'mk',
    LIBRARY_CACHE_DB_KEY: 'mk_library_cache_v1',
    LIBRARY_CACHE_MANIFEST_VERSION_DB_KEY: 'mk_library_cache_manifest_version_v1',
    console
};
vm.createContext(context);
vm.runInContext(`${extractFunction('getManifestDeckFile')}\n${extractFunction('loadDeckManifest')}\n${extractFunction('loadDeckFileList')}\n${extractFunction('refreshCachedLibraryIfNeeded')}\n${extractFunction('persistLibraryCacheInBackground')}\nthis.loadDeckFileList = loadDeckFileList;\nthis.refreshCachedLibraryIfNeeded = refreshCachedLibraryIfNeeded;\nthis.persistLibraryCacheInBackground = persistLibraryCacheInBackground;`, context);

(async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'decks-manifest.json'), 'utf8'));
    const manifestCalls = [];
    const manifestResult = await context.loadDeckFileList({}, async (url) => {
        manifestCalls.push(url);
        if (url.includes('api.github.com')) throw new Error('GitHub list API must not be called');
        return { ok: true, status: 200, json: async () => manifest };
    });
    assert.equal(manifestResult.source, 'manifest');
    assert.equal(manifestCalls.length, 1);
    assert.deepEqual(Array.from(manifestResult.files, file => file.name), manifest.files);
    if (typeof manifest.version === 'string') {
        assert.equal(manifestResult.publishVersion, manifest.version);
        assert.equal(manifestResult.files.every(file => file.download_url.endsWith(`?v=${manifest.version}`)), true);
    }

    const fallbackCalls = [];
    const fallbackResult = await context.loadDeckFileList({}, async (url) => {
        fallbackCalls.push(url);
        if (url.includes('decks-manifest.json')) return { ok: false, status: 404 };
        return {
            ok: true,
            status: 200,
            json: async () => manifest.files.map(name => ({ name, download_url: `https://raw.example/${name}`, url: `https://api.example/${name}` }))
        };
    });
    assert.equal(fallbackResult.source, 'github-api');
    assert.equal(fallbackCalls.length, 2);
    assert.equal(fallbackResult.files.length, manifest.files.length);

    const manifestFetch = async () => ({ ok:true, status:200, json:async () => manifest });
    let importCalls = 0;
    context.autoScanGitHub = async options => {
        importCalls++;
        assert.equal(options.silent, true);
        assert.equal(options.preserveCurrentView, true);
        assert.equal(options.deckFileList.publishVersion, manifest.version);
        return true;
    };

    context.readCachedLibraryManifestVersion = async () => manifest.version;
    const sameVersion = await context.refreshCachedLibraryIfNeeded(manifestFetch);
    assert.equal(sameVersion.refreshed, false);
    assert.equal(importCalls, 0);

    context.readCachedLibraryManifestVersion = async () => 'older-version';
    const changedVersion = await context.refreshCachedLibraryIfNeeded(manifestFetch);
    assert.equal(changedVersion.refreshed, true);
    assert.equal(importCalls, 1);

    context.readCachedLibraryManifestVersion = async () => '';
    const missingVersion = await context.refreshCachedLibraryIfNeeded(manifestFetch);
    assert.equal(missingVersion.refreshed, true);
    assert.equal(importCalls, 2);

    const callsBeforeFailure = importCalls;
    const libraryBeforeFailure = context.library = { cached:[{ id:'cached-card' }] };
    const manifestFailure = await context.refreshCachedLibraryIfNeeded(async () => ({ ok:false, status:503 }));
    assert.equal(manifestFailure.checked, false);
    assert.equal(manifestFailure.refreshed, false);
    assert.equal(importCalls, callsBeforeFailure);
    assert.equal(context.library, libraryBeforeFailure);

    const cacheWrites = [];
    let idleWrite;
    context.writeStatsDatabaseValue = async (key, value) => cacheWrites.push({ key, value });
    context.requestIdleCallback = callback => { idleWrite = Promise.resolve(callback()); };
    context.persistLibraryCacheInBackground({ fixture:[] }, manifest.version);
    await idleWrite;
    assert.deepEqual(cacheWrites.map(write => write.key), [
        context.LIBRARY_CACHE_DB_KEY,
        context.LIBRARY_CACHE_MANIFEST_VERSION_DB_KEY
    ]);
    assert.equal(cacheWrites[1].value, manifest.version);

    const onloadStart = source.indexOf('window.onload = async function()');
    const onloadEnd = source.indexOf('\n    };', onloadStart);
    const onloadSource = source.slice(onloadStart, onloadEnd);
    const initIndex = onloadSource.indexOf('initApp();');
    const refreshIndex = onloadSource.indexOf('refreshCachedLibraryIfNeeded(fetch)');
    assert.ok(initIndex >= 0 && refreshIndex > initIndex);
    assert.equal(onloadSource.includes('await refreshCachedLibraryIfNeeded(fetch)'), false);
    assert.equal(onloadSource.includes('if(!hasCachedLibrary) {\n            await autoScanGitHub();'), true);

    const viewContext = {
        appInitializationCompleted: true,
        currentDeckName: 'deck-a',
        currentIndex: 0,
        originalDeck: [{ id:'old-card' }],
        activeDeck: [{ id:'old-card' }],
        currentFilterMode: ['due'],
        searchQuery: 'kept',
        library: { 'deck-a': [{ id:'same-card' }, { id:'other-card' }] },
        normalizeDeckPath: value => String(value || ''),
        getDeckCards: deck => [...(viewContext.library[deck] || [])],
        getDeckGroupCards: deck => Object.entries(viewContext.library).filter(([name]) => name === deck || name.startsWith(`${deck}__`)).flatMap(([, cards]) => cards),
        findCardLocationById: id => Object.entries(viewContext.library).flatMap(([deck, cards]) => cards.map(card => ({ deck, card }))).find(item => item.card.id === id) || null,
        applyFilterAndSort: (_restore, options) => {
            viewContext.activeDeck = viewContext.originalDeck.filter(card => card.id !== 'other-card');
            viewContext.currentIndex = viewContext.activeDeck.findIndex(card => options.preferredCardIds.includes(card.id));
            if(viewContext.currentIndex < 0) viewContext.currentIndex = 0;
        },
        renderDeckTree: () => { viewContext.deckRenderCalls++; },
        renderRecentDecks: () => { viewContext.recentRenderCalls++; },
        showCard: () => { viewContext.cardRenderCalls++; },
        persistCurrentViewState: markChanged => { assert.equal(markChanged, false); viewContext.persistCalls++; },
        deckRenderCalls: 0,
        recentRenderCalls: 0,
        cardRenderCalls: 0,
        persistCalls: 0
    };
    vm.createContext(viewContext);
    vm.runInContext(`${extractFunction('restoreLibraryViewAfterBackgroundImport')}\nthis.restoreLibraryViewAfterBackgroundImport = restoreLibraryViewAfterBackgroundImport;`, viewContext);
    const restored = viewContext.restoreLibraryViewAfterBackgroundImport({
        deck:'deck-a', deckMode:'deck', cardId:'same-card', searchQuery:'kept', filter:'due'
    });
    assert.equal(restored, true);
    assert.equal(viewContext.currentDeckName, 'deck-a');
    assert.equal(viewContext.activeDeck[viewContext.currentIndex].id, 'same-card');
    assert.deepEqual(viewContext.currentFilterMode, ['due']);
    assert.equal(viewContext.searchQuery, 'kept');
    assert.deepEqual([viewContext.deckRenderCalls, viewContext.recentRenderCalls, viewContext.cardRenderCalls, viewContext.persistCalls], [1, 1, 1, 1]);

    const autoScanStart = source.indexOf('async function autoScanGitHub(');
    const autoScanEnd = source.indexOf('function* iterateAnkiRows(', autoScanStart);
    const autoScanSource = source.slice(autoScanStart, autoScanEnd);
    assert.ok(autoScanSource.indexOf('if(deckImportFailed)') < autoScanSource.indexOf('library = newLibrary'));
    assert.ok(autoScanSource.indexOf('getCurrentViewState(true)') < autoScanSource.indexOf('library = newLibrary'));

    process.stdout.write(JSON.stringify({
        manifestWithBlockedApi: 'passed',
        apiCallsWhenManifestSucceeds: 0,
        fallbackWhenManifestMissing: 'passed',
        cachedSameVersionImports: 0,
        cachedChangedVersionImports: 1,
        cachedMissingVersionImports: 1,
        cachedManifestFailureImports: 0,
        cachedMissingVersionFirstRenderBlocked: false,
        cachedRefreshRunsAfterInitApp: true,
        backgroundRefreshPreservesDeckFilterSearchAndCard: true,
        failedRefreshKeepsExistingLibrary: true,
        uncachedStartupStillAwaitsInitialImport: true,
        cacheVersionPersistedAfterLibrary: true,
        files: manifest.files
    }) + '\n');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
