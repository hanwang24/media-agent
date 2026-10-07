/**
 * A self-contained equivalent of the first-party `defineTool` helper.
 *
 * The first-party helper lives in `@deepseek-ai/dsh-tools`, which a bundle
 * installed into a profile cannot import: the package ships with the dsh
 * installation, and only the bundle's own entry name resolves from there, so an
 * import of another dsh package fails with `ERR_MODULE_NOT_FOUND`. This module
 * reproduces the two things the tool registry actually requires from that
 * helper — the authoring spec compiled into the enforced JSON Schema subset,
 * and argument validation before execution — without any cross-package import.
 *
 * The compiled shape matches what the first-party compiler produces, because
 * the registry asserts the result against the same subset.
 */

/** Types the enforced subset accepts. Type arrays are not supported. */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Keywords copied through untouched as documentation, never as constraints. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/** Container keywords that are only meaningful on one container type. */
const CONTAINER_KEYS = ['properties', 'items', 'additionalProperties'];

/**
 * Compile one author node.
 * @param spec - the author-facing schema node.
 * @param path - diagnostic path for author errors.
 * @returns the compiled schema plus whether the node was marked required.
 */
function compileNode(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} must be a schema object`);
  }
  const required = spec.required === true;
  const out = {};
  for (const key of ANNOTATION_KEYS) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }

  if (spec.oneOf !== undefined) {
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length === 0) {
      throw new Error(`${path}.oneOf must be a non-empty array`);
    }
    out.oneOf = spec.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`).schema);
    return { schema: out, required };
  }

  const type = spec.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    throw new Error(`${path}.type must be one of ${[...SCHEMA_TYPES].join('/')}`);
  }
  out.type = type;

  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
      throw new Error(`${path}.enum must be a non-empty array`);
    }
    out.enum = [...spec.enum];
  }
  if (spec.const !== undefined) out.const = spec.const;

  if (type === 'object') {
    const properties = spec.properties;
    if (properties !== undefined) {
      if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
        throw new Error(`${path}.properties must be an object`);
      }
      const compiledProperties = {};
      const requiredNames = [];
      for (const [name, child] of Object.entries(properties)) {
        const compiled = compileNode(child, `${path}.properties.${name}`);
        compiledProperties[name] = compiled.schema;
        if (compiled.required) requiredNames.push(name);
      }
      out.properties = compiledProperties;
      if (requiredNames.length > 0) out.required = requiredNames;
    }
    if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties;
    return { schema: out, required };
  }

  if (type === 'array') {
    if (spec.items === undefined) throw new Error(`${path}.items is required for an array`);
    out.items = compileNode(spec.items, `${path}.items`).schema;
    return { schema: out, required };
  }

  for (const key of CONTAINER_KEYS) {
    if (spec[key] !== undefined) throw new Error(`${path}.${key} is not supported on type "${type}"`);
  }
  return { schema: out, required };
}

/**
 * Compile the implicit open parameter object into raw JSON Schema.
 * The root stays open, matching the first-party compiler.
 * @param spec - per-property parameter definitions.
 * @returns an object-rooted JSON Schema.
 */
export function parametersToJsonSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('parameters must be an object of property definitions');
  }
  const properties = {};
  const requiredNames = [];
  for (const [name, child] of Object.entries(spec)) {
    const compiled = compileNode(child, `parameters.${name}`);
    properties[name] = compiled.schema;
    if (compiled.required) requiredNames.push(name);
  }
  return requiredNames.length > 0
    ? { type: 'object', properties, required: requiredNames }
    : { type: 'object', properties };
}

/**
 * Compile a value schema, used for a tool's declared output.
 * @param spec - the author-facing schema node.
 * @returns the compiled schema.
 */
export function valueToJsonSchema(spec) {
  return compileNode(spec, 'schema').schema;
}

/**
 * Describe one value's type for an error message.
 * @param value - the offending value.
 * @returns a short type name.
 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Check a value against one compiled node, collecting human-readable
 * violations instead of stopping at the first problem.
 * @param schema - the compiled node.
 * @param value - the candidate value.
 * @param path - diagnostic path.
 * @param violations - accumulator.
 */
function checkValue(schema, value, path, violations) {
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter((branch) => {
      const local = [];
      checkValue(branch, value, path, local);
      return local.length === 0;
    });
    if (matching.length !== 1) {
      violations.push(`${path} must match exactly one of the allowed shapes`);
    }
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path} must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
    return;
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path} must be an object, got ${describe(value)}`);
        return;
      }
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(value, name)) violations.push(`${path}.${name} is required`);
      }
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, name) && value[name] !== undefined) {
          checkValue(child, value[name], `${path}.${name}`, violations);
        }
      }
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties ?? {}, name)) {
            violations.push(`${path}.${name} is not an accepted property`);
          }
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array, got ${describe(value)}`);
        return;
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => checkValue(schema.items, entry, `${path}[${index}]`, violations));
      }
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        violations.push(`${path} must be an integer, got ${describe(value)}`);
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        violations.push(`${path} must be a number, got ${describe(value)}`);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') violations.push(`${path} must be a string, got ${describe(value)}`);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean, got ${describe(value)}`);
      return;
    }
    case 'null': {
      if (value !== null) violations.push(`${path} must be null`);
      return;
    }
    default:
  }
}

/**
 * Reduce an execute result to a lossless JSON value.
 *
 * The tool registry rejects a result that is not lossless JSON — an `undefined`
 * property value, a `NaN`/`Infinity` number, or a non-string key. Optional
 * fields are often absent rather than `null`, so this drops `undefined` values
 * and non-finite numbers instead of substituting a type that would violate the
 * declared output schema.
 * @param value - the raw execute result.
 * @returns the same value with undefined/non-finite members removed.
 */
export function toLosslessJson(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const cleaned = toLosslessJson(item);
      if (cleaned !== undefined) out.push(cleaned);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const cleaned = toLosslessJson(value[key]);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

/**
 * Build a registry-ready tool definition.
 *
 * The authoring spec is compiled once here rather than on every call, and the
 * returned `execute` validates the model's arguments first so a mistyped or
 * out-of-range argument becomes a clear violation list instead of a downstream
 * ffmpeg failure. The result is reduced to lossless JSON so optional fields
 * that were left `undefined` never trip the registry's output check.
 * @param options - the tool schema, execution, and optional callbacks.
 * @returns the definition the tool registry accepts.
 */
export function defineTool(options) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }
  const parameters = parametersToJsonSchema(options.parameters);
  const outputSchema = valueToJsonSchema(options.output.schema);
  const userExecute = options.execute;

  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
    },
    async execute(args, exec) {
      const violations = [];
      checkValue(parameters, args, '', violations);
      if (violations.length > 0) {
        const detail = violations.map((entry) => entry.replace(/^\./u, '')).join('; ');
        throw new Error(`invalid arguments: ${detail}`);
      }
      return toLosslessJson(await userExecute(args, exec)) ?? null;
    },
  };
  if (options.output.presentationMeta !== undefined) {
    definition.output.presentationMeta = options.output.presentationMeta;
  }
  for (const key of ['projectContent', 'finalizeContent', 'isConcurrencySafe', 'presentCall', 'presentResult']) {
    if (options[key] !== undefined) definition[key] = options[key];
  }
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs;
  return definition;
}
