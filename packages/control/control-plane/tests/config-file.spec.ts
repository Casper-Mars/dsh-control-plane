/**
 * `--config` file loading: the JSON file replaces the inline instance list and
 * leaves an empty composition bootable (the sidebar simply has no groups).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig, resolveInstances, type Config } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-control-plane-config-'))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('control-plane --config', () => {
  it('loads the instance list from a JSON file', () => {
    const file = join(dir, 'instances.json')
    writeFileSync(file, JSON.stringify({
      instances: [{ id: 'cto', name: 'CTO Agent', host: '127.0.0.1', port: 8090 }],
    }))
    const effective = loadConfig({ instances: [], configFile: file } satisfies Config)
    expect(effective.configFile).toBeUndefined()
    expect(resolveInstances(effective)).toEqual([{
      id: 'cto',
      name: 'CTO Agent',
      host: '127.0.0.1',
      port: 8090,
      baseUrl: 'http://127.0.0.1:8090',
    }])
  })

  it('keeps an empty composition bootable when no file is configured', () => {
    expect(resolveInstances({ instances: [] })).toEqual([])
  })

  it('names the file when it cannot be read', () => {
    const file = join(dir, 'missing.json')
    expect(() => loadConfig({ instances: [], configFile: file })).toThrow(/无法读取配置文件/)
  })

  it('rejects a file without an instance array', () => {
    const file = join(dir, 'wrong.json')
    writeFileSync(file, JSON.stringify({ version: 1 }))
    expect(() => loadConfig({ instances: [], configFile: file })).toThrow(/instances 数组/)
  })
})
