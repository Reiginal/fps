// ロビーで選んでいる兵士を、実際に3Dで見せる。
//
// なぜ別の絵にするか: 色の四角と名前だけでは、どんな兵士なのかが分からない。
// 選ぶ楽しさはここから出る。
//
// 描くのはロビーにいる間だけ。試合が始まったら止める。
// 止めないと、遊んでいる裏でずっと2つ目の場面を描き続けることになり、
// そのぶんパソコンが熱くなる（ここは既に指摘を受けている所）。
//
// 兵士そのものは対戦で使っているのと同じ物を組む。
// 見せるためだけの別モデルを作ると、選んだ姿と実際に出る姿がずれる。
import * as THREE from 'three';
import { characterAt } from '../net/protocol.js';
import { Enemy } from '../ai/enemy.js';

// 地形は要らないが、Enemyがlevelを見に来るので最小限の物を渡す。
// 当たり判定も経路も使わないので、空の返事で足りる
const NO_LEVEL = {
  octree: { capsuleIntersect: () => null, rayIntersect: () => null },
  enemySpawns: [new THREE.Vector3()],
  coverPoints: [],
};

export class CharView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.running = false;
    this._index = -1;
    this._models = new Map();   // 番号 -> 組み上がった兵士
    this._spin = 0;
  }

  /* 3Dの道具は、ロビーを初めて開いた時に作る。
     起動時に作ると、1人で遊ぶ人も使わない物の組み立てを待つことになる */
  _init() {
    if (this.ready) return;
    this.ready = true;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: true,
    });
    // 端末の画素密度をそのまま使うと、Retinaで4倍の画素を描くことになる。
    // 220×270の小さい絵なので2倍で足りる
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.canvas.width, this.canvas.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, this.canvas.width / this.canvas.height, 0.1, 20);
    // 少し上から見下ろす。真横から見ると背丈の差が読めない
    this.camera.position.set(0, 1.15, 3.4);
    this.camera.lookAt(0, 0.95, 0);

    // 光は2灯だけ。ロビーの絵に影は要らないので、影の焼き付けもしない
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(1.6, 2.4, 2.0);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.8);
    fill.position.set(-1.8, 1.0, -1.2);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0x6d7d92, 1.1));
  }

  /** 番号の兵士を出す。同じ番号なら組み直さない */
  select(index) {
    this._init();
    const i = index | 0;
    if (i === this._index) return;
    this._index = i;

    for (const m of this._models.values()) m.root.visible = false;

    let e = this._models.get(i);
    if (!e) {
      e = new Enemy(NO_LEVEL, { seed: characterAt(i).seed });
      // 足元の暗がりは要らない。床が無いので浮いた影になる
      e.blob.visible = false;
      this.scene.add(e.root);
      this._models.set(i, e);
    }
    e.root.visible = true;
    e.root.position.set(0, 0, 0);
    this._model = e;
  }

  start() { this.running = true; }

  stop() { this.running = false; }

  /** ロビーが開いている間だけ呼ばれる */
  update(dt) {
    if (!this.running || !this.ready || !this._model) return;
    // ゆっくり回す。止まった絵だと、選んでいる物が模型に見える
    this._spin += dt * 0.5;
    this._model.root.rotation.y = this._spin;
    this.renderer.render(this.scene, this.camera);
  }
}
