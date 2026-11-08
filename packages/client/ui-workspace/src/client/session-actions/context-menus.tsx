/** Structured Session actions over the workspace owner's existing callbacks. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {
  MenuAction, MenuContribution, ContextMenuTargetMap,
} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {
  ArchiveSessionInjected, ForkSessionInjected, PinSessionInjected, RenameSessionInjected, SessionIdInjected,
} from '../contract/slots.ts'
import { isFederatedSessionId } from '../federated-key.ts'

type Actions = Omit<PinSessionInjected & ArchiveSessionInjected, 'hooks'>
  & ForkSessionInjected & RenameSessionInjected & SessionIdInjected

/**
 * Register built-in actions while retaining the legacy Slot for external components.
 * @param ctx - workspace plugin context owning menus, access, membership, and locale.
 * @param actions - shared row and dialog callbacks; execution always uses the captured Session.
 */
export function registerSessionMenus(ctx: Context, actions: Actions): void {
  const t = ctx.locale.bind('workspace')
  const register = (
    id: string,
    order: number,
    endpoints: readonly RemoteEndpoint[],
    resolve: MenuContribution<'session'>['resolve'],
  ): void => {
    ctx.effect(() => ctx.contextMenus.register({
      id: `session.${id}`, target: 'session', order,
      observe: ({ sessionId }) => [
        ctx.workspaces.list, ctx.locale,
        ...endpoints.map(action => ctx.remoteAccess.source('session', sessionId, action)),
      ],
      resolve,
    }), `ui-workspace: ${id} menu`)
  }
  /**
   * Whether this Client's grants admit one operation on the captured Session.
   *
   * A federated key (`<instanceId>:<localSessionId>`) is never part of the
   * local grants snapshot: that snapshot describes the resources *this* Host
   * owns, while the Session belongs to another instance's catalog. Reading it
   * for a federated key would answer "not granted" forever and hide every
   * control-plane row action. The owning instance is the authority: it checks
   * the forwarded call against its own policy, so a refused operation still
   * fails loudly on the first RPC instead of disappearing from the menu.
   */
  const allowed = (target: ContextMenuTargetMap['session'], action: RemoteEndpoint): boolean => {
    if (isFederatedSessionId(target.sessionId)) return true
    return ctx.remoteAccess.source('session', target.sessionId, action).getSnapshot()
  }
  /**
   * Pin state of the captured Session. A surface that owns the state (a
   * control-plane row reading its owner's Workspace pin set) carries it on the
   * target; otherwise the local Workspace snapshot is the catalog.
   */
  const pinned = (target: ContextMenuTargetMap['session']): boolean =>
    target.pinned ?? ctx.workspaces.list.getSnapshot().pinnedSessionIds.includes(target.sessionId)
  /** Archive state, resolved like {@link pinned}. */
  const archived = (target: ContextMenuTargetMap['session']): boolean =>
    target.archived ?? ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(target.sessionId)
  /**
   * Disable one action while its owning instance is unreachable. The reason
   * row registered below names the cause; the action stays visible so the menu
   * still shows which operations the row would offer once the instance returns.
   */
  const gated = (target: ContextMenuTargetMap['session'], action: MenuAction): MenuAction =>
    target.unavailableReason === undefined ? action : { ...action, disabled: true }
  register('unavailable', 0, [], target => target.unavailableReason === undefined ? [] : [{
    id: 'unavailable',
    label: t('menu.unavailable', { reason: target.unavailableReason }),
    disabled: true,
  }])
  register('pin', 100, ['workspace/pinSession', 'workspace/unpinSession'], (target) => {
    const isPinned = pinned(target)
    if (archived(target) || !allowed(target, isPinned ? 'workspace/unpinSession' : 'workspace/pinSession')) return []
    return [gated(target, {
      id: 'pin', label: t(isPinned ? 'menu.unpinSession' : 'menu.pinSession'), icon: { key: isPinned ? 'workspace.unpin' : 'workspace.pin' },
      run: () => { (isPinned ? actions.unpinSession : actions.pinSession)(target.sessionId) },
    })]
  })
  register('rename', 200, ['session/rename'], target => allowed(target, 'session/rename') ? [gated(target, {
    id: 'rename', label: t('rename'), icon: { key: 'workspace.rename' }, commandId: 'session.rename' as ShortcutCommandId,
    run: () => { actions.requestSessionRename(target.sessionId, target.displayTitle) },
  })] : [])
  register('fork', 300, ['session/fork'], target => allowed(target, 'session/fork') ? [gated(target, {
    id: 'fork', label: t('menu.fork'), icon: { key: 'workspace.fork' }, commandId: 'session.fork' as ShortcutCommandId,
    run: () => { actions.forkSession(target.sessionId) },
  })] : [])
  register('id', 450, [], target => [{
    id: 'copy', label: t('menu.sessionId'), icon: { key: 'workspace.copy' }, separatorBefore: true,
    run: () => actions.copySessionId(target.sessionId),
  }])
  register('archive', 600, ['workspace/archiveSession', 'workspace/unarchiveSession'], (target) => {
    const restoring = archived(target)
    if (!allowed(target, restoring ? 'workspace/unarchiveSession' : 'workspace/archiveSession')) return []
    return [gated(target, {
      id: 'archive', label: t(restoring ? 'menu.unarchiveSession' : 'menu.archiveSession'),
      icon: { key: restoring ? 'workspace.unarchive' : 'workspace.archive' }, separatorBefore: true, afterContent: true,
      ...restoring ? {} : { commandId: 'session.archive' as ShortcutCommandId },
      run: () => { (restoring ? actions.unarchiveSession : actions.archiveSession)(target.sessionId) },
    })]
  })
}
