// Entry point: read the settings, build the pieces, start listening.
// Run with `npm start` (which runs the compiled dist/main.js).
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createIdentity } from "./identity.js";
import { createVoteServer } from "./server.js";
import { createLogSender } from "./sms.js";
import { openStore } from "./store.js";
import { createVerifier } from "./verify.js";

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  console.error(`vote-service: ${loaded.error}`);
  process.exit(1);
}
const config = loaded.value;

const store = openStore(config.dbPath);
const server = createVoteServer({
  store,
  identity: createIdentity({ secret: config.secret, secure: config.secureCookies }),
  verifier: createVerifier({ secret: config.secret }),
  sms: createLogSender((line) => console.log(line)), // a mock: no SMS leaves the machine
  demoCodes: config.smsMode === "demo",
  trustProxy: config.trustProxy,
  publicDir: fileURLToPath(new URL("./public/", import.meta.url)), // dist/public
});

server.listen(config.port, config.host, () => {
  console.log(`vote-service listening on http://${config.host}:${config.port} (db: ${config.dbPath})`);
  console.log(`SMS is mocked (SMS_MODE=${config.smsMode}): codes are ${config.smsMode === "demo" ? "shown on the page and " : ""}logged here`);
});

// Stop cleanly on Ctrl-C or a service stop: finish open requests, then close the database.
function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
