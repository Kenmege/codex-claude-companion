import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const SCHEMAS = Object.freeze({
  request: "bridge-delegation-request.schema.json",
  event: "bridge-event.schema.json",
  messageOperation: "bridge-message-operation.schema.json",
  result: "bridge-result.schema.json",
  receipt: "bridge-receipt.schema.json"
});
const validators = Object.fromEntries(Object.entries(SCHEMAS).map(([kind, filename]) => [
  kind,
  ajv.compile(JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", filename), "utf8")))
]));

export class BridgeContractValidationError extends Error {
  constructor(message, { phase, errors = [] } = {}) {
    super(message);
    this.name = "BridgeContractValidationError";
    this.phase = phase;
    this.errors = errors;
  }
}

function formatSchemaErrors(errors = []) {
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message}`;
  }).join("; ");
}

function validateSchema(kind, value) {
  const validator = validators[kind];
  if (!validator(value)) {
    const errors = structuredClone(validator.errors ?? []);
    throw new BridgeContractValidationError(
      `Bridge ${kind} failed schema validation: ${formatSchemaErrors(errors)}`,
      { phase: "schema", errors }
    );
  }
  return value;
}

export function validateBridgeRequestContract(request) {
  validateSchema("request", request);
  const { execution } = request;
  if (execution.sandboxAttestation !== null) {
    const attestation = execution.sandboxAttestation;
    for (const key of ["jobId", "executor", "canonicalWorkspacePath"]) {
      if (attestation[key] !== (key === "jobId" ? request.jobId : execution[key])) {
        throw new BridgeContractValidationError(`Bridge request sandbox attestation ${key} is not bound to the request.`, { phase: "semantics" });
      }
    }
  }
  return request;
}

export function validateBridgeEventContract(event) {
  return validateSchema("event", event);
}

export function validateBridgeMessageOperationContract(operation) {
  return validateSchema("messageOperation", operation);
}

export function validateBridgeResultContract(result) {
  return validateSchema("result", result);
}

function parseTimestamp(receipt, label, value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new BridgeContractValidationError(
      `Bridge receipt ${label} must be a valid date-time string.`,
      { phase: "semantics" }
    );
  }
  return milliseconds;
}

function validateReceiptSemantics(receipt) {
  const createdAt = parseTimestamp(receipt, "createdAt", receipt.createdAt);
  const deliveredAt = receipt.delivery.deliveredAt === null
    ? null
    : parseTimestamp(receipt, "deliveredAt", receipt.delivery.deliveredAt);
  const acknowledgedAt = receipt.delivery.acknowledgedAt === null
    ? null
    : parseTimestamp(receipt, "acknowledgedAt", receipt.delivery.acknowledgedAt);
  const verifiedAt = receipt.verification.verifiedAt === null
    ? null
    : parseTimestamp(receipt, "verifiedAt", receipt.verification.verifiedAt);

  if (deliveredAt !== null && deliveredAt < createdAt) {
    throw new BridgeContractValidationError(
      "Bridge receipt chronology is invalid: deliveredAt must not precede createdAt.",
      { phase: "semantics" }
    );
  }
  if (acknowledgedAt !== null && acknowledgedAt < deliveredAt) {
    throw new BridgeContractValidationError(
      "Bridge receipt chronology is invalid: acknowledgedAt must not precede deliveredAt.",
      { phase: "semantics" }
    );
  }
  if (verifiedAt !== null && verifiedAt < createdAt) {
    throw new BridgeContractValidationError(
      "Bridge receipt chronology is invalid: verifiedAt must not precede createdAt.",
      { phase: "semantics" }
    );
  }
}

/**
 * Validate the complete bridge receipt contract: JSON Schema shape and semantic
 * chronology. Callers must use this entry point rather than compiling only the
 * schema, because JSON Schema cannot compare date-time values.
 *
 * @returns the validated receipt unchanged
 * @throws {BridgeContractValidationError} with `phase` set to `schema` or `semantics`
 */
export function validateBridgeReceiptContract(receipt) {
  validateSchema("receipt", receipt);
  validateReceiptSemantics(receipt);
  return receipt;
}
