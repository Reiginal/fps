# ここに武器のモデルを置くと、見た目が替わる

`<武器のid>.glb` という名前で置くだけ。無ければコードで組んだ物のまま。

```
assets/models/rifle.glb      ← ライフルが替わる
assets/models/shotgun.glb
assets/models/pistol.glb
assets/models/knife.glb
assets/models/nade.glb
```

**銃口・薬莢の出口・照準の印は残る。** 面を持っている所だけ隠して、そこへ被せる。
閃光も煙も今まで通り出る。手も残る（消すと宙に浮いた銃になる）。

## どこからもらうか（全部CC0＝何をしてもいい）

| 出どころ | 中身 |
|---|---|
| Quaternius | 突撃銃・狙撃銃・散弾銃・拳銃が25本。https://poly.pizza/bundle/Ultimate-Guns-Pack-cpgUfI4t2F |
| Kenney | おもちゃ寄りの銃。glbが最初から入っている。https://kenney.nl/assets/blaster-kit |
| Poly Haven | 小物と素材。https://polyhaven.com |

**気を付ける所:**

- **Unityのアセットストアの物は、多くが「Unityの中でだけ使ってよい」規約**。ここでは使えない
- BOOTHはVRChat向けの規約が多い。ゲームに入れてよいか1本ずつ確認する
- Mixamo（動き）はAdobeがほぼ放置していて、2025年に数日止まった。頼り切らない

## 大きさと向きは自動で合わせる

モデルごとに向きも大きさもばらばらなので、**元の銃の銃口の位置に合わせて縮める**。
それでも合わない時は `src/player/glbview.js` の `fitModel()` を触る。

## 戻し方

ファイルを消すだけ。コードで組んだ物へ戻る。
