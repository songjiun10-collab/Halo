import contracts = require("../runtime-src/shared/harness-contracts");

// A malformed capability ID can throw a TypeError before a code is assigned.
// This fixture is compile-only; preserve that historical rejection shape.
const missingCode = new contracts.ContractError(undefined, "malformed capability");
const observedCode: string | undefined = missingCode.code;
void observedCode;

// Numeric error codes are not part of the contract, even with the optional code.
// @ts-expect-error A code must be a string or absent.
new contracts.ContractError(123, "invalid code");
