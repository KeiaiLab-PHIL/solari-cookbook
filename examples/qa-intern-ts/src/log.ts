/** One-line progress log with a wall-clock offset, so a run reads like a timeline. */
const started = Date.now()

function stamp(): string {
  const seconds = (Date.now() - started) / 1000
  return `[+${seconds.toFixed(1).padStart(6)}s]`
}

export const log = {
  step(message: string): void {
    console.log(`${stamp()} ${message}`)
  },
  warn(message: string): void {
    console.warn(`${stamp()} ! ${message}`)
  },
}
