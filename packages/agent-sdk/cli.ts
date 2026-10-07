#!/usr/bin/env node
import { spawn } from "node:child_process";
import { SiwcAuth } from "./src/auth.js";

const auth = new SiwcAuth();
const command = process.argv[2] ?? "status";
try {
  if (command === "login") {
    console.log("Opening Continue with ChatGPT in your browser. Complete authorization there.");
    const status = await auth.login({ openUrl });
    console.log(status.sharing ? `Connected: ${status.email ?? status.clientId} (ChatGPT plan usage enabled)` :
      `Connected: ${status.email ?? status.clientId} (ChatGPT plan usage not granted)`);
  } else if (command === "status") {
    const status = await auth.status();
    console.log(status.connected ? `Connected: ${status.email ?? status.clientId}; plan usage ${status.sharing ? "enabled" : "disabled"}` : "Not connected");
  } else if (command === "logout") {
    const result = await auth.logout();
    console.log(result.remoteRevocationConfirmed ? "ChatGPT session revoked and local connection removed" :
      "Local ChatGPT connection removed; remote revocation was not confirmed. Disconnect the app in ChatGPT Settings if needed.");
  } else if (command === "models") {
    const token = await auth.accessToken();
    const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
    const body = await response.json() as { models?: { slug: string; display_name?: string; visibility?: string }[] };
    for (const model of body.models ?? []) if (model.visibility === "list") console.log(`${model.slug}\t${model.display_name ?? model.slug}`);
  } else {
    throw new Error("Usage: workflow-siwc login|status|models|logout");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "SIWC command failed");
  process.exitCode = 1;
}

async function openUrl(url: string): Promise<void> {
  const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open the system browser")));
  });
}
