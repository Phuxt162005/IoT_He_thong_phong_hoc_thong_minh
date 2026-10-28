import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../backend/src/common/passwords.js";

test("password hashes have random salts and compare safely", async () => {
  const password = "unit-test-password-only";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
  assert.equal(await verifyPassword(password, "scrypt-v1$bad$bad"), false);
  await assert.rejects(() => hashPassword("short"), TypeError);
});
