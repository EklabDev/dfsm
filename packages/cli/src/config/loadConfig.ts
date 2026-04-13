import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export interface DfsmConfig {
  mongoUri: string
  machines: any[]
  actions: Record<string, any>
  guards: Record<string, any>
  generatedDir: string
  leaseTtlMs?: number
  outboxPollIntervalMs?: number
}

/** Injected in tests so `dfsm.config.ts` does not need a TS loader at runtime. */
export type LoadConfigModule = (
  absoluteConfigPath: string,
) => Promise<{ default?: DfsmConfig } & Record<string, unknown>>

async function importConfigFile(absoluteConfigPath: string): Promise<{ default?: DfsmConfig }> {
  const url = pathToFileURL(absoluteConfigPath).href
  return import(url)
}

export async function loadConfig(
  cwd: string,
  importModule: LoadConfigModule = importConfigFile,
): Promise<DfsmConfig> {
  const configPath = resolve(cwd, 'dfsm.config.ts')
  const mod = await importModule(configPath)
  return (mod.default ?? mod) as DfsmConfig
}
