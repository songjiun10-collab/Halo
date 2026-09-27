import { HaloMark } from './Logo'

interface Props {
  unseen: number
  open: boolean
  onToggle: () => void
}

/** The only permanent Halo element: its ring, opening Halo Chat, with a count of events worth a look. */
export function HaloButton({ unseen, open, onToggle }: Props) {
  const label = unseen ? `Halo Chat, ${unseen} new` : 'Halo Chat'
  return (
    <button className="hx-halo" aria-label={label} aria-keyshortcuts="Control+Shift+. Meta+Shift+." aria-expanded={open} aria-controls="hx-chat" onClick={onToggle}>
      <HaloMark className="hx-halo__mark" />
      <span className="hx-halo__tip" aria-hidden="true">{unseen ? `Halo Chat · ${unseen} new` : 'Halo Chat'}</span>
      {unseen > 0 && <span className="hx-halo__badge num" aria-hidden="true">{unseen}</span>}
    </button>
  )
}
