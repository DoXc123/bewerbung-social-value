import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseContestList, seedContests } from "./contests-file.js";
import { openStore } from "./store.js";

const pets = { id: "pets", title: "Best pet", options: ["Cat", "Dog"] };

test("a valid list is accepted", () => {
  assert.deepEqual(parseContestList([pets]), { ok: true, value: [pets] });
  assert.deepEqual(parseContestList([]), { ok: true, value: [] });
});

for (const file of ["contests.json", "contests.example.json"]) {
  test(`the shipped ${file} is valid and can be seeded`, () => {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const parsed = parseContestList(json);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const store = openStore(":memory:");
    const report = seedContests(store, parsed.value);
    assert.deepEqual(report.failed, []);
    assert.equal(report.created.length, parsed.value.length);
    store.close();
  });
}

test("wrong shapes are refused with a pointer to the contest", () => {
  const bad = (input: unknown, fragment: string) => {
    const r = parseContestList(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, new RegExp(fragment));
  };
  bad({}, "array");
  bad("pets", "array");
  bad([null], "contest #1 must be an object");
  bad([pets, []], "contest #2 must be an object");
  bad([{ ...pets, id: 5 }], "id must be a string");
  bad([{ ...pets, title: undefined }], "title must be a string");
  bad([{ ...pets, options: "Cat" }], "options must be an array");
  bad([{ ...pets, options: ["Cat", 2] }], "options must be an array of strings");
  bad([{ ...pets, extra: 1 }], "unknown field: extra");
});

test("seeding creates new contests and leaves existing ones alone", () => {
  const store = openStore(":memory:");
  const first = seedContests(store, [pets]);
  assert.deepEqual(first, { created: ["pets"], skipped: [], failed: [] });

  store.cast({ contestId: "pets", voterId: "u1", phoneHash: "p-u1", choice: "Cat" });
  // running again, even with different options, changes nothing
  const second = seedContests(store, [{ ...pets, options: ["Bird", "Snake"] }]);
  assert.deepEqual(second, { created: [], skipped: ["pets"], failed: [] });
  assert.deepEqual(store.getContest("pets")?.options, ["Cat", "Dog"]);
  assert.deepEqual(store.tally("pets")[0], { choice: "Cat", votes: 1 });
  store.close();
});

test("a contest the store refuses is reported and the others still go in", () => {
  const store = openStore(":memory:");
  const report = seedContests(store, [
    { id: "bad id", title: "T", options: ["A", "B"] },
    pets,
  ]);
  assert.deepEqual(report.created, ["pets"]);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0], /^bad id: .*letters, digits/);
  store.close();
});
