# fiber-servo

**React Fiber を、単一ノード向けコンテナオーケストレータの制御プレーンとして使う。**

Pod・ReplicaSet・Service を JSX で書きます。React が「何が存在すべきか」を決め、コントローラが「そのために何をするか」を決め、containerd が実行します。

```tsx
import { Container, Network, Pod, ReplicaSet, Service, containerd, serve } from 'fiber-servo';

serve(
  <>
    <Network name="backend" />

    <ReplicaSet name="api" replicas={3}>
      <Pod network="backend" labels={{ app: 'api' }}>
        <Container name="app" image="api:v1" ports={[8080]} />
      </Pod>
    </ReplicaSet>

    <Service
      name="api"
      network="backend"
      selector={{ app: 'api' }}
      port={80}
      targetPort={8080}
      publish={8080}
    />
  </>,
  { runtime: containerd() },
);
```

> **位置づけ: 実験プロジェクトです。** 単一ノード、API サーバなし、クラスタリングなし。意図的に小さく保っています——React Fiber が実際に何を担っているかを、読んで確かめられる程度に。

## 中心にある考え

リコンサイラが2つあり、それらを混ぜないことが設計のすべてです。

```text
React は管理リソースをリコンサイルする。        「これを3つ動かしたい」
コントローラは実行時リソースをリコンサイルする。  「2つしかない。もう1つ作る」
```

両者は反応する対象が違います。

```text
React のリコンサイル      = 望ましい構成が変わった
コントローラのリコンサイル = 現実が望ましい構成からずれた
```

なぜこれが重要か。`<ReplicaSet replicas={3}>` の下で Pod が1つ落ちたとします。

```text
desired = 3   <- 変わっていない。JSX は今も 3 と言っており、それは正しい。
actual  = 2   <- 変わった。
```

React には再レンダリングすべきものが何もありません。気づくべき正しい場所は「3 と 2 を比べるコントローラ」であり、実際そうなっています——落ちた Pod は **React のレンダリング 0 回** で置き換えられます。`examples/replicaset.tsx` はそのカウンタを表示するので、動かないことを目で確認できます。

```console
$ npm run example:replicaset
bringing up three replicas:
  create-pod api-0
  create-pod api-1
  create-pod api-2
  -> api-0:running api-1:running api-2:running
  React commits so far: 1

killing api-1 behind the control plane’s back:
  replace-pod api-1 because [phase]
  -> api-0:running api-2:running api-1:running
  React commits caused by the failure: 0 (the tree never changed)
```

もう一方のやり方——失敗を prop の変化としてツリーに戻し `commitUpdate` を発火させる——は本プロジェクトの以前の版がやっていたことで、それは嘘です。観測を意図であるかのように符号化しているからです。これを取り除くことが、このアーキテクチャの目的です。

## インストール

```console
npm install fiber-servo react
```

Node 20 以上。containerd ランタイムには `nerdctl` が `PATH` にあり、containerd と通信できる権限（多くの場合 `sudo`）が必要です。

## containerd なしで試す

ランタイム境界が宣言的なので、制御プレーン全体——コントローラ、ロールアウト、バックオフ、Service のエンドポイント解決まで——がインメモリのアダプタ上でそのまま動きます。

```console
npm run example            # ネットワーク1つ、Pod 1つ
npm run example:replicaset # Pod を殺し、コントローラが戻すのを見る
npm run example:webapp     # DB、ロールアウトされる API、その前段の Service
```

`fiber-servo plan` は自分のファイルに対して同じことをし、全アクションを表示して何も実行しません。

```console
npx fiber-servo plan examples/app.tsx
```

## CLI

```console
fiber-servo plan  <app.tsx>                     アクションを表示し、何も実行しない
fiber-servo apply <app.tsx>                     動作中セッションに再評価させる
fiber-servo up    <app.tsx> [--watch]           Ctrl-C まで containerd 上で動かす
```

`app.tsx` は React 要素かコンポーネントを default export します。真実の源はファイルであり、`apply` する先の API サーバは存在しません。`--watch` は保存のたびに再評価し、`apply` は任意のタイミングで再評価させます。

## モデル

コンポーネントは6つ。読み方の規則は2つです。

**ネストは所有関係。**

```text
Deployment
  └─ ReplicaSet     コントローラが作る。自分で書くことはない
      └─ Pod
          └─ Container
```

**props は参照。**

```tsx
<Pod network="backend">             {/* 名前で Network に参加 */}
<Service selector={{ app: 'api' }}>  {/* ラベルで Pod を選択 */}
```

したがってこれが正しく、

```tsx
<Network name="backend" />
<ReplicaSet name="api" replicas={3}>
  <Pod network="backend">…</Pod>
</ReplicaSet>
```

ReplicaSet を `<Network>` の中に入れるのは正しくありません——Network は、そこに接続する Pod を所有していないからです。

| コンポーネント | 意味                                                          |
| -------------- | ------------------------------------------------------------- |
| `<Network>`    | ローカルブリッジネットワーク。                                |
| `<Pod>`        | 実行サンドボックス。ネットワーク名前空間と1つ以上のコンテナ。 |
| `<Container>`  | Pod 内の1プロセスとルートファイルシステム。                   |
| `<ReplicaSet>` | 「このテンプレートの Pod を N 個保つ」。                      |
| `<Deployment>` | ReplicaSet 上のロールアウト方針。                             |
| `<Service>`    | セレクタに一致する Pod 群の前に立つ安定したエンドポイント。   |
| `<Ready>`      | 順序付け。Pod が起動するまで中身を宣言しない。                |

### Pod

Pod はライフサイクルの境界です——ReplicaSet が数え、Service がルーティングする単位。中のコンテナはネットワーク名前空間とアドレスを共有します。

```tsx
<Pod name="api" network="backend">
  <Container name="app" image="api:v1" />
  <Container name="sidecar" image="proxy:v1" />
</Pod>
```

Pod レベルの props はサンドボックスを定義するため、すべて不変です。`network` を変えると Pod は「移動」ではなく「置き換え」になります。

### 不変性モデル

```text
コンテナの cpu / memory                  → その場で更新
コンテナの image / command / env / …     → コンテナを置き換え
Pod の network / publish / labels        → Pod を置き換え
Pod が exited と観測された               → Pod を置き換え
```

クラッシュとイメージ変更は、同じ関数から同じアクションを生みます。ランタイムアダプタより上で `stop` / `delete` / `start` と言う層は1つもありません。

### Service

Service が受け取るのはターゲット一覧ではなく **セレクタ** です。

```tsx
<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

バックエンド集合は観測状態から解決されます。だからこそレプリカが増減できます。「Pod にホストポートを publish すればよいのでは」への答えでもあります——3つのレプリカが同じ 8080 番を持つことはできませんが、前段の Service 1つなら持てます。制御プレーンとデータプレーンは分離されており、今のデータプレーンは小さなプロキシ Pod です。nftables に差し替えるなら変更は1関数で済みます。

### 順序付け

```tsx
<Pod name="db">
  <Container name="postgres" image="postgres:16"
             readiness={{ exec: ['pg_isready', '-U', 'postgres'] }} />
</Pod>

<Ready on="db" until="ready">
  <Pod name="migrate">…</Pod>
</Ready>
```

`db` が ready を報告するまで `<Ready>` の中身は宣言されません。ラッチ式なので、後から依存先が落ちても依存側は取り消されません。

## 全体の流れ

```text
JSX → React Fiber → DesiredState → コントローラ → planner → Runtime アダプタ → containerd
                                        ▲                                          │
                                        └────────────── 観測状態 ◄─────────────────┘
```

ループはレベルトリガです。毎回、現在の desired と現在の observed を読んで差分を計算し直します。イベントを取りこぼしても、遅いリコンサイルになるだけで、誤ったリコンサイルにはなりません。

詳細は [`docs/architecture.md`](docs/architecture.md)、判断の理由は [`docs/decisions.md`](docs/decisions.md) にあります。

## やらないこと

マルチノードスケジューリング、クラスタメンバーシップ、分散合意、API サーバによる永続化、オーバーレイネットワーク、NetworkPolicy、Kubernetes API 互換。[`PLAN.md`](PLAN.md) を参照してください。

## ドキュメント

- [`PLAN.md`](PLAN.md) — アーキテクチャ計画と未実装分
- [`docs/architecture.md`](docs/architecture.md) — 各部品の噛み合い方
- [`docs/decisions.md`](docs/decisions.md) — 判断の記録
- [`docs/api.md`](docs/api.md) — 公開 API
- [`docs/containerd.md`](docs/containerd.md) — containerd アダプタ

## ライセンス

MIT
