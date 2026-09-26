import { HaloMark } from './Logo'

interface Props {
  unseen: number
  open: boolean
  onToggle: () => void
}

/** The only permanent Halo element: its ring, with a count of events worth a look. */
export function HaloButton({ unseen, open, onToggle }: Props) {
  const label = unseen ? `Halo activity, ${unseen} new` : 'Halo activity'
  return (
    <button className="hx-halo" aria-label={label} aria-expanded={open} aria-controls="hx-activity" onClick={onToggle}>
      <HaloMark className="hx-halo__mark" />
      {unseen > 0 && <span className="hx-halo__badge num" aria-hidden="true">{unseen}</span>}
    </button>
  )
}
