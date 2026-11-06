/**
 * Control-plane instance configuration.
 *
 * The control plane never trusts an instance to describe itself: `id` comes
 * from this configuration, is unique, and is the only key the routing layer
 * uses. `dsh`'s own `SessionId` is process-local (a counter starting at 1 in
 * every instance), so it is always qualified with the instance id.
 * @module @deepseek-ai/dsh-control-plane/src/config
 */

/** One Harness instance the control plane drives. */
export interface InstanceConfig {
  /** Stable, unique id chosen here — never reported by the instance. */
  id: string
  /** Human name for the sidebar group; defaults to {@link InstanceConfig.id}. */
  name?: string
  /** Reachable host: an IP literal, `host.docker.internal`, or a compose service name. */
  host: string
  /** Harness web port on that host. */
  port: number
  /**
   * Launch token of the instance, when that Harness still requires one.
   * Temporary: the control plane models no credentials once `dsh web` runs
   * without a token.
   */
  token?: string
}

/** Validated instance with its derived fields. */
export interface ResolvedInstance {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  /** Origin used for both HTTP and WebSocket targeting. */
  readonly baseUrl: string
  /** Launch token, present only while the instance still requires one. */
  readonly token?: string
}

/** Control-plane plugin configuration. */
export interface Config {
  /** Instances in sidebar order. */
  instances: InstanceConfig[]
}

/** Id shape accepted from configuration: lowercase words joined by `-` or `_`. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Validate configuration and derive the routing facts.
 * @param config - raw plugin configuration.
 * @returns resolved instances in configuration order.
 * @throws if an id is missing, malformed or duplicated, or a host/port is unusable.
 */
export function resolveInstances(config: Config): ResolvedInstance[] {
  const raw = config.instances
  if (raw.length === 0) throw new Error('control-plane: 至少需要一个实例（instances 为空）')

  const seen = new Set<string>()
  return raw.map((instance, index) => {
    const where = `instances[${index}]`
    const id = instance.id
    if (typeof id !== 'string' || id.length === 0) throw new Error(`control-plane: ${where}.id 必须是非空字符串`)
    if (!ID_PATTERN.test(id)) {
      throw new Error(`control-plane: ${where}.id ${JSON.stringify(id)} 只允许小写字母、数字、- 和 _`)
    }
    if (seen.has(id)) throw new Error(`control-plane: 实例 id 重复: ${id}`)
    seen.add(id)

    const host = instance.host
    if (typeof host !== 'string' || host.length === 0) throw new Error(`control-plane: ${where}.host 必须是非空字符串`)
    const port = instance.port
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`control-plane: ${where}.port 必须是 1-65535 的整数`)
    }

    const name = instance.name?.trim()
    return {
      id,
      name: name === undefined || name.length === 0 ? id : name,
      host,
      port,
      baseUrl: `http://${host}:${port}`,
      ...(instance.token === undefined || instance.token.length === 0 ? {} : { token: instance.token }),
    }
  })
}
