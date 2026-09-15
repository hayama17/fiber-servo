/**
 * A Deployment's rollout history, for as long as this process is alive.
 *
 * ## What this is
 *
 * `expandDeployment` is a pure function of the *current* `DeploymentSpec`, and
 * a Deployment carries one template — the one you wrote — not a history of
 * them. While a rollout is in progress it nonetheless has to say what the
 * *previous* generation's containers should look like, because a container
 * that dies mid-drain has to come back as the thing it was, not as an
 * approximation of it. This is where that mapping lives, and it lives here
 * for exactly as long as the process does.
 *
 * ## Why it is not persisted, anywhere
 *
 * It was, twice, and both were wrong in the same way.
 *
 * First on the container itself, as a `fiber-servo.template` label holding
 * the whole template. containerd refuses any label whose key and value exceed
 * 4096 bytes together (measured against containerd 2.2.2: 6015 bytes
 * rejected, two labels of 3000 bytes accepted, so the cap is per pair), which
 * made an ordinary spec with a few kilobytes of environment impossible to
 * create at all.
 *
 * Then in a JSON file beside the application, which fixed the symptom and
 * kept the mistake: fiber-servo's control plane is in-memory and volatile by
 * design, and writing controller bookkeeping to disk quietly gave one piece
 * of it a different lifetime from the rest. The restart gate's failure
 * counts, a `<Ready>` latch, how far a rollout has got — none of those
 * survive a restart, and none of them should. A rollout history is the same
 * kind of thing.
 *
 * The real rule is the one both attempts missed: **controller history does
 * not go into runtime metadata.** What a container carries is identity —
 * managed, owner, generation, spec digest — all small, all fixed-width, and
 * all answers to "what is this", never "how did we get here".
 *
 * ## What a restart means, precisely
 *
 * Controller state resets. fiber-servo does not resume a rollout that was in
 * flight; it converges, freshly, on what the tree says now:
 *
 *   in the current desired state, missing   -> create
 *   not in the current desired state        -> remove
 *
 * So an interrupted rollout finishes abruptly rather than gradually — the old
 * generation is drained at once instead of being stepped down, because
 * nothing any longer claims those containers are wanted. That is a real
 * difference and it is the intended one. The alternative is a control plane
 * that is partly durable, which is harder to reason about than one that is
 * honestly volatile: the guarantee fiber-servo makes is convergence to
 * current desired state, not continuity of a plan.
 *
 * `expandDeployment` will not invent a template for a generation it has no
 * record of (see `recoverTemplate` there), so the failure mode is "the
 * rollout finishes sooner", never "a container comes back as something nobody
 * asked for".
 */
import { digest, type ContainerTemplate } from './resources.js';

/**
 * Keyed by the generation's identity — the **full** `digest()` of the
 * template, the same value `GENERATION_LABEL` carries. Not the short form
 * that appears in container names: that is a rendering, and filing a history
 * under a rendering is how two unrelated templates come to share one.
 *
 * The read side is a plain map, which is what the controllers take: they stay
 * pure functions of (desired, observed, generations), and nothing about them
 * has to know where the map came from.
 */
export type Generations = ReadonlyMap<string, ContainerTemplate>;

export interface GenerationHistory {
  /** Record a template under its own generation id. Idempotent. */
  remember(template: ContainerTemplate): void;
  /** Everything known right now, to hand to the controllers. */
  all(): Generations;
  /** Drop every generation not in `keep`, so the history does not grow for ever. */
  prune(keep: Iterable<string>): void;
}

/**
 * One rollout history, empty at birth and gone when the process is.
 *
 * There is deliberately no second implementation and no option to persist it.
 * A durable variant would have to answer what happens when it disagrees with
 * the machine, and the answer this design wants is that the question cannot
 * arise: the only durable record of what is running is the machine itself.
 */
export function createGenerationHistory(): GenerationHistory {
  const templates = new Map<string, ContainerTemplate>();
  return {
    remember(template) {
      templates.set(digest(template), template);
    },
    all: () => templates,
    prune(keep) {
      const kept = new Set(keep);
      for (const generation of [...templates.keys()]) {
        if (!kept.has(generation)) templates.delete(generation);
      }
    },
  };
}
