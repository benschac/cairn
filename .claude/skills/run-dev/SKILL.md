---
name: run-dev
description: Start Cairn locally (presence server and viewer) to see a change working in a browser, including two cursors and an agent participant.
---

# Running Cairn locally

`pnpm dev` starts the presence server on port 4310 and the viewer on Vite's
port, which proxies `/presence` to the server. Open the viewer in two windows
to see two cursors. `?name=Ada` sets a name, and a client that connects with
`?kind=agent` is shown as an agent.
