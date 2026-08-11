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
    originalDeck: [],
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
    'rememberLearningStatsDeck', 'recordLearningStatsReview',
    'getLearningStatsCardLookup', 'restoreTodayLearningStatsTotal', 'getAllRecommendedStudyCards', 'getCurrentDeckRecommendedStudyCards', 'buildLearningStatsModel',
    'getLearningStatsImmediateChildren'
].forEach(name => vm.runInContext(readFunction(name), context));

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
['A','B','C','A'].forEach(id => context.recordLearningStatsReview(byId[id], 'required'));
['D','E','D'].forEach(id => context.recordLearningStatsReview(byId[id], 'new'));
['F','G','H','F'].forEach(id => context.recordLearningStatsReview(byId[id], 'other'));
context.recordLearningStatsReview(byId.A, 'other');
context.recordLearningStatsReview(byId.D, 'other');

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
assert(!html.includes('unionLearningStatsTargets'), 'snapshot/union targets are removed from denominator flow');
assert(readFunction('getCurrentLearningStatsFilterTargets').includes('buildTodayEssentialCandidates(scope)'), 'stats directly runs the existing required selector with the full scope');
assert(readFunction('getCurrentLearningStatsFilterTargets').includes('buildTodayNewCandidates(scope)'), 'stats directly runs the existing new selector with the full scope');
assert(html.includes('const scope = getCurrentDeckRecommendedStudyScope();\n        const prepared = recommendedStudySheetMode'), 'the real filter UI uses the current selected deck scope');
assert(html.includes('buildTodayNewCandidates(scope) : buildTodayEssentialCandidates(scope)'), 'today new and today review use the scoped selector input');
assert(html.includes('const sourceCards = Array.isArray(options.cards) ? options.cards : [...(activeDeck || []), ...(originalDeck || [])]'), 'required selector accepts cards without activeDeck dependency');
assert(html.includes('const sourceCards = Array.isArray(options.cards) ? options.cards : (originalDeck || [])'), 'new selector accepts cards without originalDeck dependency');
const statsTargetFunction = readFunction('getCurrentLearningStatsFilterTargets');
['activeDeck =', 'originalDeck =', 'currentIndex =', 'currentFilterMode =', 'currentSortMode ='].forEach(code => {
    assert(!statsTargetFunction.includes(code), `statistics target calculation must not mutate ${code}`);
});
assert(!readFunction('buildLearningStatsModel').includes('guardedStatsWrite'), 'opening stats never writes Stats');

console.log('learning stats scenarios passed');
