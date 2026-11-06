/**
 * Instance groups above the workspace browser.
 *
 * Rendered only when the control plane is composed into this Client (the
 * `controlPlane` Remote namespace is present). The section is deliberately
 * read-only for now: it shows which instances exist, their workspaces, and
 * which sessions carry activity, and the session keys it renders are already
 * qualified (`<instanceId>:<sessionId>`) so the routing work in 3.5 can attach
 * to the same rows.
 */
import { useEffect, useState } from 'react'
import css from './InstanceGroups.module.css'

/** `name(id)` header facts; mirrors the control plane's `InstanceNode`. */
export interface InstanceGroupView {
  readonly instanceId: string
  readonly label: string
  readonly runningCount: number
  readonly sessionCount: number
  readonly workspaces: ReadonlyArray<{
    readonly path: string
    readonly runningCount: number
    readonly sessions: ReadonlyArray<{ readonly key: string; readonly running: boolean }>
  }>
}

/** Props the sidebar shell passes to the registered entry. */
export interface InstanceGroupsProps {
  /** Reads the composed tree from the control plane Remote. */
  readonly fetchTree: () => Promise<readonly InstanceGroupView[]>
  /** Poll period in milliseconds. */
  readonly intervalMs?: number
}

/**
 * Six-second poll keeps the panel cheap while the WebSocket stream (task 3.6)
 * is still outstanding.
 * @param props - tree reader and poll period.
 * @returns the instance list, or nothing while the first read is pending.
 */
/** Zero-prop component the shell registers into `sidebar.instances`. */
export function instanceGroupsSlot(fetchTree: () => Promise<readonly InstanceGroupView[]>) {
  return function ControlPlaneInstanceGroups() {
    return <InstanceGroups fetchTree={fetchTree} />
  }
}

export function InstanceGroups({ fetchTree, intervalMs = 6000 }: InstanceGroupsProps) {
  const [groups, setGroups] = useState<readonly InstanceGroupView[]>()

  useEffect(() => {
    let disposed = false
    const read = (): void => {
      void fetchTree().then((next) => {
        if (!disposed) setGroups(next)
      }, () => {
        // 实例全不可达时 Remote 仍然返回空组；真正的失败只影响这一帧
      })
    }
    read()
    const timer = setInterval(read, intervalMs)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [fetchTree, intervalMs])

  if (groups === undefined || groups.length === 0) return null

  return (
    <section className={css.root} data-dsh-instance-groups="">
      {groups.map(group => (
        <details key={group.instanceId} className={css.group} open={group.runningCount > 0}>
          <summary className={css.header}>
            <span className={css.label}>{group.label}</span>
            {group.runningCount > 0 && <span className={css.activity}>{group.runningCount} 进行中</span>}
            <span className={css.count}>{group.sessionCount}</span>
          </summary>
          {group.workspaces.map(workspace => (
            <div key={workspace.path} className={css.workspace}>
              <div className={css.path}>{workspace.path}</div>
              {workspace.sessions.slice(0, 8).map(session => (
                <div key={session.key} className={css.session} title={session.key}>
                  <span className={session.running ? css.dotRunning : css.dot} />
                  {session.key.slice(session.key.indexOf(':') + 1)}
                </div>
              ))}
            </div>
          ))}
        </details>
      ))}
    </section>
  )
}
