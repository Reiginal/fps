# 本番で動かす姿を1つのファイルに固定する。
#
# 置き場所を選ばないようにコンテナにしてある。Fly.ioでもAWSでもGCPでも
# 自前のサーバーでも、同じ物が同じように動く。
# 「手元では動いたのに向こうでは動かない」の原因はほぼ環境の差なので、
# 環境ごと持っていく。
FROM node:22-slim

WORKDIR /app

# 依存だけ先に入れる。ここを後ろに書くと、ソースを1行直すたびに
# three(25MB)の取り直しが走って、毎回のデプロイが遅くなる。
# 依存が変わらない限りこの層は使い回される
COPY package.json package-lock.json ./
# ci は install と違って package-lock.json の通りに正確に入れる。
# --omit=dev で ESLint など検査用の物を外す（本番では要らない）
RUN npm ci --omit=dev

# 本番に要る物だけ入れる。tools/ も課題.md も入れない。
# 外へ配る物を server/index.js 側でも絞っているが、
# そもそも置かないのが一番確実
COPY index.html ./
# 個人情報の扱い。**ここに書き忘れると本番だけ404になる**（コンテナの中に無いので）。
# ogp.pngで同じことをやったので、ファイルを1枚足したらここも見ること
COPY privacy.html ./
COPY src ./src
COPY server ./server
# URLを貼った時の札に使う画像。ここに書き忘れると、手元では出るのに
# 本番だけ札に絵が出ない（コンテナの中に無いので404になる）
COPY assets ./assets

ENV NODE_ENV=production
# 置き場所がPORTを渡してくる。渡されなければ8080
ENV PORT=8080
EXPOSE 8080

# 地形(三角形20万個)を組んでからポートを開くので、起動に2秒ほどかかる。
# 死活監視の待ち時間はそれを見込んで設定すること(fly.tomlのgrace_period)
CMD ["node", "server/index.js"]
