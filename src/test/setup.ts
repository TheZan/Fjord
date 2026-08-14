import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only auto-cleans when Vitest runs with `globals: true`, which
// this project deliberately does not. Without this, a second test in the same
// file queries the previous test's DOM as well as its own.
afterEach(cleanup);
