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

const context = {
    console,
    Date,
    Set,
    Map,
    Object,
    String,
    Array,
    Math,
    APP_VERSION:'test-version',
    learningStatsSessionId:'session-a',
    learningStatsMemoryRevision:7,
    LEARNING_STATS_BACKUP_DAY_KEYS:['requiredDone', 'newDone', 'otherDone', 'allDone', 'trackedDone']
};
vm.createContext(context);
vm.runInContext(`
function parseJSONSafe(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : (value == null ? fallback : value); } catch(error) { return fallback; } }
function normalizeDeckPath(value) { return String(value || '').split('\\\\').join('__').replace(/::/g, '__'); }
function getDeviceId() { return 'device-a'; }
function getLearningStatsPlatform() { return 'Windows'; }
function getVirtualDate(timestamp) { const d = new Date(timestamp); if(d.getHours() < 4) d.setDate(d.getDate() - 1); d.setHours(0,0,0,0); return d; }
function getStatsStore() { return {}; }
function cyrb53(value) { return String(value).split('').reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381); }
`, context);

[
    'getLearningStatsDateKey',
    'getEmptyLearningStatsDay',
    'normalizeLearningStatsDay',
    'normalizeLearningStatsPersistentStore',
    'normalizeLearningStatsEvent',
    'isLearningStatsRecoveryArtifact',
    'getLearningStatsEventPairKey',
    'createLearningStatsEventId',
    'createLearningStatsLedgerEvent',
    'learningStatsSnapshotToEvents',
    'buildLearningStatsStoreFromEvents',
    'getLearningStatsPairSet',
    'mergeLearningStatsEventEvidence',
    'filterLearningStatsMigrationSeedEvents',
    'addReviewHistoryRecoveryEvidence',
    'normalizeStatsObject',
    'addStatsLastDateRecoveryEvidence',
    'normalizeFirebaseArray',
    'normalizeLearningStatsBackupPayload',
    'getLearningStatsEntryCount'
].forEach(name => vm.runInContext(readFunction(name), context));

const legacy = {
    version:1,
    days:{
        '2026-08-18':{
            requiredDone:['required-card', 'overlap-card'],
            newDone:['overlap-card'],
            otherDone:[],
            allDone:['required-card', 'overlap-card', 'uncategorized-card'],
            trackedDone:['required-card'],
            deckByCard:{ 'required-card':'A__one' }
        }
    }
};
const seeded = context.learningStatsSnapshotToEvents(legacy, 'indexeddb-current-snapshot');
assert.strictEqual(seeded.length, 3, 'one deterministic migration event is created per date/UUID pair');
const rebuilt = context.buildLearningStatsStoreFromEvents(seeded);
for(const key of context.LEARNING_STATS_BACKUP_DAY_KEYS) {
    assert.deepStrictEqual([...rebuilt.days['2026-08-18'][key]].sort(), [...legacy.days['2026-08-18'][key]].sort(), `${key} survives migration exactly`);
}
assert.strictEqual(rebuilt.days['2026-08-18'].deckByCard['required-card'], 'A__one');
const lowerRankCloudConflict = context.createLearningStatsLedgerEvent({
    eventId:'legacy_cloud_conflict', uuid:'required-card', studyDate:'2026-08-18', timestamp:new Date('2026-08-18T12:00:00').getTime(),
    category:'other', categories:['other'], completionSets:['otherDone', 'allDone', 'trackedDone'], source:'legacy-migration', evidenceSource:'snapshot-confirmed', evidenceRank:100
});
const corrected = context.buildLearningStatsStoreFromEvents([...seeded, lowerRankCloudConflict]);
assert(corrected.days['2026-08-18'].requiredDone.includes('required-card') && !corrected.days['2026-08-18'].otherDone.includes('required-card'), 'higher-rank current snapshot correction wins without deleting the cloud event');
const sameRankDifferentTimestamp = context.createLearningStatsLedgerEvent({ ...lowerRankCloudConflict, eventId:'stats_same_pair_new_timestamp', source:'legacy-migration', evidenceSource:'stats-last-date-confirmed', evidenceRank:60, timestamp:lowerRankCloudConflict.timestamp + 1234 });
const existingStatsEvidence = context.createLearningStatsLedgerEvent({ ...sameRankDifferentTimestamp, eventId:'stats_existing_timestamp', timestamp:lowerRankCloudConflict.timestamp });
assert.strictEqual(context.filterLearningStatsMigrationSeedEvents([existingStatsEvidence], [sameRankDifferentTimestamp]).length, 0, 'same-rank Stats evidence for an existing date/UUID is idempotently skipped');
assert.strictEqual(context.filterLearningStatsMigrationSeedEvents([lowerRankCloudConflict], [seeded[0]]).length, 1, 'higher-rank current snapshot is appended as a correction');

const eventMap = new Map(seeded.map(event => [context.getLearningStatsEventPairKey(event), event]));
const historyTime = new Date('2026-08-17T12:00:00').getTime();
context.addReviewHistoryRecoveryEvidence(eventMap, {
    'history-only-card':[{ id:'h1', score:2, result:'correct', time:historyTime }],
    'required-card':[{ id:'h2', score:2, result:'correct', time:new Date('2026-08-18T12:00:00').getTime() }]
}, 'firebase-review-history:1');
context.addStatsLastDateRecoveryEvidence(eventMap, {
    'stats-only-card':{ lastDate:new Date('2026-08-16T12:00:00').getTime(), total:1 },
    'history-only-card':{ lastDate:historyTime, total:1 }
}, 'firebase-stats-last-date:1');
const recovered = context.buildLearningStatsStoreFromEvents([...eventMap.values()]);
assert.strictEqual(context.getLearningStatsEntryCount(recovered), 5, 'confirmed history and Stats.lastDate pairs are unioned once');
assert(recovered.days['2026-08-17'].allDone.includes('history-only-card'));
assert(recovered.days['2026-08-16'].allDone.includes('stats-only-card'));
assert(!rebuilt.days['2026-08-18'].otherDone.includes('required-card'), 'secondary evidence cannot reclassify an existing snapshot pair');

const fake = context.createLearningStatsLedgerEvent({
    eventId:'legacy_fake', uuid:'1072494338334661', studyDate:'2000-01-01', timestamp:1,
    category:'other', source:'legacy-migration'
});
assert.strictEqual(context.isLearningStatsRecoveryArtifact(fake), true, 'known fake recovery date is excluded');

const divergentA = context.createLearningStatsLedgerEvent({ eventId:'device_a_event', uuid:'A', studyDate:'2026-08-19', timestamp:1, category:'required', source:'review', platform:'Windows' });
const divergentB = context.createLearningStatsLedgerEvent({ eventId:'device_b_event', uuid:'B', studyDate:'2026-08-19', timestamp:2, category:'new', source:'review', platform:'macOS' });
const union = context.buildLearningStatsStoreFromEvents([divergentA, divergentB, divergentA]);
assert.deepStrictEqual([...union.days['2026-08-19'].allDone].sort(), ['A', 'B'], 'stale/device divergence is event-id union, not LWW');

const queueSource = readFunction('queueLearningStatsReviewPersistence');
assert(queueSource.indexOf('appendLearningStatsEvents') < queueSource.indexOf('commitLearningStatsCacheFromLedger'), 'ledger append is durable before cache rebuild');
assert(queueSource.includes('ledgerCommitted:true'), 'cache failure does not roll back a committed ledger event');
for(const forbidden of ['activeDeck[', 'originalDeck[', 'filteredCards', 'currentFilteredDeck', 'requiredCards', 'todayRequiredCards']) {
    assert(!readFunction('createLearningStatsReviewDelta').includes(forbidden), `review event creation is independent of ${forbidden}`);
}

const appendSource = readFunction('appendLearningStatsEvents');
assert(appendSource.includes('.add(event,'), 'normal ledger persistence uses IndexedDB add');
assert(!appendSource.includes('.put(') && !appendSource.includes('.delete(') && !appendSource.includes('.clear('), 'ledger append never updates, deletes, or clears events');
const firebaseSource = readFunction('syncLearningStatsEventLedgerWithFirebase');
assert(firebaseSource.includes("method:'PATCH'"), 'Firebase receives only missing event keys');
assert(!firebaseSource.includes("method:'DELETE'"), 'Firebase ledger sync never deletes events');


const sameDayOtherFirst = context.createLearningStatsLedgerEvent({
    eventId:'same_day_other_first', uuid:'same-day-card', studyDate:'2026-08-19', timestamp:1000,
    category:'other', categories:['other'], completionSets:['otherDone','allDone','trackedDone'], source:'review', platform:'Windows'
});
const sameDayRequiredLater = context.createLearningStatsLedgerEvent({
    eventId:'same_day_required_later', uuid:'same-day-card', studyDate:'2026-08-19', timestamp:2000,
    category:'required', categories:['required'], completionSets:['requiredDone','allDone','trackedDone'], source:'review', platform:'Windows'
});
const noReclassify = context.buildLearningStatsStoreFromEvents([sameDayOtherFirst, sameDayRequiredLater]);
assert(noReclassify.days['2026-08-19'].otherDone.includes('same-day-card'), 'later today-required review does not erase the first confirmed other category');
assert(!noReclassify.days['2026-08-19'].requiredDone.includes('same-day-card'), 'later today-required UI filter does not reclassify an already-counted UUID');
assert.strictEqual(noReclassify.days['2026-08-19'].allDone.filter(id => id === 'same-day-card').length, 1, 'same-day repeated review stays one unique total');

console.log('append-only learning stats ledger scenarios passed');
