import { makeApp } from "./server";
import { printTokenBanner } from "./auth";

const host = process.env.HOST ?? "0.0.0.0";
const port = parseInt(process.env.PORT ?? "12371");

makeApp().listen({ hostname: host, port }, () => {
  console.log(`winrpc listening on http://${host}:${port}`);
  console.log(`  AHK_TEMPLATES_DIR=${process.env.AHK_TEMPLATES_DIR ?? "<cwd>/ahk"}`);
  console.log(`  Platform: ${process.platform}  PID: ${process.pid}`);
  printTokenBanner(host, port);
});
