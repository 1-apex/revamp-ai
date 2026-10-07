export { parseSource } from "./parse.js";
export { extractLogicSkeleton, hashSource, type LogicSkeleton } from "./logicSkeleton.js";
export {
  addressKey,
  computeFingerprint,
  enumerateAddressableNodes,
  resolveAddress,
  loadSourceFile,
  createInMemoryProject,
  type EditAddress,
  type AddressableNode,
  type ResolveResult,
  type ResolveFailure,
} from "./addressing.js";
export {
  EditAddressSchema,
  SetClassListOpSchema,
  SetCvaVariantsOpSchema,
  WrapElementOpSchema,
  InsertPresentationalOpSchema,
  AddImportOpSchema,
  EditOpSchema,
  EditBatchSchema,
  parseEditBatch,
  WRAPPER_TAG_ALLOWLIST,
  PRESENTATIONAL_INSERT_TAG_ALLOWLIST,
  IMPORT_SOURCE_ALLOWLIST,
  type EditAddressInput,
  type SetClassListOp,
  type SetCvaVariantsOp,
  type WrapElementOp,
  type InsertPresentationalOp,
  type AddImportOp,
  type EditOp,
  type EditBatch,
  type WrapperTag,
  type PresentationalInsertTag,
} from "./editOps.js";
export { validateEditBatch, type OpError, type ValidationResult } from "./validator.js";
export { applyEditBatch, type ApplyError, type ApplyResult } from "./applier.js";
