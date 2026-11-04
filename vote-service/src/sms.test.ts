import { test } from "node:test";
import assert from "node:assert/strict";
import { codeMessage, createLogSender } from "./sms.js";

test("the mock sender only logs: number and text", async () => {
  const lines: string[] = [];
  await createLogSender((l) => lines.push(l)).send("+447700900123", codeMessage("042042", 10));
  assert.deepEqual(lines, ["[sms mock] to +447700900123: Your voting code is 042042. It is valid for 10 minutes."]);
});
