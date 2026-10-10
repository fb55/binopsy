import type { Transform } from "node:stream";

/**
 * Objects built while parsing. Fields are added one by one, so internally
 * they are untyped; the public `Bin<T>` API carries the precise type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

/** Callback receiving the requested bytes at `buffer[offset]`. `done` signals the end of input. */
export type ReadCallback = (
  buffer: Buffer,
  offset: number,
  done: boolean,
) => void;

/** Requests `bytes` bytes from the input. */
export type ReadRequest = (bytes: number, cb: ReadCallback) => void;

/** Continuation called once a value has been read (or input ended). */
export type Continuation = (
  read: ReadRequest,
  obj: unknown,
  done: boolean,
) => void;

/** Continuation-passing reader for one value. */
export type ReadFunc = (read: ReadRequest, obj: Obj, cb: Continuation) => void;

/** Writes `value` into `buffer` and returns the number of bytes written. */
export type WriteFunc = (value: unknown, buffer: Buffer) => number;

/** Computes the serialized size of `value`. */
export type SizeFunc = (value: unknown) => number;

/** Constructor for parsed objects; receives the parent object for nested types. */
export type ConstructorFn = new (parent?: Obj) => object;

/** A bit field request, queued until the bit sequence is complete. */
export interface BitRequest {
  i: number;
  vars: string[];
  options: FieldOptions | undefined;
}

/** Common options accepted by all field methods. */
export interface FieldOptions {
  formatter?: (this: Obj, value: never) => unknown;
  deformatter?: (value: never, obj: Obj) => unknown;
  assert?: string | number | ((this: Obj, value: never) => boolean);
  flatten?: boolean;
}

/** Anything that can act as a nested type: a `Bin` instance or a primitive name. */
export interface TypeLike {
  readFunc: ReadFunc;
  writeFunc: WriteFunc;
  sizeFunc: SizeFunc;
  constructorFn: ConstructorFn;
  fixedSize: number;
  bitRequests: BitRequest[];
  _flushBitfield?: () => void;
}

/** Normalised view of a type, as used by the parser and serializer. */
export interface ResolvedType {
  constructorFn: ConstructorFn;
  fixedSize: number;
  bitRequests: BitRequest[];
  sizeFunc: SizeFunc;
  writeFunc: WriteFunc;
  readFunc: ReadFunc;
}

/** Result of `stream()`: a transform stream emitting parsed objects. */
export type ParserStream = Transform;
