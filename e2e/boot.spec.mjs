// 本物のブラウザで開いて、ホーム画面まで来ることを見る。**1本だけ。**
//
// なぜ要るか: tools/check-*.mjs は1372項目あるが、全部Nodeの中でクラスを
// 動かしているだけで、
//   ・index.html と importmap が噛み合っているか
//   ・全部のモジュールが本当に読み込めるか
//   ・読み込んだ結果、画面がホームまで来るか
//   ・画面で例外や404が出ていないか
// を1つも見ていない。**import を1行書き間違えただけで、検査は全部通ったまま、
// 開いたら真っ黒**という形が作れてしまう。ここはその穴だけを塞ぐ。
//
// 逆に、撃ち合いの中身は書かない。向こうの1372項目が見ているし、
// **重ねて書くと、遅くて壊れやすい検査が増えるだけ。**
//
// ---------------------------------------------------------------------------
// 書き方で決めていること
//
// 1. **読み込みは1回だけ。** この場面をCPUで塗る（本物のGPUが無い所で走る）と
//    1枚に何百msもかかる。読み込むだけで1分近い。3本に分けると3分になる
// 2. **マウスで押さない。** 本体が詰まっているので、押した合図の往復が返ってこず、
//    force を付けても時間切れになる（実際なった）。DOM側から呼ぶ
// 3. **見るのは「出ているか」まで。** 見た目の良し悪しは人が見る
// ---------------------------------------------------------------------------
import { test, expect } from '@playwright/test';

test('開いてホーム画面まで来て、画面でエラーが出ていない', async ({ page }) => {
  /* 画面のエラーを全部拾う。**ここが本体。**
     「動いているように見えて、裏で例外が出ている」が一番たちが悪い */
  const errors = [];
  page.on('pageerror', (e) => errors.push(`例外: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  // 読めなかったファイル。importmapの書き間違いと、置き忘れた素材はここに出る
  page.on('requestfailed', (r) => errors.push(`読めなかった: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url()}`); });

  await page.goto('/');

  // 読み込みが終わるまで待つ。地形を組むので、CPUで塗る所では1分近くかかる。
  // 画面に出ているかではなく印が付いたかで見る（終わった時点で隠れるため）
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('done'),
    null,
    { timeout: 120_000 },
  );

  /* --------------------------------------------------- ホーム画面 */
  // ここに並べるidはindex.htmlに実在すること。tools/check-meta.mjsが突き合わせる。
  // 戦績ボタン(nmStats)を消した時、ここが古いままでデプロイが止まった
  // （e2eはデプロイ直前にしか走らないので、手元のcheckでは気づけなかった）
  await expect(page.locator('#netmenu')).toBeVisible();
  for (const id of ['nmName', 'nmJoin', 'nmSolo', 'nmSettings', 'nmQuit', 'nmTutorial', 'nmRange']) {
    await expect(page.locator(`#${id}`), `${id} が出ていない`).toBeVisible();
  }

  /* ----------------------------------------------------- 3Dの画 */
  // **画面が真っ黒でないこと。** WebGLが動いていない時の症状がこれで、
  // 読み込みは終わってホーム画面も出るが、後ろの3Dだけが出ない
  const draw = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { ok: false, why: 'canvasが無い' };
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, why: 'WebGLが使えない' };
    return { ok: true, why: '', w: c.width, h: c.height };
  });
  expect(draw.ok, draw.why).toBe(true);
  expect(draw.w, '描く場所の幅が0').toBeGreaterThan(0);

  /* ------------------------------------------- 中身をJSが並べる画面 */
  // 設定は**中身をJSが表から並べる。** 行が1つも無ければ、
  // 表が届いていないか並べる所で落ちている。
  // マウスで押さずにDOM側から呼ぶ（本体が詰まっていて合図の往復が返らない）。
  // 戦績の画面もここで見ていたが、画面ごと消した（2026-08-07、「誰も見ない」）
  const rows = await page.evaluate(() => {
    document.getElementById('nmSettings').click();
    const settings = document.querySelectorAll('#stRows .strow').length;
    document.getElementById('stClose').click();
    return {
      settings,
      settingsHidden: document.getElementById('settings').classList.contains('hidden'),
    };
  });
  expect(rows.settings, '設定の行が並んでいない').toBeGreaterThan(2);
  expect(rows.settingsHidden, '設定が閉じない').toBe(true);

  /* ------------------------------------------------------ エラー */
  // 最後にまとめて見る。**先に見ると、後で出た物を見逃す**
  expect(errors, `画面でエラーが出ている:\n${errors.join('\n')}`).toEqual([]);
});
