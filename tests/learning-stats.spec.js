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
    crypto: require('crypto').webcrypto,
    APP_VERSION: 'test-version',
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
    learningStatsMemoryRevision: 0,
    learningStatsSessionId: 'test-session',
    learningStatsInstanceChannel: null,
    learningStatsReviewDeltaQueue: [],
    learningStatsPersistenceQueue: Promise.resolve({ok:true, skipped:true}),
    learningStatsStartupSyncInProgress: false,
    learningStatsEventLedgerActive: false,
    activeDeck: [],
    originalDeck: [],
    todayEssentialState: { active:false },
    todayNewState: { active:false },
    document: { getElementById: () => null },
    learningStatsFavoriteDecksMemory: [],
    learningStatsFavoritesUpdatedAt: 0,
    LEARNING_STATS_DB_PRIMARY_KEY: 'mk_learning_stats_v1',
    LEARNING_STATS_DB_STAGING_KEY: 'mk_learning_stats_v1_staging',
    LEARNING_STATS_DB_UPDATED_AT_KEY: 'mk_learning_stats_v1_updated_at',
    LEARNING_STATS_DB_REVISION_KEY: 'mk_learning_stats_v1_revision',
    LEARNING_STATS_DB_WRITE_JOURNAL_KEY: 'mk_learning_stats_v1_write_journal',
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
function getDeviceId() { return 'test-device'; }
function getLearningStatsPlatform() { return 'test-platform'; }
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
async function commitLearningStatsWriteAtomically(store, updatedAt, writeContext = {}) {
    const current = normalizeLearningStatsPersistentStore(idbStorage.get(LEARNING_STATS_DB_PRIMARY_KEY));
    const reviewDelta = writeContext.reviewDelta && typeof writeContext.reviewDelta === 'object' ? writeContext.reviewDelta : null;
    const incoming = reviewDelta ? applyLearningStatsReviewDeltas(current, [reviewDelta]) : normalizeLearningStatsPersistentStore(store);
    const currentRevision = Number(idbStorage.get(LEARNING_STATS_DB_REVISION_KEY)) || 0;
    const comparison = getLearningStatsWriteComparison(current, incoming);
    const staleRevision = Number.isFinite(Number(writeContext.expectedRevision)) && Number(writeContext.expectedRevision) !== currentRevision;
    const explicitRecovery = writeContext.allowDecrease === true && String(writeContext.source || '').startsWith('explicit-recovery:');
    const blockedRawWrite = reviewDelta ? false : (staleRevision || (comparison.decreases && !explicitRecovery));
    const committed = reviewDelta ? incoming : (blockedRawWrite ? mergeLearningStatsStoresWithoutLoss(current, incoming) : incoming);
    const revision = currentRevision + 1;
    idbStorage.set(LEARNING_STATS_DB_PRIMARY_KEY, JSON.stringify(committed));
    idbStorage.set(LEARNING_STATS_DB_UPDATED_AT_KEY, String(Math.max(Number(idbStorage.get(LEARNING_STATS_DB_UPDATED_AT_KEY)) || 0, Number(updatedAt) || 0)));
    idbStorage.set(LEARNING_STATS_DB_REVISION_KEY, String(revision));
    return { ok:true, store:committed, updatedAt:Number(idbStorage.get(LEARNING_STATS_DB_UPDATED_AT_KEY)) || 0, revision, blockedRawWrite, telemetry:{ WRITE_SOURCE:writeContext.source, currentEntryCount:comparison.currentEntryCount, newEntryCount:comparison.newEntryCount, removedUuidCount:comparison.removedUuids.length, action:reviewDelta ? (staleRevision ? 'REVIEW_DELTA_REBASED' : 'REVIEW_DELTA_COMMITTED') : (blockedRawWrite ? 'BLOCK_WRITE_REBASED' : (explicitRecovery && comparison.decreases ? 'EXPLICIT_RECOVERY_COMMITTED' : 'WRITE_COMMITTED')) } };
}
`, context);

[
    'getLearningStatsDateKey', 'getEmptyLearningStatsDay', 'normalizeLearningStatsDay',
    'normalizeLearningStatsPersistentStore', 'getLearningStatsStore', 'setLearningStatsMemoryStore', 'setLearningStatsRestoreState',
    'mergeLearningStatsStoresWithoutLoss', 'getLearningStatsWriteComparison',
    'persistLearningStatsToIndexedDBVerified', 'queueLearningStatsPersistence', 'saveLearningStatsStore', 'queueLearningStatsReviewPersistence',
    'persistLearningStatsFavoritesToIndexedDBVerified', 'updateLearningStatsDay',
    'rememberLearningStatsDeck', 'recordLearningStatsReview',
    'normalizeFirebaseArray', 'normalizeLearningStatsBackupPayload', 'getLearningStatsEntryCount', 'getLearningStatsBackupPayload',
    'normalizeLearningStatsFavoriteDecksBackupPayload', 'getLearningStatsFavoriteDecksBackupPayload',
    'canonicalizeBackupValue', 'stableBackupJson', 'getBackupFieldChecksum', 'getLegacyBackupFieldChecksum',
    'normalizeBackupFieldForChecksum', 'getCanonicalBackupFieldChecksum', 'getBackupChecksumVersion', 'verifyBackupFieldChecksum',
    'verifyLearningStatsBackupPayloadIntegrity', 'restoreLearningStatsBackupFields',
    'createLearningStatsReviewDelta', 'persistLearningStatsReviewDeltaQueue', 'queueLearningStatsReviewDelta', 'applyLearningStatsReviewDeltas',
    'evaluateLearningStatsBackupHealth',
    'verifyCoreBackupPayloadIntegrity',
    'getHistoryItemTime', 'getHistoryLatestTime', 'getStatLatestTime', 'getStartupStudyMetrics', 'compareStartupStudyStates', 'getStartupDataDecision', 'getStartupSyncNotice',
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
const rootOrderA = { version:1, days:{} };
const rootOrderB = { days:{}, version:1 };
assert.strictEqual(context.getBackupFieldChecksum(rootOrderA), context.getBackupFieldChecksum(rootOrderB), 'canonical checksum ignores root object key order');
const nestedOrderA = { days:{ '2026-08-19':{ requiredDone:['a'], otherDone:['b'] } } };
const nestedOrderB = { days:{ '2026-08-19':{ otherDone:['b'], requiredDone:['a'] } } };
assert.strictEqual(context.getBackupFieldChecksum(nestedOrderA), context.getBackupFieldChecksum(nestedOrderB), 'canonical checksum ignores nested object key order');
assert.notStrictEqual(context.getBackupFieldChecksum(['a','b']), context.getBackupFieldChecksum(['b','a']), 'canonical checksum preserves array element order');
const canonicalV2Payload = { checksumVersion:2, mk_learning_stats_v1:rootOrderB };
canonicalV2Payload.integrity = { mk_learning_stats_v1:context.getCanonicalBackupFieldChecksum(context.LEARNING_STATS_STORAGE_KEY, rootOrderA) };
assert.strictEqual(context.verifyLearningStatsBackupPayloadIntegrity(canonicalV2Payload).ok, true, 'checksum v2 verifies normalized canonical content regardless of root key order');
const legacyRootOrder = { version:1, days:{ '2026-08-19':{ requiredDone:['legacy'], allDone:['legacy'] } } };
const legacyRawPayload = { mk_learning_stats_v1:legacyRootOrder, integrity:{ mk_learning_stats_v1:context.getLegacyBackupFieldChecksum(legacyRootOrder) } };
assert.strictEqual(context.verifyLearningStatsBackupPayloadIntegrity(legacyRawPayload).ok, true, 'unversioned order-sensitive legacy checksum remains restorable');
assert(html.includes('checksumVersion: BACKUP_CHECKSUM_VERSION'), 'new Firebase payloads declare checksum algorithm version 2');
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
const startupLocal = { updatedAt:200, stats:{ A:{ total:2, updatedAt:200, fsrs:{ reps:2 } } }, reviewHistory:{ A:[{ id:'old-review', time:100, score:2 }, { id:'local-review', time:200, score:3 }] } };
const startupCloudSame = JSON.parse(JSON.stringify(startupLocal));
const startupCloudOlder = { updatedAt:100, stats:{ A:{ total:1, updatedAt:100, fsrs:{ reps:1 } } }, reviewHistory:{ A:[{ id:'old-review', time:100, score:2 }] } };
const startupCloudNewer = { updatedAt:300, stats:{ A:{ total:3, updatedAt:300, fsrs:{ reps:3 } } }, reviewHistory:{ A:[...startupLocal.reviewHistory.A, { id:'cloud-review', time:300, score:4 }] } };
const startupSameDecision = context.getStartupDataDecision(startupLocal, startupCloudSame, { backupHealthy:true });
assert.strictEqual(startupSameDecision.outcome, 'same', 'startup keeps identical local/Firebase study data unchanged');
assert.strictEqual(context.getStartupSyncNotice(startupSameDecision), '데이터 확인 완료 · 최신 상태입니다 (Stats 1)', 'identical data shows the final latest-state notice');
const startupLocalDecision = context.getStartupDataDecision(startupLocal, startupCloudOlder, { backupHealthy:true });
assert.strictEqual(startupLocalDecision.outcome, 'local', 'startup keeps local data when UUID evidence, event time, and reps are newer');
assert.strictEqual(context.getStartupSyncNotice(startupLocalDecision), '데이터 확인 완료 · 로컬 최신 상태 유지 (로컬 1 / Firebase 1)', 'newer local data shows the local-retained notice');
const startupCloudDecision = context.getStartupDataDecision(startupLocal, startupCloudNewer, { backupHealthy:true });
assert.strictEqual(startupCloudDecision.outcome, 'cloud', 'startup applies Firebase when its UUID evidence, event time, and reps are newer');
assert.strictEqual(context.getStartupSyncNotice(startupCloudDecision), '데이터 업데이트 완료 · Firebase 최신 기록 반영 (1개)', 'newer Firebase data shows the applied notice');
const startupInvalidDecision = context.getStartupDataDecision(startupLocal, startupCloudNewer, { backupHealthy:false });
assert.strictEqual(startupInvalidDecision.outcome, 'backup-invalid', 'a sudden-drop or corrupt Firebase candidate keeps local data');
assert.strictEqual(context.getStartupSyncNotice(startupInvalidDecision), '백업 이상 감지 · 안전하게 로컬 데이터 유지', 'an unhealthy backup shows the safety notice');
const startupReadFailure = context.getStartupDataDecision(startupLocal, {}, { readFailed:true });
assert.strictEqual(startupReadFailure.outcome, 'read-failed', 'a Firebase read failure keeps local data');
assert.strictEqual(context.getStartupSyncNotice(startupReadFailure), '최신 데이터 확인 실패 · 기존 로컬 데이터로 시작', 'a Firebase read failure never reports success');
const startupMergeDecision = context.getStartupDataDecision(
    startupLocal,
    { updatedAt:300, stats:{ B:{ total:1, updatedAt:300, fsrs:{ reps:1 } } }, reviewHistory:{ B:[{ id:'cloud-only', time:300, score:3 }] } },
    { backupHealthy:true }
);
assert.strictEqual(startupMergeDecision.outcome, 'merge', 'different latest UUID evidence on both sides selects the existing safe merge path');
assert.strictEqual(context.getStartupSyncNotice(startupMergeDecision), '데이터 동기화 완료 · 로컬 + Firebase 최신 기록 병합 (최신 학습 기록 1개 반영)', 'two-sided changes show the merged notice');
const startupSyncSource = readFunction('syncLatestFirebaseBackupOnStartup');
assert(startupSyncSource.includes("applyRestoredState(cloudState, 'cloud'"), 'normal startup cloud updates reuse the UUID/history merge restore path');
assert(!startupSyncSource.includes('applyStartupBootstrapPayload(candidate'), 'normal non-empty startup never force-reinstalls the whole cloud snapshot');
assert.strictEqual((startupSyncSource.match(/showToast\(/g) || []).length, 1, 'startup emits exactly one final toast after comparison and apply');
storage.delete(context.STORAGE_KEY_LEARNING_STATS_UPDATED_AT);
storage.set(context.LEARNING_STATS_STORAGE_KEY, JSON.stringify({ version:1, days:{} }));
assert.strictEqual(context.getLocalGroupUpdatedAt(context.STORAGE_KEY_LEARNING_STATS_UPDATED_AT, context.LEARNING_STATS_STORAGE_KEY), 0, 'an existing empty learning-stats key never inherits the Stats timestamp');
await context.learningStatsPersistenceQueue;
context.learningStatsMemoryStore = { version:1, days:{} };
context.learningStatsMemoryRevision = Number(idbStorage.get(context.LEARNING_STATS_DB_REVISION_KEY)) || 0;
idbStorage.set(context.LEARNING_STATS_DB_PRIMARY_KEY, JSON.stringify(context.learningStatsMemoryStore));
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
assert(html.includes('const scope = getCurrentDeckRecommendedStudyScope();'), 'the real filter UI uses the current selected deck scope');
assert(readFunction('getCurrentDeckRecommendedStudyScope').includes("query: ''"), 'recommended study does not inherit the search query');
assert(readFunction('getCurrentDeckRecommendedStudyScope').includes('filterModes: []'), 'recommended study does not inherit unrelated UI filters');
assert(html.includes('buildTodayNewCandidates(scope) : buildTodayEssentialCandidates(scope)'), 'today new and today review use the scoped selector input');
assert(html.includes('const sourceCards = Array.isArray(options.cards) ? options.cards : [...(activeDeck || []), ...(originalDeck || [])]'), 'required selector accepts cards without activeDeck dependency');
assert(html.includes('const sourceCards = Array.isArray(options.cards) ? options.cards : (originalDeck || [])'), 'new selector accepts cards without originalDeck dependency');
const statsTargetFunction = readFunction('getCurrentLearningStatsFilterTargets');
['activeDeck =', 'originalDeck =', 'currentIndex =', 'currentFilterMode =', 'currentSortMode ='].forEach(code => {
    assert(!statsTargetFunction.includes(code), `statistics target calculation must not mutate ${code}`);
});
assert(!readFunction('buildLearningStatsModel').includes('guardedStatsWrite'), 'opening stats never writes Stats');
assert(!readFunction('buildLearningStatsModel').includes('saveLearningStatsStore'), 'statistics model rendering is read-only and cannot persist a UI-filtered snapshot');
assert(readFunction('recordLearningStatsReview').includes('queueLearningStatsReviewPersistence'), 'reviews use the dedicated UUID delta persistence path');
assert(readFunction('commitLearningStatsWriteAtomically').includes('applyLearningStatsReviewDeltas(current, [reviewDelta])'), 'review deltas merge into the durable transaction current value');
assert(!readFunction('recordLearningStatsReview').includes('activeDeck'), 'review persistence never uses the visible filtered card array as its source');
const protectedIds = Array.from({length:838}, (_, index) => `protected-${index}`);
const protectedStore = { version:1, days:{ '2026-08-19':{ allDone:protectedIds, trackedDone:protectedIds } } };
idbStorage.set(context.LEARNING_STATS_DB_PRIMARY_KEY, JSON.stringify(context.normalizeLearningStatsPersistentStore(protectedStore)));
idbStorage.set(context.LEARNING_STATS_DB_REVISION_KEY, '105');
idbStorage.set(context.LEARNING_STATS_DB_UPDATED_AT_KEY, '1000');
context.learningStatsMemoryStore = context.normalizeLearningStatsPersistentStore(protectedStore);
context.learningStatsMemoryRevision = 105;
const collapseResult = await context.persistLearningStatsToIndexedDBVerified({ version:1, days:{ '2026-08-19':{ allDone:['protected-0','protected-1'] } } }, 1001, 'test-838-to-2');
assert.strictEqual(collapseResult.blockedRawWrite, true, '838 to 2 whole-object overwrite is blocked');
assert.strictEqual(context.getLearningStatsEntryCount(collapseResult.store), 838, 'blocked decreasing write preserves all UUIDs and date snapshots');
const staleIncoming = context.mergeLearningStatsStoresWithoutLoss(protectedStore, { version:1, days:{ '2026-08-19':{ allDone:['new-from-stale-instance'] } } });
const staleResult = await context.persistLearningStatsToIndexedDBVerified(staleIncoming, 1002, 'test-stale-instance', { expectedRevision:105 });
assert.strictEqual(staleResult.blockedRawWrite, true, 'a session that read revision 105 cannot replace revision 106');
assert.strictEqual(context.getLearningStatsEntryCount(staleResult.store), 839, 'stale write is rebased as an additive UUID merge without losing the 838 entries');
const recoveryResult = await context.persistLearningStatsToIndexedDBVerified(protectedStore, 1003, 'explicit-recovery:verified-backup', { expectedRevision:107, allowDecrease:true });
assert.strictEqual(recoveryResult.blockedRawWrite, false, 'an integrity-verified explicit recovery may remove accidental additions');
assert.strictEqual(recoveryResult.telemetry.action, 'EXPLICIT_RECOVERY_COMMITTED', 'explicit recovery is separately journaled');
assert.strictEqual(context.getLearningStatsEntryCount(recoveryResult.store), 838, 'explicit recovery restores the exact verified snapshot');
await context.learningStatsPersistenceQueue;
idbStorage.set(context.LEARNING_STATS_DB_PRIMARY_KEY, JSON.stringify(context.normalizeLearningStatsPersistentStore(protectedStore)));
idbStorage.set(context.LEARNING_STATS_DB_REVISION_KEY, '200');
context.learningStatsMemoryStore = context.normalizeLearningStatsPersistentStore(protectedStore);
context.learningStatsMemoryRevision = 200;
context.todayEssentialState = { active:true };
context.activeDeck = [{ id:'required-filter-new', deck:'A__one' }];
context.originalDeck = byId ? Object.values(byId) : [];
context.recordLearningStatsReview(context.activeDeck[0], 'required');
const requiredFilterDeltaResult = await context.learningStatsPersistenceQueue;
assert.strictEqual(requiredFilterDeltaResult.telemetry.action, 'REVIEW_DELTA_COMMITTED', 'today-required review commits through the delta writer');
assert.strictEqual(requiredFilterDeltaResult.blockedRawWrite, false, 'today-required delta does not require the decrease guard');
assert.strictEqual(context.getLearningStatsEntryCount(requiredFilterDeltaResult.store), 839, 'today-required visible subset adds one UUID to the full durable snapshot');
const preservedDayKeys = Object.keys(requiredFilterDeltaResult.store.days).sort();
const filterRegressionCases = [
    { label:'no-filter', source:'other', required:false, fresh:false, search:'', visible:8 },
    { label:'today-new', source:'new', required:false, fresh:true, search:'', visible:2 },
    { label:'deck-filter', source:'other', required:false, fresh:false, search:'', visible:3 },
    { label:'search-filter', source:'other', required:false, fresh:false, search:'소방', visible:1 }
];
let expectedFilterTotal = 839;
for(const testCase of filterRegressionCases) {
    const card = { id:`${testCase.label}-new`, deck:'A__one' };
    context.todayEssentialState = { active:testCase.required };
    context.todayNewState = { active:testCase.fresh };
    context.activeDeck = Array.from({length:testCase.visible}, (_, index) => index === 0 ? card : ({id:`visible-${testCase.label}-${index}`, deck:'A__one'}));
    context.document = { getElementById:id => id === 'search-input' ? { value:testCase.search } : null };
    context.recordLearningStatsReview(card, testCase.source);
    const result = await context.learningStatsPersistenceQueue;
    expectedFilterTotal += 1;
    assert.strictEqual(result.blockedRawWrite, false, `${testCase.label} delta never invokes decrease protection`);
    assert.strictEqual(result.telemetry.removedUuidCount, 0, `${testCase.label} removes no historical UUID`);
    assert.strictEqual(result.telemetry.currentEntryCount, expectedFilterTotal - 1, `${testCase.label} reads the full durable count`);
    assert.strictEqual(result.telemetry.newEntryCount, expectedFilterTotal, `${testCase.label} writes N+1`);
    assert.strictEqual(context.getLearningStatsEntryCount(result.store), expectedFilterTotal, `${testCase.label} preserves the full snapshot`);
    assert.deepStrictEqual(Object.keys(result.store.days).sort(), preservedDayKeys, `${testCase.label} preserves all historical dates`);
}
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
