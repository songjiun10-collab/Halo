import { HaloMark } from './Logo'

interface Props {
  unseen: number
  open: boolean
  onToggle: () => void
}

/** The only permanent Halo element: its ring, with a count of events worth a look. */
export function HaloButton({ unseen, open, onToggle }: Props) {
  const label = unseen ? `Halo events, ${unseen} new` : 'Halo events'
  return (
    <button className="hx-halo" aria-label={label} aria-expanded={open} aria-controls="hx-activity" onClick={onToggle}>
      <HaloMark className="hx-halo__mark" />
      <span className="hx-halo__tip" aria-hidden="true">{unseen ? `Halo events · ${unseen} new` : 'Halo events'}</span>
      {unseen > 0 && <span className="hx-halo__badge num" aria-hidden="true">{unseen}</span>}
    </button>
  )
}
