const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function readFunction(name) {
    const marker = `function ${name}(`;
    let start = html.indexOf(marker);
    assert(start >= 0, `${name} must exist`);
    if(html.slice(start - 6, start) === 'async ') start -= 6;
    let parameterDepth = 0;
    let parameterEnd = -1;
    for(let index = html.indexOf('(', start); index < html.length; index++) {
        if(html[index] === '(') parameterDepth++;
        if(html[index] === ')' && --parameterDepth === 0) { parameterEnd = index; break; }
    }
    const brace = html.indexOf('{', parameterEnd);
    let depth = 0;
    let quote = '';
    let escaped = false;
    for(let index = brace; index < html.length; index++) {
        const char = html[index];
        if(quote) {
            if(escaped) escaped = false;
            else if(char === '\\') escaped = true;
            else if(char === quote) quote = '';
            continue;
        }
        if(char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if(char === '{') depth++;
        if(char === '}' && --depth === 0) return html.slice(start, index + 1);
    }
    throw new Error(`unterminated ${name}`);
}

const storage = new Map();
const idbStorage = new Map();
const context = {
    console,
    idbStorage,
    Date,
    Set,
    Map,
    Object,
    String,
    Array,
    Math,
    performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    currentDeckName: 'A',
    LEARNING_STATS_STORAGE_KEY: 'mk_learning_stats_v1',
    LEARNING_STATS_FAVORITE_DECKS_STORAGE_KEY: 'mk_learning_stats_favorite_decks_v1',
    LEARNING_STATS_BACKUP_DAY_KEYS: ['requiredDone', 'newDone', 'otherDone', 'allDone', 'trackedDone'],
    STORAGE_KEY_LEARNING_STATS_UPDATED_AT: 'mk_learning_stats_updated_at',
    STORAGE_KEY_LEARNING_STATS_FAVORITES_UPDATED_AT: 'mk_learning_stats_favorites_updated_at',
    STORAGE_KEY_REVIEW_HISTORY: 'anki_final_review_history_v1',
    isDataChanged: false,
    learningStatsLibraryRevision: 0,
    learningStatsCardIndexCache: null,
    learningStatsReady: true,
    learningStatsRestoreState: 'success',
    learningStatsRestoreFailure: null,
    learningStatsMemoryStore: { version:1, days:{} },
    learningStatsMemoryUpdatedAt: 0,
    learningStatsReviewDeltaQueue: [],
    learningStatsPersistenceQueue: Promise.resolve({ok:true, skipped:true}),
    learningStatsStartupSyncInProgress: false,
    learningStatsFavoriteDecksMemory: [],
    learningStatsFavoritesUpdatedAt: 0,
    LEARNING_STATS_DB_PRIMARY_KEY: 'mk_learning_stats_v1',
    LEARNING_STATS_DB_STAGING_KEY: 'mk_learning_stats_v1_staging',
    LEARNING_STATS_DB_UPDATED_AT_KEY: 'mk_learning_stats_v1_updated_at',
    LEARNING_STATS_DB_DELTA_QUEUE_KEY: 'mk_learning_stats_v1_delta_queue',
    LEARNING_STATS_DB_FAVORITES_KEY: 'mk_learning_stats_v1_favorite_decks',
    LEARNING_STATS_DB_FAVORITES_STAGING_KEY: 'mk_learning_stats_v1_favorite_decks_staging',
    LEARNING_STATS_DB_FAVORITES_UPDATED_AT_KEY: 'mk_learning_stats_v1_favorite_decks_updated_at',
    localStorage: {
        getItem: key => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key)
    },
    library: {
        A__one: [{ id:'A', deck:'A__one' }, { id:'B', deck:'A__one' }, { id:'D', deck:'A__one' }, { id:'F', deck:'A__one' }],
        A__deep__leaf: [{ id:'C', deck:'A__deep__leaf' }, { id:'E', deck:'A__deep__leaf' }],
        B__child: [{ id:'G', deck:'B__child' }, { id:'H', deck:'B__child' }]
    },
    originalDeck: [],
    reviewHistory: {},
    favoriteRenderCount: 0
};
vm.createContext(context);
vm.runInContext(`
function normalizeDeckPath(value, fallback='') { return String(value || fallback || '').replace(/\\//g, '__').replace(/::/g, '__').split('__').map(v => v.trim()).filter(Boolean).join('__'); }
function getVirtualDate(ts) { const d = new Date(ts); if(d.getHours() < 4) d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return d; }
function getTodayEssentialCardId(card) { return String(card && card.id || ''); }
function getReviewHistory() { return reviewHistory; }
function getStatsStore() { return {}; }
function getBackupStatsCandidate(raw) { return parseJSONSafe(raw && raw.stats, {}); }
function renderLearningStats() { favoriteRenderCount++; }
function parseJSONSafe(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : (value === undefined || value === null ? fallback : value); } catch(e) { return fallback; } }
function hasBackupField(data, field) { return !!data && Object.prototype.hasOwnProperty.call(data, field); }
function hasBackupLearningStats(data) { return hasBackupField(data, LEARNING_STATS_STORAGE_KEY) || !!(data && data.learningStatsPresent); }
function hasBackupLearningStatsFavorites(data) { return hasBackupField(data, LEARNING_STATS_FAVORITE_DECKS_STORAGE_KEY) || !!(data && data.favoritesPresent); }
function safeRestoreLocalStorage(key, value) { try { localStorage.setItem(key, value); return { ok:true }; } catch(e) { return { ok:false }; } }
function cyrb53(value) { return String(value).split('').reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381); }
function getBackupGroupUpdatedAt(raw, group) { return Number(group === 'learningStats' ? raw.learningStatsUpdatedAt : raw.favoritesUpdatedAt) || 0; }
function getLearningStatsSyncTrace() { return {}; }
function refreshLearningStatsAfterCloudRestore() { learningStatsModelCache = null; }
async function readStatsDatabaseValue(key) { return idbStorage.has(key) ? idbStorage.get(key) : null; }
async function writeStatsDatabaseValue(key, value) { idbStorage.set(key, String(value)); }
async function removeStatsDatabaseValue(key) { idbStorage.delete(key); }
`, context);

[
    'getLearningStatsDateKey', 'getEmptyLearningStatsDay', 'normalizeLearningStatsDay',
    'normalizeLearningStatsPersistentStore', 'getLearningStatsStore', 'setLearningStatsRestoreState',
    'persistLearningStatsToIndexedDBVerified', 'queueLearningStatsPersistence', 'saveLearningStatsStore',
    'persistLearningStatsFavoritesToIndexedDBVerified', 'updateLearningStatsDay',
    'rememberLearningStatsDeck', 'recordLearningStatsReview',
    'normalizeFirebaseArray', 'normalizeLearningStatsBackupPayload', 'getLearningStatsEntryCount', 'getLearningStatsBackupPayload',
    'normalizeLearningStatsFavoriteDecksBackupPayload', 'getLearningStatsFavoriteDecksBackupPayload',
    'stableBackupJson', 'getBackupFieldChecksum', 'verifyLearningStatsBackupPayloadIntegrity', 'restoreLearningStatsBackupFields',
    'createLearningStatsReviewDelta', 'persistLearningStatsReviewDeltaQueue', 'queueLearningStatsReviewDelta', 'applyLearningStatsReviewDeltas',
    'evaluateLearningStatsBackupHealth',
    'verifyCoreBackupPayloadIntegrity',
    'getStartupSyncDecision', 'getLocalGroupUpdatedAt',
    'getLearningStatsCardLookup', 'restoreTodayLearningStatsTotal', 'getAllRecommendedStudyCards', 'getCurrentDeckRecommendedStudyCards', 'buildLearningStatsModel',
    'getLearningStatsImmediateChildren', 'getLearningStatsFavoriteDecks', 'saveLearningStatsFavoriteDecks', 'toggleLearningStatsFavorite'
].forEach(name => vm.runInContext(readFunction(name), context));

async function main() {
const cards = Object.values(context.library).flat();
const byId = Object.fromEntries(cards.map(card => [card.id, card]));
assert.strictEqual(context.getAllRecommendedStudyCards().length, 8, 'statistics can obtain every unique library card before any filter is used');
context.originalDeck = [byId.A, byId.B, byId.A];
assert.deepStrictEqual([...context.getCurrentDeckRecommendedStudyCards()].map(card => card.id), ['A','B'], 'leaf filter scope contains only the selected deck and removes UUID duplicates');
context.originalDeck = [...context.library.A__deep__leaf];
assert.deepStrictEqual([...context.getCurrentDeckRecommendedStudyCards()].map(card => card.id), ['C','E'], 'middle deck scope contains only its descendant-expanded cards');
context.originalDeck = [...context.library.A__one, ...context.library.A__deep__leaf];
assert.deepStrictEqual([...context.getCurrentDeckRecommendedStudyCards()].map(card => card.id), ['A','B','D','F','C','E'], 'parent filter scope uses the existing descendant-expanded originalDeck');
assert(!context.getCurrentDeckRecommendedStudyCards().some(card => String(card.deck).startsWith('B__')), 'cards outside the selected deck scope are excluded');
context.originalDeck = context.getAllRecommendedStudyCards();
assert.strictEqual(context.getCurrentDeckRecommendedStudyCards().length, 8, 'all-deck scope includes every unique card');

assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], [], 'favorite section starts empty');
const favoriteEvent = { prevented:false, stopped:false, preventDefault(){ this.prevented=true; }, stopPropagation(){ this.stopped=true; } };
context.toggleLearningStatsFavorite(favoriteEvent, 'A__deep__leaf');
context.toggleLearningStatsFavorite(favoriteEvent, 'B__child');
assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], ['A__deep__leaf','B__child'], 'favorites preserve canonical paths and registration order');
assert(favoriteEvent.prevented && favoriteEvent.stopped, 'favorite click prevents row drill-down');
assert.strictEqual(context.favoriteRenderCount, 2, 'favorite state rerenders immediately');
context.toggleLearningStatsFavorite(favoriteEvent, 'A__deep__leaf');
assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], ['B__child'], 'favorite toggles off immediately');
await context.learningStatsPersistenceQueue;
const reloadedFavoriteContext = JSON.parse(idbStorage.get(context.LEARNING_STATS_DB_FAVORITES_KEY));
assert.deepStrictEqual(reloadedFavoriteContext, ['B__child'], 'favorites persist across reload/PWA restart storage reads');

const backupStatsPayload = context.normalizeLearningStatsBackupPayload({ version:1, days:{ '2000-01-01':{
    requiredDone:['R1'], newDone:['N1'], otherDone:['O1'], allDone:['R1','N1','O1'], trackedDone:['R1','N1','O1'],
    requiredTarget:['derived-review'], newTarget:['derived-new'], deckByCard:{ R1:'A__one' }, aggregate:{ A:3 }
} } });
const backupDay = backupStatsPayload.days['2000-01-01'];
assert.deepStrictEqual(Object.keys(backupDay).sort(), ['allDone','newDone','otherDone','requiredDone','trackedDone'].sort(), 'backup contains only dated completion-source UUID arrays');
assert(!('requiredTarget' in backupDay) && !('newTarget' in backupDay) && !('deckByCard' in backupDay), 'target snapshots and derived deck data are excluded from backup');
const supplementalBackup = {
    mk_learning_stats_v1: backupStatsPayload,
    mk_learning_stats_favorite_decks_v1: ['Second__Deck', 'First__Deck']
};
supplementalBackup.integrity = {
    mk_learning_stats_v1: context.getBackupFieldChecksum(supplementalBackup.mk_learning_stats_v1),
    mk_learning_stats_favorite_decks_v1: context.getBackupFieldChecksum(supplementalBackup.mk_learning_stats_favorite_decks_v1)
};
storage.set('ankiStats', '{"stats-sentinel":{"total":7,"fsrs":{"reps":4}}}');
storage.set('ankiReviewHistory', '{"history-sentinel":[{"score":2}]}');
context.saveLearningStatsFavoriteDecks(['Deleted__MustNotReturn', 'Local__Only']);
await context.restoreLearningStatsBackupFields(supplementalBackup);
assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], ['Second__Deck','First__Deck'], 'favorite restore replaces local state in backup order without union');
assert.strictEqual(storage.get('ankiStats'), '{"stats-sentinel":{"total":7,"fsrs":{"reps":4}}}', 'learning-stats restore does not touch Stats or FSRS');
assert.strictEqual(storage.get('ankiReviewHistory'), '{"history-sentinel":[{"score":2}]}', 'learning-stats restore does not touch review history');
const tamperedBackup = JSON.parse(JSON.stringify(supplementalBackup));
tamperedBackup.mk_learning_stats_favorite_decks_v1.push('Tampered');
assert.strictEqual(context.verifyLearningStatsBackupPayloadIntegrity(tamperedBackup).ok, false, 'supplemental backup checksum detects mutation');
const firebaseNormalizedStats = context.normalizeLearningStatsBackupPayload({ version:1, days:{ '2026-08-11':{ requiredDone:['A'], newDone:[], otherDone:[], allDone:['A'], trackedDone:['A'] } } });
const firebaseRoundTrip = JSON.parse(JSON.stringify(firebaseNormalizedStats));
delete firebaseRoundTrip.days['2026-08-11'].newDone;
delete firebaseRoundTrip.days['2026-08-11'].otherDone;
const firebaseRoundTripPayload = { mk_learning_stats_v1:firebaseRoundTrip, integrity:{ mk_learning_stats_v1:context.getBackupFieldChecksum(firebaseNormalizedStats) } };
assert.strictEqual(context.verifyLearningStatsBackupPayloadIntegrity(firebaseRoundTripPayload).ok, true, 'Firebase omission of empty arrays is canonicalized before checksum verification');
const firebaseSparseArrayPayload = { version:1, days:{ '2026-08-11':{ requiredDone:{ 1:'B', 0:'A' }, allDone:['B','A'] } } };
assert.deepStrictEqual(
    [...context.normalizeLearningStatsBackupPayload(firebaseSparseArrayPayload).days['2026-08-11'].requiredDone],
    ['A','B'],
    'Firebase numeric-key array objects and set ordering are canonicalized'
);
assert.strictEqual(
    context.getBackupFieldChecksum(context.normalizeLearningStatsBackupPayload(firebaseSparseArrayPayload)),
    context.getBackupFieldChecksum(context.normalizeLearningStatsBackupPayload({ version:1, days:{ '2026-08-11':{ requiredDone:['A','B'], allDone:['A','B'] } } })),
    'semantically identical completion UUID sets have the same checksum'
);
const legacyOrderedStats = { version:1, days:{ '2026-08-11':{ requiredDone:['B','A'], allDone:['B','A'] } } };
const legacyChecksumPayload = {
    mk_learning_stats_v1: legacyOrderedStats,
    integrity:{ mk_learning_stats_v1:context.getBackupFieldChecksum(context.normalizeLearningStatsBackupPayload(legacyOrderedStats, false)) }
};
assert.strictEqual(context.verifyLearningStatsBackupPayloadIntegrity(legacyChecksumPayload).ok, true, 'legacy array-order checksums remain restorable after set canonicalization');
assert.strictEqual(context.evaluateLearningStatsBackupHealth({ learningStatsPresent:true }).ok, false, 'a backup marked present without any learning days is unhealthy');
const quotaRestorePayload = {
    mk_learning_stats_v1: { version:1, days:{ '2001-01-01':{ requiredDone:['cloud-card'], allDone:['cloud-card'], trackedDone:['cloud-card'] } } },
    mk_learning_stats_favorite_decks_v1: ['Cloud__Favorite'],
    learningStatsUpdatedAt: 300
};
quotaRestorePayload.integrity = {
    mk_learning_stats_v1:context.getBackupFieldChecksum(context.normalizeLearningStatsBackupPayload(quotaRestorePayload.mk_learning_stats_v1)),
    mk_learning_stats_favorite_decks_v1:context.getBackupFieldChecksum(['Cloud__Favorite'])
};
context.setLearningStatsRestoreState('pending', {source:'quota-test'});
context.recordLearningStatsReview({id:'queued-during-restore', deck:'A__one'}, 'required');
await context.learningStatsPersistenceQueue;
const normalSetItem = context.localStorage.setItem;
context.localStorage.setItem = () => { const error = new Error('origin quota full'); error.name = 'QuotaExceededError'; throw error; };
await context.restoreLearningStatsBackupFields(quotaRestorePayload, ['learningStats', 'favorites']);
context.localStorage.setItem = normalSetItem;
const quotaRestoredDay = context.getLearningStatsStore().days['2001-01-01'];
assert(quotaRestoredDay.allDone.includes('cloud-card'), 'cloud snapshot restores through IndexedDB while localStorage is quota-exhausted');
assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], ['Cloud__Favorite'], 'favorite decks also restore through IndexedDB while localStorage is quota-exhausted');
const queuedDay = context.getLearningStatsStore().days[context.getLearningStatsDateKey()];
assert(queuedDay.allDone.includes('queued-during-restore'), 'review made during restore is merged from the durable delta queue');
assert.strictEqual(context.learningStatsReviewDeltaQueue.length, 0, 'delta queue clears only after the merged IndexedDB write verifies');
assert.strictEqual(context.learningStatsRestoreState, 'success', 'verified IndexedDB restore opens the write barrier');
await context.restoreLearningStatsBackupFields(supplementalBackup, ['learningStats']);
const emptyFavoritesPayload = { favoritesPresent:true, favoritesUpdatedAt:200, integrity:{ mk_learning_stats_favorite_decks_v1:context.getBackupFieldChecksum([]) } };
context.saveLearningStatsFavoriteDecks(['Must__Be__Deleted']);
await context.restoreLearningStatsBackupFields(emptyFavoritesPayload, ['favorites']);
assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], [], 'an explicitly backed-up empty favorite array replaces older device favorites');
const coreBackup = { stats:'{}', reviewHistory:'{}', integrity:{ stats:context.getBackupFieldChecksum({}), reviewHistory:context.getBackupFieldChecksum({}) } };
assert.strictEqual(context.verifyCoreBackupPayloadIntegrity(coreBackup).ok, true, 'Stats/history checksums accept an intact backup');
coreBackup.reviewHistory = '{"changed":[]}';
assert.strictEqual(context.verifyCoreBackupPayloadIntegrity(coreBackup).ok, false, 'a corrupted newest backup is rejected before selection');
assert.deepStrictEqual({ ...context.getStartupSyncDecision({ study:100, learningStats:100, favorites:100 }, { study:110, learningStats:110, favorites:110 }) }, { study:'cloud', learningStats:'cloud', favorites:'cloud' }, 'newer verified Firebase groups are selected');
assert.deepStrictEqual({ ...context.getStartupSyncDecision({ study:110, learningStats:110, favorites:110 }, { study:100, learningStats:100, favorites:100 }) }, { study:'local', learningStats:'local', favorites:'local' }, 'newer local groups are protected');
assert.deepStrictEqual({ ...context.getStartupSyncDecision({ study:110, learningStats:110, favorites:110 }, { study:110, learningStats:110, favorites:110 }) }, { study:'same', learningStats:'same', favorites:'same' }, 'equal timestamps avoid unnecessary restore');
storage.delete(context.STORAGE_KEY_LEARNING_STATS_UPDATED_AT);
storage.set(context.LEARNING_STATS_STORAGE_KEY, JSON.stringify({ version:1, days:{} }));
assert.strictEqual(context.getLocalGroupUpdatedAt(context.STORAGE_KEY_LEARNING_STATS_UPDATED_AT, context.LEARNING_STATS_STORAGE_KEY), 0, 'an existing empty learning-stats key never inherits the Stats timestamp');
context.saveLearningStatsFavoriteDecks(['ParentA__01','ParentB__01']);
assert.deepStrictEqual([...context.getLearningStatsFavoriteDecks()], ['ParentA__01','ParentB__01'], 'same leaf names under different canonical paths remain distinct');
['A','B','C','A'].forEach(id => context.recordLearningStatsReview(byId[id], 'required'));
['D','E','D'].forEach(id => context.recordLearningStatsReview(byId[id], 'new'));
['F','G','H','F'].forEach(id => context.recordLearningStatsReview(byId[id], 'other'));
context.recordLearningStatsReview(byId.A, 'other');
context.recordLearningStatsReview(byId.D, 'other');
const accumulatedBeforeBarrier = context.getLearningStatsStore().days[context.getLearningStatsDateKey()].requiredDone.length;
const learningStatsBeforeBarrierTest = JSON.stringify(context.getLearningStatsStore());
context.learningStatsReady = false;
context.recordLearningStatsReview({ id:'blocked-before-hydrate', deck:'A__one' }, 'required');
assert.strictEqual(context.getLearningStatsStore().days[context.getLearningStatsDateKey()].requiredDone.length, accumulatedBeforeBarrier, 'review writes are blocked until learning stats hydration completes');
context.learningStatsReady = true;
context.recordLearningStatsReview({ id:'after-hydrate', deck:'A__one' }, 'required');
assert.strictEqual(context.getLearningStatsStore().days[context.getLearningStatsDateKey()].requiredDone.length, accumulatedBeforeBarrier + 1, 'one review after hydration increments the existing snapshot instead of replacing it');
context.learningStatsMemoryStore = JSON.parse(learningStatsBeforeBarrierTest);

const filterTargets = {
    requiredCards:['A','B','C'].map(id => byId[id]),
    newCards:['D','E'].map(id => byId[id])
};
let model = context.buildLearningStatsModel(filterTargets);
assert.strictEqual(model.sets.requiredDone.size, 3, 'required reviews are unique');
assert.strictEqual(model.sets.newDone.size, 2, 'new reviews are unique');
assert.strictEqual(model.sets.otherDone.size, 3, 'other excludes cards completed in required/new');
assert.strictEqual(model.sets.allDone.size, 8, 'total is the UUID union');
assert.strictEqual(model.sets.requiredTarget.size, filterTargets.requiredCards.length, 'required denominator equals the existing filter result');
assert.strictEqual(model.sets.newTarget.size, filterTargets.newCards.length, 'new denominator equals the existing filter result');

const topChildren = context.getLearningStatsImmediateChildren(model, '');
assert.deepStrictEqual([...topChildren], ['A', 'B'], 'root uses actual top-level decks');
assert.deepStrictEqual([...context.getLearningStatsImmediateChildren(model, 'A')], ['A__deep', 'A__one'], 'drill-down returns immediate children');
assert.deepStrictEqual([...context.getLearningStatsImmediateChildren(model, 'A__deep')], ['A__deep__leaf'], 'drill-down has no fixed depth');
assert.strictEqual(model.aggregates.get('A').allDone.size, 6, 'parent aggregates descendants by UUID set');
assert.strictEqual(model.aggregates.get('B').allDone.size, 2, 'sibling aggregate stays isolated');

const now = new Date();
const beforeBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 59).getTime();
const afterBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0).getTime();
assert.notStrictEqual(context.getLearningStatsDateKey(beforeBoundary), context.getLearningStatsDateKey(afterBoundary), 'date boundary follows the existing 4 AM virtual day');

context.reviewHistory.legacyCard = [{ score:2, time:Date.now() }];
model = context.buildLearningStatsModel(filterTargets);
assert.strictEqual(model.sets.allDone.size, 9, 'legacy history can restore today total');
assert.strictEqual(model.sets.otherDone.size, 3, 'legacy history is not guessed as another source');

const completedBeforeFilterChange = {
    requiredDone:[...model.day.requiredDone], newDone:[...model.day.newDone],
    otherDone:[...model.day.otherDone], allDone:[...model.day.allDone]
};
const stored = context.getLearningStatsStore();
stored.days[context.getLearningStatsDateKey()].requiredTarget = ['legacy-1','legacy-2','legacy-3','legacy-4'];
stored.days[context.getLearningStatsDateKey()].newTarget = ['legacy-new'];
context.saveLearningStatsStore(stored);
const changedFilterTargets = { requiredCards:[byId.B, byId.C], newCards:[byId.E, byId.G, byId.H] };
model = context.buildLearningStatsModel(changedFilterTargets);
assert.strictEqual(model.sets.requiredTarget.size, 2, 'stored snapshots/unions do not affect the current required denominator');
assert.strictEqual(model.sets.newTarget.size, 3, 'stored snapshots/unions do not affect the current new denominator');
assert.deepStrictEqual([...model.day.requiredDone], completedBeforeFilterChange.requiredDone, 'requiredDone is unchanged by denominator changes');
assert.deepStrictEqual([...model.day.newDone], completedBeforeFilterChange.newDone, 'newDone is unchanged by denominator changes');
assert.deepStrictEqual([...model.day.otherDone], completedBeforeFilterChange.otherDone, 'otherDone is unchanged by denominator changes');
assert.deepStrictEqual([...model.day.allDone], completedBeforeFilterChange.allDone, 'allDone is unchanged by denominator changes');
assert.strictEqual(model.aggregates.get('A').requiredTarget.size, 2, 'deck denominator filters current candidates by descendants');
assert.strictEqual(model.aggregates.get('B').newTarget.size, 2, 'sibling deck denominator uses only its current candidate UUIDs');

const sourceHook = html.match(/const learningStatsSource = ([^;]+);/);
assert(sourceHook && sourceHook[1].includes("'new'") && sourceHook[1].includes("'required'") && sourceHook[1].includes("'other'"), 'grade captures all three sources before saving');
assert(html.includes('recordLearningStatsReview(card, learningStatsSource);'), 'grade records the captured source');
assert(html.includes('[LEARNING_STATS_STORAGE_KEY]: learningStatsBackup'), 'Firebase payload includes the compact learning-stats field under its local key');
assert(html.includes('[LEARNING_STATS_FAVORITE_DECKS_STORAGE_KEY]: learningStatsFavoriteDecksBackup'), 'Firebase payload includes favorite deck paths under its local key');
assert(!html.includes('unionLearningStatsTargets'), 'snapshot/union targets are removed from denominator flow');
assert(readFunction('getCurrentLearningStatsFilterTargets').includes('buildTodayEssentialCandidates(scope)'), 'stats directly runs the existing required selector with the full scope');
assert(readFunction('getCurrentLearningStatsFilterTargets').includes('buildTodayNewCandidates(scope)'), 'stats directly runs the existing new selector with the full scope');
assert(html.replace(/\r\n/g, '\n').includes('const scope = getCurrentDeckRecommendedStudyScope();\n        const prepared = recommendedStudySheetMode'), 'the real filter UI uses the current selected deck scope');
assert(html.includes('buildTodayNewCandidates(scope) : buildTodayEssentialCandidates(scope)'), 'today new and today review use the scoped selector input');
assert(html.includes('const sourceCards = Array.isArray(options.cards) ? options.cards : [...(activeDeck || []), ...(originalDeck || [])]'), 'required selector accepts cards without activeDeck dependency');
assert(html.includes('const sourceCards = Array.isArray(options.cards) ? options.cards : (originalDeck || [])'), 'new selector accepts cards without originalDeck dependency');
const statsTargetFunction = readFunction('getCurrentLearningStatsFilterTargets');
['activeDeck =', 'originalDeck =', 'currentIndex =', 'currentFilterMode =', 'currentSortMode ='].forEach(code => {
    assert(!statsTargetFunction.includes(code), `statistics target calculation must not mutate ${code}`);
});
assert(!readFunction('buildLearningStatsModel').includes('guardedStatsWrite'), 'opening stats never writes Stats');
assert(!readFunction('openLearningStats').includes('learningStatsModelCache = null'), 'opening statistics preserves the warm model cache');
assert(!readFunction('closeLearningStats').includes('learningStatsModelCache = null'), 'closing statistics preserves the warm model cache');
assert(readFunction('getLearningStatsCardLookup').includes('learningStatsCardIndexCache'), 'UUID to deck and ancestor index is cached by library revision');
assert(html.includes("if(window.__MK_STATS_LOOKUP_DEBUG__)"), 'per-card Stats lookup logging is disabled outside explicit debug mode');
assert(!readFunction('renderLearningStats').includes("['필수'"), 'learning statistics user label is review, not required');
assert(html.includes('learning-stats-progress') && html.includes('learning-stats-denominator'), 'progress and denominator use separate typography');
assert(html.includes('.learning-stats-denominator { font-weight:400;'), 'denominator is not bold');
assert(html.includes('.learning-stats-favorite { width:40px; height:40px;'), 'favorite touch target is at least 40 by 40 pixels');
assert(!html.includes('learning-stats-progress-bar'), 'no statistics progress bar is added');

const restoreStorage = new Map([
    ['mk_learning_stats_v1', '{"version":1,"days":{"preserved":{}}}'],
    ['anki_final_library', 'rebuildable-library']
]);
let learningStatsWriteFailures = 2;
const safeRestoreContext = {
    console,
    Set,
    Array,
    String,
    STORAGE_KEY_STATS: 'anki_final_stats',
    STORAGE_KEY_LIBRARY: 'anki_final_library',
    STORAGE_KEY_ACTIVE_IDS: 'anki_final_active_ids',
    STORAGE_KEY_DECK_VIEW_STATES: 'deckViewStates',
    localStorage: {
        getItem: key => restoreStorage.has(key) ? restoreStorage.get(key) : null,
        setItem: (key, value) => {
            if(key === 'mk_learning_stats_v1' && learningStatsWriteFailures-- > 0) {
                const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error;
            }
            restoreStorage.set(key, String(value));
        },
        removeItem: key => restoreStorage.delete(key)
    },
    pruneRecoverySnapshots() {},
    getLocalStatsKeyCount() { return 0; },
    getStatsKeyCount() { return 0; },
    isBootstrapRestoring: false,
    bootstrapAllowedStatsWriteValue: null,
    isAllowedStatsRestoreCount() { return true; },
    guardedStatsWrite() { return { ok:true }; },
    statsPersistenceQueue: Promise.resolve()
};
vm.createContext(safeRestoreContext);
['normalizeBackupValue', 'getTextSizeKB', 'isQuotaExceededError', 'freeRestorableCacheStorage', 'safeRestoreLocalStorage']
    .forEach(name => vm.runInContext(readFunction(name), safeRestoreContext));
const failedRestore = safeRestoreContext.safeRestoreLocalStorage('mk_learning_stats_v1', '{"version":1,"days":{"new":{}}}');
assert.strictEqual(failedRestore.ok, false, 'a permanent quota failure is surfaced');
assert.strictEqual(failedRestore.keptOld, true, 'a failed learning-stats restore keeps the previous value');
assert.strictEqual(restoreStorage.get('mk_learning_stats_v1'), '{"version":1,"days":{"preserved":{}}}', 'quota retry never deletes the live learning-stats key');
assert.strictEqual(restoreStorage.has('anki_final_library'), false, 'only rebuildable cache is freed before a quota retry');

console.log('learning stats scenarios passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
