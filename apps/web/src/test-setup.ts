// jsdom has no layout engine. The panel library constructs a ResizeObserver; a no-op one is enough for tests, which
// assert structure and behavior rather than measured sizes. Tests that need resize callbacks stub their own.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
