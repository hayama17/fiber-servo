/**
 * containerd's event envelope, translated into the row the existing watcher
 * already understands.
 *
 * `src/runtime/containerd/events.ts` consumes `EventRow`:
 * `{ ID, Topic, Event }` where `Event` is the containerd event body with its
 * snake_case field names. That is what nerdctl prints, and it is also exactly
 * what comes out of `Events.Subscribe` once the `google.protobuf.Any` in the
 * envelope is unpacked - which means `interpretEvent` does not have to change
 * for a gRPC driver. The tests in ../test assert that.
 *
 * One correction is needed, and it is the whole reason this file exists.
 * `interpretEvent` drops a `/tasks/exit` whose `id` differs from
 * `container_id`, because exec processes exit too and only the init process
 * is the container. containerd's shim sets `id` to the container id for the
 * init process, so that holds on a real host - but the field is documented as
 * optional (events/task.proto, TaskDelete: "id is the specific exec. By
 * default if omitted will be `""` thus matches the init exec of the task
 * matching `container_id`"), and a protobuf decode with defaults turned on
 * yields `id: ''` rather than absent. An empty id therefore has to be read as
 * "the init process" before the row reaches `interpretEvent`, or every exit
 * would be silently ignored and the tree would never self-heal.
 */
import { unpackProto, type Any } from './any.js';

/** `containerd.types.Envelope` as proto-loader decodes it (api v1.8+; in 1.7 this type lived in the events service package). */
export interface Envelope {
  timestamp?: { seconds?: string; nanos?: number };
  namespace?: string;
  topic?: string;
  event?: Any;
}

/** The shape `interpretEvent` in src/runtime/containerd/events.ts consumes. */
export interface EventRow {
  ID: string;
  Topic: string;
  Event?: string | Record<string, unknown>;
}

export function envelopeToEventRow(envelope: Envelope): EventRow | null {
  const topic = envelope.topic ?? '';
  if (!topic) return null;
  const body = unpackProto(envelope.event) ?? {};
  const containerId = identify(topic, body);
  // See the note above: an empty exec id means the init process.
  if (topic === '/tasks/exit' && body['id'] === '') body['id'] = containerId;
  return { ID: containerId, Topic: topic, Event: body };
}

/**
 * Which field holds the container id depends on the event, and the spike
 * found this the hard way: `containerd.events.TaskExit` and friends carry
 * `container_id`, but `containerd.events.ContainerCreate` / `ContainerDelete`
 * (events/container.proto) carry plain `id`. `interpretEvent` reads
 * `container_id` and falls back to the row's `ID`, which nerdctl fills in for
 * both; a gRPC driver has to fill it in itself or every `/containers/delete`
 * arrives anonymous and the store never forgets a deleted container.
 *
 * `id` is only the container's id on `/containers/*`. On `/tasks/*` it is the
 * exec id, which is a different thing entirely.
 */
function identify(topic: string, body: Record<string, unknown>): string {
  const containerId = body['container_id'];
  if (typeof containerId === 'string' && containerId !== '') return containerId;
  const id = body['id'];
  if (topic.startsWith('/containers/') && typeof id === 'string') return id;
  return '';
}

/**
 * `Events.Subscribe` is cross-namespace unless filtered (see the comment on
 * the rpc in services/events/v1/events.proto), so a driver that omits this
 * would report containers from every namespace on the host.
 */
export function namespaceFilter(namespace: string): string[] {
  return [`namespace==${namespace}`];
}
