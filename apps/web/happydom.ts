import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registers a DOM (window, document, ...) as globals so component tests can render under bun:test.
GlobalRegistrator.register();
