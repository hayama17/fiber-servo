# fiber-servo

コンテナのための React reconciler です。望ましい状態を JSX で書くと、React のリコンサイルが差分を操作（ops）の列に変換し、containerd がそれを実行します。

[English](README.md)

```tsx
import { Container, Deployment, Network, Ready } from 'fiber-servo';

function WebApp({ replicas, image }) {
  return (
    <Network name="app">
      <Container name="db" image="postgres:16" />
      <Ready on="db">
        <Deployment name="web" replicas={replicas}>
          <Container image={image} env={{ DATABASE_HOST: 'db' }} />
        </Deployment>
      </Ready>
    </Network>
  );
}
```

これを render すると、ツリーは次の ops を出します。

```
CREATE network app
CREATE container db image=postgres:16 network=app
                                        (db が running と報告される)
CREATE container web-0 image=nginx network=app
CREATE container web-1 image=nginx network=app
```

`replicas` を 2 から 5 にすると CREATE がちょうど 3 つ、`image` を変えると各 replica に UPDATE が 1 つ、`web-1` を kill するとバックオフの後に `START container web-1 attempt=1` が出ます。React の state・合成・hooks の知識がそのままインフラに使えます。

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

**依存順序**は `<Ready on="db">` です。`db` が一度 running と報告されるまで、中のものは `CREATE` を出しません。内部では status store から解決される thenable を `use()` し、`<Suspense>` で包んでいます。

**合成**はただの関数です。

詳細は [docs/architecture.md](docs/architecture.md) と [docs/decisions.md](docs/decisions.md)（英語）を参照してください。

## containerd で動かす

```tsx
import {
  createContainerdRuntime,
  createNerdctl,
  createRoot,
  createStatusStore,
  watchContainerd,
} from 'fiber-servo';

const nerdctl = createNerdctl({ namespace: 'default' });
const status = createStatusStore();
const index = new Map<string, string>();

const runtime = createContainerdRuntime({ nerdctl, status, index });
const root = createRoot({ status, sink: runtime.sink });
void watchContainerd({ nerdctl, status, index, signal: new AbortController().signal });

root.render(<WebApp replicas={2} image="nginx:alpine" />);
```

完全なプログラムは `examples/containerd.tsx` にあります。各 op が nerdctl の何になるか、nerdctl の出力について何を仮定しているかは [docs/containerd.md](docs/containerd.md) にまとめています。

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

- `<Service>`: deployment を 1 つの名前で公開する。caddy の `reverse-proxy --to web-0 --to web-1` コンテナを合成で作るのが最短です。
- readiness probe を store の `ready` 状態として流し、`<Ready>` が「プロセス起動」ではなく「接続を受け付ける」を待てるようにする。
- ポート公開（Service の意味が決まってから）。
- 同じ `Nerdctl` インターフェースの裏に containerd gRPC クライアントを置く。

## コントリビュート

Issue と Pull Request を歓迎します。先に [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください。上の 2 つのルールはレビューで守られます。実機の containerd での報告が今いちばん役に立ちます。

## ライセンス

[MIT](LICENSE)
