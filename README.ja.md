# fiber-servo

[English](README.md) | 日本語

**React Fiberを制御プレーンとして使う、単一ノード向けコンテナオーケストレーターの実験です。**

JSXでアプリケーションの構成を宣言すると、Reactのコントローラーが実行中の状態を読み取り、必要なリソースを組み立てます。Composeへの適用には`nerdctl compose`、状態の監視にはcontainerd gRPCを使います。

```tsx
import { Container, Network, ReplicaSet, Service } from 'fiber-servo';

export default function App() {
  return (
    <>
      <Network name="backend" />

      <ReplicaSet name="api" replicas={3}>
        <Container image="api:v1" network="backend" labels={{ app: 'api' }} ports={[8080]} />
      </ReplicaSet>

      <Service
        name="api"
        network="backend"
        selector={{ app: 'api' }}
        port={80}
        targetPort={8080}
        publish={8080}
      />
    </>
  );
}
```

## インストール

```console
npm install fiber-servo react
```

Node.js 20以上が必要です。containerdを使う場合は、`nerdctl`とcontainerdのソケットにアクセスできる環境を用意してください。詳しくは[設定と制約](docs/containerd.md)を参照してください。

## containerdなしで試す

リポジトリをcloneして`npm install`を実行すると、containerdなしでメモリ上のサンプルを試せます。

```console
npm run example
npm run example:replicaset
npm run example:webapp
npm run example:plan -- --model
```

最初の3つはCtrl-Cまで動き続け、`example:plan`はモデルを表示して終了します。各サンプルはJSXをexportし、起動・ログ出力・終了処理はCLIが担当します。
`npm run example:replicaset -- --watch`を使うと、ファイルを保存するたびに再評価できます。

containerdで試す場合は、ソケットにアクセスできる環境で`npm run example:containerd -- --namespace default`を実行します。以前の環境変数`FIBER_SERVO_NAMESPACE`の代わりに、CLIの`--namespace`オプションを使います。ランタイム障害からの復旧はReactのコントローラーツリーを通じて行い、[制御ループのテスト](test/control-loop.test.tsx)で検証しています。

## CLI

アプリの構成を返すコンポーネントをdefault exportします。

```console
npx fiber-servo plan app.tsx --model
npx fiber-servo up app.tsx
npx fiber-servo apply app.tsx
```

- `plan`: メモリランタイム上でアプリの構成を展開します。`--model`を付けるとComposeモデルを表示します。実機との差分を取るコマンドではなく、アプリのコードを実行してモデルを作ります。
- `up`: Ctrl-Cまで実行し続けます。`--watch`を付けると、エントリーファイルを保存したときに再評価します。通常終了時にはアプリのコンテナとネットワークを削除します。
- `apply`: 実行中のセッションに再評価を依頼します。ファイルを保存しただけでは適用されません。成功してもreadinessの完了は意味せず、失敗時のロールバックも行いません。

## モデル

要素のネストは所有関係を、propsはリソース間の参照を表します。`Network`は他のリソースと同じ階層に宣言し、`Container`から`network="backend"`のように指定して接続します。

| コンポーネント | 役割                                                |
| -------------- | --------------------------------------------------- |
| `<Network>`    | ローカルのブリッジネットワーク                      |
| `<Container>`  | 1つのComposeサービスに対応する実行単位              |
| `<ReplicaSet>` | `Container`を指定した数だけ維持                     |
| `<Deployment>` | `ReplicaSet`を使った段階的なロールアウト            |
| `<Service>`    | ラベルで選んだコンテナへのプロキシ                  |
| `<Ready>`      | 依存先が起動またはreadinessを満たすまで子要素を待機 |

## 制約

- 単一ノード・単一ライター向けです。クラスタや永続APIサーバーは扱いません。
- `Container`のspecを変更すると、CPUやメモリの設定を含めてコンテナを作り直します。
- `Service`の接続先を変えるとプロキシを作り直すため、通信が一時的に途切れることがあります。実験を小さく保つため、この制約を受け入れています。
- 外部から変更されたネットワークは検知も自動復旧もしません。
- 制御プロセスを再起動するとロールアウト履歴は失われます。中断したロールアウトを再開せず、現在の構成へ収束します。

## ドキュメント

- [API](docs/api.md) — props、フック、ライフサイクル
- [Architecture](docs/architecture.md) — 責務、状態、復旧の範囲
- [containerd](docs/containerd.md) — 設定と実行時の挙動
- [Design decisions](docs/decisions.md) — 判断理由と変更履歴
- [Project scope](PLAN.md) — 対象外と未決事項
- [Contributing](CONTRIBUTING.md) — 開発と検証

## ライセンス

MIT
