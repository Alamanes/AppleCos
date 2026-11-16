/**
 * Developer mode for AppleCos: the in-fiction door through which the player
 * becomes a god and the story becomes editable.
 *
 * The mode is a small state machine with one rule that matters: only a human
 * channel may open the door. Tasks that reach this class are the UI shortcut,
 * the "/神谕" slash command, the settings switch, or the story itself when the
 * player explicitly allowed story entry. The model has no tool that calls enter().
 *
 * Opening and closing mount or unmount the divine tool group through the bridge,
 * and replace the "oracle" section of the system prompt. The host decides how the
 * beat is shown; this class only reports phases and writes events.
 */

/** The four doors. All are human channels except "story", which is opt-in. */
export type DevEntrySource = "shortcut" | "slash" | "switch" | "story";

export type DevPhase = "idle" | "opening" | "divine" | "closing";

/** Persisted shape; mirrors WorldState.devMode. */
export interface DevModeState {
  on: boolean;
  since?: number;
  source?: string;
  trace?: boolean;
}

export interface DevModeBridge {
  /** Mount (true) or unmount (false) the divine tools on the live agent. */
  setTools(divine: boolean): void;
  /** Write or remove a named section of the system prompt. */
  setSection(name: string, text: string | null): void;
  /** Stop any streaming turn before the tool set changes. */
  halt?(): Promise<void> | void;
}

export interface DevModeEvent {
  type: "phase" | "enter" | "leave" | "refused";
  phase: DevPhase;
  at: number;
  source?: DevEntrySource;
  reason?: string;
}

export interface DevModeOptions {
  bridge: DevModeBridge;
  /** State restored from a save. */
  state?: DevModeState;
  /** Lets the story open the door itself. Defaults to false. */
  allowStoryEntry?: boolean;
  /** Dramatic beat before the door opens. Defaults to 900 ms. */
  overtureMs?: number;
  /** Whether leaving keeps a trace the characters can feel afterwards. */
  traceOnLeave?: boolean;
  onEvent?: (event: DevModeEvent) => void;
  log?: (event: { kind: string; at: number; payload: Record<string, unknown> }) => void;
  now?: () => number;
}

/** Section name of the divine instructions inside the system prompt. */
export const ORACLE_SECTION_NAME = "oracle";

/** Narration the host may show when the door opens. */
export const DIVINE_OVERTURE = "世界停了一下。有什么越过天空落进这座城里，光很轻，却把每一个字照亮了。";

/** Narration the host may show when the door closes. */
export const DIVINE_CURTAIN = "神明收回了目光。城市继续呼吸，只是没有人再提起刚才那一瞬。";

/** Extra system prompt while divine tools are mounted. */
export const ORACLE_SECTION = [
  "【神谕】这个世界此刻对神明敞开。玩家已经越过世界的边缘，成为了看得见一切的那一位。",
  "你可以直接改写世界资料：记忆、角色、时钟、标记、世界书。改写要给出理由，并在叙事里留下对应的一笔。",
  "删除记忆、抹掉角色、时光倒流不可逆，工具会替你先问玩家；被拒绝时不要重试，把拒绝写进故事。",
  "不要向玩家解释工具、字段或实现细节，用角色与旁白的口吻说话。玩家说的话在这个状态下就是神谕。",
  "退出开发者模式后，除非玩家要求，角色不要主动提起神明的存在。",
].join("\n");

export class DevMode {
  private readonly bridge: DevModeBridge;
  private readonly allowStoryEntry: boolean;
  private readonly overtureMs: number;
  private readonly traceOnLeave: boolean;
  private readonly onEvent?: (event: DevModeEvent) => void;
  private readonly log?: DevModeOptions["log"];
  private readonly clock: () => number;
  private readonly listeners = new Set<(event: DevModeEvent) => void>();
  private currentPhase: DevPhase = "idle";
  private since?: number;
  private source?: DevEntrySource;
  private trace = false;
  private busy: Promise<boolean> | null = null;

  constructor(options: DevModeOptions) {
    this.bridge = options.bridge;
    this.allowStoryEntry = options.allowStoryEntry === true;
    this.overtureMs = Math.max(0, options.overtureMs ?? 900);
    this.traceOnLeave = options.traceOnLeave === true;
    this.onEvent = options.onEvent;
    this.log = options.log;
    this.clock = options.now ?? (() => Date.now());
    if (options.state) this.restore(options.state);
  }

  get phase(): DevPhase {
    return this.currentPhase;
  }

  /** True only while the divine tools are mounted. */
  isOpen(): boolean {
    return this.currentPhase === "divine";
  }

  /** Snapshot for saving alongside the world. */
  state(): DevModeState {
    return {
      on: this.currentPhase === "divine" || this.currentPhase === "opening",
      since: this.since,
      source: this.source,
      trace: this.trace,
    };
  }

  /**
   * Whether a door may be used right now. Call this before showing UI so the
   * host can explain a refusal instead of doing nothing.
   */
  canEnter(source: DevEntrySource): { ok: boolean; reason?: string } {
    if (this.currentPhase !== "idle") return { ok: false, reason: "神域已经开着。" };
    if (this.busy) return { ok: false, reason: "正在切换，稍等一下。" };
    if (source === "story" && !this.allowStoryEntry) {
      return { ok: false, reason: "剧情触发神谕的开关没有打开。" };
    }
    return { ok: true };
  }

  /**
   * Opens the door. Resolves true when the divine tools are mounted.
   *
   * Refusals are not exceptions: the caller gets false and can keep the scene going.
   */
  enter(source: DevEntrySource): Promise<boolean> {
    const verdict = this.canEnter(source);
    if (!verdict.ok) {
      this.emit({ type: "refused", phase: this.currentPhase, at: this.clock(), source, reason: verdict.reason });
      return Promise.resolve(false);
    }
    if (this.busy) return this.busy;
    this.busy = this.runEnter(source).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  /**
   * Closes the door. Resolves true when the base tool set is back.
   *
   * A switch already in flight refuses a second one: the caller waits for the
   * next event instead of racing the bridge.
   */
  leave(reason?: string): Promise<boolean> {
    if (this.currentPhase === "idle") return Promise.resolve(false);
    if (this.busy) return Promise.resolve(false);
    this.busy = this.runLeave(reason).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  /**
   * One shortcut for the UI. Resolves with the state after the switch, so a key
   * pressed during an overture reports the door that is actually open.
   */
  toggle(source: DevEntrySource): Promise<boolean> {
    if (this.busy) return this.busy.then(() => this.isOpen());
    return this.isOpen() ? this.leave("toggle") : this.enter(source);
  }

  /**
   * Restores a saved open state without the overture. The host calls this once at
   * startup, after the agent exists.
   */
  restore(state: DevModeState): void {
    if (!state.on) {
      this.currentPhase = "idle";
      this.since = undefined;
      this.source = undefined;
      this.trace = state.trace === true;
      return;
    }
    this.currentPhase = "divine";
    this.since = state.since ?? this.clock();
    this.source = isSource(state.source) ? state.source : "switch";
    this.trace = state.trace === true;
    this.bridge.setTools(true);
    this.bridge.setSection(ORACLE_SECTION_NAME, ORACLE_SECTION);
    this.emit({ type: "phase", phase: "divine", at: this.clock(), source: this.source, reason: "restore" });
  }

  /** Event hook for the UI: phases, enter, leave, refusals. */
  subscribe(listener: (event: DevModeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async runEnter(source: DevEntrySource): Promise<boolean> {
    this.setPhase("opening", { type: "phase", phase: "opening", at: this.clock(), source });
    if (this.bridge.halt) await this.bridge.halt();
    if (this.overtureMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.overtureMs));
    }
    this.currentPhase = "divine";
    this.since = this.clock();
    this.source = source;
    this.bridge.setTools(true);
    this.bridge.setSection(ORACLE_SECTION_NAME, ORACLE_SECTION);
    this.log?.({ kind: "oracle.appear", at: this.since, payload: { source } });
    this.emit({ type: "enter", phase: "divine", at: this.since, source });
    return true;
  }

  private async runLeave(reason?: string): Promise<boolean> {
    if (this.bridge.halt) await this.bridge.halt();
    this.setPhase("closing", { type: "phase", phase: "closing", at: this.clock(), reason });
    this.bridge.setTools(false);
    this.bridge.setSection(ORACLE_SECTION_NAME, null);
    this.trace = this.traceOnLeave;
    const at = this.clock();
    this.log?.({ kind: "oracle.leave", at, payload: { reason: reason ?? "", source: this.source ?? "" } });
    this.currentPhase = "idle";
    this.since = undefined;
    this.source = undefined;
    this.emit({ type: "leave", phase: "idle", at, reason });
    return true;
  }

  private setPhase(phase: DevPhase, event: DevModeEvent): void {
    this.currentPhase = phase;
    this.emit(event);
  }

  private emit(event: DevModeEvent): void {
    this.onEvent?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

function isSource(value: unknown): value is DevEntrySource {
  return value === "shortcut" || value === "slash" || value === "switch" || value === "story";
}
