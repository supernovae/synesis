import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { initPatPool, closePatPool } from "./auth/pat-resolver.js";
import { initOtel } from "./telemetry/otel.js";

const config = loadConfig();
initPatPool(config);
const app = buildApp(config);

const run = async (): Promise<void> => {
  await initOtel(config);
  await app.listen({ port: config.PORT, host: config.HOST });
};

const shutdown = async (): Promise<void> => {
  await app.close();
  await closePatPool();
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

run().catch((err) => {
  app.log.error(err, "planner-ts startup failed");
  process.exit(1);
});
