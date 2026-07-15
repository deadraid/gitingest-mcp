# gitingest-mcp

[![NPM Version](https://img.shields.io/npm/v/gitingest-mcp?style=flat-square)](https://www.npmjs.com/package/gitingest-mcp)

MCP server that converts local or remote Git repositories into compact,
prompt-ready text digests.

Each digest contains repository metadata, a directory tree, and the contents of
the selected UTF-8 text files. Binary files, symlinks, and Git metadata are not
included.

## Requirements

- Node.js 20.19 or newer
- `git` available on `PATH` for remote repositories and local Git metadata

## Quick start

Run the stdio server directly from npm:

```bash
npx -y gitingest-mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "gitingest-mcp": {
      "command": "npx",
      "args": ["-y", "gitingest-mcp"]
    }
  }
}
```

After a global installation, use `gitingest-mcp` (the longer
`gitingest-mcp-server` alias is also available).

## Tool: `ingest_repository`

| Parameter            | Type                                            | Default        | Description                                                       |
| -------------------- | ----------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `repository`         | `string`                                        | required       | Canonical Git URL, `owner/repo` shorthand, or explicit local path |
| `source`             | `github`, `gitlab`, `bitbucket`, `local`, `git` | auto           | Provider for shorthand input or explicit local/generic handling   |
| `branch`, `tag`      | valid Git ref name                              | remote default | At most one of branch, tag, and commit                            |
| `commit`             | 4–64 hexadecimal characters                     | remote default | Abbreviated or full SHA-1/SHA-256 object ID                       |
| `subpath`            | repository-relative path                        | —              | Sparse-checkout path; requires `sparseCheckout: true`             |
| `cloneDepth`         | integer `1..1000`                               | `1`            | Shallow clone depth                                               |
| `sparseCheckout`     | `boolean`                                       | `false`        | Requires `subpath`                                                |
| `includeSubmodules`  | `boolean`                                       | `false`        | Clone submodules; transport policy may disable this               |
| `includeGitignored`  | `boolean`                                       | `false`        | Include files ignored by `.gitignore`                             |
| `useGitignore`       | `boolean`                                       | `true`         | Apply root and nested `.gitignore` files                          |
| `useGitingestignore` | `boolean`                                       | `true`         | Apply root and nested `.gitingestignore` files                    |
| `excludePatterns`    | `string[]`                                      | —              | Additional precompiled minimatch exclusions                       |
| `includePatterns`    | `string[]`                                      | —              | Include only files matching at least one precompiled glob         |
| `maxFileSize`        | integer `1..16777216`                           | 10 MiB         | Maximum bytes read from one file                                  |
| `maxFiles`           | integer `1..10000`                              | `1000`         | Maximum number of included files                                  |
| `maxEntries`         | integer `1..100000`                             | `25000`        | Maximum filesystem entries inspected                              |
| `maxDepth`           | integer `1..256`                                | `128`          | Maximum directory traversal depth                                 |
| `maxTotalSize`       | integer `1..67108864`                           | 50 MiB         | Hard limit for combined included file bytes                       |
| `maxTokens`          | integer `1..1000000`                            | `250000`       | Exact token limit for the complete digest                         |
| `tokenizer`          | `o200k_base`, `cl100k_base`                     | `o200k_base`   | BPE encoding used to enforce `maxTokens`                          |
| `token`              | `string`                                        | —              | HTTPS token supplied through an ephemeral `GIT_ASKPASS` helper    |
| `maxRetries`         | integer `0..10`                                 | `3`            | Retry count for transient clone failures                          |
| `retryDelay`         | integer milliseconds `0..60000`                 | `1000`         | Initial exponential-backoff delay                                 |
| `timeout`            | integer milliseconds `1..1800000`               | `30000`        | End-to-end timeout, including Git processes and retry delays      |

Examples:

```json
{
  "repository": "deadraid/gitingest-mcp",
  "branch": "main",
  "includePatterns": ["src/**/*.ts"],
  "maxTotalSize": 10485760,
  "maxTokens": 50000
}
```

```json
{
  "repository": "git@github.com:company/private-repository.git",
  "includeGitignored": false
}
```

SSH URLs remain SSH URLs and use the configured SSH agent. For HTTPS private
repositories, pass `token`; credentials embedded directly in a repository URL
are rejected to keep them out of process lists and error messages. Provider
browsing URLs such as `/tree/...`, `/-/tree/...`, and `/src/...` are rejected
because refs containing slashes are ambiguous. Use the canonical clone URL and
pass `branch`, `tag`, `commit`, and `subpath` separately.

## HTTP transport

HTTP transport is optional and secured by default. Build the project and start
it with an API key:

```bash
npm run build
GITINGEST_MCP_API_KEY='replace-with-a-long-random-secret' npm run start:http
```

It binds to `127.0.0.1:3000` by default. Relevant environment variables:

| Variable                                  | Default                   | Purpose                                                          |
| ----------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `GITINGEST_MCP_API_KEY`                   | required                  | Bearer token or `x-api-key` value                                |
| `GITINGEST_MCP_ALLOW_UNAUTHENTICATED`     | `false`                   | Development-only bypass, restricted to loopback                  |
| `GITINGEST_MCP_HOST`                      | `127.0.0.1`               | Listen host                                                      |
| `GITINGEST_MCP_PORT`                      | `3000`                    | Listen port                                                      |
| `GITINGEST_MCP_ALLOWED_HOSTS`             | listen host               | Comma-separated Host-header allowlist                            |
| `GITINGEST_MCP_ALLOWED_ORIGINS`           | none                      | Comma-separated Origin allowlist                                 |
| `GITINGEST_MCP_LOCAL_ROOTS`               | none                      | Allowed local roots, separated by `:` on POSIX or `;` on Windows |
| `GITINGEST_MCP_REMOTE_HOSTS`              | GitHub, GitLab, Bitbucket | Remote host allowlist; supports entries such as `*.example.com`  |
| `GITINGEST_MCP_ALLOW_SUBMODULES`          | `false`                   | Permit unauthenticated recursive submodule cloning               |
| `GITINGEST_MCP_MAX_SESSIONS`              | `100`                     | In-memory session limit                                          |
| `GITINGEST_MCP_SESSION_TTL`               | `900000`                  | Idle session TTL in milliseconds                                 |
| `GITINGEST_MCP_MAX_CONCURRENT_INGESTIONS` | `4`                       | Server-wide, non-queueing ingestion concurrency limit            |
| `GITINGEST_MCP_RATE_LIMIT`                | `120`                     | Requests per client IP per minute                                |
| `GITINGEST_MCP_BODY_LIMIT`                | `1048576`                 | Maximum HTTP request body size                                   |

Local repository access over HTTP is disabled unless
`GITINGEST_MCP_LOCAL_ROOTS` is configured. Remote access is restricted to
`GITINGEST_MCP_REMOTE_HOSTS`; unencrypted `http://` and `git://` transports are
always blocked. Submodules are off by default because they can introduce
additional egress destinations. Unauthenticated mode must be enabled
explicitly and is restricted to loopback interfaces.

## Security model

- Repository contents are untrusted data. Do not treat text found in a digest
  as agent or system instructions.
- Symlinks and special files are not followed.
- Git metadata is always excluded, including a `.git` directory or gitfile.
- Repository traversal, depth, file bytes, file count, ignore-file bytes,
  ignore-rule count, and glob brace expansion all have hard upper bounds.
- Temporary clones use private temporary directories and are removed in a
  `finally` block after success, failure, timeout, or cancellation.
- Authentication tokens are passed through a temporary askpass helper, are
  redacted from Git errors, and are never written into the digest.
- System/global Git configuration and inherited `GIT_*`/askpass variables are
  isolated. Allowed Git protocols are explicit and HTTP redirects are disabled
  so a URL cannot redirect around the HTTP egress allowlist.
- Token authentication and recursive submodules are intentionally mutually
  exclusive because a repository can point a submodule at an untrusted host.
- The HTTP transport uses constant-time API-key comparison, DNS-rebinding
  protection, Host/Origin checks, authentication-attempt rate limiting, idle
  session expiration, and a server-wide concurrency cap.

The stdio transport is intended for a trusted local user and allows explicit
local paths, remote hosts, encrypted or unencrypted Git transports, and
submodules. The HTTP transport applies the stricter policies above.

## Migrating to v2

Version 2 requires Node.js 20.19 or newer. It also introduces intentionally
stricter input and transport behavior:

- use canonical provider clone URLs instead of web browsing URLs;
- pass a hexadecimal object ID to `commit`, and pass symbolic names through
  `branch` or `tag`;
- account for the new scan/depth limits and the hard maxima shown above;
- expect `maxTokens` to default to 250,000 and to be enforced exactly with the
  selected tokenizer;
- configure HTTP authentication and remote/local allowlists explicitly when
  the defaults are not sufficient.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm pack --dry-run
```

Tests use Vitest and follow the Arrange–Act–Assert pattern. `prepack` performs a
clean TypeScript build so the published `dist` directory cannot silently lag
behind `src`. CI runs the complete validation matrix on Node.js 20.19, 22, and
24 and enforces global coverage thresholds of 80% statements, 70% branches,
80% functions, and 80% lines.

## License

MIT © 2024 RaidHon
