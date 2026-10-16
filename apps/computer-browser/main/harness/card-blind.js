// Generated from runtime-src/main/harness/card-blind.ts. Do not edit; run npm run build:runtime.
"use strict";
// The planner never sees card data. Card numbers in page text and field values are masked
// before an observation reaches it, typing into a card field is a human job, and a card
// number in the chat is refused. Last four digits stay visible so a saved card can be told apart.
const CARD_FIELD = /(card.?(number|no|num)\b|cardnumber|카드\s*번호|\bcvc\b|\bcvv\b|\bcsc\b|보안\s*코드|유효\s*(기간|일)|expir(y|ation)|\bexp\b|mm\s*\/\s*yy|cc-(number|csc|exp|name))/i;
const DIGIT_RUN = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
function luhnValid(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let d = digits.charCodeAt(i) - 48;
        if (double) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}
function cardDigitsIn(text) {
    const found = [];
    if (typeof text !== "string")
        return found;
    for (const match of text.matchAll(DIGIT_RUN)) {
        const digits = match[0].replace(/\D/g, "");
        if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits))
            found.push({ raw: match[0], digits });
    }
    return found;
}
function containsCardNumber(text) {
    return cardDigitsIn(text).length > 0;
}
function maskCardNumbers(text) {
    if (typeof text !== "string" || !text)
        return text;
    let out = text;
    for (const { raw, digits } of cardDigitsIn(text))
        out = out.split(raw).join(`[카드번호 ••••${digits.slice(-4)}]`);
    return out;
}
function isCardField(element) {
    if (!element || typeof element !== "object")
        return false;
    if (element.cardField === true)
        return true;
    const label = [element.name, element.placeholder, element.autocomplete].filter((s) => typeof s === "string").join(" ");
    return CARD_FIELD.test(label);
}
// Returns a copy: field values of card inputs are hidden, card numbers anywhere in text are masked.
function blindObservation(observation) {
    if (!observation || typeof observation !== "object")
        return observation;
    const elements = Array.isArray(observation.elements)
        ? observation.elements.map((el) => {
            if (!el || typeof el !== "object")
                return el;
            const copy = { ...el };
            if (typeof copy.name === "string")
                copy.name = maskCardNumbers(copy.name);
            if (typeof copy.value === "string") {
                if (isCardField(el)) {
                    delete copy.value;
                    copy.valueHidden = true;
                }
                else
                    copy.value = maskCardNumbers(copy.value);
            }
            return copy;
        })
        : observation.elements;
    return { ...observation, ...(typeof observation.text === "string" ? { text: maskCardNumbers(observation.text) } : {}), elements };
}
module.exports = { containsCardNumber, maskCardNumbers, isCardField, blindObservation, luhnValid };
