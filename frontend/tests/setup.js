// Runs once before every test file. Adds jest-dom's matchers
// (toBeInTheDocument, toBeDisabled, etc.) to Vitest's expect.
import "@testing-library/jest-dom/vitest";

// React Testing Library's auto-cleanup-after-each-test relies on detecting
// Jest's global test hooks. Vitest isn't Jest, so without this, every
// render() in a file accumulates in the same jsdom document and later
// tests see leftover DOM from earlier ones (surfaced as "found multiple
// elements" errors on queries that should only match once).
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom doesn't implement these — Radix UI's Select (and other
// pointer/portal-driven primitives) call them internally when opening and
// navigating a dropdown. Without a stub they throw, and the dropdown never
// opens in a test.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
