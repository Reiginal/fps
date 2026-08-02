// 武器。モデルはプリミティブを組んで手で作り、動きは全部プログラムで付ける。
// 手付けアニメが無くても、反動のバネ・構えの遅れ・歩行の揺れを重ねると生きた動きになる。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { muzzleFlashTexture, radialTexture, smokeTexture } from '../world/textures.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);

const clamp = (a, b, c) => (a < b ? b : a > c ? c : a);
const clamp01 = (a) => (a < 0 ? 0 : a > 1 ? 1 : a);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (s) => (Math.random() - 0.5) * s;
// pがa..bの区間のどこにいるかを0..1で返す。装填の工程を時間軸に並べるのに使う
const seg = (p, a, b) => clamp01((p - a) / (b - a));
const ease = (t) => t * t * (3 - 2 * t);
const rnd4 = (v) => Math.round(v * 10000) / 10000;

/* ------------------------------------------------ 手続きで作る表面の凹凸 */

function ihash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (i, j) => ihash(((xi + i) % p + p) % p, ((yi + j) % p + p) % p, s);
  const a = w(0, 0), b = w(1, 0), c = w(0, 1), d = w(1, 1);
  const t0 = a + (b - a) * ux;
  const t1 = c + (d - c) * ux;
  return t0 + (t1 - t0) * uy;
}

function fbm(x, y, f, oct, s) {
  let sum = 0, amp = 0.5, fr = f;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * fr, y * fr, fr, s + i * 7) * amp;
    amp *= 0.5; fr *= 2;
  }
  return sum;
}

function dataTex(data, size) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// 高さ場から法線と粗さを焼く。銃も手袋も面が完全に平らだと光が一様に返って
// 作り物に見えるので、微細な凹凸を入れて金属の中に階調を作る
function bakeSurface(size, hf, rf, strength) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = hf(x / size, y / size);
  }
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const nd = new Uint8Array(size * size * 4);
  const rd = new Uint8Array(size * size * 4);
  // 凸度と粗さの生値。あとで材質ごとに焼き直すので数値のまま持っておく
  const cv = new Float32Array(size * size);
  const rv = new Float32Array(size * size);
  let cmax = 1e-6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      nd[i] = (nx * 0.5 + 0.5) * 255;
      nd[i + 1] = (ny * 0.5 + 0.5) * 255;
      nd[i + 2] = (nz * 0.5 + 0.5) * 255;
      nd[i + 3] = 255;
      // 粗さは倍率として持たせる。材質側のroughnessに掛かる
      const r = clamp01(rf(x / size, y / size, h[y * size + x]));
      rv[y * size + x] = r;
      rd[i] = rd[i + 1] = rd[i + 2] = r * 255;
      rd[i + 3] = 255;
      // 高さ場のラプラシアンの正側だけを拾うと、山の稜線＝角が取れる。
      // 実物は角から先に塗装が擦れて地金が出るので、これをエッジウェアの下地にする
      const lap = at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) - 4 * at(x, y);
      const p = lap > 0 ? lap : 0;
      cv[y * size + x] = p;
      if (p > cmax) cmax = p;
    }
  }
  // 擦れは全面に均一に出ると汚れに見える。低周波のむらを掛けて塊にする
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const patch = clamp01(fbm(x / size, y / size, 4, 3, 61) * 2.1 - 0.45);
      cv[i] = Math.pow(cv[i] / cmax, 0.55) * patch;
    }
  }
  return { n: dataTex(nd, size), r: dataTex(rd, size), cv, rv, size };
}

// ビーズブラストした金属。細かい梨地に薄い加工痕の筋を重ねる
const SURF_METAL = bakeSurface(96,
  (u, v) => fbm(u, v, 32, 3, 11) * 0.7 + Math.sin(v * 220) * 0.03 * fbm(u, v, 4, 2, 5),
  (u, v, h) => 0.80 + h * 0.28,
  3.0);

// 樹脂の梨地。金属より粒が粗く、光を散らす
const SURF_POLYMER = bakeSurface(96,
  (u, v) => Math.pow(fbm(u, v, 16, 4, 23), 1.4),
  (u, v, h) => 0.82 + h * 0.22,
  4.5);

// 布の織り目。手袋と袖に使う。
// 格子の振幅が大きいと、袖のように面積の広い部品で「斜めの網目が等間隔で繰り返す」のが
// 肉眼で読めてしまう（緑の水道ホースに見える原因）。格子は存在が分かる程度まで落として、
// 代わりに繊維のむら(fbm)を主役にする
const SURF_FABRIC = bakeSurface(96,
  (u, v) => (Math.sin(u * Math.PI * 32) * Math.sin(v * Math.PI * 32)) * 0.10 + 0.5
    + fbm(u, v, 24, 3, 41) * 0.5,
  (u, v, h) => 0.86 + h * 0.14,
  3.4);

/* ------------------------------------------------------------ 材質 */

// 角の地金出し（エッジウェア）と薄い埃を1枚から作る。
// 面積の大きい機関部や弾倉が色1つだと「塗り潰した多角形」に見えてしまうので、
// 凸度から アルベド／金属度／粗さ の3つを同時に振って階調を作る。
// 戻り値は map用(sRGB)と、G=粗さ・B=金属度に詰めた1枚
function bakeWear(surf, repeat, color, metalness, roughness, w) {
  const s = surf.size, n = s * s;
  const ad = new Uint8Array(n * 4);
  const md = new Uint8Array(n * 4);
  const br = (color >> 16) & 255, bg = (color >> 8) & 255, bb = color & 255;
  const wc = w.color != null ? w.color : 0x8b939c;
  const wr = (wc >> 16) & 255, wg = (wc >> 8) & 255, wb = wc & 255;
  const dAmt = w.dust || 0;
  const dc = w.dustColor != null ? w.dustColor : 0x9a8f7d;
  const dr = (dc >> 16) & 255, dg = (dc >> 8) & 255, db = dc & 255;
  const mTgt = w.metal != null ? w.metal : 1.0;
  const rTgt = w.rough != null ? w.rough : 0.20;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const k = clamp01(surf.cv[i] * w.amount);
      // 埃は低周波でうっすら。UVの上側ほど溜まる想定にして、
      // 上向きの面が明るくなる（＝立体に見える）方へ寄せる
      const du = dAmt > 0
        ? clamp01(fbm(x / s, y / s, 3, 3, 77) * 1.9 - 0.35) * dAmt * (0.30 + (y / s) * 0.70)
        : 0;
      let R = br + (wr - br) * k, G = bg + (wg - bg) * k, B = bb + (wb - bb) * k;
      R += (dr - R) * du; G += (dg - G) * du; B += (db - B) * du;
      const j = i * 4;
      ad[j] = R; ad[j + 1] = G; ad[j + 2] = B; ad[j + 3] = 255;
      const rr = clamp01((roughness * surf.rv[i]) * (1 - k) + rTgt * k + du * 0.30);
      const mm = clamp01((metalness * (1 - k) + mTgt * k) * (1 - du * 0.55));
      md[j] = 0; md[j + 1] = rr * 255; md[j + 2] = mm * 255; md[j + 3] = 255;
    }
  }
  const a = dataTex(ad, s);
  a.colorSpace = THREE.SRGBColorSpace;
  a.repeat.set(repeat, repeat);
  const p = dataTex(md, s);
  p.repeat.set(repeat, repeat);
  return { a, p };
}

function mat(color, metalness, roughness, surf, repeat, nscale, extra, wear) {
  const m = new THREE.MeshStandardMaterial(
    Object.assign({ color, metalness, roughness }, extra || {}));
  if (surf) {
    const n = surf.n.clone(); n.repeat.set(repeat, repeat);
    m.normalMap = n;
    // 罠: normalScaleをコンストラクタに数値で渡すとVector2が数値に潰れて壊れる。
    // 必ず生成後に .normalScale.set() する
    m.normalScale.set(nscale, nscale);
    if (wear) {
      const t = bakeWear(surf, repeat, color, metalness, roughness, wear);
      // 色はマップ側が全部持つ。材質のcolorを白にしないと二重に掛かって沈む
      m.color.setHex(0xffffff);
      m.map = t.a;
      m.roughness = 1.0;
      m.metalness = 1.0;
      m.roughnessMap = t.p;   // Gチャンネルを読む
      m.metalnessMap = t.p;   // Bチャンネルを読む
    } else {
      const r = surf.r.clone(); r.repeat.set(repeat, repeat);
      m.roughnessMap = r;
    }
  }
  return m;
}

const MATS = {
  // 焼入れ鋼。擦れて地金が出ている明るい部分。
  // 磨き鋼のまま金属度1.0で置くと、白飛びした空のenvMapをほぼ全反射で返して
  // 機関部上面だけが純白の板になる（未着色のプレースホルダーに見える）。
  // 実銃で機関部上面がむき出しの磨き鋼になることはないので、擦れの量も反射量も絞る
  steel: mat(0x5a6068, 1.0, 0.34, SURF_METAL, 3, 0.5, { envMapIntensity: 0.5 },
    { amount: 0.30, color: 0x7c838b, rough: 0.26 }),
  // パーカーライズド（リン酸塩皮膜）。ざらついて光を散らす軍用の黒
  phosphate: mat(0x2c2f34, 1.0, 0.68, SURF_METAL, 4, 1.0, null,
    { amount: 1.0, color: 0x7d858e, dust: 0.13 }),
  // 焼付塗装。半艶で少し樹脂寄りの黒
  enamel: mat(0x1d2024, 0.35, 0.50, SURF_METAL, 3, 0.5, null,
    { amount: 0.95, color: 0x6e767f, dust: 0.10 }),
  // アルマイト。レールと機関部上面。青みがあって金属の中で一段光る
  anodized: mat(0x3a414a, 1.0, 0.38, SURF_METAL, 3.5, 0.6, { envMapIntensity: 0.7 },
    { amount: 0.85, color: 0x939ba5, dust: 0.09 }),
  // 光学サイトの外皮。ADSでは画面中央をこれ1部品が占めるので、
  // 粗さを一定にすると縁に幅の広い白飛びハイライトが1枚だけベタっと乗って
  // 金属ではなく濡れたプラスチックに見える。粗さマップで艶を割っておく
  gunmetal: mat(0x1a1d21, 0.9, 0.46, SURF_METAL, 7, 0.75, { envMapIntensity: 0.65 },
    { amount: 0.45, color: 0x5e666f, rough: 0.30, dust: 0.07 }),
  // 樹脂。塗装金属とは反射の質が違うので分けておく。
  // 擦れても地金は出ないので、金属度の到達点を低く抑える
  polymer: mat(0x25282b, 0.0, 0.78, SURF_POLYMER, 4, 1.0, null,
    { amount: 0.6, color: 0x5b6167, metal: 0.12, rough: 0.42, dust: 0.15 }),
  polymerTan: mat(0x46413a, 0.0, 0.86, SURF_POLYMER, 9, 1.3, null,
    { amount: 0.55, color: 0x6d675c, metal: 0.10, rough: 0.50, dust: 0.14 }),
  // ゴム。バットパッドと握把の当て板。ほぼ光らない
  rubber: mat(0x131417, 0.0, 0.98, SURF_POLYMER, 7, 1.4),
  brass: mat(0xb8903e, 1.0, 0.30, SURF_METAL, 3, 0.4, null,
    { amount: 0.5, color: 0xe0c179, rough: 0.14 }),
  // 赤いショットシェル。暗い銃の中で唯一の色味になる
  shell: mat(0x8e211a, 0.0, 0.62, SURF_POLYMER, 3, 0.7),
  // 手袋。布と当て革と掌のゴムで3層に分ける。
  // 銃（紺黒）から分離させたくてアルベドを中間グレーまで上げていたが、
  // 日陰にあるはずの手が日向の砂嚢と同じ輝度（平均135）まで光り、
  // 指の1本1本ではなく「白い塊」として読めるようになっていた。材質もラテックスに見える。
  // アルベドは布として妥当な暗さまで落として、銃との分離はリムライトと接触影に任せる。
  // 無地の単色メッシュに見えないよう、織り目の山だけ色が抜けるwearを掛ける
  // 織り目の凹凸と山の色抜けは、腰だめの縮尺を0.53→0.86へ上げて手が画面上で
  // 1.6倍になったぶん実際に読めるようになる。無地の塊に見せないよう一段強める
  // 青灰色(0x3a3e42)は背景のコンクリートと同じ無彩色・同じ明度で、
  // 実測でも手袋の輝度中央値75に対して背景が78＝差がゼロだった。
  // 布として妥当な範囲で色相を土色側へ振り、明度も一段落とす（袖と同じ系統に揃う）
  glove: mat(0x38352c, 0.0, 0.88, SURF_FABRIC, 6, 1.4, null,
    { amount: 0.62, color: 0x585448, metal: 0.0, rough: 0.80, dust: 0.10, dustColor: 0x7a7166 }),
  // 拳の当て革。粗さを落として関節にスペキュラを立てる（指の関節が線として出る）。
  // 手袋の中の3層は明度差を保ったまま、同じ比率で落とす
  gloveHard: mat(0x34312a, 0.18, 0.42, SURF_POLYMER, 7, 1.1),
  palm: mat(0x24272b, 0.0, 0.95, SURF_POLYMER, 9, 1.5),
  // 袖は画面下部で一番面積が広い。彩度が高いと視線が銃でなく袖へ吸われるので抑える。
  // 緑に寄っていたぶんを落として、色ではなく明度の変化で布に見せる。
  // 織り目のrepeatを上げて、等間隔の網目が肉眼で読めないところまで細かくする
  sleeve: mat(0x2b2c26, 0.0, 0.97, SURF_FABRIC, 18, 1.6, null,
    { amount: 0.50, color: 0x484a40, metal: 0.0, rough: 0.92, dust: 0.13, dustColor: 0x6f6555 }),
  strap: mat(0x4a4e40, 0.0, 0.92, SURF_FABRIC, 3, 1.1),
  // 筒の内壁も描かないと、覗いた時に穴が抜けて背景が見えてしまう。
  // 内壁が光ると覗いた時に開口の縁が白く回るので、粗さマップを掛けて完全に消す
  opticTube: mat(0x101216, 0.15, 0.94, SURF_POLYMER, 8, 0.6, { side: THREE.DoubleSide }),
  // レンズ。実物のダットサイトは透過率90%で、覗いた時は外の世界がそのまま見える。
  // 環境マップを強く拾わせると映り込みが透過像を上書きして、
  // 「筒の中だけ青白い平面が貼ってある」画になるので、正面から見た時の反射は最小に保つ。
  // ただし0.25まで落とすと横から見た時も何も映らず、ただの穴になる。
  // 下のonBeforeCompileで「浅い角度で見た面ほど反射する」フレネルを足してあるので、
  // 正面（＝覗いている時）は素通しのまま、横顔だけコーティングの色が出る
  glass: new THREE.MeshStandardMaterial({
    color: 0xdfe8f0, metalness: 0.0, roughness: 0.03,
    transparent: true, opacity: 0.04, depthWrite: false, envMapIntensity: 0.55,
    // ドームなので裏を向く面がある。片面だと接眼側から見た時に硝子が消える
    side: THREE.DoubleSide,
  }),
  // 対物ベゼルのローレット（滑り止めの刻み）。
  // 筐体と同じgunmetalで作ると、画面中央を占める部品なのに継ぎ目が1本も無い
  // 成形プラスチックの輪に見える。粗さを一段上げて、周方向の目を細かく刻む
  knurl: mat(0x1e2126, 0.85, 0.62, SURF_METAL, 16, 1.25, { envMapIntensity: 0.5 },
    { amount: 0.55, color: 0x6a727b, rough: 0.34, dust: 0.08 }),
  // 赤ドット。板にベタ塗りだと画素の四角がそのまま芯になる。
  // 丸い滲みの中心に赤い正方形が入るのが一番安物に見えるので、必ず丸マスクを掛ける。
  // depthTestを切ると筒でも銃身でも遮蔽されず、ヒップでは筒の側面や外周に
  // 赤い点が乗って見える。実物のドットは接眼側から軸上でしか見えないので深度を戻し、
  // レンズとのZファイトはpolygonOffsetで逃がす
  dot: new THREE.MeshBasicMaterial({
    color: 0xff2b1a, toneMapped: false, transparent: true, opacity: 1,
    map: radialTexture(64, 1.4, 0.85), blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),
  // レティクルの輪。芯のドットだけだと輪郭が無くて滲みに見えるので、細いリングを足す
  reticle: new THREE.MeshBasicMaterial({
    color: 0xff3320, toneMapped: false, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),
};

// レンズのフレネル反射。実物の対物レンズは正面から覗くと素通しなのに、
// 斜めから見ると急に反射して、コーティングの色（緑〜紫）が角度で振れる。
// 標準材質のenvMapだけではこの角度依存が出ず、リングの上に幅の広い白いハイライトが
// 1本ベタっと乗るだけの「濡れたプラスチック」になる。視線と法線の角度から1項足す
MATS.glass.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
    // vViewPositionは面から視点へのベクトル。正面ほどdotが1に近い
    float _fr = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) );
    _fr = pow( clamp( _fr, 0.0, 1.0 ), 1.6 );
    // 浅い角度ほど緑から紫へ寄る。実物のマルチコートの見え方
    vec3 _coat = mix( vec3( 0.10, 0.30, 0.20 ), vec3( 0.26, 0.13, 0.34 ), _fr );
    gl_FragColor.rgb += _coat * _fr * 1.5;
    gl_FragColor.a = clamp( gl_FragColor.a + _fr * 0.55, 0.0, 1.0 );`);
};

// 手袋の縁光。手は日陰にあるので、アルベドをいくら動かしても背景のコンクリートと
// 同じ明度帯に入ってしまう（実測: 手袋75対背景78）。上げれば今度は日向の砂嚢と同じ
// 白い塊に戻るので、分離はアルベドではなく輪郭で作る。
// 視線と法線が浅く交わる面＝シルエットの縁にだけ空の色を1段乗せると、
// 背景が何色でも手の形が抜ける。指の1本ずつの丸みにも縁が乗るので、
// 稜線が増えて塊が塊でなくなる
// 指数を下げると縁が太って手全体が白い塊になるので、シルエットの1〜2px手前で切る。
// 当て革（gloveHard）には掛けない。袖のベルクロ帯も同じ材質なので、
// 掛けると布の帯の縁が銀線のように光ってクロムの輪に見える
MATS.glove.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
    float _rim = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) );
    _rim = pow( clamp( _rim, 0.0, 1.0 ), 3.4 );
    gl_FragColor.rgb += vec3( 0.30, 0.35, 0.44 ) * _rim * 0.50;`);
};
// 罠: シェーダのプログラムはmaterialの設定値から作った鍵で使い回されるので、
// onBeforeCompileを足しただけだと同じ設定の別材質（袖など）と同じプログラムを
// 引いてしまい、縁光が乗らない／余計な所に乗る。鍵を別にしておく
MATS.glove.customProgramCacheKey = () => 'rimGlove';

// 袖の皺の陰影。
// 【ここが要点】頂点色はアルベドに掛かる係数なので、トーンマップとsRGBを通ると
// 必ず圧縮される。以前は頂点色に0.50〜1.00（リニアで1.9倍）を焼いていたが、
// 画面に出るのは1.34倍で、実測の横断比1.19〜1.39倍とぴったり一致していた。
// つまりこの器を使う限り、何倍焼いても画面上1.4倍が天井になる。
// 手袋の縁光と同じく #include <dithering_fragment> の後——トーンマップとsRGBの
// 後ろ——で足せば圧縮を受けない。
// 皺の量は頂点色ではなくfoldという専用の属性で渡す。頂点色は接触影(bakeAO)と
// 掛け合わされてしまうので、それを増幅すると皺ではなく接触影の染みが浮き出る
// （実際にそうなって、袖の真ん中に大きな黒い滲みが出た）。
// 【足すのではなく掛ける】最初は縁光と同じように定数を足していたが、
// 谷の元の色が既に暗い（0.10前後）ので、そこから0.12引くと赤と緑が0で止まり、
// 空の色ぶんだけ残った青が縦に2本走った。掛け算なら色相が変わらず、
// 黒で止まることもない。表示空間で掛けるので圧縮も受けない
MATS.sleeveSkin = MATS.sleeve.clone();
MATS.sleeveSkin.onBeforeCompile = (sh) => {
  sh.vertexShader = 'attribute float fold;\nvarying float vFold;\n'
    + sh.vertexShader.replace('void main() {', 'void main() {\n\tvFold = fold;');
  sh.fragmentShader = 'varying float vFold;\n'
    + sh.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
    // 谷を山より深く取る。下側の階調が丸ごと余っているので、暗い方に振る余裕がある
    float _f = clamp( vFold, -1.0, 1.0 );
    gl_FragColor.rgb *= 1.0 + ( _f < 0.0 ? _f * 0.48 : _f * 0.32 );`);
};
MATS.sleeveSkin.customProgramCacheKey = () => 'sleeveFold';

// ドットの滲み。芯が細いと滲みが勝つので、外周は指数で落として芯だけ飽和させる
const GLOW_TEX = radialTexture(64, 1.7, 0);
// 映り込み専用。中心から外へアルファを落とし切って、板の四角い外形が出ないようにする
const SHEEN_TEX = radialTexture(64, 1.5, 0);

// ドットの滲み。芯の周りに柔らかい輪を足すと、点ではなく発光体に見える
MATS.dotGlow = new THREE.MeshBasicMaterial({
  map: GLOW_TEX, color: 0xff3a18, toneMapped: false,
  transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending,
  depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
// レンズに乗る環境の映り込み。薄い青の帯を斜めに入れる。
// 濃いと「ガラスの上に半透明の紙を斜めに貼った」ように見えるので、存在が分かる程度まで落とす。
// これはヒップで筒を横から見た時の演出であって、覗いている時に乗せる物ではない。
// 覗いている間は_animateでvisible:falseにする
MATS.sheen = new THREE.MeshBasicMaterial({
  map: SHEEN_TEX, color: 0x3f7fbf, toneMapped: false,
  transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending,
  depthWrite: false,
});
// レンズのコーティング。実物は中心が抜けていて、外周ほど色が乗る。
// 細い輪1本だと「縁に色を塗った円板」にしかならないので、
// 中心が透明・外周が青緑〜紫の分布を1枚のテクスチャに焼いて全面に敷く。
// 覗いている間もこれ越しに外を見るので、濃度は存在が分かる限界まで薄くする
function coatingTexture(size = 64) {
  const d = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x - c) / c, (y - c) / c);
      // 外周へ向かって青緑→紫。角度ではなく半径で振ると、
      // 板でも「見る角度で色が変わるコーティング」の見え方を代用できる
      const k = clamp01(Math.pow(clamp01(r), 2.6));
      const i = (y * size + x) * 4;
      d[i] = (26 + 92 * k);
      d[i + 1] = (74 - 30 * k);
      d[i + 2] = (66 + 62 * k);
      d[i + 3] = r >= 1 ? 0 : k * 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
MATS.coating = new THREE.MeshBasicMaterial({
  map: coatingTexture(64), toneMapped: false,
  transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// レンズの周縁の落ち込み。中心は素通しで、外周ほど暗く沈む板を1枚重ねて
// フレネル（斜めに見た面ほど反射して透過しない）の見え方を代用する。
// これが無いとレンズが「単色の円板」にしか見えない
function lensVignetteTexture(size = 64) {
  const d = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x - c) / c, (y - c) / c);
      const a = r >= 1 ? 0 : Math.pow(clamp01(r), 3.4);
      const i = (y * size + x) * 4;
      d[i] = 22; d[i + 1] = 26; d[i + 2] = 32; d[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
MATS.lensEdge = new THREE.MeshBasicMaterial({
  map: lensVignetteTexture(64), toneMapped: false,
  transparent: true, depthWrite: false,
});

/* --------------------------------------------------- ジオメトリと部品 */

// 部品数を増やすので、同じ寸法のジオメトリは必ず使い回す
const _geo = new Map();
function cached(key, make) {
  let g = _geo.get(key);
  if (!g) { g = make(); _geo.set(key, g); }
  return g;
}
const boxG = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cylG = (rt, rb, h, s = 12, open = false) =>
  cached(`c${rt},${rb},${h},${s},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, s, 1, open));
const capG = (r, len) => cached(`p${r},${len}`, () => new THREE.CapsuleGeometry(r, Math.max(len, 0.0002), 3, 8));
const torG = (r, t, rs = 6, ts = 14, arc = Math.PI * 2) =>
  cached(`t${r},${t},${rs},${ts},${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc));
const sphG = (r, w = 10, h = 7) => cached(`s${r},${w},${h}`, () => new THREE.SphereGeometry(r, w, h));
const planeG = (w, h) => cached(`n${w},${h}`, () => new THREE.PlaneGeometry(w, h));
const circG = (r, s = 16) => cached(`o${r},${s}`, () => new THREE.CircleGeometry(r, s));
// 浅いドーム。開口半径rを球半径Rの一部として切り出す。
// レンズを平らな円板で作ると法線が全面同じになり、どの角度から見ても反射が一定＝
// 「輪の中に貼った灰色の紙」になる。実物どおりわずかに膨らませると、
// 縁だけ視線と法線の角度が開いてフレネルの色が出る
const domeG = (r, R, s = 32) => cached(`m${r},${R},${s}`,
  () => new THREE.SphereGeometry(R, s, 8, 0, Math.PI * 2, 0, Math.asin(r / R)));

// 面取り付きの箱。
// 90度の角のままだと稜線に光の線が乗らず、機関部・弾倉・銃床の3部品が
// 1枚の紺黒の板に潰れて境目が読めない。法線マップはノイズなのでシルエットは救えないので、
// 実物どおり0.5〜1mm相当の面取りを立てて、そこだけ光を返させる。
// mergeGeometriesは索引の有無が揃っていないと失敗するので、最後に索引を張る
function chamferBoxG(w, h, d, t) {
  return cached(`x${w},${h},${d},${t}`, () => {
    const a = w / 2, b = h / 2, c = d / 2;
    const e = Math.min(t, a * 0.45, b * 0.45, c * 0.45);
    const A = a - e, B = b - e, C = c - e;
    const half = [a, b, c];
    const pos = [], nor = [], uv = [];

    // 外向きの基準方向を渡して、法線が逆なら頂点順を入れ替える。
    // 面ごとに向きを手で数えるより間違いが起きない
    const poly = (pts, rx, ry, rz) => {
      const n = _v.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2])
        .cross(_v2.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]));
      if (n.x * rx + n.y * ry + n.z * rz < 0) { pts.reverse(); n.negate(); }
      n.normalize();
      // UVは基準方向の主軸を除いた2軸で張る。BoxGeometryと同じく面あたり0..1
      const ax = Math.abs(rx), ay = Math.abs(ry), az = Math.abs(rz);
      let i0 = 0, i1 = 1;
      if (ax >= ay && ax >= az) { i0 = 2; i1 = 1; }
      else if (ay >= az) { i0 = 0; i1 = 2; }
      const emit = (p) => {
        pos.push(p[0], p[1], p[2]);
        nor.push(n.x, n.y, n.z);
        uv.push(p[i0] / (2 * half[i0]) + 0.5, p[i1] / (2 * half[i1]) + 0.5);
      };
      for (let i = 2; i < pts.length; i++) { emit(pts[0]); emit(pts[i - 1]); emit(pts[i]); }
    };

    for (const s of [1, -1]) {
      poly([[s * a, -B, -C], [s * a, B, -C], [s * a, B, C], [s * a, -B, C]], s, 0, 0);
      poly([[-A, s * b, -C], [A, s * b, -C], [A, s * b, C], [-A, s * b, C]], 0, s, 0);
      poly([[-A, -B, s * c], [A, -B, s * c], [A, B, s * c], [-A, B, s * c]], 0, 0, s);
    }
    // 12本の稜線。ここに乗る細い光の線が形状を読ませる
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        poly([[sx * a, sy * B, -C], [sx * a, sy * B, C], [sx * A, sy * b, C], [sx * A, sy * b, -C]],
          sx, sy, 0);
      }
      for (const sz of [1, -1]) {
        poly([[sx * a, -B, sz * C], [sx * a, B, sz * C], [sx * A, B, sz * c], [sx * A, -B, sz * c]],
          sx, 0, sz);
      }
    }
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        poly([[-A, sy * b, sz * C], [A, sy * b, sz * C], [A, sy * B, sz * c], [-A, sy * B, sz * c]],
          0, sy, sz);
      }
    }
    // 8隅の三角
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          poly([[sx * a, sy * B, sz * C], [sx * A, sy * b, sz * C], [sx * A, sy * B, sz * c]],
            sx, sy, sz);
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const idx = new Uint16Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  });
}
// シルエットに効く大きな部品だけ差し替える。小物まで面取りすると頂点が無駄に増える。
// 0.0018mは実寸1.8mm相当で、ビューモデルの縮尺(0.5前後)を通すと画面上0.9mmしか残らず
// 稜線に光が乗らない。実銃の面取りに近い2.6mmまで広げてハイライトを1本立てる
const CHAMFER = 0.0026;
const cboxG = (w, h, d) => chamferBoxG(w, h, d, CHAMFER);
// 弾倉のようにシルエット最大の塊は、これより太い面取りでないと輪郭が黒く潰れる
const MAG_CHAMFER = 0.0045;

function part(geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

// 楕円体を作る用。球を潰すと手の甲や掌の丸みが安く出せる
function partS(geo, mat, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  const m = part(geo, mat, x, y, z, rx, ry, rz);
  m.scale.set(sx, sy, sz);
  return m;
}

// 2点間にカプセルを渡す。指の節をこれで並べると1本ずつ作らなくても握りの形が出る
function capBetween(mat, p0, p1, r) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 0.0002;
  const m = new THREE.Mesh(capG(rnd4(r), rnd4(len)), mat);
  m.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  m.quaternion.setFromUnitVectors(_up, _v.set(dx / len, dy / len, dz / len));
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// 2点間に先細りの筒を渡す。前腕の袖に使う
function tubeBetween(mat, p0, p1, r0, r1, s = 10) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 0.0002;
  const m = new THREE.Mesh(cylG(rnd4(r1), rnd4(r0), rnd4(len), s), mat);
  m.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  m.quaternion.setFromUnitVectors(_up, _v.set(dx / len, dy / len, dz / len));
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// 袖の皮を1枚で張る。
// 先細りの筒(tubeBetween)を継いで作ると、継ぎ目が消えて滑らかな円錐になり、
// どう塗っても「塗装した配管」か「ゴムホース」にしか見えない。布に見せるには
//   ・断面を真円にしない（真円は硬い筒の証拠）
//   ・周方向に半径を揺らして縦皺を立てる
//   ・皺の位相を軸方向へ流して、筋が真っ直ぐ通らないようにする
// の3つが要る。輪の間隔で径を変えるやり方（＝節）だと蛇腹になるので、
// 半径は関数rAt(k)から連続で取る。
// atとtanAtは腕の芯線とその接線。曲がった芯にも巻けるようにしてある
function sleeveTube(mat, at, tanAt, k0, k1, rAt, o) {
  o = o || {};
  // 輪の間隔は「一番細かい揺らぎの半分」より狭くないと、その揺らぎが標本化で消える。
  // 袖口の下のギャザー（周期6cm前後）を出すので、20輪＝2.5cm間隔では足りない
  const RN = o.rings || 44;                       // 軸方向の輪の数
  const SN = o.seg || 28;                         // 周方向の分割
  const flat = o.flat != null ? o.flat : 0.88;    // 断面の扁平率。前腕は円柱ではない
  // 縦皺の深さ（半径比）。袖は画面上でも幅80pxしかないので、
  // 実寸2mm程度の皺は2pxの陰にしかならず、遠目には結局ただの円錐に見える。
  // 実物の袖のたるみと同じ5mm前後まで深くする
  const fold = o.fold != null ? o.fold : 0.105;
  const pos = [], uvs = [], idx = [], shade = [], fld = [];
  // 輪の向きは前の輪から送る（平行移動枠）。固定の基準軸から毎回作ると、
  // 曲がった芯線が基準と平行に近づいた所で輪が急にねじれて、皺が渦を巻く
  let ux = 0, uy = 0, uz = 0;
  let px = 0, py = 0, pz = 0, arc = 0;
  for (let i = 0; i <= RN; i++) {
    const k = k0 + (k1 - k0) * (i / RN);
    const c = at(k), t = tanAt(k);
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    const tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;
    if (i === 0) {
      // 最初の1本だけ、接線と平行でない軸から作る
      if (Math.abs(ty) < 0.9) { ux = 0; uy = 1; uz = 0; } else { ux = 1; uy = 0; uz = 0; }
    } else {
      arc += Math.hypot(c[0] - px, c[1] - py, c[2] - pz);
    }
    px = c[0]; py = c[1]; pz = c[2];
    // 接線成分を抜くだけで前の輪の向きが引き継がれる
    const d = ux * tx + uy * ty + uz * tz;
    ux -= tx * d; uy -= ty * d; uz -= tz * d;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const r0 = rAt(k);
    // 皺の位相を腕の長さで送ると皺がゆっくりねじれ、袖が腕に巻き付いて見える。
    // ただし一様回転(arc*8)だけだと、輪郭に当たる角度が輪ごとに滑らかに変わるので
    // シルエットは山の包絡線をなぞって放物線から1pxも外れない（実測rms0.9〜1.3px）。
    // 位相を不規則に振って、輪郭の位置に山が来る輪と谷が来る輪を作る。
    // 【振りすぎ厳禁】位相の変化率がそのまま面の軸方向の傾きになる。
    // 一様回転(8)だけだと傾き0.05でどこも真っ平ら＝配管に見えるが、
    // 一度23と53で1.5/0.8まで振ったら傾きが0.53（28度）になり、
    // 面が空を拾って青い筋が走り、法線がばらけて「濡れた金属箔」になった。
    // 傾きが0.15を超えない範囲（変化率20前後まで）に収める
    const ph = arc * 8 + Math.sin(arc * 13 + 0.7) * 0.55 + Math.sin(arc * 29 + 2.1) * 0.22;
    // 袖口の折り返し(外径0.0416)と袖の皮(同じ所で0.0412)の隙間は0.4mmしかない。
    // ここで径を揺らすと皺の山が折り返しを突き抜けて、縁に沿って黒い溝が1本開く。
    // ただし振幅を殺す区間を5cmも引きずると、実物なら一番布が寄る折り返しの直下が
    // 完全な真円になる。折り返しの口(arc=0.040)を出た直後に立ち上げる
    const out = ease(clamp01((arc - 0.040) / 0.014));
    const amp = fold * out;
    // 折り返しの直下のギャザー。締めた口の下では布が寄って膨らむ。
    // 山側だけ(0..1)に出すので、設計半径より細くなる所は作らない
    // ＝SLの単調増加が画面上のくびれに化けない
    const gd = (arc - 0.075) / 0.060;
    const gth = fold * 0.80 * out * Math.exp(-gd * gd);
    // 芯線の蛇行。皺を半径の変調(r0*(1+w))だけで作ると、周期が腕の長さ級に長いので
    // 輪郭が2次曲線から1pxも外れず「数学的に滑らかな円錐」に読める。
    // 芯そのものを数cm周期で振ると、左右の輪郭が同じ向きに揺れて幅は保ったまま
    // 輪郭だけが割れる。折り返しの中では振れないよう、こちらは緩やかに立ち上げる。
    // 振幅3.8mm＝画面上2.7pxでは輪郭を割るのに足りなかったので、
    // 6.0mm（画面上4px前後）まで上げて、周期の方は緩めて折れが尖らないようにする。
    // 【この項は幅を変えない】左右の輪郭が同じ向きに動くだけなので、
    // 半径の単調増加（＝くびれを作らない）は壊さない
    const mn = 0.0060 * ease(clamp01((arc - 0.042) / 0.050));
    const mu = (Math.sin(arc * 27 + 1.1) + Math.sin(arc * 61 + 0.4) * 0.45) * mn;
    const mv = (Math.sin(arc * 39 + 2.3) + Math.sin(arc * 19) * 0.60) * mn;
    for (let j = 0; j <= SN; j++) {
      const a = (j / SN) * Math.PI * 2;
      // 皺の本数。主の山を4本にしていたが、1周に4山あると輪郭の接線方向から
      // ±45度以内に必ず山が来るので、シルエットは常に山の包絡線をなぞって滑らかになる。
      // 3本にすると輪郭の両側(a と a+π)で cos の符号が逆になり、
      // 片側が張り出す時にもう片側が引っ込む＝幅は保ったまま芯が振れて見える。
      // 振幅の合計は前と同じなので、袖の太さ(半径の±15%)は変えていない
      // 3本だけだと画面には太い帯が2本しか出ず、腕が三角柱に見える。
      // 細かい方(7本)を厚くして、太い山の上に細かい目を乗せる。
      // 合計の振幅は前と同じ1.68倍のままなので袖の太さは変わらない
      const wf = Math.cos(a * 3 + ph) * amp
        + Math.cos(a * 7 - ph * 0.6) * amp * 0.50
        // 斜めに1本。肘へ向かって布が寄る（たるみ）を作る
        + Math.cos(a * 5 - arc * 22 + ph * 0.35) * amp * 0.18;
      // ギャザーは山側だけの膨らみなので、皺の陰影には混ぜない
      // （混ぜると折り返しの下だけ一様に明るくなって帯に見える）
      const w = wf + (Math.cos(arc * 96 + a * 1.6) * 0.5 + 0.5) * gth;
      const r = r0 * (1 + w);
      const ca = Math.cos(a) * r + mu, sa = Math.sin(a) * r * flat + mv;
      pos.push(c[0] + ux * ca + vx * sa, c[1] + uy * ca + vy * sa, c[2] + uz * ca + vz * sa);
      // 皺の谷と山を頂点色に焼く。
      // ビューモデルのカメラ側の面は太陽の裏側なので、当たっているのは半球光と
      // 弱い当て光だけ＝どの向きを向いても同じ明るさが返る。つまり形だけ皺を作っても
      // 陰影が1段も出ず、結局のっぺりした円錐に見える（実測: 袖を横切って輝度67が一定）。
      // 【上限は必ず1.0】ここは正規化Uint8のcolorに入る掛け算の係数で、1.0が素のアルベド。
      // 以前は上限1.05で焼いていて、山の1.05*255=267がUint8で11に折り返り、
      // 山が真っ黒な縦縞に反転していた（袖の頂点の21.6%が0〜15に落ちていた）。
      // 係数を1.6から0.60へ落としてあるのは、画面に出す陰影をここで作るのをやめたから。
      // ここはトーンマップの前なので、いくら振っても画面では1.4倍に潰れるうえ、
      // 1.6倍だと頂点の6%が上限1.0に当たって山の頭が平らに削られていた。
      // 実際の濃淡はMATS.sleeveSkinのフラグメント側（トーンマップの後）で付ける
      shade.push(clamp(0.80 + w * 0.60, 0.55, 1.0));
      // 皺の量そのもの。-1..+1へ正規化してフラグメントへ渡す。
      // 折り返しの中(out=0)では0になるので、隠れている区間には陰影が付かない
      fld.push(wf / (fold * 1.68));
      // 織り目の目の大きさを袖の長さに依らず一定にする。
      // uvを0..1で張ると、長い袖ほど目が伸びて手袋と質感が揃わない
      uvs.push((j / SN) * (r0 * 6.283 / 0.09), arc / 0.09);
    }
  }
  for (let i = 0; i < RN; i++) {
    for (let j = 0; j < SN; j++) {
      const a = i * (SN + 1) + j, b = a + SN + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // 両端に蓋。肘側は画面外へ抜けるので普段は見えないが、
  // 装填で腕が振られた時に開いた口から中が抜けて背景が見えるのを塞いでおく
  for (const e of [0, 1]) {
    const row = e ? RN * (SN + 1) : 0;
    const c = at(e ? k1 : k0);
    const ci = pos.length / 3;
    pos.push(c[0], c[1], c[2]);
    uvs.push(0.5, e ? k1 / 0.09 : k0 / 0.09);
    shade.push(0.80);
    fld.push(0);
    for (let j = 0; j < SN; j++) {
      if (e) idx.push(ci, row + j, row + j + 1);
      else idx.push(ci, row + j + 1, row + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // 接触影の焼き込みと同じ器（正規化Uint8のcolor）に入れる。
  // 型が違うと材質ごとの結合(mergeGeometries)が失敗して、焼き込み自体が捨てられる
  // Uint8Arrayへの代入は256で折り返す。0..1で持っている係数を、
  // 丸めと上限を通してから入れる（素で入れると255超が小さい値に化ける）
  const cb = new Uint8Array(shade.length * 3);
  for (let i = 0; i < shade.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round(shade[i] * 255)));
    cb[i * 3] = cb[i * 3 + 1] = cb[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cb, 3, true));
  // 皺の量。頂点色と別に持たせるのは、頂点色が接触影と掛け合わされるため。
  // この属性を読む材質(MATS.sleeveSkin)は袖の皮だけが使うので、
  // 材質ごとの結合で属性の顔ぶれが食い違うことはない
  g.setAttribute('fold', new THREE.Float32BufferAttribute(fld, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 継ぎ目の2列は同じ位置に頂点が重なっているのに法線が別々に出る。
  // 均さないと袖に縦の筋が1本入って、そこだけ折り目のように光る
  const nr = g.attributes.normal.array;
  for (let i = 0; i <= RN; i++) {
    const a = i * (SN + 1) * 3, b = (i * (SN + 1) + SN) * 3;
    for (let c = 0; c < 3; c++) {
      const m = (nr[a + c] + nr[b + c]) * 0.5;
      nr[a + c] = m; nr[b + c] = m;
    }
  }
  const m = new THREE.Mesh(g, mat);
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// 指定方向を軸にした輪。袖口のバンドなど
function ringAt(mat, p, dir, r, t) {
  const m = new THREE.Mesh(torG(rnd4(r), rnd4(t), 6, 14), mat);
  m.position.set(p[0], p[1], p[2]);
  m.quaternion.setFromUnitVectors(_fwd, _v.set(dir[0], dir[1], dir[2]).normalize());
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

/* ------------------------------------------------------- 共通ディテール */

// ピカティニーレール。刻みを歯として実際に立てると「箱」が「機械」に見える
// ピカティニーレール。刻みを歯として実際に立てると「箱」が「機械」に見える。
// 歯のピッチが粗いと、目から14cmしか離れていないADSでレゴのブロックに見えるので細かく刻む。
// 歯の上面も面取り箱にして、階段状の輪郭が高コントラストの直線にならないようにする
function addRail(g, y, z0, z1, w = 0.024, m = MATS.anodized) {
  const len = z1 - z0, mid = (z0 + z1) / 2;
  g.add(part(cboxG(w, 0.005, len), m, 0, y, mid));
  const pitch = 0.0082;
  const n = Math.max(2, Math.floor(len / pitch));
  const start = mid - (n * pitch) / 2 + pitch / 2;
  for (let i = 0; i < n; i++) {
    const zz = start + i * pitch;
    g.add(part(chamferBoxG(w * 0.94, 0.005, 0.0050, 0.0009), m, 0, y + 0.005, zz));
    // 上面を細くして台形にすると実物の断面に近づく
    g.add(part(chamferBoxG(w * 0.62, 0.003, 0.0050, 0.0008), m, 0, y + 0.0089, zz));
  }
}

// ネジ。1本1本は見えなくても、あると組み立てられた物に見える
function addScrewX(g, x, y, z, r = 0.0036) {
  g.add(part(cylG(r, r, 0.0022, 8), MATS.steel, x, y, z, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.0026, r * 1.7, r * 0.45), MATS.enamel, x + (x > 0 ? 0.0006 : -0.0006), y, z));
}

// 通気孔。黒い丸を貼るだけだと板に見えるので、面取りのリングで厚みを出す。
// さらに内壁の筒を通して底板を沈める。表面と同じ高さに黒い円板を置くだけだと
// 穴の深さがゼロになり、貼り付けたシールにしか見えない
function addVentX(g, x, y, z, r = 0.006) {
  const sx = x > 0 ? 1 : -1;
  const ir = rnd4(r * 0.78);
  g.add(part(torG(rnd4(r), rnd4(r * 0.30), 6, 12), MATS.phosphate, x, y, z, 0, Math.PI / 2, 0));
  g.add(part(cylG(ir, ir, 0.007, 12, true), MATS.opticTube, x - sx * 0.0035, y, z, 0, 0, Math.PI / 2));
  g.add(part(cylG(ir, ir, 0.0015, 12), MATS.enamel, x - sx * 0.0068, y, z, 0, 0, Math.PI / 2));
}

// 刻印風の凹み。細い溝を数本並べるだけで「何か彫ってある」ように見える
function addStampX(g, x, y, z, w, h, rows = 3) {
  for (let i = 0; i < rows; i++) {
    const yy = y + (i - (rows - 1) / 2) * (h / rows);
    g.add(part(boxG(0.0012, (h / rows) * 0.40, w), MATS.enamel, x, yy, z));
  }
}

// スリングを通す環
function addSlingLoop(g, x, y, z, r = 0.0085) {
  g.add(part(torG(rnd4(r), 0.0022, 6, 12), MATS.steel, x, y, z, 0, Math.PI / 2, 0));
  g.add(part(boxG(0.006, 0.010, 0.010), MATS.phosphate, x, y + r * 0.9, z));
}

/* --------------------------------------------------------- 接触影(AO) */

// ビューモデルにはGTAOも影も掛からない。何もしないと手と握把の接触部、
// マグウェルの奥、光学の下、銃床の継ぎ目が全部同じ明るさになり、
// 部品同士が「触れている」情報がゼロになる（＝紺黒の一様な塊に潰れる）。
// レイを1本ずつ飛ばすのは高いので、部品を粗い格子へ焼いてから
// 頂点のまわりだけを数える。これなら焼き込みは一瞬で済む。
const AO_CELL = 0.004;
const AO_STEP = [0.006, 0.014, 0.024, 0.038];
const AO_W = [1.0, 0.72, 0.46, 0.26];
const _aoN = new THREE.Vector3();
const _aoT = new THREE.Vector3();
const _aoB = new THREE.Vector3();
const _aoD = new THREE.Vector3();

function bakeAO(list) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const g of list) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    }
  }
  if (!(x1 > x0 || y1 > y0 || z1 > z0)) return false;
  const pad = AO_CELL * 3;
  x0 -= pad; y0 -= pad; z0 -= pad;
  const nx = Math.ceil((x1 + pad - x0) / AO_CELL) + 1;
  const ny = Math.ceil((y1 + pad - y0) / AO_CELL) + 1;
  const nz = Math.ceil((z1 + pad - z0) / AO_CELL) + 1;
  // 極端に大きい塊は格子が膨らむので諦める。見た目が元に戻るだけで壊れはしない
  if (nx * ny * nz > 4e6) return false;
  const grid = new Uint8Array(nx * ny * nz);

  // 三角形の面上を刻んで塗る。境界箱で塗ると、斜めに伸びた長い面（袖の筒など）が
  // 空っぽの箱ごと埋めてしまい、周り全部が遮蔽扱いになって銃も手も一様に暗くなる
  const step = AO_CELL * 0.5;
  const put = (px, py, pz) => {
    const i = ((px - x0) / AO_CELL) | 0;
    const j = ((py - y0) / AO_CELL) | 0;
    const k = ((pz - z0) / AO_CELL) | 0;
    if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) grid[(i * ny + j) * nz + k] = 1;
  };
  for (const g of list) {
    const p = g.attributes.position.array;
    const ix = g.index ? g.index.array : null;
    const n = ix ? ix.length : p.length / 3;
    for (let f = 0; f + 2 < n; f += 3) {
      const va = (ix ? ix[f] : f) * 3;
      const vb = (ix ? ix[f + 1] : f + 1) * 3;
      const vc = (ix ? ix[f + 2] : f + 2) * 3;
      const ux1 = p[vb] - p[va], uy1 = p[vb + 1] - p[va + 1], uz1 = p[vb + 2] - p[va + 2];
      const ux2 = p[vc] - p[va], uy2 = p[vc + 1] - p[va + 1], uz2 = p[vc + 2] - p[va + 2];
      const n1 = Math.min(400, Math.max(1, Math.ceil(Math.hypot(ux1, uy1, uz1) / step)));
      const n2 = Math.min(400, Math.max(1, Math.ceil(Math.hypot(ux2, uy2, uz2) / step)));
      for (let s = 0; s <= n1; s++) {
        const fs = s / n1;
        const lim = Math.max(1, Math.round(n2 * (1 - fs)));
        for (let t = 0; t <= lim; t++) {
          const ft = (t / lim) * (1 - fs);
          put(p[va] + ux1 * fs + ux2 * ft,
            p[va + 1] + uy1 * fs + uy2 * ft,
            p[va + 2] + uz1 * fs + uz2 * ft);
        }
      }
    }
  }

  const hit = (px, py, pz) => {
    const i = ((px - x0) / AO_CELL) | 0;
    if (i < 0 || i >= nx) return 0;
    const j = ((py - y0) / AO_CELL) | 0;
    if (j < 0 || j >= ny) return 0;
    const k = ((pz - z0) / AO_CELL) | 0;
    if (k < 0 || k >= nz) return 0;
    return grid[(i * ny + j) * nz + k];
  };

  const CT = Math.cos(0.96), ST = Math.sin(0.96);   // 約55度に開いた傘
  for (const g of list) {
    const p = g.attributes.position.array;
    const na = g.attributes.normal.array;
    const cnt = p.length / 3;
    // 部品側が先に焼いてある陰影があれば掛け合わせる。上書きすると、
    // 格子(4mm)より広くて浅い凹凸——袖の皺のような物——の陰が全部消える
    const pre = g.getAttribute('color');
    const pa = pre ? pre.array : null;
    const col = new Uint8Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      const o = i * 3;
      _aoN.set(na[o], na[o + 1], na[o + 2]);
      if (_aoN.lengthSq() < 1e-8) _aoN.set(0, 1, 0); else _aoN.normalize();
      // 接線の基準。法線と平行にならない軸を選ぶ
      _aoT.set(Math.abs(_aoN.y) > 0.9 ? 1 : 0, Math.abs(_aoN.y) > 0.9 ? 0 : 1, 0)
        .cross(_aoN).normalize();
      _aoB.copy(_aoN).cross(_aoT);
      // 自分の面のセルを拾わないよう、法線方向へ持ち上げてから飛ばす
      const sx = p[o] + _aoN.x * 0.007;
      const sy = p[o + 1] + _aoN.y * 0.007;
      const sz = p[o + 2] + _aoN.z * 0.007;
      let occ = 0;
      for (let d = 0; d < 5; d++) {
        if (d === 0) _aoD.copy(_aoN);
        else {
          const t = (d - 1) * Math.PI * 0.5;
          _aoD.copy(_aoN).multiplyScalar(CT)
            .addScaledVector(_aoT, ST * Math.cos(t))
            .addScaledVector(_aoB, ST * Math.sin(t));
        }
        for (let s = 0; s < AO_STEP.length; s++) {
          const t = AO_STEP[s];
          if (hit(sx + _aoD.x * t, sy + _aoD.y * t, sz + _aoD.z * t)) { occ += AO_W[s]; break; }
        }
      }
      // 真っ黒まで落とすと部品が消えるので下限を作る。
      // ただし0.55は浅すぎて、指と先台の接触部が周囲と同じ輝度のままだった
      // （＝握力も接地も感じられない）。手袋のアルベドを落としたぶん余裕ができたので、
      // 接触が読めるところまで下限を下げる
      const ao = clamp(1 - (occ / 5) * 0.95, 0.42, 1) * (pa ? pa[o] / 255 : 1);
      col[o] = col[o + 1] = col[o + 2] = ao * 255;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  }
  return true;
}

// 頂点カラーを読む材質は別インスタンスが要る。元の材質1つにつき1個だけ作って使い回す
const _aoMat = new Map();

// 部品を増やすと描画呼び出しが膨らむので、動かない部品は材質ごとに1つへ結合する。
// 動く部品（ボルト・弾倉・手・引金）は別のGroupに入れてあるので対象外になる
function bakeStatic(group) {
  const byMat = new Map();
  const keep = [];
  const solid = [];
  for (const c of group.children) {
    // 描画順を指定してある板（ドット・滲み・映り込み）は結合すると順序が消えるので触らない
    if (c.isMesh && c.userData.keep !== true) {
      let list = byMat.get(c.material);
      if (!list) { list = []; byMat.set(c.material, list); }
      c.updateMatrix();
      const g = c.geometry.clone().applyMatrix4(c.matrix);
      list.push(g);
      // 半透明（レンズ・コーティング）に接触影を焼くとガラスが濁るので外す
      if (!c.material.transparent && g.attributes.normal) solid.push(g);
    } else {
      keep.push(c);
    }
  }
  if (byMat.size === 0) return group;
  const shaded = solid.length > 0 ? bakeAO(solid) : false;
  const merged = [];
  for (const [m, list] of byMat) {
    const geo = mergeGeometries(list, false);
    // 結合に失敗したら元のまま使う。見た目は変わらないので黙って諦めてよい
    if (!geo) return group;
    let mm = m;
    if (shaded && geo.getAttribute('color')) {
      mm = _aoMat.get(m);
      // cloneはonBeforeCompileとプログラムの鍵を写さない。
      // 手袋の縁光はここを通った複製の方が実際に描かれるので、明示的に引き継ぐ
      if (!mm) {
        mm = m.clone();
        mm.vertexColors = true;
        mm.onBeforeCompile = m.onBeforeCompile;
        mm.customProgramCacheKey = m.customProgramCacheKey;
        _aoMat.set(m, mm);
      }
    }
    const mesh = new THREE.Mesh(geo, mm);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    merged.push(mesh);
  }
  group.clear();
  for (const c of keep) group.add(c);
  for (const m of merged) group.add(m);
  return group;
}

/* ------------------------------------------------------------ 手 */

// 手袋をした手。指を1本ずつ精密に作るのではなく「握りの円弧に沿って節を並べる」方式にする。
// 銃モデルの子として置けば銃の動きにそのまま追従するので、手の姿勢制御が要らない。
// s=+1が右手、-1が左手。X座標にsを掛けるだけで鏡像になる
function buildHand(s, o) {
  o = o || {};
  const h = new THREE.Group();
  const R = o.gripR != null ? o.gripR : 0.022;   // 握る対象の半径
  const fr = 0.0094;                              // 指の基準の太さ
  const rr = R + fr * 0.85;                       // 指の芯が通る半径
  // 指先を対象の裏側まで回り込ませる量。ここが足りないと輪が閉じず、
  // 手が対象の手前に浮いているようにしか見えない（左右の隙間から背景が見える）
  const wrap = o.wrap != null ? o.wrap : 0;
  // 末節の回り込み角の補正。太い先台を掴む手はここを詰めないと、
  // 指先が対象の側面を通り越して天面へ回り込み、上に載っている物（レール）を貫通する
  const tip = o.tip != null ? o.tip : 0;
  // 握り軸まわりに手ごと回す量。正で甲が対象の天面側へ回る（左右どちらの手でも同じ向き）。
  // 先台を真横から握らせると指が全部裏側へ回って、画面には甲の塊しか出ない。
  // 甲を斜め上へ起こすと、指の付け根から第2関節までがこちら側の面に並んで
  // 「4本の指で握っている」情報が出る。CoD系のビューモデルはこの角度で見せている
  const roll = o.roll || 0;
  // 指1本ごとに握り角をずらす量（人差し指から小指へ等差）。
  // 支え手の視線は指の並びとほぼ平行(24度)で、4本ぶんの並びが画面上19pxにしかならない。
  // 手ごと傾ければ並びは寝るが、手首まで一緒に振れて前腕が銃を横切ってしまう。
  // 指だけを握り軸まわりにずらすと、付け根の線が斜めの階段になって
  // 「4本ある」情報が出る。回り込みの角度が変わるだけなので接地は崩れない
  const skew = o.skew || 0;
  // 甲・掌・手首はPを通らないので、同じ量だけ回す関数を別に用意する。
  // ここを回し忘れると指だけ動いて甲が元の面に残り、手がねじ切れて見える
  const around = (x, y, z, r) => [
    (Math.cos(r) * x - Math.sin(r) * z) * s, y, Math.cos(r) * z + Math.sin(r) * x];
  // a=0で手の甲側(+X*s)、a=PI/2で前方(-Z)。手はs側から回り込んで握る
  const P = (a, y, k) => {
    const A = a - roll;
    return [Math.cos(A) * rr * (k || 1) * s, y, -Math.sin(A) * rr * (k || 1)];
  };
  // 指の節の皺。カプセル1本を暗い細い輪で区切るだけで、
  // 「無地の白いプラスチックの棒」から「関節のある指」に変わる
  const crease = (p0, p1, r) => {
    const m = new THREE.Mesh(torG(rnd4(r), 0.0022, 4, 10), MATS.palm);
    m.position.set(p1[0], p1[1], p1[2]);
    m.quaternion.setFromUnitVectors(_fwd,
      _v.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize());
    m.castShadow = false; m.receiveShadow = false;
    return m;
  };
  // 握り軸（ローカルY）まわりの円弧。指と指の谷を埋める継ぎ目に使う。
  // torGはXY平面の輪なのでX軸まわりに倒す。倒した後の輪の角uと握り角aの対応は
  // 右手がu=a-roll、左手が鏡像なのでu=PI-a+roll。オイラー順YXZで
  // 「倒してから握り軸まわりに回す」を1回で書く
  const arcRing = (mat, a0, a1, y, r, t) => {
    const m = new THREE.Mesh(torG(rnd4(r), rnd4(t), 4, 14, rnd4(a1 - a0)), mat);
    m.position.set(0, y, 0);
    m.rotation.set(-Math.PI / 2, s > 0 ? a0 - roll : Math.PI - a1 + roll, 0, 'YXZ');
    m.castShadow = false; m.receiveShadow = false;
    return m;
  };

  // 人差し指・中指・薬指・小指。下にいくほど細く、回り込みも浅くする。
  // 【不変条件】隣の指の間隔は、両方の指の半径の和より必ず大きくする。
  // 以前は間隔0.019に対し半径の和が0.0199〜0.0173で、上2組は重なって
  // 面がつながっていた（＝谷が幾何として存在しない＝完全なミトン）。
  // 実測でも走査線ごとの断片が全行1本、指の谷は0本だった。
  // 4本で83mmは実寸の手の幅どおりで、間隔0.0215に対し和は0.0182以下に収まる
  const FING = [
    { y: 0.0210, r: 0.0090, a: [-0.14, 0.98, 1.94] },
    { y: -0.0005, r: 0.0092, a: [-0.16, 1.04, 2.06] },
    { y: -0.0220, r: 0.0086, a: [-0.16, 1.00, 2.00] },
    { y: -0.0435, r: 0.0076, a: [-0.18, 0.92, 1.86] },
  ];

  // 人差し指ほど浅く、小指ほど深く回り込ませる。逆向き（人差し指を深く）にすると、
  // 小指の当て革が天面のレールの歯へ乗り上げる（小指は手の中で一番肘寄り＝
  // 一番レールに近い位置にいるので、この向きしか取れない）
  const skewOf = (i) => (i - 1.5) * skew;
  for (let i = 0; i < FING.length; i++) {
    if (i === 0 && o.trigger) continue;   // 人差し指は引金用に別で作る
    const f = FING[i];
    const sk = skewOf(i);
    // 【不変条件】節の芯は「握り面＋その節の半径」より内へ入れない。
    // 握り軸(手の原点)は銃身芯より6mm下にあるので、天面側では握り面までの距離が
    // 内接半径28.6mmではなく34.6mmになる。ここを見落として全部k=1.0で置いていたので、
    // 付け根が先台の面より7.3mm内側に埋まり、指の腹が半分飲まれていた
    const p0 = P(f.a[0] + sk, f.y, 1.05);
    // 基節の中間。付け根から第2関節まで(60度以上)を1本の直線で結ぶと、
    // 弦が握りの円より内側へ落ちて指の腹が対象の面に埋まり、
    // 画面には両端しか出ない＝4本が1枚の板に溶ける。中間を外へ張らせて弧にする
    const pm = P((f.a[0] + f.a[1]) * 0.5 + sk, f.y - 0.001, 1.09);
    const p1 = P(f.a[1] + sk, f.y - 0.002, 1.02);
    // 第2関節から末節の付け根までも60度近くある。ここを直線1本で結ぶと
    // 基節と同じ理由で弦が沈み、末節の付け根が先台に9mm埋まる。同じく中間を張る
    const pn = P((f.a[1] + f.a[2] + tip + wrap * 0.55) * 0.5 + sk, f.y - 0.003, 1.08);
    // 末節を2本に割って、対象の裏側へ回り込む弧を作る。
    // 先端の1節だけ半径を絞り、握り半径よりわずかに内へ入れて肉が潰れた接地にする
    const p2 = P(f.a[2] + sk + tip + wrap * 0.55, f.y - 0.004, 0.97);
    const p3 = P(f.a[2] + sk + tip + wrap, f.y - 0.006, 0.94);
    h.add(capBetween(MATS.glove, p0, pm, f.r));
    h.add(capBetween(MATS.glove, pm, p1, f.r * 0.96));
    h.add(capBetween(MATS.glove, p1, pn, f.r * 0.93));
    h.add(capBetween(MATS.glove, pn, p2, f.r * 0.90));
    h.add(capBetween(MATS.glove, p2, p3, f.r * 0.80));
    // 関節の皺。隣の指との境目は画面上1px以下に潰れて読めないが、
    // 指を横切るこの輪は指の並びと直角なので潰れない。
    // 「付け根の膨らみ→皺→節→皺→節」の縞が出れば、1本ずつ見えなくても指として読める
    h.add(crease(p0, pm, f.r * 0.99));
    h.add(crease(pm, p1, f.r * 0.97));
    h.add(crease(pn, p2, f.r * 0.90));
    // 拳の当て革。甲側の関節に硬い面を置くと戦術手袋らしくなる。
    // 指の面(rr+f.r)より7mmも外へ出していたので、当て革だけが独立した瘤3個として写り、
    // 指の付け根は全部その裏に隠れていた。指の面から2mmだけ盛り上がる高さに詰めて、
    // 4個が並んだ拳の稜線として読ませる。
    // 位置はp0を定数倍せず握り角から取り直す。p0側にkを入れた時に一緒にずれるため
    const kp = P(f.a[0] + sk, f.y + 0.004, 1.11);
    h.add(partS(sphG(1), MATS.gloveHard, kp[0], kp[1], kp[2],
      f.r * 0.94, f.r * 0.88, f.r * 0.94));
  }

  // 指と指の谷。間隔を広げて幾何の谷は開いたが、視線が指の並びとほぼ平行なので
  // 画面上は1px強にしかならない。谷の底に暗い継ぎ目を渡して明度でも段を作る。
  // 併せて、指の間に開いた隙間から背景が抜けるのも塞ぐ（装填で手が銃から離れた時に出る）
  for (let i = 0; i < FING.length - 1; i++) {
    if (i === 0 && o.trigger) continue;
    const f0 = FING[i], f1 = FING[i + 1];
    const sk = (skewOf(i) + skewOf(i + 1)) / 2;
    // 終点は第2関節の少し先まで。指先まで伸ばすと、末節が握り半径より内へ絞ってある
    // ぶんだけ継ぎ目が指の外へはみ出して、手から細い黒針が生えて見える
    // 半径は指の芯(rr*1.05)に合わせる。rrのままだと谷の継ぎ目だけ指より内へ落ちて、
    // 握り面の中に沈む（＝谷が幾何としてまた消える）
    h.add(arcRing(MATS.palm, f0.a[0] + sk - 0.10, Math.min(f0.a[1], f1.a[1]) + sk + 0.42,
      (f0.y + f1.y) / 2, rr * 1.05, Math.min(f0.r, f1.r) * 0.82));
  }

  // 引金にかける人差し指。ピボットを別Groupにして引く動きを付けられるようにする
  if (o.trigger) {
    const f = FING[0];
    const k = P(f.a[0], f.y);
    const pv = new THREE.Group();
    pv.position.set(k[0], k[1], k[2]);
    pv.add(capBetween(MATS.glove, [0, 0, 0], [-0.015 * s, 0.016, -0.016], f.r));
    pv.add(capBetween(MATS.glove, [-0.015 * s, 0.016, -0.016], [-0.026 * s, 0.024, -0.033], f.r * 0.9));
    pv.add(partS(sphG(1), MATS.gloveHard, 0.001 * s, 0.005, 0.001, 0.014, 0.011, 0.014));
    h.add(pv);
    h.userData.index = pv;
    h.userData.indexZ = k[2];
  }

  // 親指。指と同じ側で止めると何にも触れない灰色のヘラになるので、
  // 指先と向かい合う側まで回して輪を閉じる。回す量はwrapに連動させる
  // 親指の中節は握り半径の6%外を通していたが、先台を上から掴む左手ではこの1本が
  // 天面(＝レールの歯)の高さを通って刺さっていた。実物どおり握り面に密着させる。
  // ただし2本の直線で1.99radを渡していたので、弦の真ん中が握り円より9mm内へ落ちて
  // 先台に13.3mm埋まっていた（指と同じ弦の罠）。3本に割って中間を外へ張る。
  // 親指の先も、握り角の位置から取り直す（Math.cosにrollを入れ忘れていて、
  // 手を起こすほど指先だけ別の場所に置き去りになっていた）
  // 節を1本増やして、握り軸の真上(a=roll-π/2≒-1.05)にちょうど節を置く。
  // 3本だと真上を弦がまたぐので、そこを外へ張るために両端のkを上げるしかなく、
  // 親指の頂点が実寸より9mm高くなってADSの開口の下側へ余計に入っていた
  const th = -1.85 - wrap * 0.90;
  h.add(capBetween(MATS.glove, P(-0.42, 0.030, 1.12), P(-0.74, 0.033, 1.14), 0.0112));
  h.add(capBetween(MATS.glove, P(-0.74, 0.033, 1.14), P(-1.05, 0.035, 1.12), 0.0110));
  h.add(capBetween(MATS.glove, P(-1.05, 0.035, 1.12), P(-1.70, 0.037, 1.19), 0.0106));
  h.add(capBetween(MATS.glove, P(-1.70, 0.037, 1.19), P(th, 0.034, 1.21), 0.0100));
  // 親指の先。1節細くして指先の丸みを作る
  const tp = P(th, 0.033, 1.19);
  h.add(partS(sphG(1), MATS.glove, tp[0], tp[1], tp[2], 0.0092, 0.0088, 0.0092));

  // 手の甲と掌の肉。楕円体2つで丸みを付ける。
  // 薄い軸は握り面の法線方向なので、位置だけでなく向きも一緒に回す。
  // 【不変条件】甲は指の付け根(a=-0.16)より手前の角度に置き、指の上に被せない。
  // 前は握り角a=-0.09に接線方向±0.74radの塊を置いていたので、
  // カメラを向いている面(a=-1.55〜+1.59)のうち一番正面に近い所を甲1個で覆い、
  // 指の付け根から第2関節までが全部その裏に隠れていた（＝ミトン）。
  // around(d,y,0,roll-a)がP(a,y)と同じ位置になるので、握り角aで指定する。
  // 【不変条件その2】甲・掌の内面(中心−薄い軸)は握り面より内へ入れない。
  // 外径の条件だけ書いてあって内径の条件が無かったので、中心をrr-3mmに置いたまま
  // 薄い軸を12mm取っていた＝内面がrr-15mm＝先台の面より12.6mm内側で、
  // 甲の下半分が先台に飲まれていた（画面では手が先台に沈んで小さく見える）。
  // 握り軸は銃身芯より6mm下なので、天面側の握り面までは28.6ではなく34.6mm。
  // 中心をrr+7mmへ出し、薄い軸を7.5mmへ詰めて内面をrr-0.5mmに置く
  // 長さは肘側を4mm詰めてある。中心を10mm外へ出したぶん後端の極が持ち上がり、
  // SMGでは先台のレール(y=0.040, z=-0.170..-0.128)の箱へちょうど乗っていた（頂点11個）
  const BKA = -0.78;                                // 甲。指の付け根より手前
  const bk = around(rr + 0.0070, -0.003, 0, roll - BKA);
  h.add(partS(sphG(1), MATS.glove, bk[0], bk[1], bk[2], 0.0075, 0.029, 0.020,
    0, -(roll - BKA) * s, 0));
  // 掌の付け根。手首の出る所へ寄せて、手の塊と前腕をつなぐ肉にする。
  // 握り角0.15（＝指の基節の真下）に置くと、指の面より内側に埋まっていて
  // つなぎにならないうえ先台を11.8mm貫いていた。手首と同じ握り角へ回し、
  // 小指より肘寄り(y=-46mm)・指の面の外(rr+14mm)へ出して手首の筒と1つの塊にする
  const PLA = 0.90;
  const pl = around(rr + 0.014, -0.046, 0, roll - PLA);
  h.add(partS(sphG(1), MATS.palm, pl[0], pl[1], pl[2], 0.008, 0.020, 0.018,
    0, -(roll - PLA) * s, 0));
  // 甲の中央の縫い目。甲の面から浮かせると、細長い硬質材が空の反射を拾って
  // 手に金属の棒が刺さっているように光る。肉に半分埋めて筋としてだけ出す
  const sm = around(rr + 0.0125, -0.003, 0, roll - BKA);
  h.add(part(boxG(0.0035, 0.030, 0.0035), MATS.gloveHard, sm[0], sm[1], sm[2],
    0, -(roll - BKA) * s, 0));

  /* ---- 手首・袖口・前腕。境目を隠さないと手が宙に浮いて見える */
  const ad = o.armDir || [0.34 * s, -0.62, 0.70];
  const al = Math.hypot(ad[0], ad[1], ad[2]);
  const ux = ad[0] / al, uy = ad[1] / al, uz = ad[2] / al;
  // 手首の芯。[握り軸から離す量, 指の並び方向の位置, 握り軸まわりの高さ]。
  // 既定値は握把(R=0.021)に合わせてある。太い先台(R=0.031)を掴む支え手では
  // これでは全く足りず、手首の肉も袖口の帯も八角柱の中へ入って
  // 銃身の芯まで届いていた（実測: 帯の頂点の24.9%が内側、最大26.6mm）。
  // 前腕は径74〜92mmで先台(62mm)より太いので、二つの軸は
  // 「先台の面までの距離28.6mm＋前腕の半径」以上離すしかない。
  // rollは手首には4割だけ効かせる。前腕は手より下から入るので、
  // 甲と同じだけ回すと袖口が天面のレールへ乗り上げる。
  // 【不変条件】手首は握り軸まわりで指の列より下(握り角1.0前後)へ置く。
  // 目は手の左上にあるので、真横(握り角0.42)に置くと手首と前腕が
  // 目と指の間に入って中節を全部覆う。掌側は「真横」で解剖的には正しいが、
  // 実物のCクランプも手首は先台の下に落ちているので下側で合っている
  const WR = o.wrist || [R * 0.75 + 0.013, -0.052, 0.014];
  const W = around(WR[0], WR[1], WR[2], roll * 0.4);
  // 前腕は肘へ向かって外へ振れる。径のむらだけ付けた直線の筒だと、
  // 画面下辺で切れるまで滑らかに太っていくだけの「塗装した配管」に読める。
  // 軸に2次の曲がりを入れて、腕の傾きそのものを作る。
  // 曲げる向きは手の甲側(X軸のs側)から軸成分を抜いた向き。手の姿勢に依らず必ず外へ振れる
  let bx = s, by = 0, bz = 0;
  const bd = bx * ux + by * uy + bz * uz;
  bx -= ux * bd; by -= uy * bd; bz -= uz * bd;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  // 曲げが浅いと、径が変わるだけの真っ直ぐな棒になって画面下辺まで一直線に伸びる。
  // 実際の前腕は肘へ向かって体側へ寄るので、画面の隅へ弧を描いて抜けていく。
  // 0.20では弧が読めなかったので、肘の側で2cm以上振れる量まで強める
  const BEND = 0.46;
  const at = (k) => [
    W[0] + ux * k + bx * BEND * k * k,
    W[1] + uy * k + by * BEND * k * k,
    W[2] + uz * k + bz * BEND * k * k,
  ];
  // 曲がった軸に輪を巻くので、向きは接線を取り直す
  const tanAt = (k) => [ux + 2 * BEND * k * bx, uy + 2 * BEND * k * by, uz + 2 * BEND * k * bz];
  // 手首の肉。前はここをcapBetween(W, at(0.044), 0.021)で置いていた。
  // capBetweenは両端に半径ぶんの半球が生えるので、手側の端に半径21mmの
  // 無地のドームが立ち、目から見て中指〜小指の中節より25〜40mm手前に来て
  // 4本中3本を丸ごと覆っていた（画面上で直径30px、内側に縫い目も関節も無し）。
  // 半球を持たない先細りの筒に替え、太い側の端は締めの帯(半径30mm)の中へ入れて
  // 端面の円板を出さない。細い側は掌の肉の中に埋める
  h.add(tubeBetween(MATS.glove, at(-0.020), at(0.040), 0.0130, 0.0215, 14));
  // 筒の細い側の端は掌の肉の中にあるが、真円の切り口が半分だけ覗く。
  // 同じ半径の球で丸めておく（元のカプセルと違い、こちらは半径13mmなので指に掛からない）
  const we = at(-0.020);
  h.add(partS(sphG(1), MATS.glove, we[0], we[1], we[2], 0.0130, 0.0130, 0.0130));
  // 袖口の帯と締めの輪。手首のすぐ横に前腕の太さの筒を置くと必ず先台に食い込むので、
  // 手首から12mm肘寄りへずらし、手首の位置では実寸どおり細くする
  h.add(tubeBetween(MATS.strap, at(0.034), at(0.064), 0.0300, 0.0352, 16));
  h.add(ringAt(MATS.strap, at(0.042), tanAt(0.042), 0.0330, 0.0038));
  // 袖は必ず画面の外まで伸ばして、フレームの端で切れさせる。
  // 途中で終わると端面の円板が見えて、腕ではなく「端を塞いだ配管」に読めてしまう。
  // 袖の長さはビューモデルの縮尺に効く。右手の腕は肘＝目の方向へ伸びるので、
  // 銃を大きく構えると袖の先が目の前まで来て、近接面が画面いっぱいに引き伸ばされる。
  // 画面の端から外へ抜けさえすれば長さは要らないので、腕ごとに縮められるようにする
  const AL = o.armLen != null ? o.armLen : 1;
  // 前腕の太さの節。手首の径(0.076)が機関部の厚み(0.07強)に並ぶ所から始めて、肘へ太らせる。
  // 【不変条件】この列は必ず単調増加にする。
  // 途中で一度細くなる（＝くびれ）と人の腕には絶対に見えない。実物の前腕は
  // 手首から肘まで一度も細くならず、肘の手前で一番太くなる。
  // 以前の列は3番目でくびれていて、そこが配管の継ぎ手のように読めていた
  const SL = [[0.064, 0.0380], [0.130, 0.0442], [0.230, 0.0522], [0.350, 0.0630], [0.55, 0.0780]];
  // 節の間は直線で結ぶ。袖を1枚の皮として張るので、半径は連続で取れないといけない
  const rAt = (k) => {
    const t = k / AL;
    for (let i = 0; i + 2 < SL.length; i++) {
      if (t <= SL[i + 1][0]) {
        return lerp(SL[i][1], SL[i + 1][1],
          clamp01((t - SL[i][0]) / (SL[i + 1][0] - SL[i][0])));
      }
    }
    const n = SL.length - 1;
    return lerp(SL[n - 1][1], SL[n][1],
      clamp01((t - SL[n - 1][0]) / (SL[n][0] - SL[n - 1][0])));
  };
  // 皮だけ別材質にする。折り返し(下のtubeBetween)は皺の位相を持っていないので、
  // 同じ材質のまま増幅を掛けると遮蔽の差だけが強調されて縁が黒く回る
  h.add(sleeveTube(MATS.sleeveSkin, at, tanAt, SL[0][0] * AL, SL[SL.length - 1][0] * AL, rAt));
  // 袖口の折り返し。手首側へ向かって太くなる短い筒を重ねると、
  // 端に厚みのある縁が立って「布を折り返して留めてある」ように見える。
  // 袖の皮の口はこの中に隠すので、折り返しは袖より必ず太くしておく
  h.add(tubeBetween(MATS.sleeve, at(0.104 * AL), at(0.056 * AL), 0.0410, 0.0452, 20));
  // 袖のベルクロ帯。折り返しの上から締めるので、折り返しの外径より一回り太くする。
  // 布の中で唯一の硬い部品なので、ここだけ粗さが低く、縁にハイライトが1本立つ。
  // 細い帯を1本添えると、締め付けで布が寄っている段が出る
  h.add(ringAt(MATS.gloveHard, at(0.076 * AL), tanAt(0.076 * AL), 0.0442, 0.0042));
  h.add(ringAt(MATS.gloveHard, at(0.092 * AL), tanAt(0.092 * AL), 0.0418, 0.0022));

  bakeStatic(h);
  return h;
}

/* ------------------------------------------------------------ 光学サイト */

// 中身が詰まった箱で作ると覗いた時に真っ黒な壁になる。筒にして芯を通す。
//
// 【不変条件】覗いた時の視線は、接眼リム（内半径0.0195）を頂点にして
// 前へ広がる円錐になる。この円錐の内側に置いてよいのは筒の内壁とレンズとドットだけ。
// 円錐は前へ行くほど太くなるので「cy-0.021より上は禁止」のような固定の高さでは守れない。
// 部品を足す時は、外皮の半径(0.0245／対物側は最大0.0350)より外に置くか、
// 前へ出さないかのどちらかにする。マウントを板でなくリングにしてあるのはこのため
function addOptic(g, y, z) {
  const cy = y + 0.026;
  // ADSでは画面中央をこの1部品が占める。ここだけ分割を上げる。
  // 14角だと対物ベルの円周に平面ファセットが肉眼で数えられて、シェーディングが多角形に折れる
  const SEG = 40;

  // マウント。レールを跨ぐクランプとつまみネジを付けて「載せてある」感を出す
  g.add(part(cboxG(0.034, 0.013, 0.086), MATS.anodized, 0, y - 0.010, z));
  g.add(part(cboxG(0.040, 0.008, 0.030), MATS.anodized, -0.002, y - 0.009, z + 0.028));
  g.add(part(cylG(0.007, 0.007, 0.012, 12), MATS.steel, -0.021, y - 0.009, z + 0.028, 0, 0, Math.PI / 2));
  // 筒を抱えるリング部。ここを板や箱で作ると、上端が視線の円錐へ食い込んで
  // レンズの下側が黒く欠ける（clearより上は筒とレンズとドット以外置けない、の元凶）。
  // 実物どおり筒の外周を巻くリングにすれば、外皮より内へ入りようがないので原理的に安全
  for (const rz of [0.010, 0.034]) {
    g.add(part(torG(0.0262, 0.0035, 6, 26), MATS.anodized, 0, cy, z + rz));
    g.add(part(cboxG(0.012, 0.010, 0.012), MATS.anodized, 0, cy - 0.031, z + rz));
  }
  addScrewX(g, 0.0175, cy - 0.030, z + 0.010, 0.0030);
  addScrewX(g, -0.0175, cy - 0.030, z + 0.010, 0.0030);

  /* ---- 筒。
     【ケラレの不変条件】覗いた時に内壁が有効径を食うかどうかは、
     前の開口と後ろの開口が目から見て張る角度の大小だけで決まる。
     後ろ(接眼)の開口が張る角 > 前(対物)の開口が張る角 になった瞬間、
     その差の分だけ内壁が輪になって見える。今までは直筒だったので
     前の方が遠い＝角が小さく、開口の35〜45%が濃い灰色の内壁で埋まっていた。
     対物側を開いたベルにして、前の開口が張る角を後ろよりわずかに大きくすると
     開口いっぱいまで抜ける。実物のダットサイトが対物側で太いのはこれが理由。

     目までの距離: 接眼リム ≒ adsDist - 0.040*adsScale、対物リム ≒ adsDist + 0.045*adsScale。
     一番厳しいのは目に近いSMG(adsDist 0.136 / adsScale 0.70)で、0.108 と 0.1675、比 1.551。
     接眼の内半径0.0195に対し対物は0.0195*1.551=0.0303以上が要る。両銃を満たす0.0310で取る */
  // 内壁。接眼側の直筒
  g.add(part(cylG(0.0195, 0.0195, 0.050, SEG, true), MATS.opticTube, 0, cy, z + 0.015, Math.PI / 2));
  // 内壁。対物ベル（前へ開く）
  g.add(part(cylG(0.0195, 0.0310, 0.035, SEG, true), MATS.opticTube, 0, cy, z - 0.0275, Math.PI / 2));
  // 外皮。内壁と分けると筒に厚みが出る。ここも必ず両端を開ける。
  // 蓋が付いていると視線の先に黒い円板が立って、覗いた瞬間に何も見えなくなる
  g.add(part(cylG(0.0245, 0.0245, 0.052, SEG, true), MATS.gunmetal, 0, cy, z + 0.014, Math.PI / 2));
  // 対物ベルの外皮。ADSでは硝子の周りの黒い輪の太さがそのままここで決まる。
  // 外径がレンズ半径の1.3倍もあると、等倍のダットサイトとしては遮蔽が大きすぎるので
  // 内壁(0.0310)ぎりぎりまで絞って、輪をレンズ半径の1.16倍に収める
  g.add(part(cylG(0.0245, 0.0338, 0.036, SEG, true), MATS.gunmetal, 0, cy, z - 0.028, Math.PI / 2));
  // 前後のリム。対物側は面取りリングを2本重ねて、ベルの縁に細い鏡面ラインを走らせる
  g.add(part(torG(0.0248, 0.0034, 6, 28), MATS.anodized, 0, cy, z + 0.040));
  g.add(part(torG(0.0330, 0.0026, 6, 32), MATS.anodized, 0, cy, z - 0.0455));
  g.add(part(torG(0.0326, 0.0013, 5, 32), MATS.steel, 0, cy, z - 0.0405));
  // 対物ベゼルのローレット。画面中央を1部品が占めるのに、
  // 刻みもツマミも無い輪だと成形プラスチックの筒にしか見えない。
  // 実際に歯を立てると、覗いた時に縁へ細かい明暗の目が並ぶ
  g.add(part(torG(0.0338, 0.0026, 6, 32), MATS.knurl, 0, cy, z - 0.0400));
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.add(part(boxG(0.0026, 0.0026, 0.010), MATS.knurl,
      Math.cos(a) * 0.0348, cy + Math.sin(a) * 0.0348, z - 0.0400, 0, 0, a));
  }
  // 胴と対物の継ぎ目
  g.add(part(torG(0.0250, 0.0022, 5, 28), MATS.anodized, 0, cy, z - 0.010));

  // エレベーション（上下）の調整ツマミ。筒の天面に立てる。
  // 内壁(半径0.0195)より外なので視線の円錐には入らない
  g.add(part(cylG(0.0100, 0.0108, 0.016, 14), MATS.anodized, 0, cy + 0.030, z + 0.012));
  g.add(part(cylG(0.0086, 0.0086, 0.004, 14), MATS.steel, 0, cy + 0.039, z + 0.012));
  g.add(part(boxG(0.0030, 0.0016, 0.012), MATS.enamel, 0, cy + 0.0405, z + 0.012));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.add(part(boxG(0.0022, 0.014, 0.0022), MATS.knurl,
      Math.cos(a) * 0.0104, cy + 0.030, z + 0.012 + Math.sin(a) * 0.0104, 0, -a, 0));
  }

  // 輝度ダイヤル。内側の face は必ず外皮の面(x=0.0245)より外で止める。
  // これより内へ入れると、ダイヤルの上下の縁が視線の通り道（接眼の内半径0.0195の円）へ
  // 食い込んで、レンズの右端に黒い欠けが出る。円筒はx=0.0245〜0.0385。
  // 刻みもこの厚みの中へ収める。はみ出すと筒の横に短冊が浮いた「壊れたジオメトリ」に見える
  g.add(part(cylG(0.011, 0.012, 0.014, 14), MATS.anodized, 0.0315, cy, z + 0.012, 0, 0, Math.PI / 2));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    g.add(part(boxG(0.010, 0.0022, 0.0022), MATS.gunmetal,
      0.0325, cy + Math.cos(a) * 0.0122, z + 0.012 + Math.sin(a) * 0.0122));
  }
  // 電池キャップ。反対側も同じく内側の face を外皮の面で止める
  g.add(part(cylG(0.010, 0.010, 0.010, 14), MATS.anodized, -0.0295, cy, z + 0.012, 0, 0, Math.PI / 2));
  // 刻印は外皮(SEG角形なので面までの距離はほぼ半径そのもの)へ埋め込む。
  // 浮かせると筒の横に薄板が貼り付いただけに見える
  addStampX(g, 0.0242, cy - 0.009, z + 0.030, 0.016, 0.010, 2);

  /* ---- レンズ。対物ベルの内側いっぱいに張る。
     実物の透過率は90%前後で、覗けば外の世界がそのまま見える。
     ここを不透明寄りにすると「筒の中だけ別の絵」になって、サイトとして機能しない */
  // レンズは対物の口元へ寄せる。手前に置くと、レンズの縁と接眼リムの間に
  // 内壁の輪が残って「像の周りに灰色の帯」が出る
  // 外皮を絞ったぶんレンズは広げられる。硝子が広いほど覗いた時の視野が広い
  const lensR = 0.0308;
  // 球半径0.26mの浅いドーム。膨らみは1.8mmしかないが、
  // これがあるだけで縁の法線が視線から開いて、コーティングの色と反射が角度で振れる
  const DOME = 0.26;
  g.add(part(domeG(lensR, DOME, SEG), MATS.glass, 0, cy, z - 0.0425 + DOME, -Math.PI / 2));
  // 周縁の落ち込み。中心は素通しのまま外周だけ暗く沈めて、フレネルを代用する
  const edge = part(circG(lensR, SEG), MATS.lensEdge, 0, cy, z - 0.0400);
  edge.renderOrder = 16;
  edge.userData.keep = true;
  g.add(edge);
  // コーティング。中心が抜けて外周ほど青緑〜紫が乗る1枚を全面に敷く
  const coat = part(circG(lensR - 0.0006, SEG), MATS.coating, 0, cy, z - 0.0396);
  coat.renderOrder = 17;
  coat.userData.keep = true;
  g.add(coat);
  // 環境の映り込み。斜めの帯を薄く乗せる。
  // 板でやると四角い外形がそのまま継ぎ目として出るので、丸を縦に潰して使う
  const sheen = part(circG(0.021, 24), MATS.sheen, -0.008, cy + 0.008, z - 0.0414);
  sheen.scale.set(1.0, 0.42, 1);
  sheen.rotation.z = -0.7;
  sheen.renderOrder = 18;
  sheen.userData.keep = true;
  g.add(sheen);
  g.userData.sheen = sheen;

  /* ---- レティクル。滲みだけだと輪郭が無いので、細いリングと芯のドットで組む */
  // 滲みは芯に寄せる。リングと同じ大きさまで広げるとリングが滲みに溶けて輪郭が消える。
  // 芯を実MOAまで細くすると滲みの方が勝って「赤い丸シール」に逆戻りするので、
  // 滲みも芯に比例して詰める
  const glow = part(planeG(0.006, 0.006), MATS.dotGlow, 0, cy, z - 0.028);
  glow.renderOrder = 19;
  glow.userData.keep = true;
  g.add(glow);
  // 輪。ADSの画角(46度→1px=0.064度)で実測すると、半径0.0105の輪は直径300MOAあった。
  // EOTechの輪でも68MOAなので、30m先の敵の胴がまるごと入る大きさになっていた。
  // 130MOA相当（画面上で直径約68px）まで絞る
  const ring = part(torG(0.0045, 0.00035, 4, 40), MATS.reticle, 0, cy, z - 0.0272);
  ring.renderOrder = 20;
  ring.userData.keep = true;
  g.add(ring);
  // 芯。丸マスクの外周は透けるので、板の寸法より実際に光る芯は一回り小さくなる。
  // 0.0048だと画面上12px＝46MOAで、狙点ではなく的を隠す板になっていた。
  // 実物のダットは2MOA。720pで潰れない下限（芯が約3px＝12MOA相当）まで細める
  const dot = part(planeG(0.0013, 0.0013), MATS.dot, 0, cy, z - 0.0268);
  dot.renderOrder = 20;
  dot.userData.keep = true;
  g.add(dot);
  g.userData.dotGlow = glow;
  g.userData.reticle = [glow, ring, dot];

  const sight = new THREE.Object3D();
  sight.position.set(0, cy, z);
  g.add(sight);
  g.userData.sight = sight;
}

/* ------------------------------------------------------------ ライフル */

// 銃身の芯の高さ。先台の八角断面の中心をここに合わせる
const R_BORE = 0.021;
const R_RAIL = 0.052;

function buildRifle() {
  const g = new THREE.Group();

  /* ---- 下部機関部。マグウェルをラッパ状に開いて差し込み口を「口」に見せる */
  g.add(part(cboxG(0.046, 0.058, 0.20), MATS.enamel, 0, -0.006, -0.05));
  g.add(part(cboxG(0.050, 0.054, 0.070), MATS.enamel, 0, -0.032, 0.030));
  g.add(part(cboxG(0.054, 0.012, 0.078), MATS.phosphate, 0, -0.056, 0.031));
  g.add(part(cboxG(0.036, 0.022, 0.072), MATS.enamel, 0, -0.038, 0.076));
  addStampX(g, 0.0245, -0.022, 0.030, 0.030, 0.018);
  addStampX(g, -0.0245, -0.022, 0.030, 0.030, 0.018);

  /* ---- 上部機関部。上面を一段高い台にして「フラットな箱」から抜け出す */
  g.add(part(cboxG(0.048, 0.036, 0.215), MATS.anodized, 0, 0.0315, -0.055));
  g.add(part(cboxG(0.040, 0.010, 0.215), MATS.anodized, 0, 0.045, -0.055));
  g.add(part(cboxG(0.048, 0.020, 0.048), MATS.anodized, 0, 0.040, 0.070));  // 後端の段差
  addRail(g, R_RAIL, -0.160, 0.050, 0.024);
  // 機関部と先台の継ぎ目のリング
  g.add(part(cylG(0.029, 0.029, 0.022, 14), MATS.steel, 0, R_BORE, -0.152, Math.PI / 2));
  g.add(part(cylG(0.031, 0.031, 0.006, 14), MATS.phosphate, 0, R_BORE, -0.140, Math.PI / 2));

  /* ---- 排莢まわり。フォワードアシストとブラスディフレクター */
  g.add(part(cboxG(0.016, 0.028, 0.030), MATS.anodized, 0.028, 0.020, 0.052));
  g.add(part(cylG(0.0095, 0.0095, 0.016, 12), MATS.phosphate, 0.032, 0.020, 0.052, 0, 0, Math.PI / 2));
  g.add(part(cylG(0.0065, 0.0065, 0.008, 10), MATS.steel, 0.040, 0.020, 0.052, 0, 0, Math.PI / 2));
  g.add(part(cboxG(0.014, 0.024, 0.032), MATS.anodized, 0.028, 0.034, 0.022, 0, 0, 0.42));
  // 排莢口の奥。カバーが開いた時に穴が抜けないよう塞いでおく
  g.add(part(boxG(0.004, 0.026, 0.076), MATS.enamel, 0.022, 0.024, 0.000));

  /* ---- 操作部。セレクター・マガジンリリース・ボルトキャッチ */
  g.add(part(cylG(0.0095, 0.0095, 0.012, 10), MATS.phosphate, -0.026, -0.010, 0.062, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.007, 0.011, 0.028), MATS.phosphate, -0.030, -0.013, 0.070, 0.45));
  addStampX(g, -0.0245, -0.010, 0.062, 0.016, 0.014, 2);
  g.add(part(boxG(0.006, 0.020, 0.022), MATS.anodized, 0.026, -0.020, 0.062));
  g.add(part(cylG(0.0058, 0.0058, 0.010, 10), MATS.steel, 0.030, -0.020, 0.062, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.006, 0.021, 0.032), MATS.anodized, -0.026, -0.016, 0.028));
  g.add(part(boxG(0.008, 0.013, 0.011), MATS.phosphate, -0.029, -0.022, 0.016));
  addSlingLoop(g, -0.026, -0.002, 0.096);
  addScrewX(g, 0.024, -0.014, -0.120);
  addScrewX(g, -0.024, -0.014, -0.120);

  /* ---- 先台。八角の筒にして角を作る。丸でも箱でもない断面が情報量になる */
  g.add(part(cylG(0.031, 0.031, 0.270, 8), MATS.phosphate, 0, R_BORE, -0.290, Math.PI / 2, Math.PI / 8));
  // 天面レールを先台の全長に張ると、左手の指の弧（銃身芯から0.0394m）と
  // 歯の角（0.0396m）がミリ以下で同じ所を通り、指とレールが刺さったまま両方描かれる。
  // 実物のM-LOK先台も握る所にレールは付いていない。
  // さらに前半分のレールは、覗いた時に光軸から伏角3.7〜4.2度＝接眼リムの張る角(5.97度)の
  // 内側に入るので、開口の下半分を明るい歯の列が横切る原因にもなっていた。
  // レールは機関部から続く73mmだけ残して、その先はM-LOKの長穴（平面）にする
  addRail(g, R_RAIL - 0.003, -0.245, -0.172, 0.022);
  // 天面のM-LOK。八角の上面(銃身芯+0.0286)へ彫り込む
  for (let i = 0; i < 3; i++) {
    g.add(part(boxG(0.011, 0.004, 0.030), MATS.enamel, 0, R_BORE + 0.0286, -0.300 - i * 0.052));
  }
  // 通気孔。左右の平面に開ける
  for (let i = 0; i < 5; i++) {
    const z = -0.200 - i * 0.043;
    addVentX(g, 0.0292, R_BORE, z);
    addVentX(g, -0.0292, R_BORE, z);
  }
  // M-LOKの長穴。下面に彫り込みを並べる
  for (let i = 0; i < 4; i++) {
    g.add(part(boxG(0.011, 0.004, 0.030), MATS.enamel, 0, R_BORE - 0.030, -0.215 - i * 0.052));
  }
  addScrewX(g, 0.0295, R_BORE - 0.018, -0.178, 0.0032);
  addScrewX(g, -0.0295, R_BORE - 0.018, -0.178, 0.0032);
  addSlingLoop(g, -0.030, R_BORE - 0.010, -0.400, 0.0075);

  /* ---- 銃身・ガスブロック・消炎制退器。
     露出した円筒は輪郭に多角形の折れが出るので分割を上げる。
     ビューモデルは画面下部を常時占める資産なので、ここのポリゴンは惜しまない */
  g.add(part(cylG(0.0095, 0.0095, 0.190, 20), MATS.phosphate, 0, R_BORE, -0.520, Math.PI / 2));
  g.add(part(cboxG(0.026, 0.030, 0.038), MATS.phosphate, 0, R_BORE + 0.006, -0.442));
  // ガスチューブは先台の中に隠れる部品。以前は前端がz=-0.445まで出ていて、
  // 消炎制退器の爪より前に外径4.5mmの明るい針が1本浮いて見えていた。
  // シルエットで一番効く先端に余計な棒を出さないよう、ガスブロックの中で止める。
  // 材質もsteelだと至近でスペキュラを拾って光るのでphosphateにする
  g.add(part(cylG(0.0045, 0.0045, 0.270, 8), MATS.phosphate, 0, R_BORE + 0.019, -0.295, Math.PI / 2));
  for (let i = 0; i < 3; i++) {
    g.add(part(torG(0.0115, 0.0022, 5, 18), MATS.steel, 0, R_BORE, -0.560 - i * 0.016));
  }
  g.add(part(cylG(0.0165, 0.0155, 0.052, 20), MATS.steel, 0, R_BORE, -0.640, Math.PI / 2));
  // 先端の爪。真横から見た時のシルエットが効く
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.add(part(boxG(0.005, 0.005, 0.018), MATS.steel,
      Math.cos(a) * 0.012, R_BORE + Math.sin(a) * 0.012, -0.672));
  }

  /* ---- 握把。ゴムの当て板と指掛かりの溝を入れる。
     前後を厚くすると指が握把にめり込むので、実物どおり細身にする */
  g.add(part(cboxG(0.036, 0.100, 0.036), MATS.polymer, 0, -0.092, 0.126, -0.30));
  g.add(part(boxG(0.030, 0.086, 0.008), MATS.rubber, 0, -0.090, 0.146, -0.30));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.005, 0.005, 0.034, 8), MATS.polymer,
      0, -0.068 - i * 0.024, 0.106 + i * 0.008, 0, 0, Math.PI / 2));
  }
  g.add(part(cboxG(0.038, 0.011, 0.038), MATS.polymer, 0, -0.140, 0.115, -0.30));

  /* ---- 用心鉄。半円の輪にすると鋳物らしくなる */
  g.add(part(torG(0.020, 0.0036, 6, 14, Math.PI), MATS.enamel,
    0, -0.042, 0.078, 0, Math.PI / 2, Math.PI));

  /* ---- 引金（動く） */
  const trg = new THREE.Group();
  trg.position.set(0, -0.030, 0.088);
  trg.add(part(boxG(0.008, 0.024, 0.008), MATS.steel, 0, -0.012, -0.004, 0.2));
  trg.add(part(cylG(0.005, 0.005, 0.010, 8), MATS.steel, 0, 0, 0, 0, 0, Math.PI / 2));
  g.add(trg);
  g.userData.trigger = trg;

  /* ---- 排莢口カバー（動く）。蝶番を下端に置いて外へ倒す */
  const dust = new THREE.Group();
  dust.position.set(0.024, 0.012, -0.005);
  dust.add(part(boxG(0.005, 0.026, 0.074), MATS.anodized, 0.002, 0.013, 0));
  dust.add(part(boxG(0.004, 0.006, 0.010), MATS.steel, 0.003, 0.025, 0.030));
  g.add(dust);
  g.userData.dust = dust;

  /* ---- ボルト群（動く）。槓桿と、排莢口から覗くボルトキャリア */
  // 大面積で上を向く部品にsteel(金属度1.0)を使うと、白飛びした空のenvMapを
  // ほぼ全反射で返して、周囲の炭色から3〜4段明るい白い板が1枚浮く。
  // 俯瞰で銃の中で一番明るいのがこの板になっていたので、面の広い所はanodized/phosphateにして、
  // つまみの先端だけsteelを残す
  const bolt = new THREE.Group();
  bolt.add(part(cboxG(0.044, 0.009, 0.030), MATS.anodized, 0, 0.048, 0.062));
  bolt.add(part(cboxG(0.015, 0.009, 0.014), MATS.phosphate, -0.026, 0.048, 0.056));
  bolt.add(part(cboxG(0.010, 0.007, 0.016), MATS.phosphate, 0.026, 0.048, 0.056));
  bolt.add(part(boxG(0.004, 0.0045, 0.012), MATS.steel, -0.032, 0.048, 0.056));
  bolt.add(part(cylG(0.012, 0.012, 0.088, 12), MATS.phosphate, 0.006, 0.024, 0.010, Math.PI / 2));
  g.add(bolt);
  g.userData.bolt = bolt;
  g.userData.boltRest = 0;

  /* ---- 弾倉（動く）。口元を軸にしておくと抜く動きが自然に回る */
  // 弾倉はシルエット最大の塊。2段構成だと折れ線が2本の直線にしか見えず、
  // 曲率も底板の縁も読めない真っ黒な楔になる。4段に割って角度を刻み、
  // 段ごとに幅を絞ってテーパーを作る。面取りもここだけ太くして稜線に光を乗せる
  const mg = new THREE.Group();
  mg.position.set(0, -0.052, 0.033);
  const MAG = [
    [0.0340, 0.058, -0.020, 0.10],
    [0.0335, 0.057, -0.060, 0.20],
    [0.0325, 0.056, -0.100, 0.30],
    [0.0315, 0.055, -0.140, 0.40],
  ];
  for (const m of MAG) {
    mg.add(part(chamferBoxG(m[0], 0.044, m[1], MAG_CHAMFER), MATS.polymer,
      0, m[2], -m[2] * 0.21, m[3]));
  }
  // 底板は前後へ張り出したフランジにして明度の段を作る
  mg.add(part(chamferBoxG(0.040, 0.011, 0.070, 0.0030), MATS.polymerTan, 0, -0.170, 0.0357, 0.40));
  mg.add(part(boxG(0.030, 0.007, 0.060), MATS.polymer, 0, -0.161, 0.0338, 0.40));
  for (let i = 0; i < 4; i++) {
    const yy = -0.030 - i * 0.036;
    const zz = -yy * 0.21;
    const rr = 0.10 + i * 0.10;
    mg.add(part(boxG(0.036, 0.004, 0.010), MATS.polymer, 0, yy, zz - 0.019, rr));
    // 残弾確認窓。黒地に黒だと窓が消えるので真鍮にして点として読ませる
    mg.add(part(cylG(0.0048, 0.0048, 0.004, 10), MATS.brass, 0.0172, yy, zz, 0, 0, Math.PI / 2));
  }
  g.add(mg);
  g.userData.mag = mg;
  g.userData.magRest = [0, -0.052, 0.033];

  /* ---- 銃床。構えると目の後ろに来るのでADS中はまとめて消す */
  const rear = new THREE.Group();
  rear.add(part(cboxG(0.046, 0.058, 0.10), MATS.enamel, 0, -0.006, 0.100));
  rear.add(part(cylG(0.024, 0.024, 0.014, 12), MATS.phosphate, 0, 0.020, 0.062, Math.PI / 2));
  rear.add(part(cylG(0.019, 0.019, 0.200, 12), MATS.phosphate, 0, 0.020, 0.155, Math.PI / 2));
  rear.add(part(cboxG(0.044, 0.070, 0.115), MATS.polymer, 0, -0.002, 0.185));
  rear.add(part(cboxG(0.036, 0.016, 0.100), MATS.polymer, 0, 0.044, 0.190));
  rear.add(part(cboxG(0.010, 0.020, 0.016), MATS.enamel, 0.020, 0.008, 0.150));
  rear.add(part(cboxG(0.048, 0.088, 0.014), MATS.rubber, 0, -0.004, 0.252));
  for (let i = 0; i < 3; i++) {
    rear.add(part(boxG(0.050, 0.005, 0.005), MATS.rubber, 0, 0.024 - i * 0.024, 0.259));
  }
  g.add(rear);
  g.userData.rear = rear;

  // 光学の高さ。覗いた時の視線は接眼リム(内半径0.0195)から前へ広がる円錐で、
  // 光軸より下にある自分の部品はこの円錐に入ったぶんだけ像に写り込む。
  // 光軸を銃身芯から0.068mに置いていたので、レール上面の伏角が2.7〜4.5度＝
  // 接眼リムの張る角(5.97度)の内側に完全に入り、狙点の下半分が自分の銃と手で埋まっていた。
  // 高マウント相当の0.080mまで上げて、近側のレールと手を円錐の外へ出す。
  // マウントの箱は y-0.0165 まで下が伸びているので、上げてもレールを跨いだままになる。
  // adsPosはsightから逆算しているのでドットは中心に残る
  addOptic(g, 0.075, -0.020);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, R_BORE, -0.685);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.042, 0.022, 0.010);
  g.add(eject);
  g.userData.eject = eject;

  /* ---- 手。右は握把、左は先台そのものを掴む。
     以前は先台の下に垂直グリップを立てて、そこを掴む姿勢にしていたが、
     手の芯が先台の芯から7cm下にあったため指が対象に一度も触れず、
     左手と先台の間から背景の地面が見えていた。
     掴む対象を先台に変え、手の芯を銃身の芯(R_BORE)へ合わせる。
     垂直グリップは廃して、掴む位置の前にハンドストップだけ残す */
  g.add(part(cboxG(0.026, 0.030, 0.026), MATS.polymer, 0, R_BORE - 0.036, -0.352, -0.45));

  // 手は機関部のシルエットの外へ少しはみ出させる。中に収めると指の関節が
  // 機関部と重なって輪郭が消え、手と銃が1つの塊に読める。
  // armDirはZ成分を大きくして、腕が「奥から手前」ではなく「画面下隅から手へ」入るようにする。
  // 袖は画面右下隅を通って外へ抜ければよく、長さは要らない（伸ばすと目に届く）
  const handR = buildHand(1, {
    gripR: 0.021, wrap: 0.50, trigger: true, armDir: [0.38, -0.62, 0.92], armLen: 0.62,
  });
  handR.position.set(0.008, -0.064, 0.114);
  handR.rotation.set(-0.30, 0, 0);
  g.add(handR);
  g.userData.handR = handR;

  // 手を90度倒すと握りの軸が銃身方向になる。gripRは先台の外接半径(0.031)に合わせる。
  // 細いと指が対象より内側に来て、掴んでいるのに輪が閉じない。
  // 手の芯は銃身芯から6mm下げる。指の弧が先台の天面より上へ出ると、
  // 上に載っている物（レール・光学）を貫通するうえ、ADSで開口の下側へ食い込む。
  // 下げても指の弧(0.0394)は先台の面(0.031+0.006=0.037)より外なので接地は保てる。
  // tipは末節の回り込み角の補正。太い先台では指先が側面を通り越して天面へ回るので詰める。
  // rollは握り軸まわりに手ごと起こす量。真横から握らせると指が全部裏側へ回って、
  // 画面には甲の塊しか出ず「筒が銃に刺さっている」ようにしか読めない。
  // 0.52で甲が左斜め上、指の付け根から第2関節までが手前の面、親指が天面を斜めに渡る。
  // 天面のレールは機関部側の73mmだけなので、この位置(z=-0.290)の指と親指は当たらない。
  // skewは指1本ずつの回り込み角の差。視線が指の並びと平行なので、
  // これが無いと4本が奥行き方向に重なって1枚の板に見える。
  // wristは手首の芯。既定値のままだと前腕が先台を貫通する（solve3.mjsで詰めた値）
  const handL = buildHand(-1, {
    gripR: 0.031, wrap: 0.62, tip: -0.34, roll: 0.52, skew: 0.22,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.78],
  });
  handL.position.set(0, R_BORE - 0.006, -0.290);
  handL.rotation.set(-Math.PI / 2 + 0.10, 0, 0.12);
  g.add(handL);
  g.userData.handL = handL;

  // 装填中に左手が辿る握り位置。位置と角度をセットで持たせる
  g.userData.holdL = {
    rest: [[0, R_BORE - 0.006, -0.290], [-Math.PI / 2 + 0.10, 0, 0.12]],
    mag: [[0.014, -0.150, 0.036], [0.30, 0.22, -0.20]],
    low: [[0.034, -0.300, 0.085], [0.55, 0.38, -0.30]],
    charge: [[0.006, 0.052, 0.028], [0.95, 0.05, 0.35]],
  };

  bakeStatic(rear);
  bakeStatic(bolt);
  bakeStatic(mg);
  bakeStatic(trg);
  bakeStatic(dust);
  bakeStatic(g);
  return g;
}

/* ------------------------------------------------------------ SMG */

function buildSMG() {
  const g = new THREE.Group();
  const B = 0.016;           // 銃身の芯
  const RY = 0.046;          // レール面

  /* ---- 機関部。ライフルより一回り小さく、上面に段差を付ける */
  g.add(part(cboxG(0.044, 0.052, 0.170), MATS.enamel, 0, -0.004, -0.030));
  g.add(part(cboxG(0.046, 0.026, 0.185), MATS.anodized, 0, 0.026, -0.035));
  g.add(part(cboxG(0.038, 0.010, 0.185), MATS.anodized, 0, 0.039, -0.035));
  g.add(part(cboxG(0.044, 0.018, 0.040), MATS.anodized, 0, 0.034, 0.060));
  addRail(g, RY, -0.130, 0.052, 0.022);
  addStampX(g, 0.0225, -0.010, -0.010, 0.026, 0.014);
  addStampX(g, -0.0225, -0.010, -0.010, 0.026, 0.014);

  /* ---- 操作部 */
  g.add(part(cylG(0.0085, 0.0085, 0.011, 10), MATS.phosphate, -0.024, -0.008, 0.052, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.006, 0.010, 0.024), MATS.phosphate, -0.028, -0.011, 0.058, 0.45));
  g.add(part(boxG(0.006, 0.018, 0.020), MATS.anodized, 0.024, -0.018, 0.052));
  g.add(part(cylG(0.0052, 0.0052, 0.009, 10), MATS.steel, 0.027, -0.018, 0.052, 0, 0, Math.PI / 2));
  addSlingLoop(g, -0.024, 0.000, 0.082, 0.0075);
  addScrewX(g, 0.022, -0.012, -0.100, 0.0032);
  addScrewX(g, -0.022, -0.012, -0.100, 0.0032);

  /* ---- 先台。八角の樹脂。砂色にして機関部の黒と分ける */
  g.add(part(cylG(0.026, 0.026, 0.180, 8), MATS.polymerTan, 0, B, -0.200, Math.PI / 2, Math.PI / 8));
  // ライフルと同じ理由で、左手が乗る帯より前のレールは張らない。
  // 指の弧とレールの歯が同じ半径を通って刺さるのと、覗いた時に開口の下側へ
  // 歯の列が入り込むのを、幾何で同時に潰す
  addRail(g, RY - 0.006, -0.170, -0.128, 0.020);
  // 天面のM-LOK。八角の上面(銃身芯+0.024)へ彫り込む
  for (let i = 0; i < 3; i++) {
    g.add(part(boxG(0.010, 0.004, 0.026), MATS.enamel, 0, B + 0.024, -0.200 - i * 0.045));
  }
  for (let i = 0; i < 4; i++) {
    const z = -0.145 - i * 0.038;
    addVentX(g, 0.0245, B, z, 0.0052);
    addVentX(g, -0.0245, B, z, 0.0052);
  }
  for (let i = 0; i < 3; i++) {
    g.add(part(boxG(0.010, 0.004, 0.026), MATS.enamel, 0, B - 0.025, -0.155 - i * 0.045));
  }
  addSlingLoop(g, -0.025, B - 0.008, -0.278, 0.007);

  /* ---- 銃身と減音器。輪を並べて筒が単調にならないようにする */
  // 露出した円筒は分割を上げる。至近で見るので14角だと輪郭に折れが出る
  g.add(part(cylG(0.0080, 0.0080, 0.070, 16), MATS.phosphate, 0, B, -0.322, Math.PI / 2));
  g.add(part(cylG(0.0190, 0.0190, 0.130, 22), MATS.phosphate, 0, B, -0.420, Math.PI / 2));
  for (let i = 0; i < 4; i++) {
    g.add(part(torG(0.0197, 0.0022, 5, 20), MATS.anodized, 0, B, -0.372 - i * 0.032));
  }
  // 滑り止めのローレット
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    g.add(part(boxG(0.0026, 0.0026, 0.022), MATS.steel,
      Math.cos(a) * 0.019, B + Math.sin(a) * 0.019, -0.472));
  }
  g.add(part(cylG(0.0175, 0.0175, 0.006, 14), MATS.steel, 0, B, -0.486, Math.PI / 2));

  /* ---- 握把 */
  g.add(part(cboxG(0.034, 0.092, 0.034), MATS.polymer, 0, -0.080, 0.104, -0.28));
  g.add(part(boxG(0.028, 0.080, 0.008), MATS.rubber, 0, -0.078, 0.123, -0.28));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.0045, 0.0045, 0.032, 8), MATS.polymer,
      0, -0.058 - i * 0.022, 0.086 + i * 0.007, 0, 0, Math.PI / 2));
  }
  g.add(part(cboxG(0.036, 0.010, 0.036), MATS.polymer, 0, -0.124, 0.095, -0.28));
  g.add(part(torG(0.018, 0.0032, 6, 16, Math.PI), MATS.enamel,
    0, -0.038, 0.062, 0, Math.PI / 2, Math.PI));

  const trg = new THREE.Group();
  trg.position.set(0, -0.026, 0.070);
  trg.add(part(boxG(0.007, 0.022, 0.007), MATS.steel, 0, -0.011, -0.004, 0.2));
  g.add(trg);
  g.userData.trigger = trg;

  /* ---- ボルト群。左側面の槓桿が前後する。
     面の広い部品にsteelを使うと空の反射で白い板になるのでphosphate側へ寄せる */
  const bolt = new THREE.Group();
  bolt.add(part(cboxG(0.028, 0.011, 0.024), MATS.phosphate, -0.030, 0.026, 0.010));
  bolt.add(part(cboxG(0.010, 0.011, 0.014), MATS.steel, -0.044, 0.026, 0.010));
  bolt.add(part(cylG(0.010, 0.010, 0.070, 12), MATS.phosphate, 0.004, 0.020, 0.000, Math.PI / 2));
  g.add(bolt);
  g.userData.bolt = bolt;
  g.userData.boltRest = 0;

  const dust = new THREE.Group();
  dust.position.set(0.022, 0.010, 0.000);
  dust.add(part(boxG(0.004, 0.022, 0.060), MATS.anodized, 0.002, 0.011, 0));
  g.add(dust);
  g.userData.dust = dust;

  /* ---- 弾倉。直線の長物。窓を開けて残弾が見えるようにする */
  const mg = new THREE.Group();
  mg.position.set(0, -0.044, 0.018);
  mg.add(part(chamferBoxG(0.030, 0.150, 0.044, MAG_CHAMFER), MATS.polymerTan, 0, -0.075, 0.004));
  mg.add(part(chamferBoxG(0.036, 0.011, 0.056, 0.0030), MATS.polymer, 0, -0.155, 0.004));
  for (let i = 0; i < 4; i++) {
    mg.add(part(cylG(0.004, 0.004, 0.003, 8), MATS.enamel, 0.015, -0.030 - i * 0.032, 0.004, 0, 0, Math.PI / 2));
    mg.add(part(boxG(0.032, 0.003, 0.008), MATS.polymer, 0, -0.046 - i * 0.032, 0.004));
  }
  g.add(mg);
  g.userData.mag = mg;
  g.userData.magRest = [0, -0.044, 0.018];

  /* ---- 折り畳み銃床 */
  const rear = new THREE.Group();
  rear.add(part(cboxG(0.044, 0.052, 0.080), MATS.enamel, 0, -0.004, 0.075));
  rear.add(part(cylG(0.020, 0.020, 0.012, 12), MATS.phosphate, 0, 0.010, 0.106, Math.PI / 2));
  rear.add(part(cboxG(0.013, 0.028, 0.150), MATS.phosphate, 0.016, 0.006, 0.185));
  rear.add(part(cboxG(0.013, 0.028, 0.150), MATS.phosphate, -0.016, 0.006, 0.185));
  rear.add(part(cboxG(0.046, 0.010, 0.070), MATS.phosphate, 0, 0.018, 0.200));
  rear.add(part(cboxG(0.042, 0.062, 0.016), MATS.rubber, 0, 0.002, 0.262));
  for (let i = 0; i < 2; i++) {
    rear.add(part(boxG(0.044, 0.004, 0.006), MATS.rubber, 0, 0.014 - i * 0.024, 0.268));
  }
  g.add(rear);
  g.userData.rear = rear;

  // ライフルと同じ理由で光軸を上げる。銃身芯(B)から0.076mでほぼ同じ高マウント比になる
  addOptic(g, RY + 0.020, -0.020);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, B, -0.492);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.038, 0.018, 0.000);
  g.add(eject);
  g.userData.eject = eject;

  /* ---- 手。左は先台を上から掴む（Cクランプ）ので、握りの軸を寝かせる */
  const handR = buildHand(1, {
    gripR: 0.020, wrap: 0.50, trigger: true, armDir: [0.38, -0.62, 0.92], armLen: 0.62,
  });
  handR.position.set(0.007, -0.054, 0.095);
  handR.rotation.set(-0.28, 0, 0);
  g.add(handR);
  g.userData.handR = handR;

  // 手を90度倒すと握りの軸が銃身方向になる。原点は握る筒の芯に置かないと
  // 指が空を掴む。腕の向きも一緒に回るので、手のローカル座標で「後ろ下」を渡す。
  // この手はX軸に-90度回っているので、ローカル-Yが画面奥→手前、ローカル-Zが下になる
  // rollはライフルと同じ狙い（指をこちら側の面へ出す）。先台が細いぶん少しだけ浅くする
  const handL = buildHand(-1, {
    gripR: 0.026, wrap: 0.60, tip: -0.32, roll: 0.46, skew: 0.22,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.78],
  });
  handL.position.set(0, B - 0.005, -0.212);
  handL.rotation.set(-Math.PI / 2 + 0.10, 0, 0.12);
  g.add(handL);
  g.userData.handL = handL;

  g.userData.holdL = {
    rest: [[0, B - 0.005, -0.212], [-Math.PI / 2 + 0.10, 0, 0.12]],
    mag: [[0.014, -0.130, 0.022], [0.30, 0.20, -0.20]],
    low: [[0.034, -0.290, 0.070], [0.55, 0.35, -0.30]],
    charge: [[-0.030, 0.036, 0.020], [0.80, -0.20, 0.30]],
  };

  bakeStatic(rear);
  bakeStatic(bolt);
  bakeStatic(mg);
  bakeStatic(trg);
  bakeStatic(dust);
  bakeStatic(g);
  return g;
}

/* ------------------------------------------------------------ ショットガン */

function buildShotgun() {
  const g = new THREE.Group();
  const B = 0.022;           // 銃身の芯
  // 照準線の高さ。放熱筒の頂点(0.047)より上に通さないと、覗いた時に
  // 筒が邪魔をして先の照星が見えなくなる
  const SY = 0.054;

  /* ---- 機関部。上面に照星をつなぐリブを通して平らな箱をやめる */
  g.add(part(cboxG(0.050, 0.062, 0.190), MATS.phosphate, 0, 0.000, -0.020));
  g.add(part(cboxG(0.044, 0.014, 0.190), MATS.phosphate, 0, 0.034, -0.020));
  g.add(part(cboxG(0.016, 0.008, 0.230), MATS.phosphate, 0, 0.041, -0.070));
  addStampX(g, 0.0255, -0.006, -0.020, 0.040, 0.020, 4);
  addStampX(g, -0.0255, -0.006, -0.020, 0.040, 0.020, 4);
  // 排莢口とローディングポート
  g.add(part(boxG(0.006, 0.026, 0.062), MATS.enamel, 0.024, 0.006, -0.010));
  g.add(part(boxG(0.030, 0.006, 0.058), MATS.enamel, 0, -0.030, -0.005));
  // 安全子
  g.add(part(cylG(0.0055, 0.0055, 0.026, 10), MATS.steel, 0, -0.024, 0.060, 0, 0, Math.PI / 2));
  addSlingLoop(g, -0.026, 0.006, 0.086);

  /* ---- 銃身・放熱筒・弾倉チューブ */
  // 銃身と弾倉チューブは先台の外に出ている長い円筒。分割を上げて輪郭の折れを消す
  g.add(part(cylG(0.0165, 0.0165, 0.460, 20), MATS.phosphate, 0, B, -0.340, Math.PI / 2));
  g.add(part(cylG(0.0125, 0.0125, 0.380, 18), MATS.steel, 0, -0.010, -0.300, Math.PI / 2));
  g.add(part(cylG(0.0135, 0.0135, 0.016, 18), MATS.phosphate, 0, -0.010, -0.494, Math.PI / 2));
  // 放熱筒。八角の外皮に穴を並べると銃身が一気に「装備」らしくなる
  g.add(part(cylG(0.0245, 0.0245, 0.230, 8, true), MATS.phosphate, 0, B, -0.415, Math.PI / 2, Math.PI / 8));
  for (let i = 0; i < 5; i++) {
    const z = -0.330 - i * 0.040;
    addVentX(g, 0.0232, B, z, 0.0055);
    addVentX(g, -0.0232, B, z, 0.0055);
  }
  for (const z of [-0.305, -0.525]) {
    g.add(part(torG(0.0248, 0.0026, 5, 14), MATS.steel, 0, B, z));
  }

  /* ---- 照門と照星。ゴーストリングと真鍮のビーズ。
     土台は必ず照準線より下で止める。少しでも上へ出すと視線を塞ぐ */
  g.add(part(cboxG(0.032, 0.008, 0.026), MATS.phosphate, 0, 0.020, 0.100));
  g.add(part(cboxG(0.024, 0.018, 0.022), MATS.phosphate, 0, 0.026, 0.100));
  // 輪は撃ち手の方を向ける。横に倒すと輪の胴が視線を横切って穴が塞がる
  g.add(part(torG(0.020, 0.0028, 6, 16), MATS.steel, 0, SY, 0.100));
  g.add(part(boxG(0.014, 0.014, 0.010), MATS.phosphate, 0, 0.031, -0.548));
  g.add(part(boxG(0.006, 0.022, 0.008), MATS.phosphate, 0, 0.040, -0.548));
  g.add(part(sphG(0.0042), MATS.brass, 0, SY, -0.548));

  /* ---- 側面のシェルホルダー。暗い銃に赤が入って画が締まる */
  for (let i = 0; i < 4; i++) {
    const z = 0.030 - i * 0.030;
    g.add(part(cylG(0.0098, 0.0098, 0.052, 10), MATS.shell, -0.033, -0.004, z, Math.PI / 2));
    g.add(part(cylG(0.0104, 0.0104, 0.014, 10), MATS.brass, -0.033, -0.004, z + 0.024, Math.PI / 2));
  }
  g.add(part(boxG(0.005, 0.030, 0.126), MATS.strap, -0.026, -0.004, -0.005));

  /* ---- 握把と用心鉄 */
  g.add(part(cboxG(0.038, 0.100, 0.036), MATS.polymer, 0, -0.086, 0.128, -0.30));
  g.add(part(boxG(0.032, 0.088, 0.008), MATS.rubber, 0, -0.084, 0.148, -0.30));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.005, 0.005, 0.036, 8), MATS.polymer,
      0, -0.062 - i * 0.024, 0.108 + i * 0.008, 0, 0, Math.PI / 2));
  }
  g.add(part(cboxG(0.040, 0.011, 0.038), MATS.polymer, 0, -0.134, 0.117, -0.30));
  g.add(part(torG(0.021, 0.0038, 6, 16, Math.PI), MATS.phosphate,
    0, -0.040, 0.080, 0, Math.PI / 2, Math.PI));

  const trg = new THREE.Group();
  trg.position.set(0, -0.028, 0.090);
  trg.add(part(boxG(0.008, 0.026, 0.008), MATS.steel, 0, -0.013, -0.004, 0.2));
  g.add(trg);
  g.userData.trigger = trg;

  /* ---- ポンプ（動く）。滑り止めの溝を彫って握る場所だと分かるようにする */
  const pump = new THREE.Group();
  pump.position.set(0, 0, -0.280);
  pump.add(part(cylG(0.027, 0.027, 0.132, 8), MATS.polymer, 0, -0.008, 0, Math.PI / 2, Math.PI / 8));
  pump.add(part(cylG(0.029, 0.029, 0.010, 8), MATS.polymer, 0, -0.008, -0.062, Math.PI / 2, Math.PI / 8));
  pump.add(part(cylG(0.029, 0.029, 0.010, 8), MATS.polymer, 0, -0.008, 0.062, Math.PI / 2, Math.PI / 8));
  for (let i = 0; i < 6; i++) {
    const z = -0.042 + i * 0.017;
    pump.add(part(boxG(0.046, 0.005, 0.008), MATS.polymer, 0, -0.033, z));
    pump.add(part(boxG(0.008, 0.042, 0.008), MATS.polymer, 0.023, -0.008, z));
    pump.add(part(boxG(0.008, 0.042, 0.008), MATS.polymer, -0.023, -0.008, z));
  }
  g.add(pump);
  g.userData.pump = pump;
  g.userData.pumpRest = -0.280;

  /* ---- 装填用のシェル1発（動く）。同じ物を出し入れして4発装填を見せる */
  const shell = new THREE.Group();
  shell.add(part(cylG(0.0098, 0.0098, 0.050, 10), MATS.shell, 0, 0, 0, Math.PI / 2));
  shell.add(part(cylG(0.0104, 0.0104, 0.014, 10), MATS.brass, 0, 0, 0.024, Math.PI / 2));
  shell.visible = false;
  g.add(shell);
  g.userData.shell = shell;

  /* ---- 銃床。木ではなく樹脂の実用品にしてライフルと質感を変える */
  const rear = new THREE.Group();
  rear.add(part(cboxG(0.050, 0.062, 0.080), MATS.phosphate, 0, 0, 0.115));
  rear.add(part(cboxG(0.046, 0.096, 0.170), MATS.polymer, 0, -0.022, 0.230, 0.10));
  rear.add(part(cboxG(0.038, 0.018, 0.120), MATS.polymer, 0, 0.030, 0.220, 0.10));
  rear.add(part(cboxG(0.010, 0.020, 0.014), MATS.enamel, 0.022, 0.006, 0.180));
  rear.add(part(cboxG(0.052, 0.104, 0.016), MATS.rubber, 0, -0.036, 0.310, 0.10));
  for (let i = 0; i < 3; i++) {
    rear.add(part(boxG(0.054, 0.005, 0.006), MATS.rubber, 0, -0.006 - i * 0.028, 0.316));
  }
  g.add(rear);
  g.userData.rear = rear;

  // この銃はドット無しなので、照門の位置を照準の基準にする
  const sight = new THREE.Object3D();
  sight.position.set(0, SY, 0.100);
  g.add(sight);
  g.userData.sight = sight;

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, B, -0.578);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.042, 0.010, -0.010);
  g.add(eject);
  g.userData.eject = eject;

  /* ---- 手。左はポンプを掴むので、毎フレームポンプの前後量を足してやる */
  const handR = buildHand(1, {
    gripR: 0.022, wrap: 0.50, trigger: true, armDir: [0.38, -0.62, 0.94], armLen: 0.62,
  });
  handR.position.set(0.008, -0.060, 0.116);
  handR.rotation.set(-0.30, 0, 0);
  g.add(handR);
  g.userData.handR = handR;

  // ポンプにはレールが載っていないので回り込みは残せるが、
  // 指先が天面で合わさると溝の彫りを潰すので少しだけ詰める。
  // rollを書き忘れていて0のままだったので、この銃だけ指の付け根の列が
  // 甲の裏側へ回り、こちらの面には丸い甲と親指しか出ていなかった。
  // ポンプ(半径27mm)は先台(31mm)とSMG(26mm)の中間なので、0.52と0.46の間で取る。
  // 天面には銃身が通っているが、甲の外面(rr+14.5mm)でも銃身の外周より2mm外を通る
  const handL = buildHand(-1, {
    gripR: 0.027, wrap: 0.70, tip: -0.18, roll: 0.48, skew: 0.22,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.80],
  });
  handL.position.set(0, -0.010, -0.280);
  handL.rotation.set(-Math.PI / 2 + 0.08, 0, 0.10);
  g.add(handL);
  g.userData.handL = handL;

  g.userData.holdL = {
    rest: [[0, -0.010, -0.280], [-Math.PI / 2 + 0.08, 0, 0.10]],
    // 装填口は機関部の下。ここへシェルを押し込む
    mag: [[0.020, -0.090, -0.010], [0.10, 0.30, -0.45]],
    low: [[0.045, -0.250, 0.060], [0.45, 0.40, -0.40]],
    charge: [[0, -0.010, -0.280], [-Math.PI / 2 + 0.08, 0, 0.10]],
  };

  bakeStatic(rear);
  bakeStatic(pump);
  bakeStatic(trg);
  bakeStatic(shell);
  bakeStatic(g);
  return g;
}

/* ---------------------------------------------------------- 武器定義 */

export const WEAPONS = [
  {
    id: 'rifle', name: 'MK-4 カービン', build: buildRifle,
    damage: 27, headMult: 2.4, rpm: 640, auto: true, pellets: 1,
    mag: 30, reserve: 240, reloadTime: 2.15,
    spreadHip: 0.030, spreadAds: 0.0016, spreadPerShot: 0.0026, spreadMax: 0.052, spreadRecover: 0.09,
    recoilPitch: 0.0125, recoilYaw: 0.0038, kick: 0.035, adsFov: 46, adsTime: 0.16,
    range: 120, falloffStart: 42, falloffEnd: 95, falloffMin: 0.5,
    sound: { volume: 0.62, bodyFreq: 640, crackFreq: 3600, bodyDecay: 0.13, tailDecay: 0.45 },
    casing: true,
    reloadKind: 'mag', holdOpen: true,
    // 構え・揺れ・反動のバネを武器ごとに変える。数値の差がそのまま手触りの差になる。
    // adsDistは目からサイトまでの距離。遠いと「銃を少し持ち上げただけ」の画になるので、
    // 目をガラスの後ろに置いた感覚が出るところまで詰める。
    // adsPosはサイト位置からの逆算なので、adsDist/adsScaleを変えてもドットは中心に残る。
    //
    // hipの決め方（1280x720・viewCamera fov55で机上計算した）:
    //   前は scale 0.53 / z-0.335 で、銃の占有面積が画面の2.2%しかなかった。
    //   握把・右手・右前腕は全部フレームの外（右手の甲がy=903）で、
    //   プレイヤーの体と画面をつなぐ物が1つも写っていない＝右下に浮いた別レイヤーに見える。
    //   ここで「銃を目へ引き寄せて大きくする」と逆効果になる。近づけるほど
    //   模型の原点から下・後ろにある握把と右手の投影が拡大されて画面外へ飛ぶ。
    //   実際 z-0.24/scale0.62 だと右手の甲は y=1064 まで落ちる。
    //   握把が画面内に入る条件は「握把が目から46cm以上離れていること」なので、
    //   腕を伸ばした構え（z-0.52）にしたうえで縮尺を0.86まで上げるのが唯一の解になる。
    //   結果: 占有 8.3%（3.6倍）、右手の甲(1099,693)・銃床(1182,668)が画面内に入り、
    //   銃口は(722,493)で中央の戦闘領域(640,360)から離れたまま。
    //   一番手前の銃床端でも目から29.5cmあるので、手前の遠近破裂も起きない
    view: {
      scale: 0.86, adsScale: 0.64, adsDist: 0.145,
      hip: [0.21, -0.16, -0.52], hipRot: [-0.12, 0.13, 0.12],
      bob: 1.40, sway: 1.00, kickK: 300, kickD: 21,
      // 跳ね上げの初速[m/s]。このバネ（kickK 300 / kickD 21）だと
      // 1.30で頂点が約3.4cm＝銃口が画面上で20px上がる。歩きのbobが縦39pxなので、
      // 止まって撃てば十分読めて、歩きながらでも揺れに埋もれない大きさ
      kickUp: 1.30, kickSide: 0.45,
      boltTravel: 0.030, boltTime: 0.075, lower: 0.25,
    },
  },
  {
    id: 'smg', name: 'VECTOR-9 短機関銃', build: buildSMG,
    damage: 18, headMult: 2.0, rpm: 950, auto: true, pellets: 1,
    mag: 35, reserve: 280, reloadTime: 1.85,
    spreadHip: 0.038, spreadAds: 0.0042, spreadPerShot: 0.0020, spreadMax: 0.058, spreadRecover: 0.11,
    recoilPitch: 0.0072, recoilYaw: 0.0034, kick: 0.024, adsFov: 54, adsTime: 0.12,
    range: 80, falloffStart: 18, falloffEnd: 48, falloffMin: 0.42,
    sound: { volume: 0.40, bodyFreq: 780, crackFreq: 4200, bodyDecay: 0.09, tailDecay: 0.3, thumpFrom: 90, thumpTo: 42 },
    casing: true,
    reloadKind: 'mag', holdOpen: true,
    // 軽い銃なので構えが近く、跳ねが速くて小さい。
    // hipはライフルと同じ比率で作り直す（全長が短いぶんだけ手前に寄せる）
    view: {
      scale: 0.915, adsScale: 0.70, adsDist: 0.136,
      hip: [0.186, -0.145, -0.484], hipRot: [-0.11, 0.135, 0.115],
      bob: 1.15, sway: 0.78, kickK: 405, kickD: 25,
      // 950rpmでバネ1周期に5発入るので、1発を小さくしても積み上がって高く上がる
      kickUp: 0.90, kickSide: 0.40,
      boltTravel: 0.022, boltTime: 0.048, lower: 0.22,
    },
  },
  {
    id: 'shotgun', name: 'M870 ショットガン', build: buildShotgun,
    damage: 13, headMult: 1.6, rpm: 78, auto: false, pellets: 9,
    mag: 7, reserve: 56, reloadTime: 2.9,
    spreadHip: 0.062, spreadAds: 0.040, spreadPerShot: 0.0, spreadMax: 0.062, spreadRecover: 0.2,
    recoilPitch: 0.052, recoilYaw: 0.010, kick: 0.11, adsFov: 58, adsTime: 0.2,
    range: 40, falloffStart: 8, falloffEnd: 26, falloffMin: 0.18,
    sound: { volume: 0.85, bodyFreq: 380, crackFreq: 2600, bodyDecay: 0.22, tailDecay: 0.7, thumpFrom: 120, thumpTo: 38 },
    casing: true, pumpTime: 0.45,
    reloadKind: 'shell', holdOpen: false,
    // 重い銃。構えが遠く、揺れが大きく、跳ね返りが遅い。
    // 機械照門なので覗いた時に目へ近づける。
    // 全長がライフルより長いので、同じ縮尺でも銃口はもう一段先へ出る
    view: {
      scale: 0.90, adsScale: 0.56, adsDist: 0.105,
      hip: [0.205, -0.168, -0.560], hipRot: [-0.115, 0.135, 0.11],
      bob: 1.80, sway: 1.35, kickK: 205, kickD: 17,
      // 1発が重い銃なので大きく蹴り上げる。バネが柔らかい（kickK 205）ぶん戻りも遅い
      kickUp: 2.20, kickSide: 0.70,
      boltTravel: 0, boltTime: 0.10, lower: 0.29,
    },
  },
];

/* ------------------------------------------------------ 装填の工程表 */

// 左手の道のり。区間ごとに握り位置を切り替える。
// audio.reload()が全体の4%/42%/70%/88%で音を鳴らすので、そこへ動きを合わせる
const PATH_EMPTY = [
  [0.00, 0.10, 'rest', 'rest'],
  [0.10, 0.40, 'rest', 'mag'],
  [0.40, 0.54, 'mag', 'low'],
  [0.54, 0.68, 'low', 'mag'],
  [0.68, 0.78, 'mag', 'mag'],
  [0.78, 0.88, 'mag', 'charge'],
  [0.88, 1.00, 'charge', 'rest'],
];
// 弾が残っている時は槓桿を引かないので、そのまま構えに戻る
const PATH_TAC = [
  [0.00, 0.10, 'rest', 'rest'],
  [0.10, 0.40, 'rest', 'mag'],
  [0.40, 0.54, 'mag', 'low'],
  [0.54, 0.70, 'low', 'mag'],
  [0.70, 0.80, 'mag', 'mag'],
  [0.80, 1.00, 'mag', 'rest'],
];
// 装弾は1発ずつ。掴む→押し込むを繰り返して最後にポンプを引く
const PATH_SHELL = [
  [0.00, 0.10, 'rest', 'low'],
  [0.10, 0.22, 'low', 'mag'],
  [0.22, 0.32, 'mag', 'low'],
  [0.32, 0.44, 'low', 'mag'],
  [0.44, 0.54, 'mag', 'low'],
  [0.54, 0.66, 'low', 'mag'],
  [0.66, 0.76, 'mag', 'low'],
  [0.76, 0.86, 'low', 'mag'],
  [0.86, 1.00, 'mag', 'rest'],
];
// シェルを押し込んでいる区間
const SHELL_INS = [[0.10, 0.22], [0.32, 0.44], [0.54, 0.66], [0.76, 0.86]];

/* ------------------------------------------------------------ 実装 */

class Weapon {
  constructor(def, viewScene) {
    this.def = def;
    const v = def.view;
    this.inner = def.build();
    // ビューモデルは実寸のまま出すと画面を埋め尽くす。内側で縮めてから構える
    this.inner.scale.setScalar(v.scale);
    this.parts = this.inner.userData;

    // 外側は姿勢制御用。縮尺と分けておくとADSの逆算が素直になる
    this.model = new THREE.Group();
    this.model.add(this.inner);
    this.model.visible = false;
    viewScene.add(this.model);

    this.ammo = def.mag;
    this.reserve = def.reserve;
    this.spread = def.spreadHip;
    // 撃ち切るとボルトが後退したまま止まる。弾切れが目で分かる
    this.boltLocked = false;

    this.hipPos = new THREE.Vector3(v.hip[0], v.hip[1], v.hip[2]);
    this.hipRot = new THREE.Euler(v.hipRot[0], v.hipRot[1], v.hipRot[2]);

    // 覗いた時にサイトが画面中心へ来る位置を逆算する（ADS時の縮尺で計算する）
    const s = this.parts.sight.position;
    this.adsPos = new THREE.Vector3(
      -s.x * v.adsScale,
      -s.y * v.adsScale,
      -v.adsDist - s.z * v.adsScale,
    );
    this.adsRot = new THREE.Euler(0, 0, 0);

    this.model.position.copy(this.hipPos);
    this.model.rotation.copy(this.hipRot);

    // 手の道のりは毎フレーム作らずに済むよう先にVector3/Eulerへ直しておく
    this.holdL = {};
    const hl = this.parts.holdL;
    if (hl) {
      for (const k in hl) {
        this.holdL[k] = {
          p: new THREE.Vector3(hl[k][0][0], hl[k][0][1], hl[k][0][2]),
          r: new THREE.Euler(hl[k][1][0], hl[k][1][1], hl[k][1][2]),
        };
      }
    }
    const mr = this.parts.magRest;
    this.magRest = mr ? new THREE.Vector3(mr[0], mr[1], mr[2]) : null;

    // マズルフラッシュ（板を直交させて立体感を出す）。
    // 材質は武器ごとに別インスタンスにする。共有すると1挺の減衰が全挺に飛ぶ。
    //
    // 白(1,1,1)で出していたので、発砲ピークの最高輝度が(234,225,181)＝空(236,234,231)より
    // 暗く、昼間の絵の中で「光っている物」として読めなかった。
    // toneMapped:falseなので色をそのままHDRへ振れる。芯を確実にクリップさせて
    // postfxのbloom閾値(0.95)を越えさせる。青を抑えて炎の色温度に寄せる。
    //
    // depthTestを切るのは、板が銃口点(z=-0.685)に置かれていて、そのすぐ後ろにある
    // 消炎制退器の爪(-0.672)が深度で板を切り抜き、フラッシュの幾何中心に
    // 12x14pxの暗い穴が開いていたため。板は銃の最前面にしか出ないので、
    // 深度を切っても手前の物を突き抜ける事故は起きない
    this.flashMat = new THREE.MeshBasicMaterial({
      map: muzzleFlashTexture(128),
      color: new THREE.Color(5.0, 4.2, 2.6),
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.flash = new THREE.Group();
    // 正面から見える主板。正方形2枚を直交させると回転対称の星にしかならないので、
    // 横に潰した1枚を主役にして、縦の板は細く短くする
    const f1 = new THREE.Mesh(planeG(0.34, 0.34), this.flashMat);
    f1.rotation.y = Math.PI / 2;
    f1.scale.set(0.62, 0.72, 1);
    const f2 = new THREE.Mesh(planeG(0.34, 0.34), this.flashMat);
    f2.scale.set(1.4, 1.0, 1);
    this.flash.add(f1, f2);
    // 制退器のポートから横へ吹く分。前方の板だけだと丸い花火にしか見えない。
    // 左右で大きさを変えて、対称の星に見えないようにする
    let k = 0;
    for (const sx of [1, -1]) {
      const p = new THREE.Mesh(planeG(0.13, 0.13), this.flashMat);
      p.position.set(sx * 0.055, 0.008 * sx, 0.020);
      p.rotation.set(0, 0, sx * 0.5);
      p.scale.setScalar(k++ === 0 ? 1.15 : 0.85);
      this.flash.add(p);
    }
    this.flash.position.copy(this.parts.muzzle.position);
    // 爪より前へ出す。板の中心が銃の実体の中にあると、どの角度でも一度は食われる
    this.flash.position.z -= 0.020;
    this.flash.visible = false;
    this.inner.add(this.flash);

    // 発砲後に銃口へ残る薄い煙。板と光が同時に消えると
    // 「銃口にシールを貼って剥がした」画になるので、煙だけ長く引く
    this.smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTexture(128), color: 0x9b968c,
      transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    });
    this.smoke = new THREE.Mesh(planeG(0.16, 0.16), this.smokeMat);
    this.smoke.position.copy(this.parts.muzzle.position);
    this.smoke.position.z -= 0.02;
    this.smoke.visible = false;
    this.smoke.renderOrder = 12;
    this.inner.add(this.smoke);
  }

  get totalAmmo() { return this.ammo + this.reserve; }

  // 可動部を初期状態へ戻す。持ち替えや復活で中途半端な姿勢が残らないようにする
  restPose() {
    const P = this.parts;
    if (P.bolt) P.bolt.position.z = P.boltRest;
    if (P.dust) P.dust.rotation.z = 0;
    if (P.mag && this.magRest) {
      P.mag.position.copy(this.magRest);
      P.mag.rotation.set(0, 0, 0);
      P.mag.visible = true;
    }
    if (P.pump) P.pump.position.z = P.pumpRest;
    if (P.shell) P.shell.visible = false;
    if (P.trigger) P.trigger.rotation.x = 0;
    if (P.handR && P.handR.userData.index) {
      P.handR.userData.index.rotation.x = 0;
      P.handR.userData.index.position.z = P.handR.userData.indexZ;
    }
    if (P.handL && this.holdL.rest) {
      P.handL.position.copy(this.holdL.rest.p);
      P.handL.rotation.copy(this.holdL.rest.r);
    }
    // 持ち替えを跨いで前の銃の発砲演出が残らないようにする
    this.flash.visible = false;
    this.smoke.visible = false;
    this.smokeMat.opacity = 0;
    this.boltLocked = false;
  }
}

export class WeaponSystem {
  constructor(viewScene, camera, viewCamera, scene) {
    this.camera = camera;
    this.viewCamera = viewCamera;
    this.viewScene = viewScene;
    this.weapons = WEAPONS.map((d) => new Weapon(d, viewScene));
    this.index = 0;
    this.current.model.visible = true;

    this.adsFactor = 0;
    this.wantAds = false;
    this.reloading = 0;
    this.switching = 0;
    this.pumping = 0;
    this.fireTimer = 0;
    this.flashTimer = 0;
    this.flashLife = 0.035;
    this.flashBase = 1;
    this.smokeTimer = 0;
    this.smokeSeed = 0;
    this.shotIndexInMag = 0;

    // 反動の跳ね返り用バネ。
    // Zは奥行きなので画面上ではほぼ拡大縮小にしかならない。撃った事を画で見せるのは
    // 画面と平行に動くX/Yなので、同じバネをそちらにも持たせる
    this.kickZ = 0; this.kickZv = 0;
    this.kickY = 0; this.kickYv = 0;
    this.kickX = 0; this.kickXv = 0;
    this.kickPitch = 0; this.kickPitchV = 0;
    this.kickYaw = 0; this.kickYawV = 0;
    this.swayX = 0; this.swayY = 0;
    this.idleTime = 0;
    // 撃っている間はスプレッドの回復を止める（連射で開かせるため）
    this.spreadHold = 0;

    // 可動部。ボルトの往復・弾倉の揺れ・引金の引き
    this.boltCycle = 0;
    this.magWob = 0; this.magWobV = 0;
    this.trigT = 0; this.trigTarget = 0;

    // ポンプ式の排莢は遅れて出る。setTimeoutだと持ち替えや復活を跨いで飛ぶので
    // 自前のタイマーで持つ
    this._ejectDelay = -1;
    this._ejectPos = new THREE.Vector3();
    this._ejectDir = new THREE.Vector3();

    // 環境を照らす発砲光。これがあると夜でなくても迫力が出る
    this.muzzleLight = new THREE.PointLight(0xffb060, 0, 14, 2);
    this.muzzleLight.castShadow = false;
    scene.add(this.muzzleLight);

    // 銃と手はviewSceneにいて、本編のsceneとはRenderPassが別なので、
    // 上の発砲光は絶対に届かない。何もしないと発砲の瞬間に壁だけがオレンジに光って
    // 銃と手は真っ黒なまま止まり、フラッシュが銃の前に貼ったシールに見える。
    // ビューモデル側にもう1灯置いて、画面に写っている銃の左面と弾倉・手袋の甲を前から焼く。
    //
    // 前は銃口に点光源（distance 1.2）を置いていたが、銃口から機関部までは20cmしかなく、
    // しかも面をかすめる角度で当たるので、法線マップの凹凸1つ1つがスペキュラになって
    // 機関部が高周波のオレンジ斑点に化けていた（銃の勾配エネルギーの19.5%がこの光由来）。
    // それが発砲のたびに3〜4フレーム続いて元に戻るので、表面が這って見える＝「ブレ」。
    // 向きは実測で選んだ。銃口の側（前・下・右）から当てると平行光にしても面をかすめるので
    // 同じ斑点が出る（明るさ+2.0%に対して勾配+20.5%）。画面に写っているのは銃の左面なので、
    // そこへ正面から当たる前・左・やや下だと明るさ+33.4%に対して勾配+29.8%と、
    // 明るさ1%あたりの荒れが1/5になる。強度は明るさが+15%前後に収まるところ
    this.viewMuzzleLight = new THREE.DirectionalLight(0xffb060, 0);
    this.viewMuzzleLight.position.set(-0.60, -0.20, -1.0);
    this.viewMuzzleLight.castShadow = false;
    viewScene.add(this.viewMuzzleLight);

    // 手専用の当て光。握把側の面が黒く潰れると、手が銃と同じ塊に溶けて指が読めない。
    // ただし1.2はキー(vSun 4.2)の29%もあり、手が日向の砂嚢と同じ輝度(平均135)まで光って
    // 「白い塊」に見える原因になっていた。手袋のアルベドを0x6e747c→0x3a3e42へ落とした時点で
    // 線形反射率は25%まで落ちている（sRGBの出力比で約0.53、135→約72）ので、
    // 当て光まで1/3にすると今度は手が銃(32-88)へ沈んで指が読めなくなる。
    // キーの12%まで下げて、手の輝度帯を60-110＝銃の一段上に置く
    const handFill = new THREE.DirectionalLight(0xdfe6f0, 0.5);
    handFill.position.set(0.5, -0.3, 0.8);
    viewScene.add(handFill);
    // 逆方向の弱いリム。指の輪郭を銃から抜くのに要る。
    // 当て光だけだと手と銃の境目が値でつながったままになる
    const handRim = new THREE.DirectionalLight(0xffd0a0, 0.5);
    handRim.position.set(-0.6, 0.4, -0.5);
    viewScene.add(handRim);

    this.onShot = null;
    this.onSound = null;
    this.onEject = null;
  }

  get current() { return this.weapons[this.index]; }
  get def() { return this.current.def; }

  // 持ち替えが通ったかを返す。対戦では通った時だけサーバーへ知らせないと、
  // 弾かれた持ち替えまで送ってサーバー側だけ別の銃を構えることになる
  switchTo(i) {
    if (i === this.index || i < 0 || i >= this.weapons.length) return false;
    if (this.switching > 0) return false;
    this.reloading = 0;
    this.switching = 0.42;
    this._pendingIndex = i;
    return true;
  }

  reload() {
    const w = this.current;
    if (this.reloading > 0 || this.switching > 0) return false;
    if (w.ammo >= w.def.mag || w.reserve <= 0) return false;
    this.reloading = w.def.reloadTime;
    return true;
  }

  // 移動・跳躍・姿勢で精度が変わる。止まって覗くのが一番当たる形にする
  _currentSpread(player) {
    const d = this.def;
    const base = THREE.MathUtils.lerp(d.spreadHip, d.spreadAds, this.adsFactor);
    // 撃って開いたぶん。覗いている時は3割しか乗せない。
    // 丸ごと乗せると、腰だめの上限0.075がADSの0.0016に足されて0.0466＝20m先で90cmになり、
    // 8発撃った後のADSがまるで当たらなくなる。覗いて撃つ形を壊さない範囲に抑える
    const bloom = (this.current.spread - d.spreadHip) * (1 - this.adsFactor * 0.7);
    let s = base + bloom;
    const speed = player.horizontalSpeed;
    // 移動のぶれ。覗いている間は銃を体で固定するので効きを落とす。
    // ここを腰だめと同じ量にしていたせいで、歩きながらのADSが
    // 0.0016→0.0227rad（14倍）になり、20m先で45cmに散っていた。
    // 「動きながら狙って撃つ」がまったく成立しない原因がこれだった
    s += speed * 0.0045 * (1 - this.adsFactor * 0.75);
    if (!player.onFloor) s += 0.035;
    if (player.crouching) s *= 0.72;
    return Math.min(s, d.spreadMax + 0.05);
  }

  update(dt, input, player, ctx) {
    const w = this.current;
    const d = w.def;

    /* -------------------------------------------------- 持ち替え */
    if (this.switching > 0) {
      const prev = this.switching;
      this.switching -= dt;
      // 画面外まで下げた瞬間に差し替える
      if (prev > 0.21 && this.switching <= 0.21 && this._pendingIndex != null) {
        w.model.visible = false;
        w.restPose();
        this.index = this._pendingIndex;
        this._pendingIndex = null;
        this.current.model.visible = true;
        this.current.spread = this.current.def.spreadHip;
        this.boltCycle = 0;
        ctx.audio?.click(1200, 0.35, 0.05);
      }
      if (this.switching < 0) this.switching = 0;
    }

    /* ---------------------------------------------------- 装填 */
    if (this.reloading > 0) {
      const prev = this.reloading;
      this.reloading -= dt;
      if (prev > 0 && this.reloading <= 0) {
        const cur = this.current;
        const need = cur.def.mag - cur.ammo;
        const take = Math.min(need, cur.reserve);
        cur.ammo += take;
        cur.reserve -= take;
        cur.boltLocked = false;
        this.shotIndexInMag = 0;
      }
    }

    /* -------------------------------------------- 遅れて出る排莢 */
    if (this._ejectDelay >= 0) {
      this._ejectDelay -= dt;
      if (this._ejectDelay <= 0) {
        this._ejectDelay = -1;
        this.onEject?.(this._ejectPos, this._ejectDir);
      }
    }

    /* ------------------------------------------------------ ADS */
    this.wantAds = input.buttons[2] && this.reloading <= 0 && this.switching <= 0
      && !player.sprinting && player.alive;
    const adsTarget = this.wantAds ? 1 : 0;
    const adsSpeed = 1 / Math.max(d.adsTime, 0.01);
    this.adsFactor = THREE.MathUtils.damp(this.adsFactor, adsTarget, adsSpeed * 1.6, dt);
    if (Math.abs(this.adsFactor - adsTarget) < 0.002) this.adsFactor = adsTarget;
    player.adsFactor = this.adsFactor;

    /* ---------------------------------------- スプレッドの回復 */
    // 発砲より前で回復させる。後ろに置くと、撃って足した0.0055を同じフレームで削ってから
    // main.jsのクロスヘアが読むので、1発ぶんの膨らみが1画素も表示されない。
    // spreadHoldは連射間隔（ライフル0.094秒・SMG0.063秒）より長くしてある。
    // 撃っている間は回復を止めて、引金を離してから0.5秒かけて閉じる形にする。
    // 前は毎秒spreadRecover*6（ライフル0.540）引いていて、640rpmで足せる0.0587の9倍あった。
    // つまり撃っても撃たなくても常にspreadHipに張り付いていて、
    // 1発目と30発目の弾のばらけ方が完全に同じだった
    this.spreadHold = Math.max(0, this.spreadHold - dt);
    if (this.spreadHold <= 0) {
      w.spread = Math.max(d.spreadHip, w.spread - d.spreadRecover * dt);
    }

    /* ---------------------------------------------------- 発砲 */
    this.fireTimer -= dt;
    this.pumping = Math.max(0, this.pumping - dt);

    const trigger = input.buttons[0];
    const triggerEdge = trigger && !this._prevTrigger;
    this._prevTrigger = trigger;
    // 指を離したら反動パターンを最初に戻す。押しっぱなしの間だけ積み上がる
    if (!trigger) this.shotIndexInMag = 0;

    const wantFire = d.auto ? trigger : triggerEdge;
    const canFire = player.alive && this.reloading <= 0 && this.switching <= 0
      && this.pumping <= 0 && this.fireTimer <= 0 && !player.sprinting;

    // 引金に指をかけている状態。指の動きに使う
    this.trigTarget = (trigger && player.alive && this.reloading <= 0
      && this.switching <= 0 && !player.sprinting) ? 1 : 0;

    if (wantFire && canFire) {
      if (w.ammo > 0) {
        this._fire(player, ctx);
        this.fireTimer = 60 / d.rpm;
        if (d.pumpTime) this.pumping = d.pumpTime;
      } else {
        // 空撃ちのカチッ。連打で鳴り続けないよう間隔を空ける
        if (this.fireTimer <= 0) {
          ctx.audio?.click(2800, 0.3, 0.03);
          this.fireTimer = 0.28;
          if (w.reserve > 0) this.reload();
        }
      }
    }

    // 自動リロード（撃ち切ったら勝手に入れ替える）
    if (w.ammo === 0 && w.reserve > 0 && this.reloading <= 0 && this.switching <= 0) {
      this.reload();
      ctx.audio?.reload(d.reloadTime);
    }

    this._animate(dt, input, player);
    this._animateParts(dt, w, d);
    this._updateFlash(dt);
  }

  _fire(player, ctx) {
    const w = this.current;
    const d = w.def;
    const v = d.view;
    w.ammo--;
    this.shotIndexInMag = (this.shotIndexInMag ?? 0) + 1;
    // 撃ち切ったらボルトが後退位置で止まる
    if (w.ammo === 0 && d.holdOpen) w.boltLocked = true;

    const spread = this._currentSpread(player);
    const origin = _v.setFromMatrixPosition(this.camera.matrixWorld);
    const forward = _v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion);

    // 銃口のビュー空間座標。viewCameraは原点・無回転なのでviewSceneのワールド座標がそのまま使える
    const muzzleView = w.parts.muzzle.getWorldPosition(_v3);
    // ビューモデル用の発砲光は平行光なので位置を動かさない。強度だけ上げる
    this.viewMuzzleLight.intensity = 0.9 * (d.pellets > 1 ? 1.5 : 1);

    // 銃口のワールド座標（ビューモデルはカメラ空間にいるので変換する）。
    // 画角の違いを先に潰しておくこと。_v3はここから書き換わる
    const muzzleWorld = this._viewToWorld(muzzleView);

    for (let p = 0; p < d.pellets; p++) {
      const dir = _v4.copy(forward);
      if (spread > 0) {
        // 円内一様にばらけさせる（正方形にすると角に偏る）
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spread;
        const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
        // カメラの右と上をその場で作る。毎発Vector3を作らないための展開
        const q = this.camera.quaternion;
        const rx = 1 - 2 * (q.y * q.y + q.z * q.z);
        const ry = 2 * (q.x * q.y + q.z * q.w);
        const rz = 2 * (q.x * q.z - q.y * q.w);
        const ux = 2 * (q.x * q.y - q.z * q.w);
        const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
        const uz = 2 * (q.y * q.z + q.x * q.w);
        dir.set(
          forward.x + rx * cx + ux * cy,
          forward.y + ry * cx + uy * cy,
          forward.z + rz * cx + uz * cy,
        ).normalize();
      }
      this.onShot?.({
        origin, dir, muzzle: muzzleWorld, def: d,
        pellet: p, pellets: d.pellets,
      });
    }

    /* ------------------------------------------------ 反動を積む */
    const n = this.shotIndexInMag;
    // 縦は最初の数発で強く、その後は緩やかに。横は左右に蛇行させる
    const rise = d.recoilPitch * (1 + Math.min(n, 7) * 0.16);
    const drift = d.recoilYaw * Math.sin(n * 1.7) * (0.6 + Math.min(n, 10) * 0.09);
    const adsScale = 1 - this.adsFactor * 0.32;
    player.addRecoil(rise * adsScale, (drift + rand(d.recoilYaw * 0.5)) * adsScale);

    this.kickZv += d.kick * 26 * adsScale;
    // 銃を画面上で跳ね上げる。Zだけだと奥行きにしか動かず、
    // 歩くだけで出るbobの揺れ（横52px・縦39px）に埋もれて撃った事が読めない。
    // 覗いている間は平行移動ぶんをほぼ捨てる。弾はカメラ中心から出ているのに
    // ドットは銃に付いているので、銃を1cm持ち上げるとドットだけが上へ飛んで
    // 「見えている狙点と着弾点が違う」状態になる。実測で1発53px＝20m先で40cmずれる。
    // 覗いて撃つ形が壊れるので4%だけ残して5px（20m先で10cm）に収める。
    // ADSの手応えはカメラ側の反動（player.addRecoil）が持っている
    const kickMove = adsScale * (1 - this.adsFactor * 0.96);
    this.kickYv += v.kickUp * kickMove;
    this.kickXv += rand(v.kickSide * 2) * kickMove;
    this.kickPitchV += d.recoilPitch * 40 * adsScale;
    this.kickYawV += rand(d.recoilYaw * 26) * adsScale;
    // ボルトを1往復させ、弾倉を遅れて揺らす
    if (v.boltTravel > 0) this.boltCycle = 1;
    this.magWobV += d.kick * 9;

    w.spread = Math.min(d.spreadMax, w.spread + d.spreadPerShot);
    // 撃っている間は回復を止める。連射間隔より長く取らないと、
    // 発と発の間で回復が挟まって開きっぱなしにならない
    this.spreadHold = 0.12;

    /* ------------------------------------------------ 見た目と音 */
    // 板の寿命。_updateFlashで毎フレーム大きさと濃さを更新する。
    // 出しっぱなしにすると60fpsで全く同じ絵が3枚並んで、発砲に時間が無くなる。
    // 逆に長すぎてもいけない。0.055秒だと60fpsで3.3フレームあり、
    // ライフルの連射間隔5.6フレームの6割を占めるので「光る／戻る」が10Hzで往復する。
    // 2フレームに詰めて、光っていない時間のほうを長くする
    this.flashLife = 0.035;
    this.flashTimer = this.flashLife;
    w.flash.visible = true;
    // 毎発ぐるぐる回すと、形の違いではなく「同じシールが回っている」ようにしか見えない。
    // 横長の主板の向きは保ったまま、ゆらぎとして±0.25radだけ振る
    w.flash.rotation.z = rand(0.5);
    this.flashBase = (0.75 + Math.random() * 0.6) * (1 - this.adsFactor * 0.35);
    w.flash.scale.setScalar(this.flashBase);
    // 残留煙。連射で濃くなりすぎないよう上限を付ける
    this.smokeTimer = Math.min(0.34, (this.smokeTimer || 0) + 0.24);
    this.smokeSeed = Math.random() * Math.PI * 2;
    this.muzzleLight.intensity = 26 * (d.pellets > 1 ? 1.6 : 1);
    this.muzzleLight.position.copy(muzzleWorld);

    ctx.effects?.muzzle(muzzleWorld, forward);
    ctx.audio?.gunshot(d.sound, null, null);

    if (d.casing) {
      const ejectWorld = this._viewToWorld(w.parts.eject.getWorldPosition(_v3));
      if (d.pumpTime) {
        // ポンプ式は排莢が遅れる
        this._ejectPos.copy(ejectWorld);
        this._ejectDir.copy(forward);
        this._ejectDelay = 0.26;
      } else {
        this.onEject?.(ejectWorld, forward);
      }
    }
  }

  // ビュー空間の点を本編カメラのワールド座標へ移す。
  // ビューモデルはfov 55のviewCameraで写るのに、煙・火花・曳光弾はfov 75のcameraで写る。
  // 同じ3D点でも画角が違えば画面上の位置が変わるので、tanの比でx,yを補正してから移す。
  // やらないと撃つほど銃口の少し上に煙が溜まって見える。
  //
  // 比の向きを間違えやすいので導出を残す。画面上の位置(ndc)は
  //   ndc = x / (-z) / tan(fov/2)
  // で決まる。viewCameraで写った銃口と同じndcを本編cameraで作りたいので
  //   x' / tan(fovCam/2) = x / tan(fovView/2)  →  x' = x * tan(fovCam/2) / tan(fovView/2)
  // 狭いviewCamera(55)のほうが拡大されて写るぶん、外側へ広げる向き（k>1）が正しい。
  // 逆にすると補正しないより大きくずれる。
  // ADS中は両方のfovが動くので、その場でtanを取り直す
  _viewToWorld(p) {
    const D = Math.PI / 360;   // 度→ラジアン かつ 半画角にする
    const k = Math.tan(this.camera.fov * D) / Math.tan(this.viewCamera.fov * D);
    p.x *= k; p.y *= k;
    return p.applyMatrix4(this.camera.matrixWorld);
  }

  _updateFlash(dt) {
    const w = this.current;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        w.flash.visible = false;
      } else {
        // 出た瞬間が一番小さく明るく、そこから広がりながら薄れる。
        // 大きさと濃さのカーブを別にすると1発が「膨らんで消える」動きになる
        const k = clamp01(this.flashTimer / (this.flashLife || 0.035));
        w.flashMat.opacity = Math.pow(k, 0.5);
        w.flash.scale.setScalar((this.flashBase || 1) * (0.55 + 0.45 * (1 - k) + 0.35 * k));
      }
    }
    // 残留煙。板より2倍以上長く引いて、消え際は膨らませながら薄くする
    if (this.smokeTimer > 0) {
      this.smokeTimer = Math.max(0, this.smokeTimer - dt);
      const k = this.smokeTimer / 0.34;
      w.smoke.visible = k > 0.001;
      w.smokeMat.opacity = Math.pow(k, 1.4) * 0.30;
      const s = 0.7 + (1 - k) * 1.5;
      w.smoke.scale.set(s, s, 1);
      w.smoke.rotation.z = (this.smokeSeed || 0) + (1 - k) * 0.5;
      w.smoke.position.z = w.parts.muzzle.position.z - 0.02 - (1 - k) * 0.05;
    } else if (w.smoke.visible) {
      w.smoke.visible = false;
    }
    // 世界を照らす方の光は板より2〜3倍長く引く。1コマの点滅にしないため
    this.muzzleLight.intensity *= Math.max(0, 1 - dt * 10);
    if (this.muzzleLight.intensity < 0.05) this.muzzleLight.intensity = 0;
    // ビューモデル側は速く落とす。銃はここに写りっぱなしなので、光っている時間が
    // 連射間隔（ライフル0.094秒）の半分を超えると「明るい／暗い」が10Hzで往復して
    // チラつきになる。1発あたり2フレームで落ちきる速さにして往復をやめさせる。
    //
    // 係数26は上の条件を満たしていなかった。60fpsで1フレームあたり0.567倍にしかならず、
    // 0.9から切り捨ての0.01を下回るまで7フレーム掛かる。連射間隔は5.6フレームなので
    // 一度も消えないまま次の発砲で0.9へ戻る＝銃の明るさが撃っている間ずっと往復する。
    // 実測でも銃の画素の平均輝度が35.0↔47.6（36%）を10.6Hzで往復していて、
    // これが「撃つと銃の絵がブレる」の残りぶんだった。2フレームで落ちきる138にすると24%まで下がる。
    // 掛け算の形も1-dt*kからexpへ変える。1-dt*kはdtが1/k秒を超えると負になり、
    // main.js側はdtを0.1秒まで通すので、重い環境では発砲したフレームで光が即0になって
    // 銃が一度も照らされない。expなら刻みが粗くても同じ時定数で減る
    this.viewMuzzleLight.intensity *= Math.exp(-dt * 138);
    if (this.viewMuzzleLight.intensity < 0.01) this.viewMuzzleLight.intensity = 0;
  }

  /* --------------------------------------------- 銃全体の構えと揺れ */
  _animate(dt, input, player) {
    const w = this.current;
    const d = w.def;
    const v = d.view;
    const model = w.model;

    /* --------------------------------------- 反動のバネを解く */
    // バネ定数を武器ごとに変える。SMGは硬くて速く、ショットガンは柔らかくて遅い。
    // 毎フレーム走るので配列を作らず、その場で解く。
    // ただしこの解き方は1回の刻み幅が大きすぎると発散する。kickKが最大405、
    // 減衰が最大26なので、dtが0.077秒（13fps）を超えたところで銃が吹き飛ぶ。
    // main.js側でdtは0.1秒まで許しているので、刻みを0.02秒以下に割ってから解く。
    // 60fps時はdt=0.0167で1回のまま、つまり今までと同じ動きになる
    const steps = Math.max(1, Math.ceil(dt / 0.02));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.kickZv += (-this.kickZ * v.kickK - this.kickZv * v.kickD) * h;
      this.kickZ += this.kickZv * h;
      this.kickYv += (-this.kickY * v.kickK - this.kickYv * v.kickD) * h;
      this.kickY += this.kickYv * h;
      this.kickXv += (-this.kickX * v.kickK - this.kickXv * v.kickD) * h;
      this.kickX += this.kickXv * h;
      this.kickPitchV += (-this.kickPitch * v.kickK * 1.1 - this.kickPitchV * (v.kickD + 1)) * h;
      this.kickPitch += this.kickPitchV * h;
      this.kickYawV += (-this.kickYaw * v.kickK - this.kickYawV * (v.kickD - 1)) * h;
      this.kickYaw += this.kickYawV * h;
    }

    /* ------------------------------------- 視点移動に対する遅れ */
    // 素早く振ると銃が置いていかれる。角速度に負の係数を掛けて追従を遅らせる
    this.swayX = THREE.MathUtils.damp(this.swayX, -this._lookVel(player, 'yaw') * v.sway, 10, dt);
    this.swayY = THREE.MathUtils.damp(this.swayY, -this._lookVel(player, 'pitch') * v.sway, 10, dt);

    /* ---------------------------------------------- 歩行と待機 */
    this.idleTime += dt;
    // 覗いている間は狙点が動いてはいけない。当たり判定はカメラ中心から出ているので、
    // 銃だけが呼吸や振り遅れで泳ぐと、見えている狙点と実際の弾道が食い違う。
    // bobだけでなくsway・breath・rollも一緒に縮める
    // 15%/25%を残していると、静止ADSでもドットのスクリーン座標が中心から数十pxずれる。
    // 撃つのは常にカメラ中心なので、見えているドットと着弾点が食い違う。
    // 覗き切る手前(0.55〜0.90)で残り分を0まで畳んで、狙点を完全に固定する
    const adsHard = clamp01((this.adsFactor - 0.55) / 0.35);
    const steady = (1 - this.adsFactor * 0.85) * (1 - adsHard);
    const bobScale = player.bobAmount * v.bob * (1 - this.adsFactor * 0.75) * (1 - adsHard);
    const bobX = Math.cos(player.bobPhase * 0.5) * 0.030 * bobScale;
    const bobY = Math.sin(player.bobPhase) * 0.022 * bobScale;
    // 待機中の呼吸。実測で横9.8px・縦4.1px泳いでいて、しかも周期1.3と0.9が
    // 割り切れない比なので同じ位置に戻ってこない。世界は1画素も動いていないのに
    // 銃だけが動き続けるので、「呼吸している」ではなく「銃が浮いている」に見える。
    // 実物のFPSは呼吸で視点も一緒に動くから成立している演出で、
    // 視点を固定したままここだけ振ると必ず浮く。
    // 完全に0にすると静止画に見えるので、痕跡が残る量まで落とす（横2.4px・縦1.0px）
    const breathX = Math.sin(this.idleTime * 0.9) * 0.00086 * v.bob * steady;
    const breathY = Math.cos(this.idleTime * 0.62) * 0.00069 * v.bob * steady;
    const swX = this.swayX * steady;
    const swY = this.swayY * steady;

    /* ------------------------------------------------ 各種姿勢 */
    const t = this.adsFactor;
    const base = _v.lerpVectors(w.hipPos, w.adsPos, t);

    // 覗くほど縮める。サイト位置の逆算とセットで効く
    w.inner.scale.setScalar(THREE.MathUtils.lerp(v.scale, v.adsScale, t));
    // 銃床は構えると目の後ろに来る部品なので、覗いたら消す
    if (w.parts.rear) w.parts.rear.visible = t < 0.55;
    // レンズの映り込みは、筒を横から見た時にガラスだと分からせるための演出。
    // 覗いている間に乗せると透過像を白く濁らせるだけなので消す
    if (w.parts.sheen) w.parts.sheen.visible = t < 0.6;
    // レティクルはヒップだと軸から外れて見えているだけなので薄く落とす。
    // 深度は戻してあるので筒や銃身には遮蔽されるが、開口から漏れる分は残る
    if (w.parts.reticle) {
      const rk = 0.18 + 0.82 * t;
      MATS.dot.opacity = rk;
      MATS.reticle.opacity = 0.8 * rk;
      // 芯を細くしたぶん滲みが相対的に勝つ。濃度も一段落として点のままにする
      MATS.dotGlow.opacity = 0.30 * rk;
    }

    // 走っている時は銃を下げて斜めに倒す
    const sprintT = player.sprinting ? 1 : 0;
    this._sprintBlend = THREE.MathUtils.damp(this._sprintBlend ?? 0, sprintT, 9, dt);
    const sp = this._sprintBlend;

    // 装填中は下げて回す（工程の中身は_animatePartsが担当する）
    let reloadT = 0;
    if (this.reloading > 0) {
      const p = 1 - this.reloading / d.reloadTime;
      reloadT = Math.sin(clamp01(p) * Math.PI);
    }
    // 持ち替え中も下げる
    const switchT = this.switching > 0 ? Math.sin(clamp(this.switching / 0.42, 0, 1) * Math.PI) : 0;
    const lower = Math.max(reloadT, switchT);

    model.position.set(
      base.x + bobX + swX + breathX + sp * 0.05 + this.kickX,
      base.y + bobY + swY + breathY - sp * 0.05 - lower * v.lower + this.kickY,
      base.z + this.kickZ - sp * 0.02,
    );
    // kickPitch/kickYawは反動なのでADSでも残す。ADSの減衰は_fireで
    // (1 - adsFactor*0.32)を1回だけ掛けてあるので、ここで重ねない
    model.rotation.set(
      THREE.MathUtils.lerp(w.hipRot.x, w.adsRot.x, t) + this.kickPitch + swY * 1.6
        + sp * 0.22 + reloadT * 0.42 + switchT * 0.7,
      THREE.MathUtils.lerp(w.hipRot.y, w.adsRot.y, t) + this.kickYaw + swX * 2.2
        + sp * 0.55 + reloadT * 0.30,
      THREE.MathUtils.lerp(w.hipRot.z, w.adsRot.z, t) - sp * 0.30 + reloadT * 0.20
        + player.roll * 1.5 * (1 - this.adsFactor),
    );

    // 覗いている間はFOVを絞る。ビューモデルのFOVは本編より狭くしておくと
    // 手前側の遠近の伸びが抑えられて、銃が自然な形に見える
    const fov = THREE.MathUtils.lerp(55, d.adsFov * 0.9, t);
    if (Math.abs(this.viewCamera.fov - fov) > 0.01) {
      this.viewCamera.fov = fov;
      this.viewCamera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------- 可動部の動き */
  _animateParts(dt, w, d) {
    const P = w.parts;
    const v = d.view;
    const reloading = this.reloading > 0;
    const p = reloading ? clamp01(1 - this.reloading / d.reloadTime) : 0;

    /* ---- ボルト。発砲で1往復し、撃ち切ると後退位置で止まる */
    let boltOff = 0;
    if (this.boltCycle > 0) {
      this.boltCycle = Math.max(0, this.boltCycle - dt / v.boltTime);
      const u = 1 - this.boltCycle;
      // 後退は速く、戻りはゆっくり。実物の動きに近づく
      boltOff = u < 0.34 ? u / 0.34 : 1 - (u - 0.34) / 0.66;
    }
    if (w.boltLocked) {
      // 装填の終盤で槓桿を引いて解放する
      boltOff = reloading ? (p < 0.86 ? 1 : 1 - ease(seg(p, 0.86, 0.93))) : 1;
    }
    if (P.bolt) P.bolt.position.z = P.boltRest + boltOff * v.boltTravel;
    // 排莢口カバーはボルトが動いている間だけ開く
    if (P.dust) P.dust.rotation.z = -boltOff * 1.45;

    /* ---- 弾倉。反動では遅れて揺れ、装填では抜けて落ちて差し変わる */
    this.magWobV += (-this.magWob * 260 - this.magWobV * 16) * dt;
    this.magWob += this.magWobV * dt;
    if (P.mag && w.magRest) {
      const R = w.magRest;
      if (reloading && d.reloadKind === 'mag') {
        if (p < 0.40) {
          P.mag.visible = true;
          P.mag.position.copy(R);
          P.mag.rotation.set(0, 0, 0);
        } else if (p < 0.60) {
          const k = seg(p, 0.40, 0.58);
          P.mag.visible = k < 0.98;
          P.mag.position.set(R.x + k * 0.014, R.y - k * k * 0.55, R.z + k * 0.05);
          P.mag.rotation.set(k * 2.0, 0, k * 0.5);
        } else if (p < 0.62) {
          P.mag.visible = false;
        } else {
          const k = ease(seg(p, 0.62, 0.72));
          P.mag.visible = true;
          P.mag.position.set(R.x, R.y - (1 - k) * 0.16
            - Math.sin(seg(p, 0.72, 0.80) * Math.PI) * 0.004, R.z + (1 - k) * 0.03);
          P.mag.rotation.set((1 - k) * 0.45, 0, 0);
        }
      } else {
        P.mag.visible = true;
        P.mag.position.copy(R);
        P.mag.rotation.set(this.magWob, 0, this.magWob * 0.4);
      }
    }

    /* ---- 引金と人差し指 */
    this.trigT = THREE.MathUtils.damp(this.trigT, this.trigTarget, 30, dt);
    if (P.trigger) P.trigger.rotation.x = -this.trigT * 0.32;
    const ix = P.handR && P.handR.userData.index;
    if (ix) {
      // 曲げるだけだと届いてしまうので、少し手前へ引いて「引いた」ように見せる
      ix.rotation.x = -this.trigT * 0.22;
      ix.position.z = P.handR.userData.indexZ + this.trigT * 0.006;
    }

    /* ---- ポンプ。発砲後の排莢と、装填の最後の一動作 */
    if (P.pump) {
      let po = 0;
      if (this.pumping > 0 && d.pumpTime) po = Math.sin((1 - this.pumping / d.pumpTime) * Math.PI);
      if (reloading && d.reloadKind === 'shell') {
        po = Math.max(po, Math.sin(seg(p, 0.88, 1.0) * Math.PI));
      }
      P.pump.position.z = P.pumpRest + po * 0.075;
    }

    /* ---- 装填中のシェル。1発を出し入れして繰り返し装弾に見せる */
    if (P.shell) {
      let on = false;
      if (reloading && d.reloadKind === 'shell') {
        for (let i = 0; i < SHELL_INS.length; i++) {
          const a = SHELL_INS[i][0], b = SHELL_INS[i][1];
          if (p >= a && p < b) {
            const k = ease(seg(p, a, b));
            P.shell.position.set(
              lerp(0.052, 0.004, k), lerp(-0.230, -0.038, k), lerp(0.050, -0.010, k));
            P.shell.rotation.set(lerp(0.55, 0.04, k), lerp(0.45, 0.0, k), 0);
            on = true;
            break;
          }
        }
      }
      P.shell.visible = on;
    }

    /* ---- ドットの滲みをわずかに脈打たせる。生きた光に見える */
    if (P.dotGlow) {
      const k = 1 + Math.sin(this.idleTime * 8.5) * 0.05;
      P.dotGlow.scale.set(k, k, 1);
    }

    this._poseHands(w, d, p, reloading);
  }

  // 左手の位置。構えている間は握り位置、装填中は工程表に沿って動かす
  _poseHands(w, d, p, reloading) {
    const P = w.parts;
    const L = P.handL;
    const H = w.holdL;
    if (!L || !H.rest) return;

    if (reloading) {
      const path = d.reloadKind === 'shell' ? PATH_SHELL
        : (w.boltLocked ? PATH_EMPTY : PATH_TAC);
      for (let i = 0; i < path.length; i++) {
        const s = path[i];
        if (p <= s[1] || i === path.length - 1) {
          const t = ease(seg(p, s[0], s[1]));
          const a = H[s[2]], b = H[s[3]];
          L.position.lerpVectors(a.p, b.p, t);
          L.rotation.set(
            lerp(a.r.x, b.r.x, t), lerp(a.r.y, b.r.y, t), lerp(a.r.z, b.r.z, t));
          break;
        }
      }
    } else {
      L.position.copy(H.rest.p);
      L.rotation.copy(H.rest.r);
    }

    // ポンプ式は左手がポンプと一緒に前後する
    if (P.pump) L.position.z += P.pump.position.z - P.pumpRest;
  }

  // 視点の角速度。銃を遅れて追従させるのに使う
  _lookVel(player, key) {
    const cur = key === 'yaw' ? player.yaw : player.pitch;
    const prev = this[`_prev_${key}`] ?? cur;
    this[`_prev_${key}`] = cur;
    let dv = cur - prev;
    if (key === 'yaw') {
      if (dv > Math.PI) dv -= Math.PI * 2;
      if (dv < -Math.PI) dv += Math.PI * 2;
    }
    return clamp(dv * 2.2, -0.06, 0.06);
  }

  resetAll() {
    for (const w of this.weapons) {
      w.ammo = w.def.mag;
      w.reserve = w.def.reserve;
      w.spread = w.def.spreadHip;
      w.model.visible = false;
      w.flash.visible = false;
      w.restPose();
    }
    this.index = 0;
    this.current.model.visible = true;
    this.reloading = 0;
    this.switching = 0;
    this.pumping = 0;
    this.adsFactor = 0;
    this.shotIndexInMag = 0;
    this.boltCycle = 0;
    this.magWob = 0; this.magWobV = 0;
    this.trigT = 0; this.trigTarget = 0;
    this._ejectDelay = -1;
    this.flashTimer = 0;
    this.smokeTimer = 0;
    this.muzzleLight.intensity = 0;
    this.viewMuzzleLight.intensity = 0;
    this.kickZ = 0; this.kickZv = 0;
    this.kickY = 0; this.kickYv = 0;
    this.kickX = 0; this.kickXv = 0;
    this.kickPitch = 0; this.kickPitchV = 0;
    this.kickYaw = 0; this.kickYawV = 0;
    this.spreadHold = 0;
  }
}
