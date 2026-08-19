const assert = require('node:assert');
const childProcess = require('node:child_process');
const vm = require('node:vm');

const oldHtml = childProcess.execFileSync('git', ['show', 'c7e435ee:index.html'], {encoding:'utf8'});
function readFunction(name) {
    const marker = `function ${name}(`;
    let start = oldHtml.indexOf(marker);
    assert(start >= 0, `${name} exists in v18.5.152`);
    if(oldHtml.slice(start - 6, start) === 'async ') start -= 6;
    const brace = oldHtml.indexOf('{', oldHtml.indexOf(')', oldHtml.indexOf('(', start)));
    let depth = 0, quote = '', escaped = false;
    for(let index = brace; index < oldHtml.length; index++) {
        const char = oldHtml[index];
        if(quote) {
            if(escaped) escaped = false;
            else if(char === '\\') escaped = true;
            else if(char === quote) quote = '';
            continue;
        }
        if(char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if(char === '{') depth++;
        if(char === '}' && --depth === 0) return oldHtml.slice(start, index + 1);
    }
    throw new Error(`unterminated ${name}`);
}

const sharedIndexedDB = new Map();
function makeInstance(sessionName) {
    const context = {
        console, Date, Set, Object, String, Array, Math,
        sessionName,
        sharedIndexedDB,
        learningStatsRestoreState:'success',
        learningStatsMemoryStore:{version:1, days:{}},
        learningStatsMemoryUpdatedAt:0,
        learningStatsPersistenceQueue:Promise.resolve({ok:true}),
        LEARNING_STATS_DB_PRIMARY_KEY:'mk_learning_stats_v1',
        LEARNING_STATS_DB_STAGING_KEY:'mk_learning_stats_v1__staging',
        LEARNING_STATS_DB_UPDATED_AT_KEY:'mk_learning_stats_v1__updated_at',
        STORAGE_KEY_LEARNING_STATS_UPDATED_AT:'mk_learning_stats_updated_at',
        localStorage:{setItem(){}},
        setLearningStatsRestoreState(){},
        getLearningStatsEntryCount(value) {
            return Object.values((value && value.days) || {}).reduce((sum, day) => sum + new Set((day && day.allDone) || []).size, 0);
        }
    };
    vm.createContext(context);
    vm.runInContext(`
function parseJSONSafe(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : (value == null ? fallback : value); } catch(e) { return fallback; } }
function normalizeDeckPath(value) { return String(value || ''); }
function getEmptyLearningStatsDay() { return {requiredDone:[], newDone:[], otherDone:[], allDone:[], trackedDone:[], deckByCard:{}}; }
function normalizeLearningStatsDay(value) {
    const empty = getEmptyLearningStatsDay(); const source = value && typeof value === 'object' ? value : {};
    Object.keys(empty).forEach(key => { if(key !== 'deckByCard') empty[key] = [...new Set((source[key] || []).map(String))]; });
    empty.deckByCard = source.deckByCard || {}; return empty;
}
function normalizeLearningStatsPersistentStore(value) {
    const parsed = parseJSONSafe(value, {}); const days = parsed && parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
    return {version:1, days:Object.fromEntries(Object.entries(days).map(([key, day]) => [key, normalizeLearningStatsDay(day)]))};
}
async function readStatsDatabaseValue(key) { return sharedIndexedDB.has(key) ? sharedIndexedDB.get(key) : null; }
async function writeStatsDatabaseValue(key, value) { sharedIndexedDB.set(key, String(value)); }
async function removeStatsDatabaseValue(key) { sharedIndexedDB.delete(key); }
`, context);
    ['persistLearningStatsToIndexedDBVerified', 'queueLearningStatsPersistence', 'saveLearningStatsStore']
        .forEach(name => vm.runInContext(readFunction(name), context));
    return context;
}

(async () => {
    const ids838 = Array.from({length:838}, (_, index) => `uuid-${index}`);
    const base = {version:1, days:{'2026-08-19':{allDone:ids838, trackedDone:ids838}}};
    sharedIndexedDB.set('mk_learning_stats_v1', JSON.stringify(base));
    const current = makeInstance('current');
    const stale = makeInstance('stale');
    current.learningStatsMemoryStore = JSON.parse(JSON.stringify(base));
    stale.learningStatsMemoryStore = JSON.parse(JSON.stringify(base));

    const newest = JSON.parse(JSON.stringify(base));
    newest.days['2026-08-19'].allDone.push(...Array.from({length:10}, (_, index) => `new-${index}`));
    newest.days['2026-08-19'].trackedDone = [...newest.days['2026-08-19'].allDone];
    current.saveLearningStatsStore(newest, {source:'review-handler-required'});
    await current.learningStatsPersistenceQueue;
    assert.strictEqual(current.getLearningStatsEntryCount(JSON.parse(sharedIndexedDB.get('mk_learning_stats_v1'))), 848);

    const callStack = [
        'buildLearningStatsModel',
        'saveLearningStatsStore',
        'queueLearningStatsPersistence',
        'persistLearningStatsToIndexedDBVerified',
        'writeStatsDatabaseValue(LEARNING_STATS_DB_PRIMARY_KEY)'
    ];
    assert(readFunction('buildLearningStatsModel').includes('saveLearningStatsStore(store);'));
    assert(readFunction('saveLearningStatsStore').includes('queueLearningStatsPersistence'));
    assert(readFunction('queueLearningStatsPersistence').includes('persistLearningStatsToIndexedDBVerified'));
    assert(readFunction('persistLearningStatsToIndexedDBVerified').includes('writeStatsDatabaseValue(LEARNING_STATS_DB_PRIMARY_KEY'));
    stale.saveLearningStatsStore(stale.learningStatsMemoryStore, {source:'learning-stats-model-history-merge'});
    await stale.learningStatsPersistenceQueue;
    const after = JSON.parse(sharedIndexedDB.get('mk_learning_stats_v1'));
    assert.strictEqual(stale.getLearningStatsEntryCount(after), 838, 'v18.5.152 stale model write reproduces the loss');
    console.log(JSON.stringify({version:'v18.5.152', function:'buildLearningStatsModel', before:848, after:838, callStack}, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
