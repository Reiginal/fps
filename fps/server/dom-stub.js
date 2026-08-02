// Nodeにブラウザの顔をさせるための最小限の偽物。
//
// level.jsとtextures.jsは模様をcanvasに描いてテクスチャにするので、
// documentもcanvasも無いNodeではimportした瞬間に落ちる。
// だが地形の形（頂点の座標）はテクスチャの中身に一切依存しないので、
// 「呼ばれても何もしない」canvasに差し替えれば、衝突判定に必要な物だけが正しく組み上がる。
//
// このファイルは副作用だけのモジュール。src/配下を読む前に必ず評価されている必要があるので、
// server側の各ファイルは他のどのimportよりも先にこれを書く。
// ESMは「importした順に、深さ優先で」評価するので、行を一番上に置けば順序は保証される。

// 何を呼ばれても落ちない受け皿。描画命令(fillRect等)は捨てて、
// 戻り値を使う数少ないもの(getImageData/gradient/measureText)だけ形を合わせて返す
const noop = new Proxy({}, {
  get(_, k) {
    if (k === 'canvas') return null;
    if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set() { return true; },
});

// 幅・高さを1にしておくのは、実寸で確保すると1024x1024の配列が何十枚も無駄に作られるから。
// テクセルは誰も読まないので大きさに意味がない
class FakeCanvas {
  constructor() { this.width = 1; this.height = 1; this.style = {}; }
  getContext() { return noop; }
  toDataURL() { return 'data:,'; }
}

globalThis.document = {
  createElement(tag) { return tag === 'canvas' ? new FakeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }; },
  createElementNS() { return new FakeCanvas(); },
  body: { appendChild() {} },
  getElementById() { return null; },
};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
globalThis.OffscreenCanvas = FakeCanvas;
globalThis.HTMLCanvasElement = FakeCanvas;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

// three本体がcanvasを触る時にHTMLCanvasElementかどうかで分岐する箇所があるので、
// instanceofが通るようにしておく（通らないと未知の入力扱いで例外を投げる）
globalThis.addEventListener = globalThis.addEventListener ?? (() => {});
globalThis.removeEventListener = globalThis.removeEventListener ?? (() => {});
globalThis.devicePixelRatio = 1;
