import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SecretBox } from "../backend/src/common/secret-box.js";

test("outbox secrets are authenticated, randomized and bound to their operation", () => {
  const box = new SecretBox(randomBytes(32).toString("hex"));
  const value = box.seal("device-password-never-plaintext", "device:operation1");
  assert.ok(!value.includes("device-password-never-plaintext"));
  assert.equal(box.open(value, "device:operation1"), "device-password-never-plaintext");
  assert.notEqual(box.seal("device-password-never-plaintext", "device:operation1"), value);
  assert.throws(() => box.open(value, "other-device:operation2"));
  assert.throws(() => new SecretBox(randomBytes(32).toString("hex")).open(value, "device:operation1"));
});
