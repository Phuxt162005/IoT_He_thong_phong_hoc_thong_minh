import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRoutes } from "../backend/src/routes.js";

test("OpenAPI covers all mounted HTTP operations and resolves local schema references", async () => {
  const document = JSON.parse(await readFile(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  const router = createRoutes({ pool: {}, config: { jwtSecret: "test-secret-for-openapi-contract-coverage" } });
  const actual = new Set(["get /health", "get /ready"]);
  function visit(stack) {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) actual.add(`${method} /api/v1${layer.route.path.replaceAll(/:([a-z_]+)/g, "{$1}")}`);
      else if (layer.handle?.stack) visit(layer.handle.stack);
    }
  }
  visit(router.stack);
  const documented = new Set();
  for (const [path, methods] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(methods)) {
    documented.add(`${method} ${path}`);
    for (const parameter of path.matchAll(/\{([^}]+)\}/g)) assert.ok(operation.parameters.some((p) => p.in === "path" && p.name === parameter[1] && p.required));
  }
  assert.deepEqual([...documented].sort(), [...actual].sort());
  function references(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) assert.ok(value.$ref.split("/").slice(1).reduce((current, key) => current?.[key], document), value.$ref);
    for (const child of Object.values(value)) references(child);
  }
  references(document);
});
