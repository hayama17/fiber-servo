# fiber-servo

**React Fiber を、単一ノード向けコンテナオーケストレータの制御プレーンとして使う。**

コンテナ・ReplicaSet・Service を JSX で書きます。React が「何が存在すべきか」を決め、コントローラが「そのために何をするか」を決め、`nerdctl compose` が実行し、containerd が「実際に何が動いているか」を答えます。

```tsx
import { Container, Network, ReplicaSet, Service, containerd, serve } from 'fiber-servo';

serve(
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
  </>,
  { runtime: containerd() },
);
```

> **位置づけ: 実験プロジェクトです。** 単一ノード、API サーバなし、クラスタリングなし。意図的に小さく保っています——React Fiber が実際に何を担っているかを、読んで確かめられる程度に。

## どこに位置するか

```text
Compose        アプリケーションを記述する。コントローラを持たない:
               レプリカ数を数えることも、世代をロールアウトすることも、
               落ちたコンテナを戻すこともできない。

fiber-servo    そのコントローラ群と、それを宣言するための React ツリー。
               アプリケーションは Compose に渡す。

Kubernetes     それらすべてに加えて、クラスタとそれに伴う一切。
```

したがって fiber-servo はコンテナを作りません。**Compose アプリケーションモデル** を組み立て、`nerdctl compose` に適用させます。`createContainer` も `startTask` も、spec から組み立てたコマンドラインも、このプロジェクトのどこにもありません——イメージの解決、ネットワークの作成、プロセスの実行は Compose の仕事であり、すでに解かれた問題です。

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

なぜこれが重要か。`<ReplicaSet replicas={3}>` の下でコンテナが1つ落ちたとします。

```text
desired = 3   <- 変わっていない。JSX は今も 3 と言っており、それは正しい。
actual  = 2   <- 変わった。
```

React には再レンダリングすべきものが何もありません。気づくべき正しい場所は「3 と 2 を比べるコントローラ」であり、実際そうなっています——落ちたコンテナは **React のレンダリング 0 回** で置き換えられます。`examples/replicaset.tsx` はそのカウンタを表示するので、動かないことを目で確認できます。

代替案——失敗を prop の変化としてツリーに戻し `commitUpdate` を発火させるやり方——は、このプロジェクトの以前のバージョンがやっていたことで、これは嘘です。観測を意図であるかのように符号化しているからです。それを取り除くことが、このアーキテクチャの目的です。

## インストール

```console
npm install fiber-servo react
```

Node 20 以上。containerd ランタイムを使う場合は `nerdctl` が `PATH` にあり、containerd と通信できる権限（通常は `sudo`）が必要です。

## containerd なしで試す

ランタイム境界が宣言的なので、制御プレーン全体——コントローラ、ロールアウト、バックオフ、Service のエンドポイント解決まで——がインメモリのアダプタ上でそのまま動きます。

```console
npm run example            # ネットワーク1つとコンテナ1つ
npm run example:replicaset # コンテナを落とし、コントローラが戻すのを見る
npm run example:webapp     # データベース、ロールアウトされる API、その前段の Service
```

`fiber-servo plan` は自分のファイルに対して同じことをします。適用されるはずの Compose モデルを表示し、何も変更しません。

```console
npx fiber-servo plan examples/app.tsx
```

## CLI

```console
fiber-servo plan  <app.tsx> [--model]           何が作られるかを表示する。--model は Compose ファイル自体
fiber-servo up    <app.tsx> [--watch]           Ctrl-C まで containerd 上で動かす
fiber-servo apply <app.tsx>                     動作中のセッションを再評価する
```

`app.tsx` は要素かコンポーネントを default export します。ファイルが真実の源であり、`apply` を投げる先の API サーバはありません。`--watch` は保存のたびに再評価し、`apply` は必要なときに再評価します。

## モデル

コンポーネントは6つ。読むときの規則は2つです。

**ネストは所有を意味する。**

```text
Deployment
  └─ ReplicaSet     コントローラが作る。自分では書かない
      └─ Container
```

**props は参照である。**

```tsx
<Container network="backend" />       {/* 名前で Network に参加 */}
<Service selector={{ app: 'api' }} /> {/* ラベルでコンテナを選ぶ */}
```

つまりこう書くのが正しく、

```tsx
<Network name="backend" />
<ReplicaSet name="api" replicas={3}>
  <Container image="api:v1" network="backend" />
</ReplicaSet>
```

ReplicaSet を `<Network>` の内側に入れるのは誤りです。Network は、そこに接続するコンテナを所有していません。

| コンポーネント | 何であるか                                             |
| -------------- | ------------------------------------------------------ |
| `<Network>`    | ローカルのブリッジネットワーク。                       |
| `<Container>`  | 1つのプロセスとルートファイルシステム。すべての単位。  |
| `<ReplicaSet>` | 「このテンプレートのコンテナを N 個生かしておく」。    |
| `<Deployment>` | ReplicaSet に対するロールアウト方針。                  |
| `<Service>`    | セレクタに一致するコンテナ群の前段にある安定した窓口。 |
| `<Ready>`      | 順序づけ。あるコンテナが起動するまで内側を宣言しない。 |

Pod はありません。以前のバージョンには Pod があり、infra コンテナとその network namespace を共有するメンバーという CRI 流のエミュレーションで実現していました——containerd も Compose も持たないものを手で作って維持し、その対価として得られるのはサイドカーだけで、ここでは誰も使っていませんでした。コンテナ1つが Compose サービス1つであり、モデルはその分だけ小さくなりました（decision 32）。

### 不変性

```text
コンテナの spec がどこか1つでも違う  → コンテナを置き換える
コンテナが exited と観測された       → コンテナを置き換える
ネットワークの spec が違う           → Compose が作り直す
```

クラッシュとイメージ変更は同じ経路で処理されます。そしてその場での更新はもうありません。Compose にはライブ更新のプリミティブがなく、アクチュエータが所有しているものを横から書き換えるのは、この設計が避けようとしている境界侵犯そのものだからです。メモリ上限を上げるとプロセスは再起動します（decision 34）。

ランタイムアダプタより上では、`stop`・`delete`・`start` と言う場所はどこにもありません。アダプタは望ましいアプリケーション全体を渡され、変更されたサービスを `compose up --no-recreate` が作り直す前に退去させる必要がある、という判断はそこで行われます。

### Service

Service は宛先の一覧ではなく **セレクタ** を取ります。

```tsx
<Service name="api" selector={{ app: 'api' }} port={80} targetPort={8080} publish={8080} />
```

バックエンドの集合は観測状態から解決されます。だからレプリカが入れ替わっても成立します。これは「なぜ各レプリカでホストポートを公開しないのか」への答えでもあります。3つのレプリカが同時に 8080 を持つことはできませんが、その前に立つ Service 1つなら持てます。制御プレーンとデータプレーンは分かれていて、今のデータプレーンは小さなプロキシコンテナです。nftables に置き換えるとしても、変わるのは関数1つです。

### 順序づけ

```tsx
<Container name="db" image="postgres:16"
           readiness={{ exec: ['pg_isready', '-U', 'postgres'] }} />

<Ready on="db" until="ready">
  <Container name="migrate" image="migrate:v1" />
</Ready>
```

`db` が ready を報告するまで、`<Ready>` の内側は宣言されません。これはラッチです。依存先が後から落ちても、依存している側を取り消したりはしません。

## 全体の流れ

```text
JSX → React Fiber → DesiredState → controllers → Compose モデル → nerdctl compose
                                        ▲                              │
                                        │                              ▼
                                        └──── observed state ◄──── containerd gRPC
```

ループはレベルトリガです。毎回、現在の望ましい状態と現在の観測状態を読み、差分を最初から計算し直します。イベントを取りこぼしても、遅れたリコンサイルにはなっても、誤ったリコンサイルにはなりません。

書き込みは Compose を通って下り、読み取りはその下の containerd から返ってきます。これは階層の侵犯ではありません。両者は別の問いに答えているからです。Compose が答えるのは「アプリケーションは適用されたか」であり、containerd が答えるのは「このプロセスは今生きているか、終了コードは何か」——制御ループが必要とする入力であり、どんな CLI 呼び出しでもストリームとしては提供できないものです。

[`docs/architecture.md`](docs/architecture.md) が全体を丁寧に説明し、[`docs/decisions.md`](docs/decisions.md) が各判断の理由を1件ずつ記録しています。

## 非目標

マルチノードのスケジューリング、クラスタメンバーシップ、分散合意、API サーバによる永続化、オーバーレイネットワーク、NetworkPolicy、Kubernetes API 互換。そして今は、Compose がすでに語彙を持っているものを自前で作ること。[`PLAN.md`](PLAN.md) を参照してください。

## ドキュメント

- [`PLAN.md`](PLAN.md) — アーキテクチャ計画と残っている作業
- [`docs/architecture.md`](docs/architecture.md) — 各部品のつながり
- [`docs/decisions.md`](docs/decisions.md) — 判断の理由、1件ずつ
- [`docs/api.md`](docs/api.md) — 公開 API
- [`docs/containerd.md`](docs/containerd.md) — containerd アダプタ

## ライセンス

MIT
