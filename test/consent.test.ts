import { describe, expect, test } from "bun:test";

import {
  ConsentQueue,
  type ConsentDecision,
  type ConsentInput,
  type ConsentRequest,
} from "../src/consent";

const INPUT: ConsentInput = {
  tool: "rewind",
  label: "时光倒流",
  summary: "退回一轮",
  irreversible: true,
};

/** Records every request and never answers on its own. */
function deferring(): { ask: (request: ConsentRequest) => Promise<ConsentDecision | "deferred">; seen: ConsentRequest[] } {
  const seen: ConsentRequest[] = [];
  return {
    seen,
    ask: async (request) => {
      seen.push(request);
      return "deferred";
    },
  };
}

function queueWith(ui: ReturnType<typeof deferring>): ConsentQueue {
  const queue = new ConsentQueue({ unboundPolicy: "deny" });
  queue.bind(ui.ask);
  return queue;
}

describe("ConsentQueue id binding", () => {
  test("answers only the request the UI was handed", async () => {
    const ui = deferring();
    const queue = queueWith(ui);
    const first = queue.request(INPUT);
    const second = queue.request(INPUT);

    const firstId = queue.current()?.id ?? "";
    const secondId = queue.pending()[1]?.id ?? "";
    expect(firstId).not.toBe(secondId);

    // A queued request was never presented, so it cannot be approved.
    expect(queue.allow(secondId)).toBe(false);
    expect(queue.deny("c999")).toBe(false);

    expect(queue.allow(firstId)).toBe(true);
    expect(await first).toBe(true);
    expect(queue.current()?.id).toBe(secondId);

    // Approving the card that already settled changes nothing.
    expect(queue.allow(firstId)).toBe(false);
    expect(queue.deny(secondId)).toBe(true);
    expect(await second).toBe(false);
  });

  test("reports each settlement once, with its outcome", async () => {
    const ui = deferring();
    const queue = queueWith(ui);
    const notices: Array<[string, string]> = [];
    queue.onSettled((request, outcome) => notices.push([request.id, outcome]));

    const first = queue.request(INPUT);
    const id = queue.current()?.id ?? "";
    queue.allow(id);
    queue.allow(id);
    expect(await first).toBe(true);

    expect(notices).toEqual([[id, "allow"]]);
  });
});

describe("ConsentQueue expiry and unbinding", () => {
  test("a timed out request resolves as denied and reports timeout", async () => {
    const ui = deferring();
    const queue = queueWith(ui);
    const notices: Array<[string, string]> = [];
    queue.onSettled((request, outcome) => notices.push([request.id, outcome]));

    const pending = queue.request(INPUT, { timeoutMs: 1_000 });
    const id = queue.current()?.id ?? "";
    expect(await pending).toBe(false);
    expect(notices).toEqual([[id, "timeout"]]);
  });

  test("unbinding settles the active and queued requests as cancelled", async () => {
    const ui = deferring();
    const queue = queueWith(ui);
    const notices: string[] = [];
    queue.onSettled((_request, outcome) => notices.push(outcome));

    const first = queue.request(INPUT);
    const second = queue.request(INPUT);
    queue.bind(null);

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(notices).toEqual(["cancelled", "cancelled"]);
    expect(queue.current()).toBeNull();
  });

  test("the asking tool's abort signal settles the request", async () => {
    const ui = deferring();
    const queue = queueWith(ui);
    const controller = new AbortController();
    const pending = queue.request(INPUT, { signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
    expect(queue.current()).toBeNull();
  });
});

describe("ConsentQueue unbound policy", () => {
  test("answers from the policy while no UI is bound", async () => {
    const deny = new ConsentQueue({ unboundPolicy: "deny" });
    expect(await deny.request(INPUT)).toBe(false);
    const allow = new ConsentQueue({ unboundPolicy: "allow" });
    expect(await allow.request(INPUT)).toBe(true);
    expect(allow.current()).toBeNull();
  });
});
