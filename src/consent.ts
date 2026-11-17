/**
 * Consent queue for irreversibly visible story actions.
 *
 * One request is active at a time: the story asks a question, the UI answers it,
 * and the next request is presented only after the previous one settles. A request
 * settles exactly once, by allow, deny, timeout, cancellation, or an unbound policy.
 *
 * Answers are bound to a request id. Only the request the UI was handed can be
 * answered, so a stale card left on screen after a timeout cannot approve the
 * request that replaced it. Every settlement is reported to `onSettled` so the
 * UI can retire the card it rendered for that id, whatever the outcome was.
 *
 * The queue holds no story state and never writes anything; callers pass a summary
 * and optional details for the UI to render.
 */

/** What the UI is allowed to answer. */
export type ConsentDecision = "allow" | "deny";

/** Why a request stopped waiting. */
export type ConsentOutcome = "allow" | "deny" | "timeout" | "cancelled" | "unbound";

/** Behaviour when no UI has been bound yet. */
export type UnboundPolicy = "allow" | "deny";

export interface ConsentRequest {
  /** Stable id, unique per queue instance. */
  readonly id: string;
  /** Tool that asked, e.g. "rewind". */
  readonly tool: string;
  /** Short human label, e.g. "时光倒流". */
  readonly label: string;
  /** One line the player reads first. */
  readonly summary: string;
  /** Optional multi-line preview, e.g. the entries about to be erased. */
  readonly details?: string;
  /** True when the action cannot be undone from the story side. */
  readonly irreversible: boolean;
  readonly createdAt: number;
  readonly timeoutMs: number;
}

export interface ConsentInput {
  tool: string;
  label: string;
  summary: string;
  details?: string;
  irreversible: boolean;
}

/**
 * Answers one request.
 *
 * Returning a decision settles the request immediately. Returning "deferred" keeps
 * it open until the UI calls allow(id) or deny(id), the timeout expires, or the
 * asking tool's abort signal fires.
 */
export type ConsentAsk = (request: ConsentRequest) => Promise<ConsentDecision | "deferred">;

/** Called once per request, with the outcome it actually ended with. */
export type ConsentSettled = (request: ConsentRequest, outcome: ConsentOutcome) => void;

export interface ConsentQueueOptions {
  /** Time a single request may stay open. Defaults to 30_000. */
  timeoutMs?: number;
  /** Answer used while no UI is bound. Defaults to "allow". */
  unboundPolicy?: UnboundPolicy;
  /** Clock override for tests. */
  now?: () => number;
}

interface Pending {
  request: ConsentRequest;
  settle: (outcome: ConsentOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  detach: (() => void) | null;
  /** True once this request has been answered; every later answer is ignored. */
  done: boolean;
}

/** Serial, single-shot consent queue shared by every tool that asks. */
export class ConsentQueue {
  private asker: ConsentAsk | null = null;
  private readonly waiting: Pending[] = [];
  private active: Pending | null = null;
  private policy: UnboundPolicy;
  private serial = 0;
  private clearing = false;
  private readonly listeners = new Set<(current: ConsentRequest | null) => void>();
  private readonly settledListeners = new Set<ConsentSettled>();
  readonly defaultTimeoutMs: number;
  private readonly clock: () => number;

  constructor(options: ConsentQueueOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
    this.policy = options.unboundPolicy ?? "allow";
    this.clock = options.now ?? (() => Date.now());
  }

  /** True once a UI has taken over asking. */
  get bound(): boolean {
    return this.asker !== null;
  }

  /**
   * Installs the UI that answers requests.
   *
   * Passing null unbinds the queue and settles every open question as cancelled:
   * a tool that already asked must never wait forever for a UI that left.
   */
  bind(ask: ConsentAsk | null): void {
    if (ask === null) {
      this.asker = null;
      this.clear("cancelled");
      return;
    }
    if (ask === this.asker) return;
    this.asker = ask;
    this.pump();
  }

  setUnboundPolicy(policy: UnboundPolicy): void {
    this.policy = policy;
  }

  getUnboundPolicy(): UnboundPolicy {
    return this.policy;
  }

  /** Called whenever the active request changes (null when the queue empties). */
  subscribe(listener: (current: ConsentRequest | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Called once for every request that stops waiting, with its outcome.
   *
   * The UI uses this to mark the card it rendered for that id as final
   * (approved, denied, expired) and drop its buttons, including on timeout.
   */
  onSettled(listener: ConsentSettled): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /** The request the UI should show now, if any. */
  current(): ConsentRequest | null {
    return this.active?.request ?? null;
  }

  /** Requests waiting behind the active one, oldest first. */
  pending(): readonly ConsentRequest[] {
    return [...(this.active ? [this.active.request] : []), ...this.waiting.map((p) => p.request)];
  }

  /**
   * Asks for permission. Resolves true only on "allow".
   *
   * With no bound UI the unbound policy answers directly and nothing is queued.
   */
  request(input: ConsentInput, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean> {
    if (!this.asker) {
      return Promise.resolve(this.policy === "allow");
    }
    if (options.signal?.aborted) return Promise.resolve(false);

    const request: ConsentRequest = {
      id: `c${++this.serial}`,
      tool: input.tool,
      label: input.label,
      summary: input.summary,
      details: input.details,
      irreversible: input.irreversible,
      createdAt: this.clock(),
      timeoutMs: Math.max(1_000, options.timeoutMs ?? this.defaultTimeoutMs),
    };

    return new Promise<boolean>((resolve) => {
      const pending: Pending = {
        request,
        settle: (outcome) => resolve(outcome === "allow"),
        timer: null,
        detach: null,
        done: false,
      };
      this.waiting.push(pending);
      if (options.signal) {
        const onAbort = () => this.settle(pending, "cancelled");
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.detach = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pump();
    });
  }

  /**
   * Answers the active request by id.
   *
   * Returns false when that id is not the request on screen: a click on a card
   * that timed out or that never became active changes nothing.
   */
  allow(id: string): boolean {
    return this.answer(id, "allow");
  }

  deny(id: string): boolean {
    return this.answer(id, "deny");
  }

  /** Settles the active request and everything queued behind it. */
  clear(outcome: ConsentOutcome = "cancelled"): void {
    this.clearing = true;
    try {
      for (const pending of [...this.waiting]) this.settle(pending, outcome);
      this.waiting.length = 0;
      if (this.active) this.settle(this.active, outcome);
    } finally {
      this.clearing = false;
    }
    this.emit(null);
  }

  /** Unbinds the UI and drops every pending question. */
  dispose(): void {
    this.bind(null);
    this.clear("cancelled");
    this.listeners.clear();
    this.settledListeners.clear();
  }

  private answer(id: string, outcome: ConsentOutcome): boolean {
    const active = this.active;
    if (!active || active.request.id !== id) return false;
    this.settle(active, outcome);
    return true;
  }

  /** Presents the oldest waiting request when nothing is active. */
  private pump(): void {
    if (this.clearing || this.active || !this.asker) return;
    const next = this.waiting.shift();
    if (!next) {
      this.emit(null);
      return;
    }
    this.active = next;
    // The timer starts before the listener runs, so a synchronous answer clears it.
    next.timer = setTimeout(() => this.settle(next, "timeout"), next.request.timeoutMs);
    this.emit(next.request);
    // A listener may have answered the request while it was being shown.
    if (next.done || this.active !== next) return;

    const asker = this.asker;
    Promise.resolve(asker(next.request))
      .then((answer) => {
        if (answer === "deferred") return;
        this.settle(next, answer);
      })
      .catch(() => this.settle(next, "deny"));
  }

  private settle(pending: Pending, outcome: ConsentOutcome): void {
    if (pending.done) return;
    pending.done = true;

    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.detach?.();
    pending.detach = null;

    if (this.active === pending) {
      this.active = null;
    } else {
      const index = this.waiting.indexOf(pending);
      if (index >= 0) this.waiting.splice(index, 1);
    }

    this.notifySettled(pending.request, outcome);
    pending.settle(outcome);
    this.pump();
  }

  private notifySettled(request: ConsentRequest, outcome: ConsentOutcome): void {
    for (const listener of this.settledListeners) {
      try {
        listener(request, outcome);
      } catch {
        // A broken listener must not leave the asking tool waiting.
      }
    }
  }

  private emit(current: ConsentRequest | null): void {
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        // A broken listener must not break the queue.
      }
    }
  }
}
