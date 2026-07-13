# Unreal MCP reconnect relay

Devil Codex keeps a local relay on `http://127.0.0.1:3001/mcp` and forwards to
the Unreal native MCP endpoint for whichever project is currently open. It is
not tied to a project name, engine installation, or Unreal workspace.

Change Codex once:

```toml
[mcp_servers.unreal-engine]
enabled = true
url = "http://127.0.0.1:3001/mcp"
```

Keep Unreal `bEnableNativeMCP=True`. The standard plugin default is port `3000`.

## Non-default ports

Set these user environment variables before starting Devil Codex or its
background service. Both endpoints remain loopback-only for safety. On Windows,
persist them so the logon service receives them too, then sign out/in (or restart
the service).

```powershell
[Environment]::SetEnvironmentVariable("DEVIL_UNREAL_MCP_UPSTREAM_URL", "http://127.0.0.1:3100/mcp", "User")
[Environment]::SetEnvironmentVariable("DEVIL_UNREAL_MCP_RELAY_PORT", "3101", "User")
```

Then point Codex at `http://127.0.0.1:3101/mcp`. This lets separate Unreal
projects use their own native MCP ports without changing Relay code.

After Unreal restarts, its `Mcp-Session-Id` is gone. Relay creates an internal
replacement while preserving Codex's virtual session. `tools/list` retries once.
`tools/call` never retries because save/create/delete could otherwise run twice.
It returns HTTP 503; send mutation again deliberately.

Packaged Windows installs run this with existing Devil Codex Stock Bridge logon
service. In development, start Devil Codex before Codex.

## Check

1. Start Devil Codex. Run `Test-NetConnection localhost -Port 3001`; expect
   `TcpTestSucceeded : True`.
2. Start Unreal, then make a harmless tools-list/inspection request.
3. Restart Unreal and wait until `Test-NetConnection localhost -Port 3000` is true.
4. Repeat tool-list or inspection. It should work without restarting Codex.
5. Send mutation while Unreal is restarting. Expect relay HTTP 503; it must not
   replay automatically.
