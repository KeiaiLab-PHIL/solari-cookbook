/** Load ./.env when present; real environment variables win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(".env")
  } catch {
    // no .env — environment variables only
  }
}
