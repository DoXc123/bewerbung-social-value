// Entry point: close a contest. It then refuses votes but keeps its results.
//   DB_PATH=votes.sqlite npm run close -- <contest-id>
import { openStore } from "./store.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: npm run close -- <contest-id>");
  process.exit(1);
}

const store = openStore(process.env.DB_PATH ?? "votes.sqlite");
const closed = store.closeContest(id);
store.close();

if (!closed) {
  console.error(`close: no open contest "${id}" (it doesn't exist or is already closed)`);
  process.exit(1);
}
console.log(`closed: ${id}`);
