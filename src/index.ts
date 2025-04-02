#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Tool,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import FirecrawlApp, {
  type ScrapeParams,
  type MapParams,
  type CrawlParams,
  type FirecrawlDocument,
} from '@mendable/firecrawl-js';
import PQueue from 'p-queue';

import dotenv from 'dotenv';

dotenv.config();

// Tool definitions
const SCRAPE_TOOL: Tool = {
  name: 'firecrawl_scrape',
  description:
    'Scrape a single webpage with advanced options for content extraction. ' +
    'Supports various formats including markdown, HTML, and screenshots. ' +
    'Can execute custom actions like clicking or scrolling before scraping.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to scrape',
      },
      formats: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'markdown',
            'html',
            'rawHtml',
            'screenshot',
            'links',
            'screenshot@fullPage',
            'extract',
          ],
        },
        description: "Content formats to extract (default: ['markdown'])",
      },
      onlyMainContent: {
        type: 'boolean',
        description:
          'Extract only the main content, filtering out navigation, footers, etc.',
      },
      includeTags: {
        type: 'array',
        items: { type: 'string' },
        description: 'HTML tags to specifically include in extraction',
      },
      excludeTags: {
        type: 'array',
        items: { type: 'string' },
        description: 'HTML tags to exclude from extraction',
      },
      waitFor: {
        type: 'number',
        description: 'Time in milliseconds to wait for dynamic content to load',
      },
      timeout: {
        type: 'number',
        description:
          'Maximum time in milliseconds to wait for the page to load',
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [
                'wait',
                'click',
                'screenshot',
                'write',
                'press',
                'scroll',
                'scrape',
                'executeJavascript',
              ],
              description: 'Type of action to perform',
            },
            selector: {
              type: 'string',
              description: 'CSS selector for the target element',
            },
            milliseconds: {
              type: 'number',
              description: 'Time to wait in milliseconds (for wait action)',
            },
            text: {
              type: 'string',
              description: 'Text to write (for write action)',
            },
            key: {
              type: 'string',
              description: 'Key to press (for press action)',
            },
            direction: {
              type: 'string',
              enum: ['up', 'down'],
              description: 'Scroll direction',
            },
            script: {
              type: 'string',
              description: 'JavaScript code to execute',
            },
            fullPage: {
              type: 'boolean',
              description: 'Take full page screenshot',
            },
          },
          required: ['type'],
        },
        description: 'List of actions to perform before scraping',
      },
      extract: {
        type: 'object',
        properties: {
          schema: {
            type: 'object',
            description: 'Schema for structured data extraction',
          },
          systemPrompt: {
            type: 'string',
            description: 'System prompt for LLM extraction',
          },
          prompt: {
            type: 'string',
            description: 'User prompt for LLM extraction',
          },
        },
        description: 'Configuration for structured data extraction',
      },
      mobile: {
        type: 'boolean',
        description: 'Use mobile viewport',
      },
      skipTlsVerification: {
        type: 'boolean',
        description: 'Skip TLS certificate verification',
      },
      removeBase64Images: {
        type: 'boolean',
        description: 'Remove base64 encoded images from output',
      },
      location: {
        type: 'object',
        properties: {
          country: {
            type: 'string',
            description: 'Country code for geolocation',
          },
          languages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Language codes for content',
          },
        },
        description: 'Location settings for scraping',
      },
    },
    required: ['url'],
  },
};

const MAP_TOOL: Tool = {
  name: 'firecrawl_map',
  description:
    'Discover URLs from a starting point. Can use both sitemap.xml and HTML link discovery.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Starting URL for URL discovery',
      },
      search: {
        type: 'string',
        description: 'Optional search term to filter URLs',
      },
      ignoreSitemap: {
        type: 'boolean',
        description: 'Skip sitemap.xml discovery and only use HTML links',
      },
      sitemapOnly: {
        type: 'boolean',
        description: 'Only use sitemap.xml for discovery, ignore HTML links',
      },
      includeSubdomains: {
        type: 'boolean',
        description: 'Include URLs from subdomains in results',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of URLs to return',
      },
    },
    required: ['url'],
  },
};

const CRAWL_TOOL: Tool = {
  name: 'firecrawl_crawl',
  description:
    'Start an asynchronous crawl of multiple pages from a starting URL. ' +
    'Supports depth control, path filtering, and webhook notifications.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Starting URL for the crawl',
      },
      excludePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'URL paths to exclude from crawling',
      },
      includePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only crawl these URL paths',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum link depth to crawl',
      },
      ignoreSitemap: {
        type: 'boolean',
        description: 'Skip sitemap.xml discovery',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of pages to crawl',
      },
      allowBackwardLinks: {
        type: 'boolean',
        description: 'Allow crawling links that point to parent directories',
      },
      allowExternalLinks: {
        type: 'boolean',
        description: 'Allow crawling links to external domains',
      },
      webhook: {
        oneOf: [
          {
            type: 'string',
            description: 'Webhook URL to notify when crawl is complete',
          },
          {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'Webhook URL',
              },
              headers: {
                type: 'object',
                description: 'Custom headers for webhook requests',
              },
            },
            required: ['url'],
          },
        ],
      },
      deduplicateSimilarURLs: {
        type: 'boolean',
        description: 'Remove similar URLs during crawl',
      },
      ignoreQueryParameters: {
        type: 'boolean',
        description: 'Ignore query parameters when comparing URLs',
      },
      scrapeOptions: {
        type: 'object',
        properties: {
          formats: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'markdown',
                'html',
                'rawHtml',
                'screenshot',
                'links',
                'screenshot@fullPage',
                'extract',
              ],
            },
          },
          onlyMainContent: {
            type: 'boolean',
          },
          includeTags: {
            type: 'array',
            items: { type: 'string' },
          },
          excludeTags: {
            type: 'array',
            items: { type: 'string' },
          },
          waitFor: {
            type: 'number',
          },
        },
        description: 'Options for scraping each page',
      },
    },
    required: ['url'],
  },
};

const BATCH_SCRAPE_TOOL: Tool = {
  name: 'firecrawl_batch_scrape',
  description:
    'Scrape multiple URLs in batch mode. Returns a job ID that can be used to check status.',
  inputSchema: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of URLs to scrape',
      },
      options: {
        type: 'object',
        properties: {
          formats: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'markdown',
                'html',
                'rawHtml',
                'screenshot',
                'links',
                'screenshot@fullPage',
                'extract',
              ],
            },
          },
          onlyMainContent: {
            type: 'boolean',
          },
          includeTags: {
            type: 'array',
            items: { type: 'string' },
          },
          excludeTags: {
            type: 'array',
            items: { type: 'string' },
          },
          waitFor: {
            type: 'number',
          },
        },
      },
    },
    required: ['urls'],
  },
};

const CHECK_BATCH_STATUS_TOOL: Tool = {
  name: 'firecrawl_check_batch_status',
  description: 'Check the status of a batch scraping job.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Batch job ID to check',
      },
    },
    required: ['id'],
  },
};

const CHECK_CRAWL_STATUS_TOOL: Tool = {
  name: 'firecrawl_check_crawl_status',
  description: 'Check the status of a crawl job.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Crawl job ID to check',
      },
    },
    required: ['id'],
  },
};

const SEARCH_TOOL: Tool = {
  name: 'firecrawl_search',
  description:
    'Search and retrieve content from web pages with optional scraping. ' +
    'Returns SERP results by default (url, title, description) or full page content when scrapeOptions are provided.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)',
      },
      lang: {
        type: 'string',
        description: 'Language code for search results (default: en)',
      },
      country: {
        type: 'string',
        description: 'Country code for search results (default: us)',
      },
      tbs: {
        type: 'string',
        description: 'Time-based search filter',
      },
      filter: {
        type: 'string',
        description: 'Search filter',
      },
      location: {
        type: 'object',
        properties: {
          country: {
            type: 'string',
            description: 'Country code for geolocation',
          },
          languages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Language codes for content',
          },
        },
        description: 'Location settings for search',
      },
      scrapeOptions: {
        type: 'object',
        properties: {
          formats: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['markdown', 'html', 'rawHtml'],
            },
            description: 'Content formats to extract from search results',
          },
          onlyMainContent: {
            type: 'boolean',
            description: 'Extract only the main content from results',
          },
          waitFor: {
            type: 'number',
            description: 'Time in milliseconds to wait for dynamic content',
          },
        },
        description: 'Options for scraping search results',
      },
    },
    required: ['query'],
  },
};

const EXTRACT_TOOL: Tool = {
  name: 'firecrawl_extract',
  description:
    'Extract structured information from web pages using LLM. ' +
    'Supports both cloud AI and self-hosted LLM extraction.',
  inputSchema: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of URLs to extract information from',
      },
      prompt: {
        type: 'string',
        description: 'Prompt for the LLM extraction',
      },
      systemPrompt: {
        type: 'string',
        description: 'System prompt for LLM extraction',
      },
      schema: {
        type: 'object',
        description: 'JSON schema for structured data extraction',
      },
      allowExternalLinks: {
        type: 'boolean',
        description: 'Allow extraction from external links',
      },
      enableWebSearch: {
        type: 'boolean',
        description: 'Enable web search for additional context',
      },
      includeSubdomains: {
        type: 'boolean',
        description: 'Include subdomains in extraction',
      },
    },
    required: ['urls'],
  },
};

const DEEP_RESEARCH_TOOL: Tool = {
  name: 'firecrawl_deep_research',
  description:
    'Conduct deep research on a query using web crawling, search, and AI analysis.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The query to research',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth of research iterations (1-10)',
      },
      timeLimit: {
        type: 'number',
        description: 'Time limit in seconds (30-300)',
      },
      maxUrls: {
        type: 'number',
        description: 'Maximum number of URLs to analyze (1-1000)',
      },
    },
    required: ['query'],
  },
};

const GENERATE_LLMSTXT_TOOL: Tool = {
  name: 'firecrawl_generate_llmstxt',
  description:
    'Generate standardized LLMs.txt file for a given URL, which provides context about how LLMs should interact with the website.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to generate LLMs.txt from',
      },
      maxUrls: {
        type: 'number',
        description: 'Maximum number of URLs to process (1-100, default: 10)',
      },
      showFullText: {
        type: 'boolean',
        description: 'Whether to show the full LLMs-full.txt in the response',
      },
    },
    required: ['url'],
  },
};

// Type definitions
interface BatchScrapeOptions {
  urls: string[];
  options?: Omit<ScrapeParams, 'url'>;
}

/**
 * Parameters for LLMs.txt generation operations.
 */
interface GenerateLLMsTextParams {
  /**
   * Maximum number of URLs to process (1-100)
   * @default 10
   */
  maxUrls?: number;
  /**
   * Whether to show the full LLMs-full.txt in the response
   * @default false
   */
  showFullText?: boolean;
  /**
   * Experimental flag for streaming
   */
  __experimental_stream?: boolean;
}

/**
 * Response interface for LLMs.txt generation operations.
 */
// interface GenerateLLMsTextResponse {
//   success: boolean;
//   id: string;
// }

/**
 * Status response interface for LLMs.txt generation operations.
 */
// interface GenerateLLMsTextStatusResponse {
//   success: boolean;
//   data: {
//     llmstxt: string;
//     llmsfulltxt?: string;
//   };
//   status: 'processing' | 'completed' | 'failed';
//   error?: string;
//   expiresAt: string;
// }

interface StatusCheckOptions {
  id: string;
}

interface SearchOptions {
  query: string;
  limit?: number;
  lang?: string;
  country?: string;
  tbs?: string;
  filter?: string;
  location?: {
    country?: string;
    languages?: string[];
  };
  scrapeOptions?: {
    formats?: string[];
    onlyMainContent?: boolean;
    waitFor?: number;
  };
}

// Add after other interfaces
interface ExtractParams<T = any> {
  prompt?: string;
  systemPrompt?: string;
  schema?: T | object;
  allowExternalLinks?: boolean;
  enableWebSearch?: boolean;
  includeSubdomains?: boolean;
  origin?: string;
}

interface ExtractArgs {
  urls: string[];
  prompt?: string;
  systemPrompt?: string;
  schema?: object;
  allowExternalLinks?: boolean;
  enableWebSearch?: boolean;
  includeSubdomains?: boolean;
  origin?: string;
}

interface ExtractResponse<T = any> {
  success: boolean;
  data: T;
  error?: string;
  warning?: string;
  creditsUsed?: number;
}

// Type guards
function isScrapeOptions(
  args: unknown
): args is ScrapeParams & { url: string } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'url' in args &&
    typeof (args as { url: unknown }).url === 'string'
  );
}

function isMapOptions(args: unknown): args is MapParams & { url: string } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'url' in args &&
    typeof (args as { url: unknown }).url === 'string'
  );
}

function isCrawlOptions(args: unknown): args is CrawlParams & { url: string } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'url' in args &&
    typeof (args as { url: unknown }).url === 'string'
  );
}

function isBatchScrapeOptions(args: unknown): args is BatchScrapeOptions {
  return (
    typeof args === 'object' &&
    args !== null &&
    'urls' in args &&
    Array.isArray((args as { urls: unknown }).urls) &&
    (args as { urls: unknown[] }).urls.every((url) => typeof url === 'string')
  );
}

function isStatusCheckOptions(args: unknown): args is StatusCheckOptions {
  return (
    typeof args === 'object' &&
    args !== null &&
    'id' in args &&
    typeof (args as { id: unknown }).id === 'string'
  );
}
