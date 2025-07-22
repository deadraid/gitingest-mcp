#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ingestTool, ingestSchema } from '../tools/ingest.js';

// Default configuration constants
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

const mcpConfig = {
  defaults: {
    maxRetries: DEFAULT_MAX_RETRIES,
    retryDelay: DEFAULT_RETRY_DELAY,
  },
};

const server = new Server(
  {
    name: 'gitingest-mcp',
    version: '1.0.0',
    description:
      'MCP server for transforming Git repositories into LLM-friendly text digests',
    categories: ['git', 'repository', 'llm', 'code-analysis'],
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools with LLM-friendly descriptions
 */
server.setRequestHandler(ListToolsRequestSchema, () => {
  return {
    tools: [
      {
        name: 'ingest_repository',
        description: `
Transform a Git repository into a prompt-friendly text digest for LLMs.

**Best for:** Getting structured code context from Git repositories for AI analysis
**Not recommended for:** When you need the raw binary files or full repository cloning
**Common mistakes:** Using this tool without proper authentication for private repositories
**Prompt Example:** "Analyze the codebase at https://github.com/coderamp-labs/gitingest"
**Usage Example:**
\`\`\`json
{
  "name": "ingest_repository",
  "arguments": {
    "repository": "https://github.com/coderamp-labs/gitingest",
    "token": "github_pat_...",
    "includeSubmodules": true,
    "includeGitignored": false,
    "excludePatterns": ["*.md", "*.txt"],
    "maxFileSize": 100000
  }
}
\`\`\`
**Returns:** A structured text digest containing code content, file tree, and repository statistics.
`,
        inputSchema: {
          type: 'object',
          properties: {
            repository: {
              type: 'string',
              description: 'Git repository URL or local path',
            },
            token: {
              type: 'string',
              description:
                'GitHub Personal Access Token for private repositories',
              optional: true,
            },
            includeSubmodules: {
              type: 'boolean',
              description: 'Include repository submodules in the digest',
              default: false,
            },
            includeGitignored: {
              type: 'boolean',
              description: 'Include files listed in .gitignore',
              default: false,
            },
            excludePatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Glob patterns to exclude files (e.g., "*.md", "test/*")',
              optional: true,
            },
            maxFileSize: {
              type: 'number',
              description:
                'Maximum file size in bytes to include (default: unlimited)',
              optional: true,
            },
            maxRetries: {
              type: 'number',
              description: 'Maximum retry attempts',
              default: mcpConfig.defaults.maxRetries,
            },
            retryDelay: {
              type: 'number',
              description: 'Base delay in milliseconds between retry attempts',
              default: mcpConfig.defaults.retryDelay,
            },
          },
          required: ['repository'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'ingest_repository': {
        const ingestInput = ingestSchema.parse(args);
        return await ingestTool(ingestInput);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid input: ${error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gitingest MCP server started');
}

// Always run the server when executed directly
main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

export { server };
