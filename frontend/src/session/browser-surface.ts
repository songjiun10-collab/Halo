import type { BrowserViewport, HaloBrowserApi } from './api'

const HIDDEN_VIEWPORT: BrowserViewport = { x: 0, y: 94, width: 0, height: 0, visible: false }

/** Keep the main-process WebContentsView exactly within the rendered page slot. */
export function syncNativeSurface(
  api: Pick<HaloBrowserApi, 'setTaskViewport'>,
  taskId: string | null,
  element: Pick<HTMLElement, 'getBoundingClientRect'> | null,
  visible: boolean,
): Promise<unknown> {
  if (!taskId || !element || !visible) return api.setTaskViewport(null, HIDDEN_VIEWPORT)
  const rect = element.getBoundingClientRect()
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    return api.setTaskViewport(null, HIDDEN_VIEWPORT)
  }
  return api.setTaskViewport(taskId, {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    visible: true,
  })
}
