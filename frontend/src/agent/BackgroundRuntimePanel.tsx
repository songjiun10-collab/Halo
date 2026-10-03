import { useEffect, useState, useSyncExternalStore } from 'react'
import { BackgroundRuntimeStore, MEMORY_OVERRIDE_WARNING, type BackgroundRuntimeApi, type BackgroundRuntimeState, type MemoryPolicy } from '../session/background-runtime'

const POLICIES: [MemoryPolicy, string, string][] = [
  ['budgeted', 'Budgeted', 'HALO limits parallel work and pauses under memory pressure.'],
  ['user_override', 'Override', 'No admission limits or automatic pauses for the next parent run.'],
]

/**
 * What the host can report and do: a window is either attached to the background
 * service or runs locally. Start at login (which also starts the service now) is
 * offered only where the host reports the login item and can change it.
 */
export function RuntimeStatus({ state, onStop, onPolicy, onLaunchAtLogin }: { state: BackgroundRuntimeState; onStop: () => void; onPolicy: (mode: MemoryPolicy, confirmed: boolean) => void; onLaunchAtLogin?: (enabled: boolean) => void }) {
  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmLogin, setConfirmLogin] = useState(false)
  const [pending, setPending] = useState<MemoryPolicy | null>(null)
  const on = state.connection === 'connected' && state.service === 'running'
  return <div className="hx-ag__form" style={{ width: '100%' }}>
    <div className="hx-xrow hx-gl"><span className="hx-xlive" data-on={on || undefined} /><div className="hx-xrow__b">
      <b>{on ? 'Background service connected' : state.connection === 'unavailable' ? 'Background service unavailable' : 'Background service not connected'}</b>
      <small>{on ? 'Always-on agents run here, even with every window closed.' : "This window runs tasks itself. Always-on schedules won't run until the background service is running."}</small></div>
      {on ? confirmStop
        ? <><button type="button" className="hx-agbtn" onClick={() => setConfirmStop(false)}>Keep running</button><button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => { setConfirmStop(false); onStop() }}>Stop</button></>
        : <button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => setConfirmStop(true)}>Stop service</button> : null}
    </div>
    {state.launchAgentInstalled !== undefined && onLaunchAtLogin ? <>
      <div className="hx-xrow hx-gl"><div className="hx-xrow__b"><b>Start at login</b>
        <small>{state.launchAgentInstalled ? 'The background service starts when you log in to this Mac.' : 'Run the background service when you log in, so always-on agents keep working.'}</small></div>
        <button type="button" className="hx-agbtn" role="switch" aria-checked={state.launchAgentInstalled}
          onClick={() => { if (state.launchAgentInstalled) onLaunchAtLogin(false); else setConfirmLogin(true) }}>{state.launchAgentInstalled ? 'On' : 'Off'}</button></div>
      {confirmLogin ? <div className="hx-ag__note" role="alertdialog" aria-label="Confirm start at login"><span>This adds a login item for HALO's background service and starts it now. New windows connect to it.</span>
        <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={() => setConfirmLogin(false)}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--p" onClick={() => { setConfirmLogin(false); onLaunchAtLogin(true) }}>Turn on</button></div></div> : null}
    </> : state.launchAgentInstalled !== undefined ? <p className="hx-ag__note">{state.launchAgentInstalled ? 'Launch agent installed.' : 'Launch agent not installed.'}</p> : null}
    <h3 className="hx-ag__h" style={{ margin: '4px 0 0' }}>Memory policy</h3>
    <div className="hx-xseg hx-xseg--2" role="radiogroup" aria-label="Memory policy">{POLICIES.map(([mode, title, detail]) =>
      <button type="button" key={mode} role="radio" aria-checked={state.memoryPolicy === mode}
        onClick={() => { if (state.memoryPolicy === mode) return; if (mode === 'user_override') setPending(mode); else onPolicy(mode, false) }}><b>{title}</b><small>{detail}</small></button>)}</div>
    {pending ? <div className="hx-ag__note" role="alertdialog" aria-label="Confirm memory override"><span>{MEMORY_OVERRIDE_WARNING}</span>
      <div className="hx-ag__actions"><button type="button" className="hx-agbtn" onClick={() => setPending(null)}>Cancel</button><button type="button" className="hx-agbtn hx-agbtn--d" onClick={() => { onPolicy(pending, true); setPending(null) }}>Override</button></div></div> : null}
    {state.error ? <p className="hx-ag__err" role="alert">{state.error}</p> : null}
  </div>
}

export function useBackgroundRuntime() {
  const [store] = useState(() => new BackgroundRuntimeStore(window.haloBrowser as Partial<BackgroundRuntimeApi> | undefined))
  const state = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => { const off = store.connect(); void store.refresh(); return off }, [store])
  return { store, state }
}

const canSetLaunchAtLogin = () => typeof (window.haloBrowser as Partial<BackgroundRuntimeApi> | undefined)?.setBackgroundLaunchAtLogin === 'function'

export function BackgroundRuntimePanel() {
  const { store, state } = useBackgroundRuntime()
  return <RuntimeStatus state={state} onStop={() => void store.stopService()} onPolicy={(mode, confirmed) => void store.setMemoryPolicy(mode, confirmed)}
    onLaunchAtLogin={canSetLaunchAtLogin() ? (enabled) => void store.setLaunchAtLogin(enabled) : undefined} />
}
