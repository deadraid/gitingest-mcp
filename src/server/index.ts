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
const DEFAULT_TIMEOUT = 30000; // 30 seconds

const mcpConfig = {
  defaults: {
    maxRetries: DEFAULT_MAX_RETRIES,
    retryDelay: DEFAULT_RETRY_DELAY,
    timeout: DEFAULT_TIMEOUT,
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
Transform a Git repository into a prompt-friendly text digest for LLMs with enhanced capabilities.

**Best for:** Comprehensive code context analysis with support for multiple Git hosts, local repositories, and advanced filtering
**Not recommended for:** Simple use cases where basic functionality is sufficient
**Common mistakes:** Not specifying branch/tag when needed, ignoring file size limits
**Prompt Example:** "Analyze the codebase at user/repo with all branches"
**Usage Example:**
\`\`\`json
{
  "name": "ingest_repository",
  "arguments": {
    "repository": "user/repo",
    "branch": "main",
    "includeGitignored": false,
    "maxFileSize": 50000,
    "maxFiles": 200,
    "maxTotalSize": 10000000
  }
}
\`\`\`
**Returns:** A structured text digest containing code content, file tree, and repository statistics with enhanced metadata.
`,
        inputSchema: {
          type: 'object',
          properties: {
            repository: {
              type: 'string',
              description:
                'Git repository URL, local path, or shorthand (user/repo)',
            },
            source: {
              type: 'string',
              enum: ['github', 'gitlab', 'bitbucket', 'local', 'git'],
              description: 'Explicit source type (optional, auto-detected)',
              optional: true,
            },
            branch: {
              type: 'string',
              description: 'Branch to analyze (optional, defaults to main)',
              optional: true,
            },
            commit: {
              type: 'string',
              description: 'Specific commit to analyze (optional)',
              optional: true,
            },
            tag: {
              type: 'string',
              description: 'Specific tag to analyze (optional)',
              optional: true,
            },
            subpath: {
              type: 'string',
              description: 'Specific subpath to analyze (optional)',
              optional: true,
            },
            cloneDepth: {
              type: 'number',
              description: 'Depth of git clone (1-1000, default: 1)',
              default: 1,
            },
            sparseCheckout: {
              type: 'boolean',
              description: 'Use sparse checkout for large repositories',
              default: false,
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
            useGitignore: {
              type: 'boolean',
              description: 'Use .gitignore file for filtering',
              default: true,
            },
            useGitingestignore: {
              type: 'boolean',
              description: 'Use .gitingestignore file for filtering',
              default: true,
            },
            excludePatterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns to exclude files',
              optional: true,
            },
            includePatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Glob patterns to include files (if specified, only these files are included)',
              optional: true,
            },
            maxFileSize: {
              type: 'number',
              description: 'Maximum file size in bytes to include',
              optional: true,
            },
            maxFiles: {
              type: 'number',
              description: 'Maximum number of files to include (default: 1000)',
              default: 1000,
            },
            maxTotalSize: {
              type: 'number',
              description: 'Maximum total size in bytes (default: 50MB)',
              default: 50 * 1024 * 1024,
            },
            token: {
              type: 'string',
              description: 'Access token for private repositories',
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
            timeout: {
              type: 'number',
              description:
                'Maximum time in milliseconds to complete the operation',
              default: mcpConfig.defaults.timeout,
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

    // Handle timeout error
    if (error instanceof Error && error.message.includes('timed out')) {
      return {
        content: [
          {
            type: 'text',
            text: `Request timed out: ${error.message}`,
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
