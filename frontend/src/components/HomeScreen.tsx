import { useState } from 'react'
import { AGENT_ROLE } from '../session/session'
import { Forward } from './Icons'
import { HaloMark } from './Logo'

interface Props {
  /** A task already running or paused in another tab, if there is one. */
  activeTask?: { text: string; tabId: string }
  onSelectTab: (id: string) => void
  onSubmit: (text: string) => void
}

/**
 * A new tab: this is Halo's own surface, not a web page — dark, not the light site
 * background — with a place to tell the agent what to do next.
 */
export function HomeScreen({ activeTask, onSelectTab, onSubmit }: Props) {
  const [value, setValue] = useState('')
  return (
    <div className="hx-home">
      <HaloMark className="hx-home__mark" />
      <h2 className="hx-home__title">What should the {AGENT_ROLE.toLowerCase()} do?</h2>
      <form
        className="hx-home__form"
        onSubmit={(e) => {
          e.preventDefault()
          const text = value.trim()
          if (text) onSubmit(text)
        }}
      >
        <input
          className="hx-home__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Describe a task…"
          aria-label="What should the agent do?"
        />
        <button className="hx-btn hx-btn--primary hx-btn--compact" type="submit" disabled={!value.trim()}>Go</button>
      </form>
      {activeTask && (
        <button className="hx-home__resume" onClick={() => onSelectTab(activeTask.tabId)}>
          Continue: {activeTask.text}
          <Forward />
        </button>
      )}
    </div>
  )
}
