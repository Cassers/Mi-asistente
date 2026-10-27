import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { monitorOutputs } from './monitor-outputs.mjs'

const run = promisify(execFile)

/**
 * Screenshots of the user's own desktop (Wayland/niri, via grim).
 *
 * A read in every sense that matters: nothing on the machine changes except a
 * JPEG written under the temp dir so the HUD can show it. Fixed argv, no shell,
 * so a model-chosen argument can never become a command. That is why it is
 * allowed in read-only mode while Bash is not.
 *
 * Two front doors share takeScreenshot(): the in-process server below (Claude
 * brain) and bridge/desktop-mcp.mjs over stdio (OpenCode brain).
 */

const DIR = join(tmpdir(), 'jarvis-screens')

export const DESKTOP_DESCRIPTION = `Take a screenshot of the user's desktop and look at it.

Returns the image so you can actually see and describe what is on screen, plus a
file path. Show it on the display (file:///path) when that helps.

monitor:
  all        — both monitors in one image (default)
  principal  — the main monitor (LG UltraGear, 1920x1080)
  secundario — the secondary monitor (LG HD, 1600x900)

Use it when the user asks you to look at their screen, a window, an error, "what
do I have open". Not speculatively: it sends what is on their screen to you.`

export const MONITORS = ['all', 'principal', 'secundario']

/** Automatic turn context stays in memory; unlike the manual tool, no file. */
export async function captureDesktop(monitor = 'principal', { signal } = {}) {
  const args = ['-t', 'png', '-l', '1']
  if (!MONITORS.includes(monitor)) throw new Error('Unknown monitor')
  if (monitor !== 'all') {
    const name = (await outputs())[monitor]
    if (!name) throw new Error(`No ${monitor} monitor is connected`)
    args.push('-o', name)
  }
  const options = { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 4000, signal }
  const { stdout: png } = await run('grim', [...args, '-'], options)
  signal?.throwIfAborted()
  try {
    const conversion = run('ffmpeg', [
      '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1',
    ], options)
    conversion.child.stdin.on('error', () => {})
    conversion.child.stdin.end(png)
    const { stdout: jpg } = await conversion
    if (!jpg.length) throw new Error('Empty screenshot')
    return { data: jpg.toString('base64'), mimeType: 'image/jpeg' }
  } catch (err) {
    signal?.throwIfAborted()
    if (!png.length) throw err
    return { data: png.toString('base64'), mimeType: 'image/png' }
  }
}

/** Output names move between boots (DP-1, HDMI-A-1…), so resolve by model. */
async function outputs() {
  try {
    return await monitorOutputs()
  } catch {
    return {}
  }
}

/** Returns MCP tool-result content: a text line with the path, then the image. */
export async function takeScreenshot(monitor) {
  const which = MONITORS.includes(monitor) ? monitor : 'all'
  const grimArgs = ['-t', 'png', '-l', '1']
  if (which !== 'all') {
    const name = (await outputs())[which]
    if (!name) {
      return {
        isError: true,
        content: [{ type: 'text', text: `No ${which} monitor is connected.` }],
      }
    }
    grimArgs.push('-o', name)
  }
  await mkdir(DIR, { recursive: true })
  const stamp = `screen-${which}-${Date.now()}`
  const png = join(DIR, `${stamp}.png`)
  let file = png
  let mimeType = 'image/png'
  try {
    // This grim build has no JPEG support, so capture PNG and let ffmpeg
    // compress it (a two-monitor PNG is several MB).
    await run('grim', [...grimArgs, png], { timeout: 10_000 })
    try {
      const jpg = join(DIR, `${stamp}.jpg`)
      await run('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '4', jpg], { timeout: 10_000 })
      await unlink(png).catch(() => {})
      file = jpg
      mimeType = 'image/jpeg'
    } catch {
      /* no ffmpeg: send the PNG */
    }
    const data = (await readFile(file)).toString('base64')
    return {
      content: [
        { type: 'text', text: `Screenshot (${which}) saved at file://${file}` },
        { type: 'image', data, mimeType },
      ],
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Could not take the screenshot: ${err?.message ?? err}.` }],
    }
  }
}

export function desktopServer() {
  return createSdkMcpServer({
    name: 'jarvis_desktop',
    version: '1.0.0',
    instructions:
      "Screenshots of the user's own desktop (two monitors). Use when they ask " +
      'you to look at their screen.',
    alwaysLoad: true,
    tools: [
      tool(
        'screenshot',
        DESKTOP_DESCRIPTION,
        {
          monitor: z
            .enum(['all', 'principal', 'secundario'])
            .optional()
            .catch(undefined)
            .describe('Which monitor. Default all.'),
        },
        (args) => takeScreenshot(args.monitor),
      ),
    ],
  })
}
