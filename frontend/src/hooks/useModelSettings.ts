import { useEffect, useState } from 'react'
import type { HostSettings } from '../session/api'
import { saveModel } from '../session/claude-models'
import { saveEffort, type PlannerEffort } from '../session/planner-effort'

/** Host planner settings plus the save handlers a ModelPicker needs. */
export function useModelSettings() {
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [savingProvider, setSavingProvider] = useState(false)
  const [providerError, setProviderError] = useState(false)
  const [savingEffort, setSavingEffort] = useState(false)
  const [effortError, setEffortError] = useState(false)

  useEffect(() => {
    let current = true
    void window.haloBrowser?.getHostSettings().then((next) => {
      if (current) setSettings(next)
    }).catch(() => {})
    return () => { current = false }
  }, [])

  const selectModel = async (id: string) => {
    if (savingProvider) return
    setSavingProvider(true)
    setProviderError(false)
    const next = await saveModel(window.haloBrowser, id)
    if (next) setSettings(next)
    else setProviderError(true)
    setSavingProvider(false)
  }
  const selectEffort = async (effort: PlannerEffort) => {
    if (!settings || savingEffort) return
    const previous = settings
    setSettings({ ...settings, plannerEffort: effort })
    setSavingEffort(true)
    setEffortError(false)
    const next = await saveEffort(window.haloBrowser, effort)
    if (next) setSettings(next)
    else { setSettings(previous); setEffortError(true) }
    setSavingEffort(false)
  }
  return { settings, savingProvider, providerError, savingEffort, effortError, selectModel, selectEffort }
}
