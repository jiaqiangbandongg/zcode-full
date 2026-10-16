import { getPackageRoot, startStreamAnimateServer } from "./http.js";

const port = Number.parseInt(process.env.STREAM_ANIMATE_PORT ?? "5187", 10);
const dev = process.argv.includes("--dev");
const server = await startStreamAnimateServer({
  dev,
  packageRoot: getPackageRoot(),
  port: Number.isFinite(port) ? port : 5187,
});

console.log(`stream-animate ready at ${server.url}`);

process.once("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
