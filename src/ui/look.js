// スキン変更とストアの画面。武器ごとにスキンを着ける所と、買う所。
//
// **選んだ物が見えないと選べない。** 色の名前を並べるだけでは
// 「デザート」がどんな色なのか分からないので、実物の銃を3Dで出して回す。
// ロビーの兵士のプレビュー（src/ui/charview.js）と同じ作りで、
// あちらの「描くのは開いている間だけ」も踏襲する
// （閉じた後も描き続けると、ホームに居るだけでパソコンが熱くなる）。
//
// **入口はホームに2つ（スキン変更・ストア）、画面と3Dの場面は1つ。**
// やることが違うので入口は分けるが、見せる物が「持っている物」か
// 「売り物」かの違いしかないので、画面まで2枚にすると
// 3Dの場面を2つ持つことになる（そのぶん重い）。
// 開く時にどちらの面かを渡して、開いた後は行き来しない。
//
// **持っていない物は着けられない。** 画面でも押せなくしてあるが、
// あれは親切であって守りではない（守るのはサーバー側のserver/store.js）。
import * as THREE from 'three';
import { WEAPONS } from '../player/weapons.js';
import {
  SKINS, skinAt, applySkin, shapeFor, paintFor, hasSkin, wearSkin,
  setOwned, ownedSkus, shapeOf,
} from '../player/skins.js';
import {
  SKINNABLE, DEFAULT_SKIN, skuOf, itemsFor, slotOf,
} from '../net/protocol.js';

const $ = (id) => document.getElementById(id);

/* 返事を待つ間の上限。返らないサーバーを待ち続けると
   押した本人には「固まった」としか見えない（account.jsと同じ） */
const TIMEOUT_MS = 15_000;

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return { off: true };
  let json = null;
  try { json = await res.json(); } catch { /* 中身が無い返事もある */ }
  return { status: res.status, ...(json || {}) };
}

export class LookMenu {
  constructor() {
    this.el = {
      root: $('look'),
      canvas: $('lkView'),
      title: $('lkTitle'), sub: $('lkSub'),
      guns: $('lkGuns'),
      list: $('lkList'),
      shapes: $('lkShapes'), shapeRow: $('lkShapeRow'), paintName: $('lkPaintName'),
      name: $('lkName'), note: $('lkNote'), help: $('lkHelp'),
      status: $('lkStatus'), coins: $('lkCoins'),
      close: $('lkClose'),
    };
    this.ready = false;
    this.running = false;
    this.store = false;          // 今ストアの面か
    this.weapon = SKINNABLE[0];  // 今見ている武器
    this.busy = false;
    /** ログインしているか。ストアはログインしていないと使えない */
    this.user = null;
    /** 装備を変えた時に呼ぶ。今持っている銃へ掛け直すのは呼ぶ側の仕事 */
    this.onChange = () => {};
    /* 買えた時に呼ぶ。**この画面は音を知らない。**
       AudioEngineを直に持たせると、スキンの画面を出すだけで音の一式が要る */
    this.onBought = () => {};

    this._buildGuns();
    this.el.close.onclick = () => this.hide();
  }

  /** 会員証の状態が変わったら呼ばれる（main.jsが繋ぐ） */
  setUser(user) {
    this.user = user;
    if (this.isOpen) this._paint();
  }

  /* 3Dの道具は初めて開いた時に作る。起動時に作ると、
     一度も開かない人まで組み立てを待つことになる（charview.jsと同じ） */
  _init() {
    if (this.ready) return;
    this.ready = true;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.el.canvas, antialias: true, alpha: true,
    });
    // 小さい絵なので2倍で足りる。端末の画素密度をそのまま使うと4倍描くことになる
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.el.canvas.width, this.el.canvas.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      32, this.el.canvas.width / this.el.canvas.height, 0.05, 10,
    );
    this.camera.position.set(0, 0.06, 1.05);
    this.camera.lookAt(0, 0, 0);

    /* 光は3灯。銃は金属の面が多いので、正面1灯だと
       陰影が付かず「黒い板」に見える。斜め後ろから縁を出す1灯が効く */
    const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
    key.position.set(1.2, 1.4, 1.6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 1.0);
    fill.position.set(-1.6, 0.4, 0.8);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 1.4);
    rim.position.set(-0.6, 0.8, -1.6);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x6d7d92, 1.2));

    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    /* 組んだ銃の置き場。**一度組んだら使い回す。**
       武器のタブを押すたびに組み直すと、押すたびに引っかかる */
    this.guns = new Map();
    this._spin = 0;
    this._showGun();
  }

  /* 見せる銃を差し替える。**本番と同じ組み立てを使う。**
     見せるためだけの別モデルを作ると、選んだ物と実際に出る物がずれる。

     **形違いは組み立てが別なので、形ごとに1つ持つ。**
     鍵を「武器＋形」にしてあるのはそのため。色だけなら同じ物を塗り替える */
  _showGun() {
    for (const g of this.guns.values()) g.visible = false;
    const def = WEAPONS.find((w) => w.id === this.weapon);
    if (!def) return;
    const { shape, paint } = this._look();
    const build = shapeOf(shape) || def.build;
    const key = `${this.weapon}:${build === def.build ? '-' : shape}`;

    let g = this.guns.get(key);
    if (!g) {
      g = build(def.view);
      // 手は消す。ここで見たいのは銃であって、握り方ではない
      g.traverse((o) => { if (o.userData?.isHand) o.visible = false; });
      // 銃は原点が機関部あたりにあるので、少し引いて枠へ収める
      g.position.set(0, 0, 0.06);
      this.holder.add(g);
      this.guns.set(key, g);
    }
    g.visible = true;
    this.gun = g;
    // 色を選んでいなければ、その形が持っている色で塗る（金色の刀 / 素の刀）
    applySkin(g, paint === DEFAULT_SKIN ? shape : paint);
  }

  /**
   * 今プレビューに出す組み合わせ。**枠が2つあるので対で返す。**
   *
   * 試着(preview)は、その物が入る枠だけを差し替える。
   * ここを1つの値にしていた頃は、刀を着けている人がゴールドを試着すると
   * **刀が消えて普通のナイフが金色になっていた**（遊んで指摘された所）。
   * 枠で分ければ、着けている刀の上に色が乗って「金色の刀」が見える
   */
  _look() {
    const slot = this.preview ? slotOf(this.preview) : null;
    return {
      shape: slot === 'shape' ? this.preview : shapeFor(this.weapon),
      paint: slot === 'paint' ? this.preview : paintFor(this.weapon),
    };
  }

  _buildGuns() {
    this.el.guns.innerHTML = '';
    this.gunBtns = SKINNABLE.map((id) => {
      const def = WEAPONS.find((w) => w.id === id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lkgun';
      b.textContent = def?.nick || id;
      b.onclick = () => this.selectWeapon(id);
      this.el.guns.appendChild(b);
      return b;
    });
  }

  selectWeapon(id) {
    if (!SKINNABLE.includes(id)) return;
    this.weapon = id;
    this.preview = null;
    if (this.ready) this._showGun();
    this._paint();
  }

  /* どちらの面で開くか。**入口はホームに2つあり、開いた後は行き来しない。**
     着け替えに来た人を買い物の画面へ通さない（逆も同じ） */
  _setTab(store) {
    this.store = !!store;
    this.preview = null;
    this.el.title.textContent = this.store ? 'ストア' : 'スキン変更';
    this.el.sub.textContent = this.store ? 'コインで武器のスキンを買う' : '武器の見た目を選ぶ';
    if (this.ready) this._showGun();
    this._say('');
    this._paint();
  }

  /* 画面を全部描き直す。**ここだけが「今どうなっているか」を描く。**
     押した時に個別に書き換える形にすると、必ずどこかで食い違う */
  _paint() {
    const { list, coins } = this.el;
    this.gunBtns.forEach((b, i) => b.classList.toggle('on', SKINNABLE[i] === this.weapon));
    // 残高はストアの時だけ。着け替えるだけの時に見せる意味が無い
    coins.textContent = !this.store ? ''
      : (this.user
        ? `コイン ${Number(this.user.coins ?? 0).toLocaleString()}枚`
        : 'ログインすると買えます');

    /* **その武器で扱える物だけを並べる。**
       色は全武器で売っているが、形（刀・ダガー）はその武器専用なので、
       全部のスキンをなめると「ライフルの刀」が並んでしまう */
    const sell = itemsFor(this.weapon).map((it) => ({ ...skinAt(it.id), ...it }));
    const now = this._look();
    // 標準はどちらの枠にも要る（形を元へ戻す／色を外す）。買う物ではないので売らない
    const back = { ...skinAt(DEFAULT_SKIN), price: 0 };
    const shapes = sell.filter((s) => s.kind === 'shape');
    const paints = sell.filter((s) => s.kind !== 'shape');

    /* **形を持たない武器では、形の列ごと隠す。**
       選べる物が標準1つだけの列を出しても、何ができるのか分からない */
    this.el.shapeRow.classList.toggle('hidden', shapes.length === 0);
    if (shapes.length) this._row(this.el.shapes, [back, ...shapes], 'shape', now.shape);
    this._row(list, [back, ...paints], 'paint', now.paint);
    this.el.paintName.textContent = shapes.length ? '色' : 'スキン';

    /* 印の読み方。**印だけ置いても意味は伝わらない**
       （遊んで「左右のマークがなんなのか謎」と言われた）。
       形違いが1つも並んでいない時に「形」の説明を出しても邪魔なので、
       並んでいる物に合わせて出し分ける */
    this.el.help.innerHTML = '<span class="sw"></span> その武器がこの色になる'
      + (shapes.length ? '　／　<b>形</b> 色だけでなく形も変わる。'
        + '**形と色は別々に着けられる**（刀を金色に、など）' : '');

    // 名前と説明は、今プレビューに出ている物。形が標準なら色の方を出す
    const lead = now.shape !== DEFAULT_SKIN ? now.shape : now.paint;
    const s = SKINS.find((x) => x.id === lead) || SKINS[0];
    this.el.name.textContent = now.shape !== DEFAULT_SKIN && now.paint !== DEFAULT_SKIN
      ? `${skinAt(now.shape).name} / ${skinAt(now.paint).name}`
      : s.name;
    this.el.note.textContent = s.note;
  }

  /**
   * 枠1つぶんを並べる。
   *
   * **ストアでも持っている物を隠さない。** 前は買った物が消える形だったので、
   * 買うほど品揃えが減って寂しくなるうえ、「刀を持っているのに刀が見当たらない」
   * になっていた（遊んで「それぞれのスキンが見えるべき」と言われた所）。
   * 持っている物には「所持」と出して、押したら試着になる
   */
  _row(box, items, slot, current) {
    box.innerHTML = '';
    for (const s of items) {
      const have = hasSkin(this.weapon, s.id);
      // 装備の面には、持っている物だけ（買う画面ではないので値段も出さない）
      if (!this.store && !have) continue;

      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lkitem';
      if (s.id === current) b.classList.add('on');
      /* 形違いは色違いと値打ちが違うので、一目で分かる印を付ける。
         印の意味は下の1行(lkHelp)で説明する。**印だけでは伝わらない** */
      b.innerHTML = `<span class="sw" style="background:${s.swatch}" title="この色になる"></span>`
        + `<span class="nm">${s.name}</span>`
        + (s.kind === 'shape' ? '<span class="kd" title="形そのものが変わる">形</span>' : '')
        + (!this.store ? ''
          : (have || s.id === DEFAULT_SKIN)
            ? '<span class="ow">所持</span>'
            : `<span class="pr">${(s.price || 0).toLocaleString()}</span>`);
      /* 持っている物をストアで押した時は試着だけ。**着け替えはしない。**
         入口が2つに分かれているので、買いに来た人を着せ替えの動きへ通さない */
      b.onclick = () => {
        if (!this.store) { this._wear(s.id, slot); return; }
        if (have || s.id === DEFAULT_SKIN) { this._try(s); return; }
        this._buy(s);
      };
      box.appendChild(b);
    }

    if (!box.children.length) {
      const p = document.createElement('div');
      p.className = 'lkempty';
      // 行き先を書いておく。入口が分かれているので、ここから飛べない
      p.textContent = '持っているスキンがありません。ホームのストアで買えます';
      box.appendChild(p);
    }
  }

  /** 試着だけ。買わないし着けもしない（ストアで持っている物を押した時） */
  _try(s) {
    this.preview = this.preview === s.id ? null : s.id;
    this._showGun();
    this._paint();
    this._say('');
  }

  _say(text, bad = false) {
    this.el.status.textContent = text || '';
    this.el.status.classList.toggle('bad', !!bad);
  }

  /**
   * 装備する。**その場で決まる。**「決定」を押させると押し忘れる人が出る。
   *
   * @param slot どちらの枠か。**明示して送る。** idから割り出す形にすると、
   *   標準(stock)がどちらの枠にも属さないので「形を元へ戻す」が送れない
   */
  async _wear(id, slot) {
    if (this.busy) return;
    if (!wearSkin(this.weapon, id, slot)) { this._say('持っていません', true); return; }
    this.preview = null;
    this._showGun();
    this._paint();
    this.onChange();
    // ログインしていれば台帳にも覚えさせる。していなければこの端末だけ
    if (!this.user) return;
    try {
      await api('/api/equip', { weapon: this.weapon, slot, skin: id });
    } catch { /* 手元は変わっている */ }
  }

  async _buy(s) {
    if (this.busy) return;
    if (!this.user) { this._say('買うにはログインしてください', true); return; }

    /* 1回目は試着。**押した瞬間に買わない。**
       値段だけ見て押した人が、確かめる間もなく買わされるのは避ける */
    if (this.preview !== s.id) {
      this.preview = s.id;
      this._showGun();
      this._paint();
      this._say(`${s.name} … もう一度押すと${s.price.toLocaleString()}コインで買います`);
      return;
    }

    this.busy = true;
    this._say('買っています…');
    let r;
    try {
      r = await api('/api/buy', { sku: skuOf(this.weapon, s.id) });
    } catch {
      this.busy = false;
      this._say('サーバーに繋がりません。少し待ってからもう一度', true);
      return;
    }
    this.busy = false;
    if (r.off) { this._say('この置き場では買えません', true); return; }
    // 文言はサーバーが作った物をそのまま出す。こちらでも同じ判定を書くと食い違う
    if (!r.ok) { this._say(r.error || 'うまくいきませんでした', true); return; }

    setOwned(r.owned);
    /* 買えた合図。**文字が変わるだけでは手応えが無い。**
       押した所は「値段」から「所持」へ変わるだけなので、
       買えたのか押し間違えたのかが文字だけでは読めない */
    this.onBought(s);
    if (this.user) this.user.coins = r.coins;
    this.preview = null;
    /* 買ったらそのまま着ける。買った直後にもう一度押させる理由が無い。
       **枠を明示する。** 形を買ったら形の枠へ、色を買ったら色の枠へ。
       枠を分けたので、刀を買っても着けている色は消えない */
    const slot = slotOf(s.id);
    wearSkin(this.weapon, s.id, slot);
    this._showGun();
    this.onChange();
    this._say(`${s.name} を買って、そのまま装備しました`);
    this._paint();
    try {
      await api('/api/equip', { weapon: this.weapon, slot, skin: s.id });
    } catch { /* 手元は変わっている */ }
  }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  /** storeがtrueならストアの面で開く。ホームのボタン2つがそれぞれ渡す */
  show(store = false) {
    this._init();
    this.preview = null;
    this._say('');
    this._setTab(store);
    this.el.root.classList.remove('hidden');
    this.running = true;
  }

  hide() {
    this.el.root.classList.add('hidden');
    // 閉じたら描くのをやめる。**畳み忘れるとホームの裏で回り続ける**
    this.running = false;
    this.preview = null;
    if (this.ready) this._showGun();
  }

  /** 開いている間だけ呼ばれる */
  update(dt) {
    if (!this.running || !this.ready) return;
    // ゆっくり回す。止まった絵だと、選んでいる物が模型に見える
    this._spin += dt * 0.6;
    this.holder.rotation.y = this._spin;
    this.renderer.render(this.scene, this.camera);
  }
}

// 検査から「持ち物の一覧を読む口があるか」を見るために出しておく
export { ownedSkus };
