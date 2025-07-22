# gitingest-mcp

[![NPM Version](https://img.shields.io/npm/v/gitingest-mcp?style=flat-square)](https://www.npmjs.com/package/gitingest-mcp)

> MCP Server for transforming Git repositories into LLM-friendly text digests

MCP (Model Context Protocol) server providing tools to ingest and analyze Git repositories. This server transforms codebases into structured text digests that are optimized for LLM consumption.

## Overview

This package provides MCP-compatible tools for Git repository analysis:

- **ingest_repository**: Transform a Git repository into an LLM-friendly text digest with directory structure, file contents, and metadata

## 🚀 Quick Start

### Universal MCP Configuration
All modern AI editors use the same MCP configuration format:

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

### Editor Configuration Locations

| Editor | Configuration File |
|--------|-------------------|
| **Claude Desktop** | `claude_desktop_config.json` |
| **Cursor** | Settings > MCP > Add Server |
| **Claude Code** | `.claude.json` in project root |
| **Windsurf** | `.windsurfrc` in project root |
| **Cline** | `.cline/mcp.json` in project root |
| **Zed** | Settings > Extensions > MCP |

## 📋 Available Tools

### ingest_repository
Transform a Git repository into an LLM-friendly text digest.

**Parameters:**
- `repository` (string): Git repository URL or local path
- `token` (string, optional): GitHub Personal Access Token for private repositories
- `includeSubmodules` (boolean, optional): Include repository submodules in the digest (default: false)
- `includeGitignored` (boolean, optional): Include files listed in .gitignore (default: false)
- `excludePatterns` (array, optional): Glob patterns to exclude files (e.g., "*.md", "test/*")
- `maxFileSize` (number, optional): Maximum file size in bytes to include (default: unlimited)
- `maxRetries` (number, optional): Maximum retry attempts (default: 3)
- `retryDelay` (number, optional): Base delay in milliseconds between retry attempts (default: 1000)

## 🔧 Development

```bash
# Clone repository
git clone https://github.com/deadraid/gitingest-mcp.git
cd gitingest

# Install dependencies
npm install

# Build
npm run build

# Run server
npm run start
```

## 📁 Examples
See the `examples/` directory for configuration files for different editors:
- `examples/claude-desktop-config.json`
- `examples/cursor-config.json`
- `examples/claude-code-config.json`