// Run: node tests/current-problem-focus.spec.js
// Focus selection is tested without Firebase, storage changes, or deck mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = source.indexOf('    function mkIsRenderedProblemAnchor(');
const end = source.indexOf('    function scrollToCurrentProblem(e) {', start);
assert(start > 0 && end > start, 'focus functions must exist');
const focusCode = source.slice(start, end);
new Function(focusCode);

class FakeElement {
    constructor(tag='div', classes='', rect={top:120,width:80,height:20}, attrs={}) {
        this.tagName = tag.toUpperCase();
        this.classes = new Set(classes.split(/\s+/).filter(Boolean));
        this.rect = rect;
        this.attrs = attrs;
        this.children = [];
        this.parentElement = null;
        this.isConnected = true;
        this.classList = {contains: value => this.classes.has(value)};
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    matches(query) {
        const sel = query.trim();
        if(sel.startsWith('[') && sel.endsWith(']')) return this.attrs[sel.slice(1,-1)] !== undefined;
        const tag = sel.match(/^[a-z]+/i);
        if(tag && this.tagName !== tag[0].toUpperCase()) return false;
        for(const match of sel.matchAll(/\.([\w-]+)/g))
            if(!this.classes.has(match[1])) return false;
        return !!(tag || sel.startsWith('.') || sel.startsWith('['));
    }
    closest(selector) {
        for(let node=this;node;node=node.parentElement)
            if(selector.split(',').some(part=>node.matches(part))) return node;
        return null;
    }
    matchesFull(selector) {
        const parts=selector.trim().split(/\s+/);
        let node=this;
        if(!node.matches(parts.pop())) return false;
        while(parts.length) {
            const part=parts.pop();
            node=node.parentElement;
            while(node && !node.matches(part)) node=node.parentElement;
            if(!node) return false;
        }
        return true;
    }
    querySelectorAll(selector) {
        const result=[], visit=node=>{
            for(const child of node.children) {
                if(selector.split(',').some(s=>child.matchesFull(s))) result.push(child);
                visit(child);
            }
        };
        visit(this);
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
    getBoundingClientRect() { return {...this.rect,bottom:this.rect.bottom ?? this.rect.top+this.rect.height}; }
    getAttribute(name) { return this.attrs[name]||null; }
}
function blank(top, cls='cloze-q', visible=true) {
    return new FakeElement('span',cls,{top,width:80,height:visible?18:0});
}
function fixture(type, contextCount=2, nested=false) {
    const q=new FakeElement('section','text-area',{top:0,width:380,height:800});
    const list=q.append(new FakeElement('ul','children-list'));
    for(let i=0;i<contextCount;i++) {
        const li=list.append(new FakeElement('li','children sibling-block'));
        const div=li.append(new FakeElement('div'));
        div.append(new FakeElement('span','cloze-wrapper')).append(blank(50+i*22));
    }
    let group=list;
    if(nested) group=list.append(new FakeElement('li','children active-block')).append(new FakeElement('ul'));
    const owner=group.append(new FakeElement('li',type==='card'?'children mk-card-current':'children active-block'));
    const line=owner.append(new FakeElement('div','problem-line',{top:360,width:320,height:22}));
    let target;
    if(type==='card') {
        owner.append(new FakeElement('ul','mk-card-original-answer',{top:420,width:300,height:0}))
            .append(blank(450,'cloze-q',false));
        target=line;
    } else {
        const cls=type==='arrow'?'cloze-wrapper mk-arrow-target mk-arrow-card':
            type==='cs'?'mk-cs-wrapper mk-cs-target':'cloze-wrapper';
        target=line.append(new FakeElement('span',cls)).append(blank(370,type==='cs'?'mk-cs-mask':'cloze-q'));
    }
    return {q,owner,target};
}

const frames=[],events={},scrolls=[];
let question=null, card=null;
const answer=new FakeElement('section','',{top:0,width:400,height:0});
const scroller=new FakeElement('div','',{top:0,width:380,height:700});
const state={
    document:{
        getElementById:id=>id==='question-section'?question:id==='answer-section'?answer:id==='scroll-area'?scroller:null,
        addEventListener:(type,listener)=>{events[type]=listener;}
    },
    activeDeck:[],currentIndex:0,mkOrdinaryCardContextRenderToken:1,
    isMkCSCardFast:c=>c?.type==='cs',
    isMkArrowCard:c=>c?.type==='arrow',
    isMkImageOcclusionCardFast:c=>c?.type==='io',
    isVisibleRect:rect=>rect&&rect.width>0&&rect.height>0,
    requestAnimationFrame:callback=>frames.push(callback),
    setTimeout:callback=>frames.push(callback),
    scrollElementToProblemPosition:(element,options)=>{
        if(!element)return false;
        scrolls.push({element,options});
        return true;
    },console
};
const api=new Function('env','with(env){'+focusCode+
    '\nreturn {get:getMkCurrentProblemScrollTarget, schedule:mkScheduleInitialProblemFocus};}')(state);
let checked=0;
for(const type of ['ordinary','arrow','cs','card']) {
    const fixtureItem=fixture(type);
    question=fixtureItem.q;card={id:type,type,isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),fixtureItem.target,type+' target must ignore contextual blanks');
    checked++;
}
for(const count of [25,120]) {
    const item=fixture('ordinary',count,true);
    question=item.q;card={id:'nested'+count,type:'ordinary',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,count+' preceding clozes must not hijack focus');
    checked++;
}
{
    const item=fixture('ordinary');
    question=item.q;card={id:'current',type:'ordinary'};state.activeDeck=[card];
    scrolls.length=0;frames.length=0;
    api.schedule(card,item.q,1);
    while(frames.length) frames.shift()();
    assert.equal(scrolls.length,1);
    assert.equal(scrolls[0].element,item.target);
    checked++;
}
{
    const item=fixture('ordinary');
    question=item.q;card={id:'old',type:'ordinary'};state.activeDeck=[card];
    scrolls.length=0;frames.length=0;
    api.schedule(card,item.q,1);
    state.activeDeck=[{id:'new',type:'ordinary'}];
    while(frames.length) frames.shift()();
    assert.equal(scrolls.length,0,'stale callback must not scroll the next card');
    checked++;
}
{
    const item=fixture('ordinary');
    question=item.q;card={id:'wheel',type:'ordinary'};state.activeDeck=[card];
    scrolls.length=0;frames.length=0;
    api.schedule(card,item.q,1);
    events.wheel();
    while(frames.length) frames.shift()();
    assert.equal(scrolls.length,0,'manual wheel must cancel automatic focus');
    checked++;
}
{
    // A delayed sibling source or table layout can push the current question
    // beyond the viewport after the initial successful auto-focus.
    const item=fixture('ordinary');
    question=item.q;card={id:'late-layout',type:'ordinary'};state.activeDeck=[card];
    scrolls.length=0;frames.length=0;
    item.target.rect={top:360,width:80,height:18};
    api.schedule(card,item.q,1);
    frames.shift()();frames.shift()(); // 2 RAF: first successful scroll
    assert.equal(scrolls.length,1);
    item.target.rect={top:900,width:80,height:18};
    frames.shift()(); // 180ms verification
    assert.equal(scrolls.length,2,'late off-screen focus must be restored');
    checked++;
}
// Multiple formats and long contextual lists can contain earlier blanks
// that look exactly like valid targets; the exported active LI must win.
{
    const item=fixture('arrow',18,true);
    const context=item.q.querySelector('li.sibling-block .cloze-wrapper');
    context.classes.add('mk-arrow-card');
    context.classes.add('mk-arrow-target');
    question=item.q;card={id:'arrow-context-rogue',type:'arrow',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,'active arrow outranks earlier contextual arrow marker');
    checked++;
}
{
    const item=fixture('cs',18,true);
    const context=item.q.querySelector('li.sibling-block .cloze-wrapper');
    context.classes.add('mk-cs-wrapper');
    context.classes.add('mk-cs-target');
    question=item.q;card={id:'cs-context-rogue',type:'cs',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,'active CS outranks earlier contextual CS marker');
    checked++;
}
{
    const item=fixture('ordinary',60,true);
    question=item.q;card={id:'mixed-long-context',type:'ordinary',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,'nested active cloze wins over 60 earlier blank rows');
    checked++;
}
{
    const item=fixture('arrow',3);
    const wrapper=item.target.parentElement;
    const hiddenAnswer=new FakeElement('span','cloze-a',{top:368,width:100,height:18});
    hiddenAnswer.parentElement=wrapper;
    wrapper.children.unshift(hiddenAnswer);
    question=item.q;card={id:'answer-before-mask',type:'arrow',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,'prefer question mask over answer even when answer precedes it');
    checked++;
}
{
    const item=fixture('cs',5);
    item.owner.classes.delete('active-block');
    question=item.q;card={id:'cs-no-active-marker',type:'cs',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,'fallback to typed CS target when active marker is missing');
    checked++;
}
{
    const item=fixture('arrow',5);
    item.owner.classes.delete('active-block');
    question=item.q;card={id:'arrow-no-active-marker',type:'arrow',isLogseq:true};state.activeDeck=[card];
    assert.equal(api.get(),item.target,'fallback to typed arrow target when active marker is missing');
    checked++;
}
// Entire flattened source is audited below. The tests above exercise the
// semantic selection that raw source markup inspection alone cannot verify.
// Full repository-source structural inventory. This checks the original focus
// markers; it is not a replacement for opening every card in a real browser.
let rows=0;
for(const name of ['소방학개론.txt','소방관계법규.txt']) {
    const file=path.join(root,name);
    if(!fs.existsSync(file)) continue;
    const lines=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);
    for(const line of lines) {
        if(line.split('\t').length < 4) continue;
        rows++;
        assert(/<li\b[^>]*\bactive-block\b/i.test(line),
            name+' original source card '+rows+' has no active LI');
    }
}
console.log('OK: '+checked+' focus regression scenarios, '+rows+' original source rows structurally audited.');
