// Generated from runtime-src/main/harness/action-safety.ts. Do not edit; run npm run build:runtime.
"use strict";
// One place that answers, for any action the agent proposes, what the host's three safety checks say:
//   privacy  - is the agent about to type a secret (card, password, code) or an unauthorized personal value?
//   payment  - is the action a press on a payment control?
//   effect   - does the control under the point move money or destroy an account (text screen map only)?
// The dispatch loop calls inspectAction once per action and acts on the answer. Every action type in
// permission-policy.js ACTIONS must be declared below for every check; test/action-safety.test.js fails
// when a type is added without a declaration, and proves each declaration against the real check.
// "applies" means the check is run for that type; "not-applicable" says why it is not. A reason that
// says "relies on the approval gate" is a statement, not a guarantee: Full mode skips that gate.
const { resolveTarget } = require("./screen-map");
const { classifyTarget, isPaymentControl } = require("./effect-classifier");
const { typingBlock } = require("./pii-tiers");
const CHECKS = Object.freeze(["privacy", "payment", "effect"]);
const applies = (reason) => Object.freeze({ applies: true, reason });
const notApplicable = (reason) => Object.freeze({ applies: false, reason });
const reads = (what) => Object.freeze({
    privacy: notApplicable(`${what} types nothing`),
    payment: notApplicable(`${what} presses nothing`),
    effect: notApplicable(`${what} acts on no control`),
});
const SAFETY_DECLARATIONS = Object.freeze({
    observe: Object.freeze(reads("observe")),
    scroll: Object.freeze(reads("scroll")),
    find_text: Object.freeze(reads("find_text (it only scrolls a matching passage into view)")),
    navigate: Object.freeze(reads("navigate (a payment needs a button press on the page it opens)")),
    follow_link: Object.freeze(reads("follow_link (a link only navigates; the payment press happens on the destination page)")),
    click: Object.freeze({
        privacy: notApplicable("a click types no text"),
        payment: applies("a click on a payment control must be covered by an order or wait for the person"),
        effect: notApplicable("element clicks rely on the approval gate and isAutoDomAction; Full mode skips that gate by definition"),
    }),
    type: Object.freeze({
        privacy: applies("typing a secret or an unrequested personal value is the person's to do"),
        payment: notApplicable("typing text does not press a payment control"),
        effect: notApplicable("typing into a field cannot move money by itself"),
    }),
    click_at: Object.freeze({
        privacy: notApplicable("a click types no text"),
        payment: applies("the control under the point can be a payment control"),
        effect: applies("with a text screen map the control under the point is classified; money or account destruction is refused"),
    }),
    type_at: Object.freeze({
        privacy: applies("typing at a point can hit a secret field or carry a secret value"),
        payment: notApplicable("typing text does not press a payment control"),
        effect: applies("with a text screen map the target under the point is classified before typing"),
    }),
    select_option: Object.freeze({
        privacy: notApplicable("choosing a listed option types no free text"),
        payment: notApplicable("choosing an option presses no control; a page whose dropdown submits its form on change relies on the approval gate, and Full mode skips that gate by definition"),
        effect: notApplicable("option choices rely on the approval gate; Full mode skips that gate by definition"),
    }),
    press_key: Object.freeze({
        privacy: notApplicable("a single key press carries no text value"),
        payment: notApplicable("Enter keeps the approval gate in computer-use modes; Full mode skips that gate by definition"),
        effect: notApplicable("a key press has no control under a point"),
    }),
    play_loop: Object.freeze({
        privacy: notApplicable("play_loop presses letters, digits and arrows only, one key per rule, and carries no text value"),
        payment: notApplicable("Enter, Space and Tab cannot be in a rule (a focused Buy button needs one of them), so a run presses no control; it is bounded to 60 seconds, needs the person's approval outside Full mode, and stops if the page navigates"),
        effect: notApplicable("the keys act on a game canvas the person asked to play; there is no control under a point to classify"),
    }),
    submit_form: Object.freeze({
        privacy: notApplicable("submitting types no text"),
        payment: applies("a form submit on a payment control, or of a whole form that holds one, must be covered by an order or wait for the person"),
        effect: notApplicable("form submits rely on the approval gate; Full mode skips that gate by definition"),
    }),
    download: Object.freeze(reads("download (unsupported, denied by the permission policy)")),
});
function screenHit(action, ctx) {
    const maps = ctx.screenTargets;
    if (!maps || maps.observationId !== action.observationId)
        return null;
    return resolveTarget(maps.targets, Number(action.x), Number(action.y));
}
function privacyOf(action, ctx) {
    if (action.type !== "type" && action.type !== "type_at")
        return null;
    const element = action.type === "type"
        ? (ctx.observation?.elements?.find((el) => el.elementId === action.elementId) ?? null)
        : screenHit(action, ctx);
    return typingBlock({ text: action.text, element, userText: ctx.userText });
}
function paymentTargetOf(action, ctx) {
    if (action.type === "click_at" && ctx.computerUse) {
        const hit = screenHit(action, ctx);
        return isPaymentControl(hit) ? hit : null;
    }
    if (action.type === "click" || action.type === "submit_form") {
        const elements = Array.isArray(ctx.observation?.elements) ? ctx.observation.elements : [];
        const element = elements.find((el) => el.elementId === action.elementId);
        if (!element || typeof element.name !== "string")
            return null;
        const own = asControl(element);
        if (isPaymentControl(own))
            return own;
        // Submitting a whole form sends what its own payment button would, whatever the form is called:
        // look at the buttons inside it and the ones that submit to the same place. A submit through one
        // particular non-payment button (Apply coupon) stays that button's.
        if (action.type !== "submit_form" || element.role === "button" || element.role === "link")
            return null;
        const byId = new Map(elements.map((el) => [el.elementId, el]));
        const inside = (candidate) => {
            let id = candidate.parentElementId;
            for (let depth = 0; id !== null && id !== undefined && depth < 64; depth += 1) {
                if (id === element.elementId)
                    return true;
                id = byId.get(id)?.parentElementId;
            }
            return false;
        };
        const sameTarget = (candidate) => typeof element.formAction === "string" && element.formAction !== "" && candidate.formAction === element.formAction;
        for (const candidate of elements) {
            if (candidate === element || (candidate.role !== "button" && candidate.role !== "link") || typeof candidate.name !== "string")
                continue;
            if (!inside(candidate) && !sameTarget(candidate))
                continue;
            const target = asControl(candidate);
            if (isPaymentControl(target))
                return target;
        }
        return null;
    }
    return null;
}
function asControl(element) {
    return { role: element.role === "link" ? "link" : "button", name: element.name, covered: false, disabled: !!element.disabled };
}
function effectOf(action, ctx) {
    if (action.type !== "click_at" && action.type !== "type_at")
        return null;
    if (!ctx.screenTargets || ctx.screenTargets.observationId !== action.observationId || !ctx.computerUse)
        return null;
    return classifyTarget(screenHit(action, ctx), action.type);
}
// ctx: { observation, screenTargets: { observationId, targets } | null, computerUse: boolean, userText: string }
// An action type with no declaration comes back { undeclared: true } so the caller can fail closed.
function inspectAction(action, ctx) {
    if (!action || !Object.hasOwn(SAFETY_DECLARATIONS, action.type))
        return { privacy: null, paymentTarget: null, effect: null, undeclared: true };
    return { privacy: privacyOf(action, ctx), paymentTarget: paymentTargetOf(action, ctx), effect: effectOf(action, ctx) };
}
module.exports = { inspectAction, SAFETY_DECLARATIONS, CHECKS };
