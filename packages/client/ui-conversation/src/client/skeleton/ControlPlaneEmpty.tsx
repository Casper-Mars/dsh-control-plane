/** Control-plane home: no local Session can exist, so no composer is offered. */
import type { ConversationContentProps } from '../contract/slots.ts'
import css from './ControlPlaneEmpty.module.css'

/** Locale seat the notice reads through. */
export interface ControlPlaneEmptyProps {
  t: ConversationContentProps['t']
}

/**
 * Render the centered "no Session selected" notice that takes the Hero's place.
 *
 * It deliberately renders no composer chain, model selector, workspace chip, or
 * workspace title: a control plane owns remote instances, and a local Session
 * cannot be created or opened from this Client.
 * @param props - the Conversation locale seat.
 * @returns the empty Conversation body.
 */
export function ControlPlaneEmpty({ t }: ControlPlaneEmptyProps) {
  return (
    <div className={css.root} data-conversation-control-plane-empty="" data-conversation-region="chat">
      <h2 className={css.title}>{t('empty.controlPlane.title')}</h2>
      <p className={css.description}>{t('empty.controlPlane.description')}</p>
    </div>
  )
}
