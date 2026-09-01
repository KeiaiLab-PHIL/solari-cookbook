import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { FILM_FPS, FILM_NAME, FRAME_DIR, VIEWPORT } from "./constants.js"
import { log } from "./log.js"

const run = promisify(execFile)

/**
 * Frames to film.
 *
 * The intern takes a JPEG after every action when `--film` is on; ffmpeg turns
 * the numbered frames into an MP4 you can post. If ffmpeg is not installed the
 * frames stay on disk and the run is otherwise unaffected — this is a nicety,
 * not part of the result.
 */
export function frameName(index: number): string {
  return `${String(index).padStart(4, "0")}.jpg`
}

export async function encodeFilm(outDir: string): Promise<string | undefined> {
  const frames = path.join(outDir, FRAME_DIR)
  const count = (await fs.readdir(frames).catch(() => [])).length
  if (count === 0) {
    return undefined
  }

  const output = path.join(outDir, FILM_NAME)
  try {
    await run("ffmpeg", [
      "-y",
      "-framerate", String(FILM_FPS),
      "-i", path.join(frames, "%04d.jpg"),
      // yuv420p and even dimensions are what players and social sites accept.
      "-vf", `scale=${VIEWPORT.width}:${VIEWPORT.height}:force_original_aspect_ratio=decrease,pad=${VIEWPORT.width}:${VIEWPORT.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-movflags", "+faststart",
      output,
    ])
    log.step(`film: ${output} (${count} frames)`)
    return FILM_NAME
  } catch (err) {
    log.warn(`ffmpeg failed, keeping ${count} frames: ${(err as Error).message.split("\n")[0]}`)
    return undefined
  }
}
