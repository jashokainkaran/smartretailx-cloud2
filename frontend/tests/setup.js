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
