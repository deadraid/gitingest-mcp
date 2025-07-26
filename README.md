# gitingest-mcp

[![NPM Version](https://img.shields.io/npm/v/gitingest-mcp?style=flat-square)](https://www.npmjs.com/package/gitingest-mcp)

> MCP server that converts Git repositories into compact, prompt-ready digests for Large-Language-Models (LLMs).

`gitingest-mcp` exposes the **Model Context Protocol (MCP)** over stdio so any LLM-aware editor or tool can request an up-to-date representation of a Git repository—local _or_ remote. The server clones (or analyses a local checkout), applies flexible filters (e.g. `.gitignore`, size limits, glob patterns), and streams back a single text document containing:

1. A summary (branch, commit, size, token count…)
2. A human-readable directory tree
3. The concatenated contents of every included file

The result is optimised for conversational code understanding, code-review, and RAG style retrieval.

---

## ✨ Features

• Works with **GitHub, GitLab, Bitbucket, generic git**, or a **local path**  
• Optional **shallow clone**, **sparse checkout**, or **submodule** support  
• Honor `.gitignore` _and_ custom `.gitingestignore` files  
• Powerful include/exclude glob patterns  
• Hard limits for _file size_, _file count_, _total size_, or _token budget_  
• Built-in retry & timeout logic to survive flaky networks

---

## 🚀 Quick Start

```bash
# One-off execution via npx
npx -y gitingest-mcp-server
```

Every MCP-aware client needs a small configuration snippet. Example:

```jsonc
{
  "mcpServers": {
    "gitingest-mcp": {
      "command": "npx",
      "args": ["-y", "gitingest-mcp-server"],
    },
  },
}
```

_(Swap `npx` for the absolute path to `gitingest-mcp-server` if you installed the package globally or are running from source.)_

---

## 🛠️ Available Tools

### ingest_repository

Transform a Git repository into an LLM-friendly digest.

| Parameter                             | Type                                                      | Default             | Description                                                                  |
| ------------------------------------- | --------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `repository`                          | `string`                                                  | **required**        | Git URL (`https://…`), SSH (`git@…`), shorthand (`user/repo`), or local path |
| `source`                              | `"github" \| "gitlab" \| "bitbucket" \| "local" \| "git"` | auto                | Force a specific provider                                                    |
| `branch` / `commit` / `tag`           | `string`                                                  |                     | Checkout a specific ref                                                      |
| `cloneDepth`                          | `number`                                                  | `1`                 | Depth of shallow clone                                                       |
| `sparseCheckout`                      | `boolean`                                                 | `false`             | Enable sparse checkout when possible                                         |
| `includeSubmodules`                   | `boolean`                                                 | `false`             | Recursively pull submodules                                                  |
| `includeGitignored`                   | `boolean`                                                 | `false`             | Include files matched by `.gitignore`                                        |
| `useGitignore`                        | `boolean`                                                 | `true`              | Respect `.gitignore` when filtering                                          |
| `useGitingestignore`                  | `boolean`                                                 | `true`              | Respect `.gitingestignore` when filtering                                    |
| `excludePatterns` / `includePatterns` | `string[]`                                                |                     | Additional glob patterns                                                     |
| `maxFileSize`                         | `number`                                                  |                     | Max single file size (bytes)                                                 |
| `maxFiles`                            | `number`                                                  | `1000`              | Hard file-count limit                                                        |
| `maxTotalSize`                        | `number`                                                  | `52428800` (50 MiB) | Max combined size (bytes)                                                    |
| `maxTokens`                           | `number`                                                  |                     | Trim output after N tokens                                                   |
| `token`                               | `string`                                                  |                     | Auth token for private repos                                                 |
| `maxRetries`                          | `number`                                                  | `3`                 | Retry attempts for network ops                                               |
| `retryDelay`                          | `number`                                                  | `1000`              | Base delay between retries (ms)                                              |
| `timeout`                             | `number`                                                  | `30000`             | Abort the entire operation after N ms                                        |

Example call body:

```jsonc
{
  "name": "ingest_repository",
  "arguments": {
    "repository": "deadraid/gitingest-mcp",
    "branch": "main",
    "excludePatterns": ["**/tests/**"],
    "maxFileSize": 50000,
  },
}
```

---

## 🔭 Running from Source

```bash
# Clone & install
git clone https://github.com/deadraid/gitingest-mcp.git
cd gitingest-mcp
npm install

# Build TypeScript → dist
npm run build

# Start the MCP server (stdout/stdin)
node dist/server/index.js
```

During development you can use:

```bash
npm run dev   # ts-node with autoreload
npm run test  # vitest
npm run lint  # eslint
```

---

## ✅ Tests

Vitest suites live under `tests/` and exercise cancellation, timeouts, schema validation, and advanced edge-cases.

Run all tests with coverage:

```bash
npm run test:coverage
```

---

## 📝 License

MIT © 2024 RaidHon
