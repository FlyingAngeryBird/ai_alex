import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import dotenv from 'dotenv'

function trimLoadedEnvValues(beforeLoad: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (beforeLoad[key] !== undefined || value === undefined) {
      continue
    }

    process.env[key] = value.trim()
  }
}

export function loadEnvironmentFiles(candidateDirectories: string[]): string[] {
  const loaded: string[] = []

  for (const directory of candidateDirectories) {
    const envPath = join(directory, '.env')

    if (!existsSync(envPath)) {
      continue
    }

    const beforeLoad = { ...process.env }

    dotenv.config({
      override: false,
      path: envPath,
      quiet: true
    })
    trimLoadedEnvValues(beforeLoad)
    loaded.push(envPath)
  }

  return loaded
}

export function resolveEnvironmentCandidateDirectories(options: {
  appPath: string
  cwd: string
  mainDir: string
  userDataPath: string
}): string[] {
  const candidates = [
    options.cwd,
    options.appPath,
    join(options.mainDir, '../..'),
    join(options.mainDir, '../../..'),
    options.userDataPath
  ]

  return [...new Set(candidates.map((candidate) => resolve(candidate)))]
}
