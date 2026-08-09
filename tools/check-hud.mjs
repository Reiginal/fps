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

import { readFileSync } from 'node:fs';

/* ------------------------------------------------ 最小限の偽DOM */

const mkEl = (id) => {
  const classes = new Set();
  return {
    id,
    textContent: '',
    _html: '',
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
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    /* 名札(nameplates)はinnerHTMLで部品を組んでfirstChild/lastChildで掴むので、
       divの入れ子だけ読める最小の解釈を持つ。本物のDOMの代わりではなく、
       この検査で使う形が通るだけの物 */
    set innerHTML(v) {
      this._html = String(v || '');
      this.children.length = 0;
      const stack = [this];
      for (const m of this._html.matchAll(/<div class="([^"]+)">|<\/div>/g)) {
        if (m[0] === '</div>') { if (stack.length > 1) stack.pop(); continue; }
        const el = mkEl(m[1]);
        stack[stack.length - 1].appendChild(el);
        stack.push(el);
      }
    },
    get innerHTML() { return this._html; },
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

console.log('\n[11] 武器の札 … 数が変わる');
/* 札はもう固定の4枚ではない。ガンゲームは今の段の1本しか持たないので1枚になる。
   手榴弾を投げ切った時は**枚数を変えずに薄くする**（消すと後ろの番号が繰り上がって、
   押し慣れた数字と出てくる武器が変わってしまう）。
   数字キーに載らない武器（Qの狙撃銃）はこの行には入らない（下の[11.5]） */
{
  const box = document.getElementById('slots');
  const h3 = new HUD();
  const items = (...names) => names.map((n) => ({ name: n, out: false }));

  h3.weaponSlots(items('ライフル', 'ピストル', 'ナイフ', '手榴弾'));
  ok(box.children.length === 4, `4枚組み上がる (${box.children.length}枚)`);
  ok(box.children[0].textContent === '1 ライフル', `番号が付く (${box.children[0].textContent})`);
  ok(box.children[3].textContent === '4 手榴弾', `4枚目まで付く (${box.children[3].textContent})`);

  // 持ち替えると印が動く
  h3.ammo(30, 90, 'MK-4 カービン', 0, 0, false);
  ok(box.children[0]._classes.has('on'), '1枚目に印が付く');
  h3.ammo(15, 75, 'P-9 サイドアーム', 1, 0, false);
  ok(!box.children[0]._classes.has('on') && box.children[1]._classes.has('on'), '印が2枚目へ移る');

  // 使い切った札は薄くする（枚数は変えない）
  const withOut = items('ライフル', 'ピストル', 'ナイフ', '手榴弾');
  withOut[3].out = true;
  h3.weaponSlots(withOut);
  ok(box.children.length === 4, '薄くしても枚数は変わらない');
  ok(box.children[3]._classes.has('out'), '手榴弾の札が薄くなる');
  ok(box.children[3].textContent === '4 手榴弾', '番号も文字もそのまま');

  // 減る（ガンゲームは1本だけ）
  h3.weaponSlots(items('ライフル'));
  ok(box.children.length === 1, `1枚まで減らせる (${box.children.length}枚)`);
}

console.log('\n[11.5] Qの札 … 2行目（包帯と同じ行）');
/* 番号の続きに並べると「5」に見えるのに5では出ない、という嘘になるので、
   数字キーに載らない武器は行を分けてある。支給されるまでは畳んでおく */
{
  const el = document.getElementById('slotQuick');
  const h4 = new HUD();

  h4.quickSlot(null, false);
  ok(el._classes.has('hide'), '支給される前は畳んである');

  h4.quickSlot('スナイパー', false);
  ok(!el._classes.has('hide'), '支給されると出る');
  ok(el.textContent === 'Q スナイパー', `押すキーが名前に付く (${el.textContent})`);
  ok(!el._classes.has('on'), '持っていなければ印は付かない');

  h4.quickSlot('スナイパー', true);
  ok(el._classes.has('on'), '持つと印が付く');

  // 1行目の札とは別扱い。Qの武器を持っている間は1行目のどれも光らない
  const box = document.getElementById('slots');
  h4.weaponSlots(['ライフル', 'ピストル'].map((n) => ({ name: n, out: false })));
  h4.ammo(5, 5, 'SR-12 マークスマン', -1, 0, false);
  ok(![...box.children].some((c) => c._classes.has('on')), '1行目の印は全部消える');

  h4.quickSlot(null, false);
  ok(el._classes.has('hide'), '出撃し直すとまた畳む');
}

console.log('\n[軽さ] 毎フレームの無駄をしていない');
/* **遊ぶ人のPCが熱くなったら、その時点で他が全部どうでもよくなる。**
   HUDは毎フレーム呼ばれるので、ここでの「同じ値をもう一度書く」がそのまま
   熱に変わる。同じ値で呼んでも2度目からは触らないこと */
{
  const el = (id) => document.getElementById(id);
  const writes = (o, key) => {
    let n = 0;
    let v = o[key];
    Object.defineProperty(o, key, {
      configurable: true,
      get() { return v; },
      set(x) { n++; v = x; },
    });
    return () => n;
  };

  // 弾数の欄。同じ弾数で何度呼んでも、書くのは1回だけ
  {
    const h2 = new HUD();
    const count = writes(el('reserve'), 'textContent');
    for (let i = 0; i < 10; i++) h2.ammo(30, 240, 'ライフル', 0, 0, false);
    ok(count() <= 1, `予備弾は変わった時だけ書く（10回呼んで${count()}回）`);
    h2.ammo(30, 200, 'ライフル', 0, 0, false);
    ok(count() === 2, `変わった時はちゃんと書く（${count()}回）`);
  }

  // 走っている印
  {
    const h2 = new HUD();
    const count = writes(el('speedlines').style, 'opacity');
    for (let i = 0; i < 10; i++) h2.sprinting(true);
    ok(count() <= 1, `走りの印も変わった時だけ（10回呼んで${count()}回）`);
  }

  // 順位表。Tabを押している間、中身を毎フレーム作り直さない
  {
    const h2 = new HUD();
    const count = writes(el('sbRows'), 'innerHTML');
    const rows = [{ id: 1, name: 'あき', rounds: 1, kills: 2, deaths: 0, ping: 20, me: true }];
    for (let i = 0; i < 10; i++) h2.scoreboard(rows, true);
    ok(count() <= 1, `押しっぱなしでも作り直さない（10回呼んで${count()}回）`);
    h2.scoreboard([{ ...rows[0], kills: 3 }], true);
    ok(count() === 2, '点が動いたら作り直す');
  }

  // 武器の札。持ち物が変わっていない限り、DOMには指1本触れない。
  // ここは毎フレーム呼ばれる（main.jsの_weaponSlotsHud）ので、
  // 作り直すと1秒に60回divを捨てて作り直すことになる
  {
    const h2 = new HUD();
    const box = el('slots');
    const items = ['ライフル', 'ピストル', 'ナイフ', '手榴弾'].map((n) => ({ name: n, out: false }));
    h2.weaponSlots(items);
    const count = writes(box.children[0], 'textContent');
    for (let i = 0; i < 10; i++) h2.weaponSlots(items);
    ok(count() === 0, `同じ持ち物なら10回呼んでも書かない（${count()}回）`);
    h2.weaponSlots([...items, { name: 'スナイパー', out: false }]);
    ok(count() >= 0 && box.children.length === 5, '増えた時はちゃんと組み直す');
  }

  // 地図。**毎フレーム塗り直さない**（塗るたびに絵を画面へ送り直すことになる）
  {
    const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    ok(/const MAP_HZ = \d+;/.test(main), '地図を塗る回数が決めてある');
    const hz = Number(main.match(/const MAP_HZ = (\d+);/)?.[1]);
    ok(hz > 0 && hz <= 30, `毎秒${hz}回（60回だと毎フレームと同じ）`);
    ok(/_mapAcc[\s\S]{0,120}?1 \/ MAP_HZ/.test(main), 'その回数で間引いている');
    ok(/_mapAcc[\s\S]{0,200}?hud\.minimap/.test(main), '間引いた後で塗っている');
  }
}

console.log('\n[軽さ・名札] 相手の頭上の名札も、変わった時だけ書く');
/* 対戦で一番数が多いHUD。前は1人につき毎フレーム10個のstyleを無条件に書き、
   位置がleft/topだったので書くたびに配置のやり直し(reflow)まで走っていた。
   位置はtransformへ移し、全部を前回値と比べてから書く */
{
  const h2 = new HUD();
  const mk = (hp) => [{ id: 7, x: 320, y: 180, name: 'nana', hp, dist: 20, fade: 1, mate: false }];
  h2.nameplates(mk(100));
  const root = document.getElementById('plates').lastChild;
  ok(!!root && root.children.length === 2, '札が組み上がる（名前とバー）');
  ok(typeof root.style.transform === 'string' && root.style.transform.includes('320px'),
    `位置がtransformで入る（${root.style.transform}）`);
  ok(!('left' in root.style) && !('top' in root.style),
    '配置のやり直しが走るleft/topを使っていない');

  // ここからstyleへの書き込みを数える
  const count = { n: 0 };
  const watch = (el) => {
    el.style = new Proxy(el.style, {
      set(o, k, v) { count.n++; o[k] = v; return true; },
    });
  };
  watch(root); watch(root.lastChild); watch(root.lastChild.firstChild);
  for (let i = 0; i < 10; i++) h2.nameplates(mk(100));
  ok(count.n === 0, `同じ状態なら10回呼んでも書かない（${count.n}回）`);
  h2.nameplates(mk(50));
  ok(count.n > 0, `体力が動いたら書く（${count.n}回）`);
}

console.log('\n[計測窓] ?debugの数字窓が、測る側なのに重さを増やしていない');
/* 重さを測るための窓が毎フレームDOMへ書いたら本末転倒
   （「測る仕掛けが測られる物を重くしていた」を過去に実際に踏んでいる）。
   更新は毎秒4回まで、しかも文字が変わった時だけ書くこと */
{
  const { PerfMeter } = await import('../src/ui/perfmeter.js');
  const el = mkEl('perfMeter');
  let writes = 0;
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { writes++; text = v; },
  });
  const meter = new PerfMeter(el);
  // 60fps相当で10フレーム（0.17秒）。まだ更新間隔(0.25秒)に届かない
  for (let i = 0; i < 10; i++) meter.frame(1 / 60, 544, 198000, 1);
  ok(writes === 0, `間隔が来るまで書かない（10フレームで${writes}回）`);
  // さらに10フレームで0.33秒。1回だけ書く
  for (let i = 0; i < 10; i++) meter.frame(1 / 60, 544, 198000, 1);
  ok(writes === 1, `間隔が来たら書く（${writes}回）`);
  ok(text.includes('fps') && text.includes('544'), `fpsと描画命令が読める（${text}）`);
  // 同じ数字が続く限り、間隔が何度来てももう書かない
  for (let i = 0; i < 120; i++) meter.frame(1 / 60, 544, 198000, 1);
  ok(writes === 1, `同じ数字なら書き直さない（2秒回して${writes}回のまま）`);
  // 数字が動いたら書く
  for (let i = 0; i < 20; i++) meter.frame(1 / 60, 300, 100000, 1);
  ok(writes === 2, `数字が動いたら書く（${writes}回）`);
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
