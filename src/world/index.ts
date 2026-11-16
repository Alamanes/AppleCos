// Public entry of the world engine.
//
// Wiring, for the integration pass:
// 1. const store = getStore();            // generated IPC, or useStore(createLocalStore())
// 2. const world = await store.loadWorld(id);
// 3. const loaded = await store.loadSession(sessionId);
//    const session = hydrateSession(loaded.state, loaded.messages, world);
// 4. new Agent({
//      ...,
//      transformContext: createTransformContext({
//        snapshot: () => ({ world, cards, player: session.player, session }),
//        onLore: (result) => { live = absorbLore(live, result); },
//      }),
//    });
// 5. After every assistant message: live = appendMessage(live, {...});
//    live = advanceTurn(live); live = snapshotTurn(live); await store.saveSession(live);
//
// The engine never rewrites a card: play state lives in overlays and memory.

export * from "./types";
export * from "./lorebook";
export * from "./card";
export * from "./memory";
export * from "./prompt";
export * from "./session";
export * from "./store";
