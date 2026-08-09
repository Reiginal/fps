// 見た目の画面。今は武器のスキンだけ。
//
// **選んだ物が見えないと選べない。** 色の名前を並べるだけでは
// 「デザート」がどんな色なのか分からないので、実物の銃を3Dで出して回す。
// ロビーの兵士のプレビュー（src/ui/charview.js）と同じ作りで、
// あちらの「描くのはロビーにいる間だけ」も踏襲する
// （開いていない間も描き続けると、遊んでいる裏で2つ目の場面を描くことになる）。
//
// ホームから開く。**ロビーではなくホームに置いた**のは、
// ロビーは対戦に入らないと出ないので、1人で遊ぶ人が一生辿り着けないため。
import * as THREE from 'three';
import { WEAPONS } from '../player/weapons.js';
import { SKINS, applySkin, loadSkin, saveSkin } from '../player/skins.js';

const $ = (id) => document.getElementById(id);

// 見せる武器。**ライフル1本。** 持ち替えて見せる形にすると、
// 選ぶ物が2つ（武器とスキン）になって、何を選んでいるのか読めなくなる
const SHOW_ID = 'rifle';

export class LookMenu {
  constructor() {
    this.el = {
      root: $('look'),
      canvas: $('lkView'),
      list: $('lkList'),
      name: $('lkName'),
      note: $('lkNote'),
      close: $('lkClose'),
    };
    this.ready = false;
    this.running = false;
    this.current = loadSkin();
    /** 選び直した時に呼ぶ。今持っている銃へ反映するのは呼ぶ側の仕事 */
    this.onChange = () => {};

    this._buildList();
    this.el.close.onclick = () => this.hide();
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

    // 銃そのもの。**本番と同じ組み立てを使う。**
    // 見せるためだけの別モデルを作ると、選んだ物と実際に出る物がずれる
    const def = WEAPONS.find((w) => w.id === SHOW_ID) || WEAPONS[0];
    this.gun = def.build(def.view);
    // 手は消す。ここで見たいのは銃であって、握り方ではない
    this.gun.traverse((o) => { if (o.userData?.isHand) o.visible = false; });
    this.holder = new THREE.Group();
    this.holder.add(this.gun);
    // 銃は原点が機関部あたりにあるので、少し引いて枠へ収める
    this.gun.position.set(0, 0, 0.06);
    this.scene.add(this.holder);
    this._spin = 0;
    applySkin(this.gun, this.current);
  }

  _buildList() {
    this.el.list.innerHTML = '';
    this.btns = SKINS.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lkitem';
      b.innerHTML = `<span class="sw" style="background:${s.swatch}"></span>`
        + `<span class="nm">${s.name}</span>`;
      b.onclick = () => this.select(s.id);
      this.el.list.appendChild(b);
      return b;
    });
    this._paint();
  }

  _paint() {
    const at = SKINS.findIndex((s) => s.id === this.current);
    this.btns.forEach((b, i) => b.classList.toggle('on', i === at));
    const s = SKINS[at] || SKINS[0];
    this.el.name.textContent = s.name;
    this.el.note.textContent = s.note;
  }

  /** 選ぶ。**その場で覚える。**「決定」を押させると、押し忘れて戻る人が出る */
  select(id) {
    this.current = saveSkin(id);
    if (this.gun) applySkin(this.gun, this.current);
    this._paint();
    this.onChange(this.current);
  }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  show() {
    this._init();
    this.el.root.classList.remove('hidden');
    this.running = true;
  }

  hide() {
    this.el.root.classList.add('hidden');
    // 閉じたら描くのをやめる。**畳み忘れるとホームの裏で回り続ける**
    this.running = false;
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
