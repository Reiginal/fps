// 本物のブラウザで動かす検査の設定。
//
// **tools/check-*.mjs が一切届いていない層のためにある。**
// あちらはNodeの中でクラスを動かしているだけなので、
//   ・index.html と importmap が噛み合っているか
//   ・全部のモジュールが本当に読み込めるか
//   ・読み込んだ結果、画面がホームまで来るか
// を1つも見ていない。**import を1つ書き間違えただけで、
// 検査は1372項目とも通ったまま、開いたら真っ黒**という形が作れてしまう。
//
//   npm run e2e
//
// サーバーはここが自分で起動して、終わったら落とす（数秒）。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  /* **長めに取ってある。** 本物のGPUが無い所（CIも手元のheadlessも）では
     この場面をCPUで塗ることになり、1枚に何百msもかかる。
     地形を組んで影と環境を焼き上げるまでで1分近い。
     短くすると「重い日だけ落ちる検査」になって、誰も信じなくなる */
  timeout: 240_000,
  expect: { timeout: 30_000 },
  // 落ちた時にどこで落ちたか分かればいいので、1回だけ試す。
  // 再試行を入れると、たまに落ちる物が「たまたま通った」で隠れる
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    /* **窓を小さくする。** 本物のGPUが無い所ではCPUで塗るので、
       費用は塗る画素の数にそのまま比例する。1280x720 を 400x300 にすると
       画素は10分の1以下になり、そのぶん全部が速くなる。
       見たいのは「起動するか」なので、大きさは要らない
       （大きいままだと、CIの遅い機械では読み込むだけで時間切れになった） */
    viewport: { width: 400, height: 300 },
    // 落ちた時の手掛かり。通った時は残さない（毎回画像が溜まる）
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // WebGLが要る。headlessのままだと端末によってはソフトウェア描画になり、
        // 起動そのものは確かめられるので、そこは割り切る
        launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
      },
    },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://localhost:8080',
    // 手元で既に起動している時は、それを使って立ち上げ直さない
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
