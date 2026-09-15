# fiber-servo

[English](README.md) | 日本語

**React Fiber を使った、単一ノード向けコンテナオーケストレータの実験。**

JSX で望ましい構成を宣言します。React のコントローラコンポーネントが実行状態を購読し、
必要なリソースを render します。適用には `nerdctl compose`、観測には containerd gRPC を使います。

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

Node 20 以上。containerd ランタイムには `nerdctl` と containerd のソケットに
アクセスできる権限が必要です。[設定と制約](docs/containerd.md)を参照してください。

## containerd なしで試す

リポジトリを clone して `npm install` 後、メモリ上でサンプルを実行できます。

```console
npm run example
npm run example:replicaset
npm run example:webapp
npm run example:plan -- --model
```

最初の3つは Ctrl-C まで実行し、`example:plan` はモデルを表示して終了します。
各 example は JSX を export し、起動・ログ・終了処理は CLI が担当します。
`npm run example:replicaset -- --watch` で保存時の再評価もできます。

containerd での実行は、ソケットへのアクセス権限を持つ環境で
`npm run example:containerd -- --namespace default` を使います。
従来の環境変数 `FIBER_SERVO_NAMESPACE` は CLI の `--namespace` に置き換わります。
React の再レンダリングなしでの復旧は[制御ループのテスト](test/control-loop.test.tsx)で検証します。

## CLI

アプリのファイルは React 要素かコンポーネントを default export します。

```console
npx fiber-servo plan app.tsx --model
npx fiber-servo up app.tsx
npx fiber-servo apply app.tsx
```

- `plan`: メモリランタイムで構成を展開します。`--model` は Compose モデルを
  表示します。実機との差分ではなく、アプリのコード自体は実行されます。
- `up`: Ctrl-C まで実行します。`--watch` を付けるとエントリファイルの保存時に
  再評価します。通常終了時にはアプリのコンテナとネットワークを削除します。
- `apply`: 実行中のセッションに再評価を依頼します。保存だけでは適用しません。
  成功は readiness 完了を意味せず、失敗時のロールバックはありません。

## モデル

ネストは所有関係、props は参照を表します。Network は他のリソースと並べて宣言し、
Container から `network="backend"` で参照します。

| コンポーネント | 役割                                       |
| -------------- | ------------------------------------------ |
| `<Network>`    | ローカルのブリッジネットワーク。           |
| `<Container>`  | Compose サービスに対応する実行単位。       |
| `<ReplicaSet>` | Container テンプレートを指定数維持。       |
| `<Deployment>` | ReplicaSet を通じた段階的ロールアウト。    |
| `<Service>`    | ラベルで選択したコンテナ群へのプロキシ。   |
| `<Ready>`      | 依存先の起動・readiness を待って子を宣言。 |

## 制約

- 単一ノード・単一ライターを想定。クラスタや永続的な API サーバはありません。
- CPU・メモリを含め、Container の spec 変更は再作成になります。
- Service は接続先の変更時にプロキシを再作成し、通信が途切れる場合があります。
  実験の小ささを優先し、この挙動を許容します。
- 外部からのネットワーク変更は検出・自動復旧しません。
- 制御プロセスを再起動するとロールアウト履歴は失われ、旧世代を段階的に
  縮小することなく現在の構成へ収束します。

## ドキュメント

- [API](docs/api.md) — props、フック、ライフサイクル。
- [Architecture](docs/architecture.md) — 責務、状態、復旧の範囲。
- [containerd](docs/containerd.md) — 設定と実行時の挙動。
- [Design decisions](docs/decisions.md) — 判断理由と変更履歴。
- [Project scope](PLAN.md) — 対象外と未決事項。
- [Contributing](CONTRIBUTING.md) — 開発と検証。

## ライセンス

MIT
