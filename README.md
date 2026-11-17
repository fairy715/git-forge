# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fairy715/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fairy715/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process with no dependencies, written for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty. It keeps everything in memory and serves four surfaces from the same store: git smart HTTP (clone, fetch and push, with its own object store and packfile reader and writer, no git binary), the REST v3 API under `/api/v3`, the GraphQL v4 API at `/api/graphql`, and a Model Context Protocol endpoint at `/mcp`. A repository, issue or pull request made through one surface reads back the same through the others.

## Run it

```sh
FORGE_PORT=8787 node --experimental-strip-types main.ts
```

That serves on port 8787 with no suite to talk to; any bearer token is accepted unless `MAKEFUN_SHOP_TOKEN` is set. In a trial the harness sets `MAKEFUN_ENV_URL` and the forge binds a port of its own, registers it and exits when the suite is done.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The trial lifecycle: listen, register, wait for done, exit. |
| `app.ts` | Routing to the four surfaces, and the error boundary. |
| `src/wire.ts` | HTTP/1.1 on TCP sockets: parsing, keep-alive, single-write replies, and repeated reads answered from their last reply until state changes. |
| `src/http.ts` | Requests and replies as the surfaces see them: auth, JSON, pagination. |
| `src/store.ts` | The state: repositories, refs, labels, issues, pull requests, the clock. |
| `src/forge.ts` | The operations every surface shares (create, commit a file, merge, ...). |
| `src/views.ts` | The JSON GitHub's REST API shows for each object. |
| `src/rest.ts` | The REST v3 routes. |
| `src/mcp.ts` | The MCP endpoint and its tools. |
| `src/graphql/` | A GraphQL parser, an engine with introspection, and the schema. |
| `src/git/` | Objects, packfiles, tree operations and the smart-HTTP protocol. |

---

<sub>Entered on [make.fun](https://make.fun/?ref=64xdc7nz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
