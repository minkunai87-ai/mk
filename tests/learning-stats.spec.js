const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function readFunction(name) {
    const marker = `function ${name}(`;
    const start = html.indexOf(marker);
    assert(start >= 0, `${name} must exist`);
    const brace = html.indexOf('{', start);
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
const context = {
    console,
    Date,
    Set,
    Map,
    Object,
    String,
    Array,
    Math,
    currentDeckName: 'A',
    LEARNING_STATS_STORAGE_KEY: 'mk_learning_stats_v1',
    localStorage: {
        getItem: key => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value))
    },
    library: {
        A__one: [{ id:'A', deck:'A__one' }, { id:'B', deck:'A__one' }, { id:'D', deck:'A__one' }, { id:'F', deck:'A__one' }],
        A__deep__leaf: [{ id:'C', deck:'A__deep__leaf' }, { id:'E', deck:'A__deep__leaf' }],
        B__child: [{ id:'G', deck:'B__child' }, { id:'H', deck:'B__child' }]
    },
    reviewHistory: {}
};
vm.createContext(context);
vm.runInContext(`
function normalizeDeckPath(value, fallback='') { return String(value || fallback || '').replace(/\\//g, '__').replace(/::/g, '__').split('__').map(v => v.trim()).filter(Boolean).join('__'); }
function getVirtualDate(ts) { const d = new Date(ts); if(d.getHours() < 4) d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return d; }
function getTodayEssentialCardId(card) { return String(card && card.id || ''); }
function getReviewHistory() { return reviewHistory; }
`, context);

[
    'getLearningStatsDateKey', 'getEmptyLearningStatsDay', 'normalizeLearningStatsDay',
    'getLearningStatsStore', 'saveLearningStatsStore', 'updateLearningStatsDay',
    'rememberLearningStatsDeck', 'unionLearningStatsTargets', 'recordLearningStatsReview',
    'getLearningStatsCardLookup', 'restoreTodayLearningStatsTotal', 'buildLearningStatsModel',
    'getLearningStatsImmediateChildren'
].forEach(name => vm.runInContext(readFunction(name), context));

const cards = Object.values(context.library).flat();
const byId = Object.fromEntries(cards.map(card => [card.id, card]));
context.unionLearningStatsTargets('required', ['A','B','C'].map(id => byId[id]));
context.unionLearningStatsTargets('new', ['D','E'].map(id => byId[id]));
['A','B','C','A'].forEach(id => context.recordLearningStatsReview(byId[id], 'required'));
['D','E','D'].forEach(id => context.recordLearningStatsReview(byId[id], 'new'));
['F','G','H','F'].forEach(id => context.recordLearningStatsReview(byId[id], 'other'));
context.recordLearningStatsReview(byId.A, 'other');
context.recordLearningStatsReview(byId.D, 'other');

let model = context.buildLearningStatsModel();
assert.strictEqual(model.sets.requiredDone.size, 3, 'required reviews are unique');
assert.strictEqual(model.sets.newDone.size, 2, 'new reviews are unique');
assert.strictEqual(model.sets.otherDone.size, 3, 'other excludes cards completed in required/new');
assert.strictEqual(model.sets.allDone.size, 8, 'total is the UUID union');
assert.strictEqual(model.sets.requiredTarget.size, 3, 'first required candidate set becomes the denominator');
assert.strictEqual(model.sets.newTarget.size, 2, 'first new candidate set becomes the denominator');

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
model = context.buildLearningStatsModel();
assert.strictEqual(model.sets.allDone.size, 9, 'legacy history can restore today total');
assert.strictEqual(model.sets.otherDone.size, 3, 'legacy history is not guessed as another source');

const beforeUnion = JSON.parse(storage.get(context.LEARNING_STATS_STORAGE_KEY));
const completedBeforeUnion = {
    requiredDone:[...model.day.requiredDone], newDone:[...model.day.newDone],
    otherDone:[...model.day.otherDone], allDone:[...model.day.allDone]
};
context.unionLearningStatsTargets('required', [byId.B, byId.C]);
model = context.buildLearningStatsModel();
assert.strictEqual(model.sets.requiredTarget.size, 3, 'a later smaller required list never shrinks the denominator');
context.unionLearningStatsTargets('required', [byId.B, byId.C, byId.D]);
context.unionLearningStatsTargets('new', [byId.E, byId.G]);
model = context.buildLearningStatsModel();
assert.strictEqual(model.sets.requiredTarget.size, 4, 'a newly due required UUID is appended');
assert.strictEqual(model.sets.newTarget.size, 3, 'a newly eligible new UUID is appended');
context.unionLearningStatsTargets('required', [byId.C, byId.D]);
model = context.buildLearningStatsModel();
assert.strictEqual(model.sets.requiredTarget.size, 4, 'a disappeared required UUID is retained');
assert.deepStrictEqual([...model.day.requiredDone], completedBeforeUnion.requiredDone, 'requiredDone is unchanged by target unions');
assert.deepStrictEqual([...model.day.newDone], completedBeforeUnion.newDone, 'newDone is unchanged by target unions');
assert.deepStrictEqual([...model.day.otherDone], completedBeforeUnion.otherDone, 'otherDone is unchanged by target unions');
assert.deepStrictEqual([...model.day.allDone], completedBeforeUnion.allDone, 'allDone is unchanged by target unions');
assert(beforeUnion.days[context.getLearningStatsDateKey()], 'existing v1 today data is used as the initial set');
assert.strictEqual(context.getLearningStatsStore().days[context.getLearningStatsDateKey()].requiredTarget.length, 4, 'target union survives a store reload');

const oldDateKey = '2000-01-01';
const persisted = context.getLearningStatsStore();
persisted.days[oldDateKey] = { ...context.getEmptyLearningStatsDay(), requiredTarget:['old-card'] };
context.saveLearningStatsStore(persisted);
context.unionLearningStatsTargets('required', [byId.D]);
assert.deepStrictEqual([...context.getLearningStatsStore().days[oldDateKey].requiredTarget], ['old-card'], 'previous dates are preserved');

const sourceHook = html.match(/const learningStatsSource = ([^;]+);/);
assert(sourceHook && sourceHook[1].includes("'new'") && sourceHook[1].includes("'required'") && sourceHook[1].includes("'other'"), 'grade captures all three sources before saving');
assert(html.includes('recordLearningStatsReview(card, learningStatsSource);'), 'grade records the captured source');
assert(readFunction('buildTodayEssentialCandidates').includes("unionLearningStatsTargets('required', candidates)"), 'required targets union when final candidates are built');
assert(readFunction('buildTodayNewCandidates').includes("unionLearningStatsTargets('new', candidates.map(item => item.card))"), 'new targets union when final candidates are built');
assert(!readFunction('startRecommendedStudy').includes('unionLearningStatsTargets'), 'target accumulation does not wait for study start');
assert(!readFunction('buildLearningStatsModel').includes('guardedStatsWrite'), 'opening stats never writes Stats');

console.log('learning stats scenarios passed');
