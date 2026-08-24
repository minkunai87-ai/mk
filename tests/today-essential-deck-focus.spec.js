const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function readFunction(name) {
    const start = html.indexOf(`function ${name}(`);
    assert(start >= 0, `${name} must exist`);
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

const today = new Date();
today.setHours(0, 0, 0, 0);
const day = 86400000;
const cards = {
    A: { id:'A', deck:'Top__Child', q:'A', a:'' },
    B: { id:'B', deck:'Top__Child', q:'B', a:'' },
    C: { id:'C', deck:'Top__Child', q:'C', a:'' },
    D: { id:'D', deck:'Top__Child', q:'D', a:'' },
    E: { id:'E', deck:'Outside', q:'E', a:'' },
    F: { id:'F', deck:'Top__Grand__Leaf', q:'F', a:'' }
};
const stats = {
    A: { dueDate:today.getTime() - 5 * day, lastDate:today.getTime() - 10 * day, total:4, correct:1 },
    B: { dueDate:today.getTime(), lastDate:today.getTime() - day, total:5, correct:5 },
    C: { dueDate:today.getTime() + day, lastDate:0, total:0, correct:0 },
    D: { dueDate:today.getTime() + day, lastDate:Date.now(), total:2, correct:1 },
    E: { dueDate:today.getTime() - day, lastDate:0, total:1, correct:0 },
    F: { dueDate:today.getTime(), lastDate:today.getTime() - 2 * day, total:5, correct:4 }
};
const context = {
    console:{ log(){} }, performance:{ now:() => 0 }, Date, Set, Map, Math, Number, String, Array, Object,
    activeDeck:[], originalDeck:[],
    document:{ getElementById:() => null },
    getStatsStore:() => stats,
    getActiveFilterModes:() => [],
    findStatsForCard:(card, store, id) => ({ key:id, stat:store[id] || {} }),
    getVirtualDate:value => new Date(value),
    getRepresentativeReviewSeconds:() => 12
};
vm.createContext(context);
[
    'getTodayEssentialCardId', 'isTodayEssentialWrong', 'getTodayEssentialAccuracy',
    'getTodayEssentialPriority', 'buildTodayEssentialCandidates'
].forEach(name => vm.runInContext(readFunction(name), context));
context.isConfirmHistoryItem = item => Number(item && item.score) === 3;
context.getAccuracyStatsFromItems = (items, fallback) => ({ correct:Number(fallback.correct) || 0, total:Number(fallback.total) || 0 });

const scopeCards = [cards.A, cards.B, cards.C, cards.D, cards.F];
const prepared = context.buildTodayEssentialCandidates({ cards:scopeCards, statsSnapshot:stats, query:'', filterModes:[] });
assert.deepStrictEqual(Array.from(prepared.candidates, card => card.id), ['A', 'B', 'F'], 'future due, completed/future-due, and out-of-scope cards are excluded while a child-deck card remains');
assert.deepStrictEqual(Array.from(prepared.ranked, item => item.card.id), ['A', 'F', 'B'], 'priority order is deterministic and descending');
assert.strictEqual(prepared.ranked[0].score, 85, 'A uses overdue, aggregate accuracy, elapsed time, and early-learning weights');
assert.deepStrictEqual(Array.from(prepared.ranked.slice(0, 2), item => item.card.id), ['A', 'F'], 'count limiting preserves priority order');
assert.strictEqual(Math.floor(1800 / prepared.representativeSeconds), 150, '30-minute preset uses the representative seconds path');
assert.strictEqual(Math.floor(3600 / prepared.representativeSeconds), 300, '1-hour preset uses the representative seconds path');
assert.strictEqual(Math.floor(7200 / prepared.representativeSeconds), 600, '2-hour preset uses the representative seconds path');

const durationStorage = new Map();
context.localStorage = { getItem:key => durationStorage.has(key) ? durationStorage.get(key) : null };
context.REVIEW_DURATION_STORAGE_KEY = 'duration-test';
context.REVIEW_DURATION_MAX_SAMPLES = 300;
context.REVIEW_DURATION_DEFAULT_SECONDS = 12;
vm.runInContext(readFunction('getValidReviewDurationSamples'), context);
vm.runInContext(readFunction('getRepresentativeReviewSeconds'), context);
durationStorage.set('duration-test', JSON.stringify([0, -1, 'bad', null, ...Array(30).fill(60)]));
assert.strictEqual(context.getRepresentativeReviewSeconds(), 60, 'invalid duration values are removed and a valid median remains bounded');
durationStorage.set('duration-test', JSON.stringify([0, -1, 'bad', null]));
assert.strictEqual(context.getRepresentativeReviewSeconds(), 12, 'too few valid duration samples use the nonzero fallback');

const renderDeckTreeSource = readFunction('renderDeckTree');
assert(renderDeckTreeSource.includes('head.dataset.deckPath = item._path'), 'folder identity uses the full deck path');
assert(renderDeckTreeSource.includes('li.dataset.deckPath = item._path'), 'leaf identity uses the full deck path');
assert(renderDeckTreeSource.includes("currentDeckName.startsWith(item._path + '__')"), 'selected descendants open their ancestors');
assert(renderDeckTreeSource.includes("item._path === currentDeckName ? 'active' : ''"), 'the exact current leaf keeps the active style');

const openRequiredSource = readFunction('openRecommendedStudySheet');
assert(openRequiredSource.includes("if(recommendedStudySheetMode === 'required')"), 'today required has an explicit scope branch');
assert(openRequiredSource.includes("scope.query = '';"), 'today required ignores a stale UI search query');
assert(openRequiredSource.includes('scope.filterModes = [];'), 'today required uses the pure due set instead of unrelated UI filters');
const startRequiredSource = readFunction('startRecommendedStudy');
assert(startRequiredSource.includes('processedIds: new Set()'), 'each today-required start resets processed UUIDs');
assert(!readFunction('buildTodayEssentialCandidates').includes('processedIds'), 'processed UUIDs cannot zero the initial candidate builder');

function makeClassList(initial = []) {
    const values = new Set(initial);
    return { add:value => values.add(value), remove:value => values.delete(value), contains:value => values.has(value) };
}
const scrolls = [];
const targets = ['Root__Same', 'Other__Same'].map((deckPath, index) => ({
    dataset:{ deckPath },
    getBoundingClientRect:() => ({ top:500 + index * 50, bottom:540 + index * 50 }),
    scrollIntoView:options => scrolls.push({ deckPath, options })
}));
const sidebar = {
    classList:makeClassList(),
    querySelectorAll:() => targets,
    getBoundingClientRect:() => ({ top:0, bottom:300 })
};
const overlay = { classList:makeClassList() };
const focusContext = {
    currentDeckName:'Root__Same',
    document:{
        getElementById:id => id === 'sidebar' ? sidebar : null,
        querySelector:selector => selector === '.sidebar-overlay' ? overlay : null
    },
    renderDeckTree:() => { focusContext.renderCount++; },
    renderCount:0,
    requestAnimationFrame:callback => callback()
};
vm.createContext(focusContext);
vm.runInContext('let deckManagerFocusRequest = 0;\n' + readFunction('focusCurrentDeckInManager') + '\n' + readFunction('toggleMenu'), focusContext);
focusContext.toggleMenu(true);
assert.strictEqual(focusContext.renderCount, 1, 'opening refreshes the tree for the current deck');
assert.deepStrictEqual(scrolls.map(item => item.deckPath), ['Root__Same'], 'duplicate display names focus the exact full path once');
focusContext.toggleMenu(false);
focusContext.currentDeckName = 'Other__Same';
focusContext.toggleMenu(true);
assert.deepStrictEqual(scrolls.map(item => item.deckPath), ['Root__Same', 'Other__Same'], 're-entry focuses the newly selected deck once');
targets[1].getBoundingClientRect = () => ({ top:100, bottom:140 });
focusContext.toggleMenu(false);
focusContext.toggleMenu(true);
assert.strictEqual(scrolls.length, 2, 'an already fully visible current deck does not cause a scroll jump');

console.log('today-essential-deck-focus.spec.js: all assertions passed');
