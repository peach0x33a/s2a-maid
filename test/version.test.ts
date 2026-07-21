import { expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import { APP_VERSION } from "../src/version";

test("uses the package version at runtime", () => {
  expect(APP_VERSION).toBe(packageJson.version);
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
});
