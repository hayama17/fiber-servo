# fiber-servo

English | [日本語](README.ja.md)

**An experiment in using React Fiber as a single-node container control plane.**

Declare the desired application in JSX. Controllers reconcile it with runtime
state, applying through `nerdctl compose` and observing through containerd gRPC.

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

## Install

```console
npm install fiber-servo react
```

Node 20+. The containerd runtime also needs `nerdctl` and access to the
containerd socket. See [configuration and limitations](docs/containerd.md).

## Try it without containerd

Clone this repository and run `npm install`, then use the in-memory examples:

```console
npm run example
npm run example:replicaset
npm run example:webapp
npm run example:plan -- --model
```

The ReplicaSet example demonstrates recovery from a stopped container without
requiring a React render.

## CLI

Your app file must default-export a React element or component.

```console
npx fiber-servo plan app.tsx --model
npx fiber-servo up app.tsx
npx fiber-servo apply app.tsx
```

- `plan` expands the application against the memory runtime; `--model`
  prints the Compose model. It is not a diff against the machine, and it
  executes your app code.
- `up` runs until Ctrl-C. Add `--watch` to re-evaluate on entry-file saves.
  Normal shutdown removes the application's containers and networks.
- `apply` asks the running session to re-evaluate. Saving alone does not
  apply changes. Success does not mean readiness; failures are not rolled back.

## Model

Nesting means ownership; props express references. Declare Network alongside
other resources and join it with `network="backend"` on Container.

| Component      | Role                                                      |
| -------------- | --------------------------------------------------------- |
| `<Network>`    | Local bridge network.                                     |
| `<Container>`  | Runtime unit, mapped to one Compose service.              |
| `<ReplicaSet>` | Maintain a count of a Container template.                 |
| `<Deployment>` | Gradual rollout through ReplicaSets.                      |
| `<Service>`    | Proxy to containers selected by label.                    |
| `<Ready>`      | Declare children after dependencies are running or ready. |

## Limitations

- Single node, single writer. No cluster or persistent API server.
- Every Container spec change replaces it, including CPU and memory limits.
- Service backend changes replace the proxy and can interrupt traffic.
  This is accepted to keep the experiment small.
- External network changes are not detected or self-healed.
- A control-plane restart loses rollout history and converges to the current
  configuration without gradually draining old generations.

## Documentation

- [API](docs/api.md) — props, hooks, and lifecycle.
- [Architecture](docs/architecture.md) — responsibilities, state, recovery scope.
- [containerd](docs/containerd.md) — configuration and runtime behavior.
- [Design decisions](docs/decisions.md) — rationale and history.
- [Project scope](PLAN.md) — non-goals and open questions.
- [Contributing](CONTRIBUTING.md) — development and checks.

## License

MIT
