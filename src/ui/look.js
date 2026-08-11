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
  SKINS, skinAt, applySkin, skinFor, hasSkin, wearSkin, setOwned, ownedSkus, shapeOf,
} from '../player/skins.js';
import { SKINNABLE, DEFAULT_SKIN, skuOf, itemsFor } from '../net/protocol.js';

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
      name: $('lkName'), note: $('lkNote'), help: $('lkHelp'),
      status: $('lkStatus'), coins: $('lkCoins'),
      close: $('lkClose'),
      /* 買う札。**選んだ時だけ出す。**
         2026-08-11まで「同じボタンを2回押す」形だったのを分けた */
      buy: $('lkBuy'), buyName: $('lkBuyName'), buyPrice: $('lkBuyPrice'),
      buyGo: $('lkBuyGo'), buyNote: $('lkBuyNote'),
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
    /* 買う札の「買う」。**買う操作はここ1箇所だけ。**
       並んだ商品を押しても買わないので、押し間違えで買うことが起きない */
    this.el.buyGo.onclick = () => {
      const id = this.preview;
      const item = id ? itemsFor(this.weapon).find((it) => it.id === id) : null;
      if (item) this._buy({ ...skinAt(id), ...item });
    };
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
    const shown = this._shown();
    const build = shapeOf(shown) || def.build;
    const key = `${this.weapon}:${build === def.build ? '-' : shown}`;

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
    applySkin(g, shown);
  }

  /* 今プレビューに出すスキン。ストアの面では、選んでいる商品を試着させる */
  _shown() { return this.preview || skinFor(this.weapon); }

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

    list.innerHTML = '';
    const shown = this._shown();
    /* **その武器で扱える物だけを並べる。**
       色は全武器で売っているが、形（刀・ダガー）はその武器専用なので、
       全部のスキンをなめると「ライフルの刀」が並んでしまう */
    const sell = itemsFor(this.weapon).map((it) => ({ ...skinAt(it.id), ...it }));
    const all = [skinAt(DEFAULT_SKIN), ...sell];
    for (const s of all) {
      const have = hasSkin(this.weapon, s.id);
      /* ストアの面には標準以外を全部並べる。**買った物も消さない。**
         2026-08-11まで買った瞬間に棚から消していて、
         「買ったやつは購入済みってなるようにしてよ。いなくなるの寂しい」と言われた所。
         消すと、買った物を見に来る場所がストアから無くなる
         （着け替えの面はあるが、そちらは値段も並びも別） */
      if (this.store && s.id === DEFAULT_SKIN) continue;
      // 装備の面には、持っている物だけ
      if (!this.store && !have) continue;

      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lkitem';
      if (s.id === shown) b.classList.add('on');
      // 買った物の印。値段の代わりに「購入済み」が出る（CSSが付ける）
      if (this.store && have) b.classList.add('own');
      /* 見本の色と名前と値段だけ。**「形」「色」の区別は出さない。**
         遊ぶ人にとってはどれも同じ「スキン」で、
         作り手から見た「これは形が変わる方」は、選ぶ時に要らない区別だった
         （「何この分け方、そんな制度ないから」と言われた 2026-08-11）。
         形が変わる物はプレビューを見れば分かるし、値段も高いので伝わる */
      b.innerHTML = `<span class="sw" style="background:${s.swatch}"></span>`
        + `<span class="nm">${s.name}</span>`
        + (this.store ? `<span class="pr">${(s.price || 0).toLocaleString()}</span>` : '');
      /* **ストアで押しても買わない。試着だけ。**
         買うのは下の札の「買う」1回で、押す物と買う物を分けてある */
      b.onclick = () => (this.store ? this._pick(s) : this._wear(s.id));
      list.appendChild(b);
    }

    if (!list.children.length) {
      const p = document.createElement('div');
      p.className = 'lkempty';
      p.textContent = this.store
        ? 'この武器のスキンは全部持っています'
        // 行き先を書いておく。入口が分かれているので、ここから飛べない
        : '持っているスキンがありません。ホームのストアで買えます';
      list.appendChild(p);
    }

    /* 見本の色の読み方だけ。**「形」「色」の分け方は書かない。**
       前は「その武器がこの色になる／形 色だけでなく形も変わる」と
       2種類あるかのように書いていて、**そんな制度は無い**と言われた。
       スキンはスキンで、1つの武器に1つ着ける */
    this.el.help.textContent = list.querySelector('.lkitem')
      ? '左の四角がそのスキンの色。選ぶと上の3Dがすぐ変わります' : '';

    const s = SKINS.find((x) => x.id === shown) || SKINS[0];
    this.el.name.textContent = s.name;
    this.el.note.textContent = s.note;
    // 買う札も一緒に塗り直す。**別々に呼ぶと片方が古いまま残る**
    this._paintBuy();
  }

  _say(text, bad = false) {
    this.el.status.textContent = text || '';
    this.el.status.classList.toggle('bad', !!bad);
  }

  /** 装備する。**その場で決まる。**「決定」を押させると押し忘れる人が出る */
  async _wear(id) {
    if (this.busy) return;
    if (!wearSkin(this.weapon, id)) { this._say('持っていません', true); return; }
    this.preview = null;
    this._showGun();
    this._paint();
    this.onChange();
    // ログインしていれば台帳にも覚えさせる。していなければこの端末だけ
    if (!this.user) return;
    try { await api('/api/equip', { weapon: this.weapon, skin: id }); } catch { /* 手元は変わっている */ }
  }

  /**
   * ストアで1つ選ぶ。**試着して、買う札を出すだけ。ここでは買わない。**
   *
   * 2026-08-11まで「同じボタンを2回押す」形だった（1回目が試着・2回目で購入）。
   * 「購入が2回クリックなのが嫌だわ。なんかpopoverじゃないけど、なんか出してみて」
   * と言われて分けた。押す回数は変わっていないが、
   * **2回目が何をするか分からない**のが問題だったので、
   * 買う操作を専用の札へ移して「買う」と書いてある物を1回押す形にした。
   */
  _pick(s) {
    if (this.busy) return;
    this.preview = s.id;
    this._showGun();
    this._paint();
    this._say('');
  }

  /** 買う札の中身を差し替える。選んでいなければ畳む */
  _paintBuy() {
    const el = this.el;
    const id = this.preview;
    const item = id ? itemsFor(this.weapon).find((it) => it.id === id) : null;
    if (!this.store || !item) { el.buy.classList.add('hidden'); return; }
    el.buy.classList.remove('hidden');

    const s = skinAt(id);
    const have = hasSkin(this.weapon, id);
    const coins = Number(this.user?.coins ?? 0);
    el.buyName.textContent = s.name;
    el.buyPrice.textContent = item.price.toLocaleString();

    if (have) {
      el.buyGo.disabled = true;
      el.buyGo.textContent = '購入済み';
      el.buyNote.textContent = 'ホームのスキン変更で着けられます';
      return;
    }
    el.buyGo.textContent = '買う';
    if (!this.user) {
      el.buyGo.disabled = true;
      el.buyNote.textContent = 'ログインすると買えます';
      return;
    }
    /* 足りない時は**押す前に分かるようにする。**
       押してからサーバーに断られるより、いくら足りないかが先に見えた方が早い */
    if (coins < item.price) {
      el.buyGo.disabled = true;
      el.buyNote.textContent = `${(item.price - coins).toLocaleString()}コイン足りません`;
      return;
    }
    el.buyGo.disabled = false;
    el.buyNote.textContent = `買うと残り ${(coins - item.price).toLocaleString()}コイン`;
  }

  /** 買う。**札の「買う」から1回で呼ばれる。**試着はもう済んでいる */
  async _buy(s) {
    if (this.busy) return;
    if (!this.user) { this._say('買うにはログインしてください', true); return; }
    if (hasSkin(this.weapon, s.id)) { this._say('もう持っています'); return; }

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
       今は買っても棚から消えないので、押した所は「購入済み」の印に変わるだけ。
       印だけだと手応えが薄いので、音は残してある（硬貨が落ちる音） */
    this.onBought(s);
    if (this.user) this.user.coins = r.coins;
    /* **試着を解かない。** 買った物をそのまま着けるので、
       ここでpreviewを消すと3Dが元の見た目へ戻って「買ったのに何も起きていない」に見える */
    // 買ったらそのまま着ける。買った直後にもう一度押させる理由が無い
    wearSkin(this.weapon, s.id);
    this._showGun();
    this.onChange();
    /* 買ったらそのまま着ける。**棚から消えなくなったので、
       「買った」と「着けた」を両方言う必要がある**
       （前は商品が消えることが「買えた」の合図を兼ねていた）。
       面は切り替えない（入口が分かれているので、勝手に別の画面へ移らない） */
    this._say(`${s.name} を買って、そのまま装備しました`);
    this._paint();
    try { await api('/api/equip', { weapon: this.weapon, skin: s.id }); } catch { /* 手元は変わっている */ }
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
