// 撃破バナーの検査。
//
// なぜ要るか: このバナーは main.js から呼ばれていたのに HUD側に実体が無く、
// 呼ぶたびに例外で落ちていた（tools/check-calls.mjs はその再発を止める）。
// 実体を書いた後も、連続撃破の数え方とヘッドショットの札は分岐があるので、
// 画面を見ないと合っているか分からない場所が残る。そこをここで潰す。
//
// DOMは自前の偽物を使う。dom-stub.js の getElementById は null を返す作りで、
// HUDが「部品が無いので何もしない」経路に落ちてしまい検査にならない。
//
//   node tools/check-hud.mjs

/* ------------------------------------------------ 最小限の偽DOM */

const mkEl = (id) => {
  const classes = new Set();
  return {
    id,
    textContent: '',
    innerHTML: '',
    style: {},
    offsetWidth: 100,
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    appendChild(c) { this.children.push(c); c._parent = this; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    remove() {
      const p = this._parent;
      if (p) p.children.splice(p.children.indexOf(this), 1);
    },
    querySelectorAll: () => [],
  };
};

const els = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, mkEl(id));
    return els.get(id);
  },
  createElement: () => mkEl('new'),
  querySelectorAll: () => [],
};
// 時刻は自分で進める。実時間に頼ると5秒待たないと連続の切れ目を試せない
let clock = 10_000;
globalThis.performance = { now: () => clock };
globalThis.window = globalThis.window || {};

const { HUD } = await import('../src/ui/hud.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const hud = new HUD();
const elim = document.getElementById('elim');
const name = document.getElementById('elimName');
const tag = document.getElementById('elimTag');

console.log('\n[1] 1回倒した時');
hud.elim('nana', false);
ok(name.textContent === 'nana', `相手の名前が出る (${name.textContent})`);
ok(tag.textContent === '', `1回目に連続の札は出ない (${tag.textContent || 'なし'})`);
ok(elim._classes.has('on'), '出す動きが始まっている');
ok(!elim._classes.has('head'), '胴体なので青くならない');

console.log('\n[2] 頭に当てて倒した時');
clock += 60_000;
hud.elim('nana', true);
ok(elim._classes.has('head'), '青へ振れる');
ok(tag.textContent === '頭部', `頭部の札が出る (${tag.textContent})`);

console.log('\n[3] 続けて倒した時');
clock += 1200;
hud.elim('nana', false);
ok(tag.textContent === '2連続', `2連続と出る (${tag.textContent})`);
clock += 1200;
hud.elim('nana', false);
ok(tag.textContent === '3連続', `3連続と出る (${tag.textContent})`);
ok(!elim._classes.has('head'), '胴体で倒したら青が外れる');

console.log('\n[4] 間が空いた時');
clock += 5001;
hud.elim('nana', false);
ok(tag.textContent === '', `5秒空いたら数え直す (${tag.textContent || 'なし'})`);

console.log('\n[5] 名前が無い場合と、名前にタグが混ざっている場合');
clock += 60_000;
hud.elim('', false);
ok(name.textContent === '', '1人用で名前が空でも落ちない');
hud.elim('<img src=x onerror=alert(1)>', false);
ok(name.textContent.includes('<img'), 'textContentで入れるのでタグとして解釈されない');

/* ------------------------------------------------------------ 包帯の表示 */

// 包帯は「Fで手に持つ→左クリックで巻く」の2段階なので、今どちらなのかが
// 画面から読めないと手が止まる。
// 前は残数と操作の案内を右下の武器の行に、進み具合を左下の体力の下に置いていて、
// 巻いている最中に画面の左右を交互に見ることになっていた。
// さらに文言が「F 包帯 2」と「左クリックで巻く」で幅が変わり、
// そのたびに武器の行ごと横へ動いていた
const wrap = document.getElementById('healWrap');
const state = document.getElementById('healState');
const pips = document.getElementById('healPips');
const slot = document.getElementById('slotHeal');
const fill = document.getElementById('healFill');

console.log('\n[6] 包帯 … 持っていない時');
hud.bandage(2, 0, 2.4, false, 2);
ok(state.textContent === 'F 包帯', `Fで出せると分かる (${state.textContent})`);
ok(pips.children.length === 2, `玉が持てる数だけ並ぶ (${pips.children.length}個)`);
ok(pips.children.every((p) => p._classes.has('on')), '2本とも点いている');
ok(!wrap._classes.has('out') && !wrap._classes.has('busy'), '光らせない');

console.log('\n[7] 包帯 … 手に持っている時');
// 右下の札はindex.htmlに書いた文字のまま動かないこと。
// 印を入れておいて、HUDが書き換えないかを見る（偽DOMには元の文字が無いので、
// 「◯◯という文字であること」ではなく「触っていないこと」で確かめる）
slot.textContent = '＜index.htmlの文字＞';
hud.bandage(2, 0, 2.4, true, 2);
ok(state.textContent === '左クリックで巻く', `次に何をするか出る (${state.textContent})`);
ok(wrap._classes.has('out'), '持っている印が付く');
ok(slot.textContent === '＜index.htmlの文字＞', '右下の札の文言を書き換えない');
ok(slot._classes.has('busy'), '色だけ変える');

console.log('\n[8] 包帯 … 巻いている時');
hud.bandage(2, 1.2, 2.4, true, 2);
ok(state.textContent === '巻いている', `巻いていると出る (${state.textContent})`);
ok(wrap._classes.has('busy') && !wrap._classes.has('out'), '巻いている印に切り替わる');
ok(fill.style.width === '50%', `進み具合が半分 (${fill.style.width})`);
hud.bandage(2, 0.24, 2.4, true, 2);
ok(fill.style.width === '90%', `進み具合が伸びる (${fill.style.width})`);

console.log('\n[9] 包帯 … 使い切った時');
hud.bandage(0, 0, 2.4, false, 2);
ok(wrap._classes.has('none'), '使えない印が付く');
ok(pips.children.every((p) => !p._classes.has('on')), '玉が全部消える');

console.log('\n[10] 包帯 … 持てる数が変わっても玉が合う');
hud.bandage(3, 0, 2.4, false, 4);
ok(pips.children.length === 4, `玉が4つになる (${pips.children.length}個)`);
ok(pips.children.filter((p) => p._classes.has('on')).length === 3, '点いているのは3つ');
hud.bandage(1, 0, 2.4, false, 2);
ok(pips.children.length === 2, `玉が2つに戻る (${pips.children.length}個)`);

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
