import { useEffect, useState, useSyncExternalStore } from 'react'
import { BackgroundRuntimeStore, type BackgroundRuntimeApi } from '../session/background-runtime'

export function useBackgroundRuntime() {
  const [store] = useState(() => new BackgroundRuntimeStore(window.haloBrowser as Partial<BackgroundRuntimeApi> | undefined))
  const state = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => { const off = store.connect(); void store.refresh(); return off }, [store])
  return { store, state }
}
