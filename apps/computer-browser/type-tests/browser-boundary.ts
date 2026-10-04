import ports = require('../runtime-src/shared/port-contracts');
import layout = require('../runtime-src/shared/layout-constants');
import bounds = require('../runtime-src/shared/clamp-bounds');
import router = require('../runtime-src/shared/task-profile-router');
import runtimeUi = require('../runtime-src/main/harness/background-runtime-ui');

const box: { x: number; y: number; width: number; height: number } = bounds.clampBrowserBounds({ x: 0, y: 0, width: 1200, height: 900 }, 1200, 900);
const profile = router.resolveTaskProfile({ goalInput: { originalRequest: 'visit MDN' } });
const duration: 'short' | 'fast' | 'middle' | 'long' = profile.duration.id;
const signalArg: 0 = ports.BROWSER_PORT.requests.observe.signalArg;
void box; void duration; void signalArg;

// @ts-expect-error window sizes are numeric, even though JS input is validated at runtime
bounds.clampBrowserBounds({}, 'wide', 900);
// @ts-expect-error routing returns a deeply readonly profile
profile.duration.id = 'long';
// @ts-expect-error transport method definitions are readonly
ports.BROWSER_PORT.requests.observe.signalArg = 1;
// @ts-expect-error renderer/main layout constants are readonly
layout.HEADER_HEIGHT = 0;
// @ts-expect-error a host must expose settings reads and writes
new runtimeUi.BackgroundRuntimeUi({ host: {} });
