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
import { characterAt, HITBOX } from '../net/protocol.js';
import { Enemy } from '../ai/enemy.js';
import { preloadCharModel, charModelReady, spawnCharModel } from '../ai/glbchar.js';

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
    // 260×260の小さい絵なので2倍で足りる
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.canvas.width, this.canvas.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, this.canvas.width / this.canvas.height, 0.1, 20);
    /* 少し上から見下ろす。真横から見ると背丈の差が読めない。
     *
     * この距離は目分量ではなく、6人ぶんの頂点を投影して詰めてある
     * （tools/check-character.mjs の[5]が同じ測り方で見張る）。
     *
     * 元は (0,1.15,3.4) → (0,0.95,0) で、**頭が枠の上へ突き抜けていた**。
     * 収まらない理由は2つあって、どちらも兵士の一部なので切るわけにいかない:
     *   ・無線のアンテナが2.37mまで伸びている（身長1.74mより63cm上）
     *   ・ライフルが中心から1.04m出ていて、回ると横へ大きく振れる
     * 実測では頂点の8.6%が枠の外にあり、背丈だけで画面の107%を占めていた。
     *
     * 引いた結果、背丈は画面の69%になる。小さくはなるが、
     * **切れている物を大きく見せても選ぶ役には立たない** */
    this.camera.position.set(0, 1.40, 5.10);
    this.camera.lookAt(0, 1.20, 0);

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
    this._show(i);
  }

  /* 実際に出す。selectと分けてあるのは、外部モデルの枠は読み込みが後から届くので、
     届いた時にupdate()からもう一度呼び直すため */
  _show(i) {
    for (const m of this._models.values()) m.root.visible = false;

    const def = characterAt(i);
    // 外部モデルの枠。まだ届いていなければコード製で出して、届いたら差し替わる
    if (def.model) preloadCharModel(def.model);
    const useGlb = def.model && charModelReady(def.model);
    const key = useGlb ? `glb:${i}` : i;

    let e = this._models.get(key);
    if (!e) {
      if (useGlb) {
        // プレビューも本番(remote.js)と同じ身長に合わせる。ここだけ大きいと詐欺になる
        e = spawnCharModel(def.model, HITBOX.STAND_H);
        this.scene.add(e.root);
      } else {
        e = new Enemy(NO_LEVEL, { seed: def.seed });
        // 足元の暗がりは要らない。床が無いので浮いた影になる
        e.blob.visible = false;
        this.scene.add(e.root);
      }
      this._models.set(key, e);
    }
    e.root.visible = true;
    e.root.position.set(0, 0, 0);
    this._model = e;
    this._modelIsGlb = !!useGlb;
  }

  start() { this.running = true; }

  stop() { this.running = false; }

  /** ロビーが開いている間だけ呼ばれる */
  update(dt) {
    if (!this.running || !this.ready || !this._model) return;
    // 外部モデルの枠をコード製の代役で出している間に読み込みが届いたら、本物へ替える
    if (!this._modelIsGlb && characterAt(this._index).model
      && charModelReady(characterAt(this._index).model)) {
      this._show(this._index);
    }
    // ゆっくり回す。止まった絵だと、選んでいる物が模型に見える
    this._spin += dt * 0.5;
    this._model.root.rotation.y = this._spin;
    // 外部モデルは待機のアニメを再生する(コード製は組んだ姿勢のまま)
    this._model.mixer?.update(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
