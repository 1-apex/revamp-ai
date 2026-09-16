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
