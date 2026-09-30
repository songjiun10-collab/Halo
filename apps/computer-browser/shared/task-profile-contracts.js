// Generated from runtime-src/shared/task-profile-contracts.ts. Do not edit; run npm run build:runtime.
"use strict";
const harnessContracts = require("./harness-contracts");
const { ContractError, DEFAULT_LIMITS, isPlainObject, } = harnessContracts;
// Assertion functions need an explicit annotation to narrow at call sites;
// these are the same load-time bindings the destructuring above would make.
const assertId = harnessContracts.assertId;
const assertUuid = harnessContracts.assertUuid;
const { validateHarnessProfile } = require("./harness-profile");
const { CAPABILITY_REGISTRY_VERSION, getCapabilityProfile, } = require("./capability-registry");
const PROFILE_SCHEMA_VERSION = 1;
const SOURCE_IDS = Object.freeze([
    "routine_entrypoint",
    "explicit_user_choice",
    "intent_rule",
    "default",
    "parent_plan_policy",
]);
const PROFILE_FIELDS = Object.freeze([
    "schemaVersion", "classifierVersion", "duration", "capability", "parentBinding", "selection",
]);
const SELECTED_PAYLOAD_FIELDS = Object.freeze([
    "profileSchemaVersion", "classifierVersion", "parentBinding", "duration", "capability", "selection", "workGoalBinding",
]);
const DURATION_FIELDS = Object.freeze(["id", "harnessProfileVersion", "policySetId"]);
const SELECTED_DURATION_FIELDS = Object.freeze([...DURATION_FIELDS, "effectiveLimits"]);
const CAPABILITY_FIELDS = Object.freeze(["id", "registryVersion", "dependencies", "adapters"]);
const ADAPTER_FIELDS = Object.freeze(["capabilityId", "adapterId", "adapterVersion"]);
const SELECTION_FIELDS = Object.freeze(["duration", "capability"]);
const SELECTION_ITEM_FIELDS = Object.freeze(["source", "ruleId"]);
const PARENT_BINDING_FIELDS = Object.freeze(["parentTaskId", "planId", "parentGoalVersion"]);
const WORK_GOAL_BINDING_FIELDS = Object.freeze(["goalId", "goalVersion", "reservationId"]);
const LIMIT_FIELDS = Object.freeze(["maxActions", "maxPlannerCalls", "maxActiveMs"]);
/**
 * getCapabilityProfile's own rejection carries code "unknown_capability",
 * but building its message calls String(id), which itself throws a TypeError
 * without any `code` for malformed input such as { toString: null }. The
 * code read here is therefore a string or undefined; runtime is unchanged.
 */
function capabilityErrorCode(error) {
    return error.code;
}
function assertObject(value, label, fields) {
    if (!isPlainObject(value))
        throw new ContractError("invalid_shape", `${label} must be a plain object`);
    for (const key of Object.keys(value)) {
        if (!fields.includes(key))
            throw new ContractError("unknown_field", `${label} has unknown field "${key}"`);
    }
}
function requireFields(value, fields, label) {
    for (const field of fields) {
        if (!Object.hasOwn(value, field))
            throw new ContractError("invalid_field", `${label}.${field} is required`);
    }
}
function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
    // The typeof guard is implied by Number.isSafeInteger; it only narrows.
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new ContractError("invalid_field", `${label} must be a positive safe integer`);
    }
    if (value > maximum)
        throw new ContractError("limit_exceeded", `${label} exceeds the host limit`);
}
function validateParentBinding(value, label = "parentBinding") {
    assertObject(value, label, PARENT_BINDING_FIELDS);
    requireFields(value, PARENT_BINDING_FIELDS, label);
    assertUuid(value.parentTaskId, `${label}.parentTaskId`);
    assertId(value.planId, `${label}.planId`);
    positiveInteger(value.parentGoalVersion, `${label}.parentGoalVersion`);
    return value;
}
function validateWorkGoalBinding(value) {
    assertObject(value, "workGoalBinding", WORK_GOAL_BINDING_FIELDS);
    requireFields(value, WORK_GOAL_BINDING_FIELDS, "workGoalBinding");
    assertUuid(value.goalId, "workGoalBinding.goalId");
    positiveInteger(value.goalVersion, "workGoalBinding.goalVersion");
    assertUuid(value.reservationId, "workGoalBinding.reservationId");
    return value;
}
function validateDuration(value, { selected = false } = {}) {
    const fields = selected ? SELECTED_DURATION_FIELDS : DURATION_FIELDS;
    assertObject(value, "duration", fields);
    requireFields(value, DURATION_FIELDS, "duration");
    validateHarnessProfile(value.id);
    positiveInteger(value.harnessProfileVersion, "duration.harnessProfileVersion");
    assertId(value.policySetId, "duration.policySetId");
    if (selected) {
        requireFields(value, ["effectiveLimits"], "duration");
        assertObject(value.effectiveLimits, "duration.effectiveLimits", LIMIT_FIELDS);
        requireFields(value.effectiveLimits, LIMIT_FIELDS, "duration.effectiveLimits");
        for (const key of LIMIT_FIELDS)
            positiveInteger(value.effectiveLimits[key], `duration.effectiveLimits.${key}`, DEFAULT_LIMITS[key]);
    }
    else if (Object.hasOwn(value, "effectiveLimits")) {
        throw new ContractError("unknown_field", "duration.effectiveLimits is only valid in the persisted profile event");
    }
    return value;
}
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function validateCapability(value) {
    assertObject(value, "capability", CAPABILITY_FIELDS);
    requireFields(value, CAPABILITY_FIELDS, "capability");
    const entry = getCapabilityProfile(value.id);
    if (!entry.available)
        throw new ContractError("capability_unavailable", `${value.id} capability is unavailable`);
    positiveInteger(value.registryVersion, "capability.registryVersion");
    if (value.registryVersion !== CAPABILITY_REGISTRY_VERSION) {
        throw new ContractError("unknown_version", "capability.registryVersion is not supported");
    }
    if (!Array.isArray(value.dependencies))
        throw new ContractError("invalid_shape", "capability.dependencies must be an array");
    value.dependencies.forEach((id, index) => {
        try {
            getCapabilityProfile(id);
        }
        catch (error) {
            throw new ContractError(capabilityErrorCode(error), `capability.dependencies[${index}] is unknown`);
        }
    });
    if (value.dependencies.some((id, index) => index > 0 && compareText(value.dependencies[index - 1], id) >= 0)) {
        throw new ContractError("invalid_order", "capability.dependencies must be unique and sorted");
    }
    if (!Array.isArray(value.adapters))
        throw new ContractError("invalid_shape", "capability.adapters must be an array");
    for (const [index, adapter] of value.adapters.entries()) {
        assertObject(adapter, `capability.adapters[${index}]`, ADAPTER_FIELDS);
        requireFields(adapter, ADAPTER_FIELDS, `capability.adapters[${index}]`);
        try {
            getCapabilityProfile(adapter.capabilityId);
        }
        catch (error) {
            throw new ContractError(capabilityErrorCode(error), `capability.adapters[${index}].capabilityId is unknown`);
        }
        assertId(adapter.adapterId, `capability.adapters[${index}].adapterId`);
        positiveInteger(adapter.adapterVersion, `capability.adapters[${index}].adapterVersion`);
    }
    const adapterKey = (item) => `${item.capabilityId}\u0000${item.adapterId}`;
    if (value.adapters.some((item, index) => index > 0 && compareText(adapterKey(value.adapters[index - 1]), adapterKey(item)) >= 0)) {
        throw new ContractError("invalid_order", "capability.adapters must be unique and sorted");
    }
    if (JSON.stringify(value.dependencies) !== JSON.stringify(entry.dependencies)
        || JSON.stringify(value.adapters) !== JSON.stringify(entry.adapters)) {
        throw new ContractError("unknown_adapter", "capability dependency or adapter closure differs from the host registry");
    }
    return value;
}
function validateSelection(value) {
    assertObject(value, "selection", SELECTION_FIELDS);
    requireFields(value, SELECTION_FIELDS, "selection");
    for (const axis of SELECTION_FIELDS) {
        const item = value[axis];
        assertObject(item, `selection.${axis}`, SELECTION_ITEM_FIELDS);
        requireFields(item, ["source"], `selection.${axis}`);
        if (typeof item.source !== "string" || !SOURCE_IDS.includes(item.source))
            throw new ContractError("unknown_enum", `selection.${axis}.source is unsupported`);
        if (item.ruleId !== undefined)
            assertId(item.ruleId, `selection.${axis}.ruleId`);
        if (item.source === "intent_rule" && item.ruleId === undefined) {
            throw new ContractError("invalid_field", `selection.${axis}.ruleId is required for intent_rule`);
        }
        if (item.source !== "intent_rule" && item.ruleId !== undefined) {
            throw new ContractError("invalid_field", `selection.${axis}.ruleId is only valid for intent_rule`);
        }
    }
    // Every axis was checked above: source is a SOURCE_IDS string, ruleId an id.
    return value;
}
function validateProfile(value, { selected = false } = {}) {
    const fields = selected ? SELECTED_PAYLOAD_FIELDS : PROFILE_FIELDS;
    assertObject(value, selected ? "task_profile_selected.payload" : "resolvedTaskProfile", fields);
    const required = selected
        ? ["profileSchemaVersion", "classifierVersion", "duration", "capability", "selection"]
        : ["schemaVersion", "classifierVersion", "duration", "capability", "selection"];
    requireFields(value, required, selected ? "task_profile_selected.payload" : "resolvedTaskProfile");
    const schemaVersion = selected ? value.profileSchemaVersion : value.schemaVersion;
    positiveInteger(schemaVersion, selected ? "profileSchemaVersion" : "schemaVersion");
    if (schemaVersion !== PROFILE_SCHEMA_VERSION)
        throw new ContractError("unknown_version", "profile schema version is not supported");
    assertId(value.classifierVersion, "classifierVersion");
    if (Object.hasOwn(value, "parentBinding"))
        validateParentBinding(value.parentBinding);
    if (Object.hasOwn(value, "workGoalBinding")) {
        if (!selected)
            throw new ContractError("unknown_field", "workGoalBinding is only valid in the persisted profile event");
        validateWorkGoalBinding(value.workGoalBinding);
        if (value.parentBinding)
            throw new ContractError("invalid_profile", "child profiles cannot bind independently to a Work Goal");
    }
    validateDuration(value.duration, { selected });
    // Same objects as value.capability / value.selection, typed by validation.
    const capability = validateCapability(value.capability);
    const selection = validateSelection(value.selection);
    if (capability.id === "routine" && selection.capability.source !== "routine_entrypoint") {
        throw new ContractError("invalid_profile", "Routine capability must be selected by a typed routine entrypoint");
    }
    if (value.parentBinding && (capability.id !== "browser" || selection.capability.source !== "parent_plan_policy")) {
        throw new ContractError("invalid_profile", "child profiles are host-pinned Browser routes");
    }
    if (!value.parentBinding && selection.capability.source === "parent_plan_policy") {
        throw new ContractError("invalid_profile", "parent_plan_policy requires a child parentBinding");
    }
    return value;
}
function validateResolvedTaskProfile(value) {
    return validateProfile(value);
}
function validateTaskProfileSelectedPayload(value) {
    return validateProfile(value, { selected: true });
}
function validateProfileRequiredGoalCreatedPayload(value) {
    if (!isPlainObject(value))
        throw new ContractError("invalid_shape", "goal_created.payload must be a plain object");
    // Unmarked historical payloads were intentionally opaque in the journal
    // contract (including the empty payload in the shared conformance corpus).
    // Tight validation applies only to records opting into the new invariant.
    if (!Object.hasOwn(value, "profileRequired"))
        return value;
    assertObject(value, "goal_created.payload", ["goalVersion", "profileRequired"]);
    requireFields(value, ["goalVersion", "profileRequired"], "goal_created.payload");
    positiveInteger(value.goalVersion, "goal_created.payload.goalVersion");
    if (value.profileRequired !== true) {
        throw new ContractError("invalid_field", "goal_created.payload.profileRequired must be true when present");
    }
    return value;
}
module.exports = {
    PROFILE_SCHEMA_VERSION,
    SOURCE_IDS,
    validateResolvedTaskProfile,
    validateTaskProfileSelectedPayload,
    validateWorkGoalBinding,
    validateProfileRequiredGoalCreatedPayload,
};
