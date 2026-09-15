# Vendored containerd API definitions

These `.proto` files are copied verbatim from
[containerd/containerd](https://github.com/containerd/containerd), under
`api/`, and are licensed Apache-2.0 by the containerd authors (see the header
of each file).

They are vendored rather than fetched because they are the wire contract this
adapter reads containerd through: a build that silently picked up a different
revision of them would change how state is decoded, which is not something a
`npm install` should be able to do quietly.

Only the services fiber-servo _reads_ are here — `Containers`, `Tasks` and
`Events`, plus the types they reference. Nothing that writes is: every
mutation goes through the `nerdctl` CLI (see `docs/decisions.md`).

To refresh them, re-copy the same paths from the containerd revision you want
and run the test suite; `api.ts` names every field it depends on.
