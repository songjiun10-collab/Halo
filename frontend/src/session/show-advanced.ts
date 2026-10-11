import { useEffect, useState } from 'react'

/** Host setting `showAdvanced`: technical chips stay hidden on the main screens unless the user turns it on in Settings > Advanced. */
export function useShowAdvanced(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let current = true
    void window.haloBrowser?.getHostSettings().then((settings) => { if (current) setOn(settings.showAdvanced === true) }).catch(() => {})
    return () => { current = false }
  }, [])
  return on
}
