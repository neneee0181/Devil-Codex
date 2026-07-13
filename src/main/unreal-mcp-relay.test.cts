import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get, type Server } from "node:http";
import test from "node:test";
import { UnrealMcpRelay } from "./unreal-mcp-relay.cjs";

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("survives an upstream response aborted by an Unreal restart", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: connected\n\n");
    setImmediate(() => response.destroy());
  });
  const upstreamPort = await listen(upstream);
  const portProbe = createServer();
  const relayPort = await listen(portProbe);
  await close(portProbe);
  const relay = new UnrealMcpRelay({
    listenPort: relayPort,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}/mcp`,
  });
  await relay.start();
  t.after(async () => {
    await relay.stop();
    await close(upstream);
  });

  const outcome = await new Promise<"end" | "aborted" | "error">((resolve, reject) => {
    const request = get(`http://127.0.0.1:${relayPort}/mcp`, (response) => {
      response.resume();
      response.once("end", () => resolve("end"));
      response.once("aborted", () => resolve("aborted"));
      response.once("error", () => resolve("error"));
    });
    request.once("error", reject);
  });

  assert.ok(["aborted", "error"].includes(outcome));
});
