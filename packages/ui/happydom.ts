import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Registers a DOM (window, document, ...) as globals so component tests can render under bun:test.
GlobalRegistrator.register();

// Tells React 18 it is running inside a test, which enables `act()` and silences the
// "not wrapped in act(...)" warning for state updates driven by timers and focus effects.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom implements no layout, so `scrollIntoView` is absent. Select calls it to keep the
// active option in view; the call sites guard with `?.`, but the stub keeps the tests honest by
// letting the real code path run instead of short-circuiting.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
