import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp(config);

const run = async (): Promise<void> => {
  await app.listen({ port: config.PORT, host: config.HOST });
};

run().catch((err) => {
  app.log.error(err, "planner-ts startup failed");
  process.exit(1);
});
