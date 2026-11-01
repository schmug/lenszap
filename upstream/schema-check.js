// SPDX-License-Identifier: Apache-2.0
//
// A dependency-free checker for the subset of JSON Schema that the LensPub
// schemas actually use.
//
// Why this exists: spec/lens-manifest.md Section 2 requires a conforming
// consumer to REJECT documents that fail schema validation, and
// security/privacy-model.md Section 2.1 leans on exactly that — the
// `additionalProperties: false` constraints are what make a manifest carrying
// reading history mechanically detectable rather than merely prohibited. A
// consumer that only checks a few required members accepts such a document,
// which the conformance suite reports as a failure.
//
// Why not Ajv: the extension has no build step and no runtime dependencies
// (architecture/reference-implementation.md Section 1). Ajv stays a
// devDependency of the repository's Node entry points.
//
// Why not a hand-written mirror of the schema's rules: it would drift. This
// module interprets the normative schema document itself, bundled verbatim as
// ./lens-manifest.schema.js, so there is one source of truth. The test suite
// asserts the bundled copy is structurally identical to schemas/, and that this
// checker understands every keyword the schema uses — teaching it a new keyword
// is a test failure, never a silent pass.
//
// Pure and DOM-free, like the rest of engine/.

/** JSON Schema keywords this checker enforces. */
const ENFORCED = new Set([
  '$ref', 'type', 'required', 'properties', 'additionalProperties',
  'items', 'const', 'enum', 'pattern', 'maxLength', 'minLength',
  'minimum', 'maximum', 'minItems', 'maxItems'
]);

/** Keywords that carry no constraint here: metadata, annotation, or plumbing. */
const IGNORED = new Set([
  '$schema', '$id', '$defs', 'title', 'description', 'default',
  // `format` is an annotation by default in JSON Schema 2020-12. Ajv only
  // asserts it because ajv-formats is loaded; a consumer that does not is
  // still conforming, so this checker deliberately does not enforce it.
  'format'
]);

/**
 * Every keyword the schema uses that this checker neither enforces nor
 * deliberately ignores. The test suite requires this to be empty: a schema that
 * grows a constraint the consumer cannot see is a consumer that has quietly
 * stopped rejecting what the specification says it must.
 *
 * @param {object} schema
 * @returns {string[]} sorted, deduplicated keyword names
 */
export function unhandledKeywords(schema) {
  const found = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (!ENFORCED.has(key) && !IGNORED.has(key)) found.add(key);
      if (key === 'properties' || key === '$defs') Object.values(value).forEach(walk);
      else if (key !== 'enum' && key !== 'required') walk(value);
    }
  })(schema);
  return [...found].sort();
}

function resolve(node, root) {
  let seen = 0;
  while (node && node.$ref) {
    if (++seen > 32) throw new Error('cyclic $ref in schema');
    const path = node.$ref.replace(/^#\/?/, '').split('/').filter(Boolean);
    node = path.reduce((acc, key) => (acc ? acc[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
  }
  return node;
}

/** RFC 6901 pointer, rendered for a person rather than a parser. */
const where = (pointer) => (pointer === '' ? 'the manifest' : pointer);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check `value` against `schema`, collecting every violation.
 *
 * @param {unknown} value - the parsed document.
 * @param {object} schema - a JSON Schema using the supported subset.
 * @returns {string[]} human-readable errors; empty means the document conforms.
 */
export function checkAgainstSchema(value, schema) {
  const errors = [];
  check(value, schema, '', schema, errors);
  return errors;
}

function check(value, node, pointer, root, errors) {
  node = resolve(node, root);
  if (!node || typeof node !== 'object') return;

  if ('const' in node && value !== node.const) {
    errors.push(`${where(pointer)} must be ${JSON.stringify(node.const)}.`);
    return;
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${where(pointer)} must be one of: ${node.enum.join(', ')}.`);
    return;
  }

  switch (node.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${where(pointer)} must be an object.`);
        return;
      }
      const properties = node.properties || {};
      for (const key of node.required || []) {
        if (key in value) continue;
        // Name the expected value where the schema fixes it: "missing 'type'"
        // is a worse rejection message than "missing 'type' (must be
        // \"LensManifest\")", and the popup shows these to a person.
        const sub = properties[key] ? resolve(properties[key], root) : null;
        const expected = sub && 'const' in sub
          ? ` (must be ${JSON.stringify(sub.const)})`
          : sub && sub.enum
            ? ` (one of: ${sub.enum.join(', ')})`
            : '';
        errors.push(`${where(pointer)} is missing the required field '${key}'${expected}.`);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push(
              `${where(pointer)} has a field '${key}' the Lens Manifest schema does not define. ` +
              `Undeclared fields are refused rather than ignored: they are where reading history would hide.`
            );
          }
        }
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (key in value) check(value[key], sub, `${pointer}/${key}`, root, errors);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${where(pointer)} must be an array.`);
        return;
      }
      if (typeof node.minItems === 'number' && value.length < node.minItems) {
        errors.push(`${where(pointer)} must have at least ${node.minItems} item(s).`);
      }
      if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
        errors.push(`${where(pointer)} must have at most ${node.maxItems} item(s).`);
      }
      if (node.items) value.forEach((item, i) => check(item, node.items, `${pointer}/${i}`, root, errors));
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${where(pointer)} must be a string.`);
        return;
      }
      if (node.pattern && !new RegExp(node.pattern).test(value)) {
        errors.push(`${where(pointer)} must match ${node.pattern}.`);
      }
      if (typeof node.minLength === 'number' && value.length < node.minLength) {
        errors.push(`${where(pointer)} must be at least ${node.minLength} character(s).`);
      }
      if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
        errors.push(`${where(pointer)} must be at most ${node.maxLength} character(s).`);
      }
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${where(pointer)} must be a number.`);
        return;
      }
      if (node.type === 'integer' && !Number.isInteger(value)) {
        errors.push(`${where(pointer)} must be a whole number.`);
      }
      if (typeof node.minimum === 'number' && value < node.minimum) {
        errors.push(`${where(pointer)} must be at least ${node.minimum}.`);
      }
      if (typeof node.maximum === 'number' && value > node.maximum) {
        errors.push(`${where(pointer)} must be at most ${node.maximum}.`);
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${where(pointer)} must be true or false.`);
      return;
    default:
      // No `type`: only const/enum applied, both handled above.
  }
}
