// Finds the producer/consumer pairs a review can settle without a model: an exported function that
// builds a record and an exported reader that accepts one, in the same changed module. The scan is
// deliberately narrow — a pair it does not recognise, or an input it cannot ground, is reported as
// unproven, never as healthy.

/** Names that build a record: `writeRecord`, `serializeEntry`, `encodeFrame`, `toJSON`. */
const WRITER = /^(write|serialize|encode|toJSON|toJson|make|build)/;
/** Names that accept a record: `readRecord`, `parseEntry`, `decodeFrame`, `validate`, `restore`. */
const READER = /^(read|parse|decode|fromJSON|fromJson|validate|restore)/;

/** Parameter names that are numbers in every codebase this kit has seen. `version` appears here and
 * in `STRING` on purpose: it is both, so the conflict rule leaves the pair unproven. */
const NUMERIC = /(ms|timeout|limit|count|size|bytes|seconds|attempts|retries|port|index|idx|depth|width|height|offset|version)$/i;
/** Parameters that are booleans by their name. */
const BOOLEAN = /^(is|has|can|should|was|did)[A-Z]|^(enabled|disabled|active|flag|flags|verbose|strict|dry|force|quiet|async|optional|required)$/i;
/** Parameters that are strings by their name. */
const STRING = /^(id|ids|name|names|key|keys|slug|path|paths|file|files|dir|directory|text|label|title|kind|type|value|values|format|mode|locale|email|url|uri|service|channel|model|role|version|tag|host)$/i;

/**
 * What a probe may safely hand a writer for one value. `unknown` means the domain cannot be grounded
 * from the name, and the pair is reported as unproven rather than probed with an invented value: an
 * exception caused by our invention would say nothing about the code.
 *
 * @param {string} name
 * @returns {'string'|'number'|'boolean'|'unknown'}
 */
export function parameterDomain(name) {
  const matches = [NUMERIC, BOOLEAN, STRING].filter(rule => rule.test(name)).length;
  // A name that fits two rules does not establish a domain; guessing one of them is how a valid
  // contract gets refused.
  if (matches !== 1) return 'unknown';
  if (NUMERIC.test(name)) return 'number';
  if (BOOLEAN.test(name)) return 'boolean';
  return 'string';
}

function valueFor(name) {
  switch (parameterDomain(name)) {
    case 'number': return 1;
    case 'boolean': return true;
    case 'string': return 'probe';
    default: return undefined;
  }
}

/**
 * The arguments a function declares, one entry per parameter, so a probe keeps the declared
 * boundaries: `writeRecord(id, { service })` is two arguments, not two fields of one object.
 *
 * @param {object} node a function node
 * @returns {Array<{ kind: 'scalar'|'object', name?: string, hasDefault?: boolean, fields?: Array<{ name: string, hasDefault: boolean }> }>|null}
 *   `null` when the shape is one this stage cannot build — rest, arrays, nested destructuring.
 */
export function describeParams(node) {
  const args = [];
  for (const param of node.params ?? []) {
    if (param.type === 'Identifier') {
      args.push({ kind: 'scalar', name: param.name, hasDefault: false });
      continue;
    }
    if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') {
      args.push({ kind: 'scalar', name: param.left.name, hasDefault: true });
      continue;
    }
    if (param.type === 'ObjectPattern') {
      const fields = [];
      for (const property of param.properties ?? []) {
        if (property.type !== 'ObjectProperty') return null;
        const key = property.key?.name ?? property.key?.value;
        if (typeof key !== 'string') return null;
        if (property.value?.type === 'ObjectPattern' || property.value?.type === 'ArrayPattern') {
          // A nested destructuring pattern needs a nested object this stage cannot synthesise.
          return null;
        }
        fields.push({ name: key, hasDefault: property.value?.type === 'AssignmentPattern' });
      }
      args.push({ kind: 'object', fields });
      continue;
    }
    return null;
  }
  return args;
}

/**
 * Pairs a writer and a reader from one parsed module. Same module and same record family only:
 * `writeUser` pairs with `readUser`, never with `readConfig`, and a cross-file pair needs the
 * consumer's import graph, which this stage does not guess.
 *
 * @param {{ file: string, functions: Array<{ name: string, params: Array<object>|null }> }} module
 * @returns {{ pairs: Array<object>, unproven: string[], readers: string[], writers: string[] }}
 */
export function pairUp(module) {
  const writers = module.functions.filter(fn => WRITER.test(fn.name));
  const readers = module.functions.filter(fn => READER.test(fn.name));
  const unproven = [];
  for (const fn of [...writers, ...readers]) {
    if (fn.params === null) unproven.push(`${module.file} ${fn.name}: the parameter shape is not something the probe can build`);
  }
  const buildable = list => list.filter(fn => fn.params !== null);
  const pairs = [];
  for (const writer of buildable(writers)) {
    const family = recordFamily(writer.name, WRITER);
    const matching = buildable(readers).filter(reader => recordFamily(reader.name, READER) === family);
    if (matching.length === 0) {
      unproven.push(`${module.file} ${writer.name}: no reader of the same record family was found in this module`);
    }
    for (const reader of matching) {
      pairs.push({
        file: module.file,
        writer: writer.name,
        reader: reader.name,
        // Where the probe must look: a default export is not a named property of the module.
        writerExport: writer.exportName ?? writer.name,
        readerExport: reader.exportName ?? reader.name,
        writerParams: writer.params,
        readerParams: reader.params,
      });
    }
  }
  return { pairs, unproven, writers: writers.map(fn => fn.name), readers: readers.map(fn => fn.name) };
}

/**
 * The record family a function name belongs to: the verb removed, the rest folded, so `writeUser`
 * pairs with `readUser` and `toJSON` with `fromJSON`, and `writeConfig` never pairs with `readUser`.
 *
 * @param {string} name
 * @param {RegExp} verb
 * @returns {string}
 */
export function recordFamily(name, verb) {
  const match = String(name).match(verb);
  const rest = match ? String(name).slice(match[0].length) : String(name);
  // The verb is removed, the record word is not: `buildRecord` and `readRecord` are one family,
  // `toJSON` and `fromJSON` are the empty family.
  const folded = rest.replace(/^Json$/i, 'json');
  return folded.charAt(0).toLowerCase() + folded.slice(1);
}

/**
 * The arguments the probe hands a writer, one per declared parameter: values for the parameters
 * without a default, `undefined` for the ones with a default so the writer's own default applies,
 * which is the whole point of the exercise. `null` when a value's domain is not grounded.
 *
 * @param {Array<object>} args
 * @returns {Array<unknown>|null}
 */
export function probeArguments(args) {
  // Slots, not values: a defaulted slot is `absent` and becomes `undefined` in the child, because
  // `null` would override the writer's default and JSON drops a bare `undefined` from an array.
  const slots = [];
  for (const arg of args) {
    if (arg.kind === 'scalar') {
      if (arg.hasDefault) {
        slots.push({ absent: true });
        continue;
      }
      const value = valueFor(arg.name);
      if (value === undefined) return null;
      slots.push({ value });
      continue;
    }
    const record = {};
    for (const field of arg.fields) {
      if (field.hasDefault) continue;
      const value = valueFor(field.name);
      if (value === undefined) return null;
      record[field.name] = value;
    }
    slots.push({ value: record });
  }
  // Trailing defaulted slots can be dropped entirely: `arguments.length` stays shorter and the writer's
  // defaults still apply.
  while (slots.length > 0 && slots[slots.length - 1].absent === true) slots.pop();
  return slots;
}

export { READER, WRITER };
