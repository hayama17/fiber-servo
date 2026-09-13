# fiber-servo

コンテナのための React reconciler です。望ましい状態を JSX で書くと、React のリコンサイルが差分を操作（ops）の列に変換し、containerd がそれを実行します。

[English](README.md)

```tsx
// app.tsx
import { Container, Deployment, Network } from 'fiber-servo';

export default function App() {
  return (
    <Network name="app">
      <Container name="db" image="postgres:16" readiness={{ exec: ['pg_isready'] }}>
        <Deployment name="web" replicas={2} service={{ port: 80, publish: 8080 }}>
          <Container image="nginx:alpine" env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Container>
    </Network>
  );
}
```

ツリーの形がそのままトポロジです。`<Network>` の中は所属、`<Container>` の中は依存。`fiber-servo plan app.tsx` で、何も実行せずに展開結果を見られます。

```
CREATE network app
CREATE container db image=postgres:16 network=app
                                        (db が ready と報告される)
CREATE container web-0 image=nginx:alpine network=app
CREATE container web-1 image=nginx:alpine network=app
CREATE container web image=docker.io/library/caddy:2-alpine network=app
```

`fiber-servo up app.tsx` で containerd 上に実体化します。`replicas` を 2 から 5 にすると CREATE がちょうど 3 つとプロキシの UPDATE が 1 つ、`image` を変えると各 replica に UPDATE が 1 つ、`web-1` を kill するとバックオフの後に `START container web-1 attempt=1` が出ます。React の state・合成・hooks の知識がそのままインフラに使えます。

> **ステータス: 実験段階です。** reconciler はランタイムに触れないテストで固定されています。containerd ランタイムは実機で動作確認していますが、まだ利用者が少ない段階です。1.0 までは API が変わることがあります。

## なぜ

コンテナオーケストレータは「望ましい状態」と「観測した状態」をリコンサイルします。React は UI に対して同じことをしていて、しかも reconciler が差し替え可能です。fiber-servo はそれを containerd に繋ぎます。制御ループは `render()`、合成は関数呼び出し、依存順序は Suspense です。

## インストール

```sh
npm install fiber-servo react
```

Node 20 以上。実際に動かすには containerd と [nerdctl](https://github.com/containerd/nerdctl) がホストに必要です。開発とテストにはどちらも要りません。

## 設計の2つのルール

1. **spec = fiber ツリー、status = external store。** host element が望ましい状態です。コンテナが動いているかどうかはツリーの外の `StatusStore` にあり、`useSyncExternalStore` で読みます。ツリーは status を書かず、hostConfig は status を読みません。
2. **commit は何も実行しない。** hostConfig のメソッドはすべて同期で、op を積むだけです。ランタイムが commit 後にバッチを消費します。docker なしで reconciler をテストできるのも、ランタイムの差し替えが 2 ファイルで済むのもこのためです。

**自己修復**は「望ましいリスタート世代」です。`<Container>` は自分の status を読み、死亡を観測すると指数バックオフの後に `restarts={n + 1}` を render し、reconciler が `START` を出します。リスタート回数、`maxRestarts`、安定稼働後のリセットは component の state です。

**ネットワーク**は 2 つ目の host element です。`<Network>` の中のコンテナはそこに接続され、名前で互いを解決できます。ツリーのネストが作成・削除の順序を保証します。

**依存順序**はネストです。`<Container>` の子は、その container が running（`readiness={{ exec }}` の probe があれば ready）と報告されるまで `CREATE` を出しません。親以外への依存は `<Ready on="db">` で書けます。内部では status store から解決される thenable を `use()` し、`<Suspense>` で包んでいます。

**Service**は合成です。`<Service name="web" port={80} targets={[…]}>` は caddy の reverse proxy コンテナを描画し、`<Deployment service={{ port, publish }}>` は replica の前にそれを置いて、scale に合わせてコマンドを更新します。ホストポートはプロキシ側で公開するので replica 同士が衝突しません。

**合成**はただの関数です。

詳細は [docs/architecture.md](docs/architecture.md) と [docs/decisions.md](docs/decisions.md)（英語）を参照してください。

## containerd で動かす

CLI なら app ファイルがプログラムそのものです。

```sh
npx fiber-servo plan app.tsx        # ops を表示するだけ。何も実行しない
sudo npx fiber-servo up app.tsx     # containerd 上で Ctrl-C まで動かす
```

コードからは `serve()` の 1 行です。

```tsx
import { containerd, serve } from 'fiber-servo';

const served = serve(<App />, { runtime: containerd({ namespace: 'default' }) });
process.once('SIGINT', () => served.stop().then(() => process.exit(0)));
```

`examples/containerd.tsx` はこれにログを足したもので、`examples/app.tsx` がそこで serve されるツリーです。`serve()` の裏にある部品（`createRoot`、`createContainerdRuntime`、`watchContainerd`）も export しています。各 op が nerdctl の何になるか、nerdctl の出力について何を仮定しているかは [docs/containerd.md](docs/containerd.md) にまとめています。

## 開発

```sh
npm install
npm test                   # vitest、ランタイム不要
npm run typecheck
npm run build              # dist/
npm run check              # CI と同じ一式
npm run example            # scale / update / teardown
npm run example:self-heal  # 死亡 -> バックオフ付き START
npm run example:webapp     # network + 依存順序付き deployment
sudo npm run example:containerd  # 実機。replica を kill すると戻ってきます
```

## ロードマップ

- HTTP / TCP の readiness probe（ホストから CNI ネットワークへの経路ができてから）。
- Volume とリソース制限を spec のフィールドとして追加する。
- 同じ `Nerdctl` インターフェースの裏に containerd gRPC クライアントを置く。

## コントリビュート

Issue と Pull Request を歓迎します。先に [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください。上の 2 つのルールはレビューで守られます。実機の containerd での報告が今いちばん役に立ちます。

## ライセンス

[MIT](LICENSE)
