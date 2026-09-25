/**
 * custom_call: the escape-hatch action type for on-chain operations outside
 * the other 4 built-in action types (arbitrary contract, arbitrary method).
 * Encodes a human-readable Solidity function signature + string args into
 * real calldata via viem — verified against a real ERC20 approve() call
 * (correct 4-byte selector, correct ABI-encoded args) before wiring in.
 */
import { parseAbiItem, encodeFunctionData, parseEther, type AbiParameter } from "viem";

type TupleAbiParameter = AbiParameter & { components?: readonly AbiParameter[] };

/** Recursively coerces an already-JSON-parsed JS value to match one ABI parameter's declared type, including nested tuples/tuple arrays. */
function coerceValue(value: unknown, param: AbiParameter): unknown {
  const type = param.type;

  if (type === "tuple") {
    const components = (param as TupleAbiParameter).components ?? [];
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const c of components) result[c.name!] = coerceValue(input[c.name!], c);
    return result;
  }
  if (type === "tuple[]") {
    const asTuple = { ...param, type: "tuple" } as AbiParameter;
    return (value as unknown[]).map((v) => coerceValue(v, asTuple));
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return type.endsWith("[]") ? (value as unknown[]).map((v) => BigInt(v as string)) : BigInt(value as string);
  }
  if (type === "bool") {
    return typeof value === "boolean" ? value : value === "true";
  }
  return value; // address(/[]), string(/[]), bytes*(/[]) — already the right shape after JSON.parse
}

/** Coerces one top-level string arg (from customCallArgs) for one ABI input parameter — JSON-parses first when the type is a tuple or any array (uint256[], (address,uint256)[], etc.), since those can't be expressed as a bare string. */
function coerceArg(rawValue: string, param: AbiParameter): unknown {
  const needsJsonParse = param.type === "tuple" || param.type.endsWith("[]");
  const parsed = needsJsonParse ? JSON.parse(rawValue) : rawValue;
  return coerceValue(parsed, param);
}

export interface EncodedCustomCall {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export function encodeCustomCall(params: {
  target: string;
  functionSignature: string;
  args: string[];
  valueEth: string;
}): EncodedCustomCall {
  const abiItem = parseAbiItem(params.functionSignature);
  if (abiItem.type !== "function") {
    throw new Error(`customCallFunction must be a function signature, got: ${params.functionSignature}`);
  }
  const inputs = abiItem.inputs as readonly AbiParameter[];
  if (inputs.length !== params.args.length) {
    throw new Error(`${params.functionSignature} expects ${inputs.length} args, got ${params.args.length}`);
  }
  const coercedArgs = inputs.map((input, i) => coerceArg(params.args[i], input));

  const data = encodeFunctionData({ abi: [abiItem], functionName: abiItem.name, args: coercedArgs });
  return {
    to: params.target as `0x${string}`,
    data,
    value: params.valueEth && params.valueEth !== "0" ? parseEther(params.valueEth) : 0n,
  };
}
