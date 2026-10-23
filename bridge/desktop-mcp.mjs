#!/usr/bin/env node
/**
 * The desktop screenshot tool as a stdio MCP server, for the OpenCode brain.
 * OpenCode cannot load the Claude SDK's in-process servers, so it spawns this.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DESKTOP_DESCRIPTION, takeScreenshot } from './desktop.mjs'
import { historySummary, reviewHistory } from './history-review.mjs'

const server = new McpServer({ name: 'jarvis_desktop', version: '1.0.0' })

server.registerTool(
  'screenshot',
  {
    description: DESKTOP_DESCRIPTION,
    inputSchema: {
      monitor: z
        .enum(['all', 'principal', 'secundario'])
        .optional()
        .describe('Which monitor. Default all.'),
    },
  },
  async ({ monitor }) => takeScreenshot(monitor),
)

server.registerTool('history_status', {
  description: 'Read the local 30-minute screen/audio archive status, coverage times and recording folder. Read-only.',
  inputSchema: {},
}, async () => ({ content: [{ type: 'text', text: JSON.stringify(await historySummary()) }] }))

server.registerTool('history_review', {
  description: 'Review PAST screen and microphone/PC audio from the last 30 minutes. Use for "what happened", "what did I/they say", errors or activity a moment/minutes ago. Returns up to 8 timestamped images and interpretation of original audio by MiMo Free; nothing is invented if unavailable. seconds_ago is the END of the requested window: 0 with duration 30 = last 30 seconds; 120 with duration 30 = from 150 to 120 seconds ago. start_time overrides it and must include timezone. For longer periods, inspect separate windows. This is archived content, not current screen. Default includes both audio sources; disable audio only for purely visual questions.',
  inputSchema: {
    seconds_ago: z.number().min(0).max(1800).optional(),
    duration_seconds: z.number().min(1).max(120).optional(),
    start_time: z.string().optional(),
    include_audio: z.boolean().optional(),
  },
}, async (args, { signal }) => {
  try { return await reviewHistory(args, undefined, { signal }) }
  catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] } }
})

await server.connect(new StdioServerTransport())
