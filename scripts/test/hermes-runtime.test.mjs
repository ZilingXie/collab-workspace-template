import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { validateRuntimeWorkspace } from "../validate-hermes-runtime.mjs";

test("Hermes runtime, policy, and action documents are complete and refer to existing sources", async () => {
  const workspaceRoot = path.resolve(new URL("../..", import.meta.url).pathname);
  assert.deepEqual(await validateRuntimeWorkspace(workspaceRoot), []);
});
