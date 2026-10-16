"use strict";

interface Browser {
  captureTextObservation?(observation: any): Promise<any>;
  captureComputerUseObservation?(observation: any): Promise<any>;
}
interface Options { taskId: string; imageInput: boolean; lastActionType?: string; lastActionStatus?: string }
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function validBinding(capture: any, observation: any, taskId: string): boolean {
  return capture?.binding?.observationId === observation.id && capture.binding.taskId === taskId && capture.binding.documentEpoch === observation.documentEpoch;
}

// Observation routing only: this never dispatches an action or grants authority.
async function capturePreferredObservation(browser: Browser, observation: any, options: Options): Promise<any> {
  let textCapture = null;
  let reason = "text_unavailable";
  const domFailed = options.lastActionStatus === "failed" && ["click", "type", "follow_link"].includes(options.lastActionType ?? "");
  if (typeof browser.captureTextObservation === "function") {
    try {
      textCapture = await browser.captureTextObservation(observation);
      if (!validBinding(textCapture, observation, options.taskId) || typeof textCapture.screenMap?.text !== "string") fail("invalid_text_binding");
      if (!options.imageInput || (textCapture.screenMap.sparse === false && !domFailed)) return { textCapture, visualCapture: null, route: "text", reason: "dom_available" };
      reason = domFailed ? "dom_action_failed" : "sparse_dom";
    } catch (error) {
      if (!options.imageInput) throw error;
      textCapture = null;
      reason = "text_capture_failed";
    }
  }
  if (!options.imageInput || typeof browser.captureComputerUseObservation !== "function") fail("computer_use_unavailable");
  const visualCapture = await browser.captureComputerUseObservation(observation);
  if (!validBinding(visualCapture, observation, options.taskId) || !visualCapture.attachment || typeof visualCapture.attachment.path !== "string" || typeof visualCapture.attachment.dispose !== "function") {
    await visualCapture?.attachment?.dispose?.();
    fail("invalid_image_binding");
  }
  return { textCapture: null, visualCapture, route: "image", reason };
}
export = { capturePreferredObservation };
