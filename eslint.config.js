// 静的解析の設定。
//
// なぜ入れるか: このリポジトリの不具合は「実際に動かすまで気づけない物」に偏っている。
// 過去には存在しない識別子（torusG / FADE_SMOKE）をそのまま書いていて、
// 手作業のgrepで偶然見つかった。no-undef はこの類を1秒で潰す。
// tools/check-*.mjs は実際に動かして確かめる検査だが、動かさない経路
// （例外の中、めったに通らない分岐）はどうしても抜ける。そこを機械で埋める。
//
// 入れない物: 整形のルール。
// このコードは手で整えた長いコメントと、桁を揃えた数値の表が資産になっている。
// 自動整形はそれを崩すだけで、間違いを1つも見つけてくれない。
// 見るのは「間違い」だけにする。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'sounds/**'],
  },

  js.configs.recommended,

  {
    // ブラウザで動く側。window / document / localStorage / AudioContext などを使う。
    // Nodeの検査ツールからも読み込まれるが、その時は server/dom-stub.js が
    // 偽物を用意するので、ここではブラウザのグローバルとして扱ってよい
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  {
    // Nodeで動く側。サーバー本体と検査の道具
    files: ['server/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    // 検査の道具。Nodeで動くが、ブラウザ向けのコードを読み込むために
    // window や document の偽物を自分で作って globalThis へ置く。
    // だから両方のグローバルを知っている必要がある
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    /* 本物のブラウザで動かす検査（e2e/）。
       Nodeで走るが、page.evaluate() の中はブラウザの中で動くので、
       document や window をそのまま書く。両方のグローバルを知っている必要がある */
    files: ['e2e/**/*.mjs', 'playwright.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    rules: {
      // 使っていない変数。消し忘れが積もるとどれが生きている値か読めなくなる。
      // 頭に _ を付けた物だけは「意図して使っていない」と見なして見逃す
      // （分割代入で前の要素を飛ばす時などに要る）
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // 全角の空白。日本語の画面表示では区切りとして意図的に使っているので、
      // 文字列とテンプレートとコメントの中は見逃す。コードの途中に紛れた物だけ拾う
      'no-irregular-whitespace': ['error', {
        skipStrings: true, skipTemplates: true, skipComments: true,
      }],
      // 「既定値を入れておいて、条件ごとに上書きする」書き方を許す。
      // src/world/effects.js の素材ごとの分岐がこの形で、既定値そのものは
      // 読まれないが、分岐を1つ足した時に未定義にならない保険として意味がある。
      // 消すと、書き足す人が全分岐で代入する義務を負う
      'no-useless-assignment': 'off',
      // 中身の無いブロック。ただし catch の空は許す。
      // localStorage は設定次第で例外を投げるので「覚えられないだけ」として
      // 握り潰す箇所が複数あり、そこはコメント付きで意図的に空にしてある
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
