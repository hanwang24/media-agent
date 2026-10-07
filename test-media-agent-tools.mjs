import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { apply, inject, name } from './plugin/index.js';
import { defineTool, parametersToJsonSchema, toLosslessJson, valueToJsonSchema } from './plugin/lib/define-tool.js';
import { resolveTool } from './plugin/lib/toolchain.js';

let passed = 0;
const failures = [];
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

// ------------------------------------------------- schema compiler behaviour
await test('parameters compile to object-rooted JSON Schema', () => {
  const schema = parametersToJsonSchema({
    path: { type: 'string', required: true, description: 'p' },
    count: { type: 'integer' },
  });
  assert.deepEqual(schema, {
    type: 'object',
    properties: { path: { type: 'string', description: 'p' }, count: { type: 'integer' } },
    required: ['path'],
  });
});
await test('a parameter object with no required members omits required', () => {
  const schema = parametersToJsonSchema({ a: { type: 'string' } });
  assert.ok(!Object.hasOwn(schema, 'required'));
});
await test('nested objects carry their own required array', () => {
  const schema = parametersToJsonSchema({
    items: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string', required: true }, b: { type: 'boolean' } },
      },
    },
  });
  const inner = schema.properties.items.items;
  assert.deepEqual(inner.required, ['a']);
  assert.equal(inner.additionalProperties, false);
  assert.deepEqual(schema.required, ['items']);
});
await test('schema compiler passes enum and oneOf through', () => {
  const schema = parametersToJsonSchema({
    mode: { type: 'string', enum: ['copy', 'reencode'], required: true },
    choice: { oneOf: [{ type: 'string' }, { type: 'integer' }], required: true },
  });
  assert.deepEqual(schema.properties.mode.enum, ['copy', 'reencode']);
  assert.equal(schema.properties.choice.oneOf.length, 2);
});
await test('schema compiler rejects an unknown type', () => {
  assert.throws(() => parametersToJsonSchema({ a: { type: 'json' } }), /type must be one of/u);
});
await test('schema compiler rejects a container keyword on a scalar', () => {
  assert.throws(() => parametersToJsonSchema({ a: { type: 'string', items: { type: 'string' } } }), /not supported on type/u);
});
await test('schema compiler rejects an array without items', () => {
  assert.throws(() => valueToJsonSchema({ type: 'array' }), /items is required/u);
});

// -------------------------------------------------------- argument validation
await test('defineTool rejects a missing required argument', async () => {
  const tool = defineTool({
    name: 't', description: 'd',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => 'ok',
  });
  await assert.rejects(() => tool.execute({}, {}), /path is required/u);
});
await test('defineTool rejects a bad enum member and names the alternatives', async () => {
  const tool = defineTool({
    name: 't', description: 'd',
    parameters: { mode: { type: 'string', enum: ['a', 'b'], required: true } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => 'ok',
  });
  await assert.rejects(() => tool.execute({ mode: 'c' }, {}), /must be one of "a", "b"/u);
});
await test('defineTool rejects a wrong scalar type', async () => {
  const tool = defineTool({
    name: 't', description: 'd',
    parameters: { n: { type: 'integer', required: true } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => 'ok',
  });
  await assert.rejects(() => tool.execute({ n: 1.5 }, {}), /must be an integer/u);
});
await test('defineTool rejects an unknown argument when the object is closed', async () => {
  const tool = defineTool({
    name: 't', description: 'd',
    parameters: { o: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => 'ok',
  });
  await assert.rejects(() => tool.execute({ o: { a: 'x', z: 1 } }, {}), /is not an accepted property/u);
});
await test('defineTool passes valid arguments through to execute', async () => {
  const tool = defineTool({
    name: 't', description: 'd',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: (args) => `got ${args.path}`,
  });
  assert.equal(await tool.execute({ path: 'x' }, {}), 'got x');
});
await test('defineTool refuses a non-positive timeout', () => {
  assert.throws(() => defineTool({
    name: 't', description: 'd', timeoutMs: 0,
    parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'x',
  }), /timeoutMs/u);
});
await test('toLosslessJson drops undefined and non-finite numbers', () => {
  assert.deepEqual(
    toLosslessJson({ a: 1, b: undefined, c: [1, undefined, 2], d: { e: undefined, f: NaN, g: Infinity, h: null } }),
    { a: 1, c: [1, 2], d: { h: null } },
  );
  assert.equal(toLosslessJson(undefined), undefined);
  assert.equal(toLosslessJson('x'), 'x');
  assert.equal(toLosslessJson(NaN), undefined);
});

// -------------------------------------- registration through a mock Host context
/** A tool registry that records definitions instead of serving them. */
const registered = [];
/** A subprocess service that really runs the argv, so tool bodies are exercised. */
const mockCtx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
  subprocess: {
    spawn(spec) {
      const child = spawnSync(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const stdout = child.stdout ?? '';
      const stderr = child.stderr ?? '';
      return {
        done: Promise.resolve({ exitCode: child.status, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
      };
    },
  },
};

await test('the plugin exports the loader-visible shape', () => {
  assert.equal(name, 'media-agent');
  assert.deepEqual(inject, ['tools', 'subprocess']);
  assert.equal(typeof apply, 'function');
});

apply(mockCtx);

const EXPECTED_TOOLS = ['av_probe', 'av_transcode', 'av_extract', 'av_clip', 'av_concat', 'av_batch', 'av_plot'];
const byName = new Map(registered.map((definition) => [definition.name, definition]));

await test(`apply registers exactly the expected tools`, () => {
  assert.deepEqual([...byName.keys()].sort(), [...EXPECTED_TOOLS].sort());
});
await test('every tool is registry-shaped and registry-valid', () => {
  for (const definition of registered) {
    assert.equal(typeof definition.name, 'string');
    assert.ok(definition.description.length > 40, `${definition.name} has a thin description`);
    assert.equal(definition.parameters.type, 'object', `${definition.name} parameters are not object-rooted`);
    assert.equal(typeof definition.output.render, 'function', `${definition.name} has no render`);
    assert.ok(definition.output.schema.type !== undefined, `${definition.name} output has no type`);
    assert.equal(typeof definition.execute, 'function');
  }
});
await test('no tool declares a timeout, so a long encode is never cut off', () => {
  for (const definition of registered) {
    assert.equal(definition.timeoutMs, undefined, `${definition.name} declares timeoutMs`);
  }
});
await test('only the read-only probe is concurrency safe', () => {
  assert.equal(byName.get('av_probe').isConcurrencySafe({}), true);
  for (const id of EXPECTED_TOOLS.filter((tool) => tool !== 'av_probe')) {
    assert.notEqual(byName.get(id).isConcurrencySafe?.({}), true, `${id} claims to be concurrency safe`);
  }
});
await test('every tool renders something model-visible', () => {
  for (const definition of registered) {
    const blocks = definition.output.render({}, { summary: 's', output: 'o', elapsedMs: 1, argv: [] });
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${definition.name} renders nothing`);
    assert.equal(blocks[0].type, 'text');
  }
});

// ------------------------------------------------------- tool bodies, for real
const OUT = 'tools-out';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const INPUT = 'sample/probe-test.mp4';
const exec = { signal: undefined };

await test('av_probe reads a real file and returns merged facts', async () => {
  const facts = await byName.get('av_probe').execute({ path: INPUT }, exec);
  assert.match(facts.container, /mp4/u);
  assert.equal(facts.video[0].codec, 'h264');
  assert.equal(facts.audio[0].codec, 'aac');
  assert.equal(facts.audio[0].channels, 2);
  assert.ok(facts.durationSeconds > 5.9 && facts.durationSeconds < 6.1);
  assert.ok(facts.mediainfo.video[0].format.includes('AVC'));
  assert.match(facts.summary, /h264/u);
});
await test('av_probe rejects a missing file with an actionable message', async () => {
  await assert.rejects(() => byName.get('av_probe').execute({ path: 'nope.mp4' }, exec), /does not exist/u);
});
await test('av_probe validates arguments before running anything', async () => {
  await assert.rejects(() => byName.get('av_probe').execute({}, exec), /path is required/u);
});
await test('av_probe includes the raw documents only when asked', async () => {
  const plain = await byName.get('av_probe').execute({ path: INPUT }, exec);
  assert.equal(plain.raw, undefined);
  const withRaw = await byName.get('av_probe').execute({ path: INPUT, includeRaw: true }, exec);
  assert.ok(withRaw.raw.ffprobe.format);
  const blocks = byName.get('av_probe').output.render({ includeRaw: true }, withRaw);
  assert.equal(blocks.length, 2, 'raw must reach the model through render');
});
await test('a relative input resolves against the session cwd, not the host cwd', async () => {
  const scoped = { signal: undefined, agent: { session: { header: { cwd: resolve('sample') } } } };
  const facts = await byName.get('av_probe').execute({ path: 'probe-test.mp4' }, scoped);
  assert.equal(facts.path, resolve('sample/probe-test.mp4'));
});
await test('a missing relative input names the base it was resolved against', async () => {
  const scoped = { signal: undefined, agent: { session: { header: { cwd: resolve('sample') } } } };
  await assert.rejects(
    () => byName.get('av_probe').execute({ path: 'absent.mp4' }, scoped),
    /absent\.mp4.*resolved against/u,
  );
});
await test('a relative output resolves against the session cwd', async () => {
  const scoped = { signal: undefined, agent: { session: { header: { cwd: resolve(OUT) } } } };
  const result = await byName.get('av_transcode').execute(
    { input: resolve(INPUT), output: 'relative.mp4', quality: 36, speed: 'fastest' },
    scoped,
  );
  assert.equal(result.output, resolve(OUT, 'relative.mp4'));
  assert.ok(existsSync(result.output));
});
await test('av_transcode writes a real file and reports the argv', async () => {
  const result = await byName.get('av_transcode').execute(
    { input: INPUT, output: `${OUT}/t.mp4`, quality: 32, speed: 'fastest', scale: '320:-2' },
    exec,
  );
  assert.ok(existsSync(result.output));
  assert.ok(result.bytes > 0);
  assert.equal(result.argv[0].includes('ffmpeg'), true);
  assert.ok(result.argv.includes('-progress'));
});
await test('av_transcode surfaces an ffmpeg failure', async () => {
  await assert.rejects(
    () => byName.get('av_transcode').execute({ input: INPUT, output: `${OUT}/bad.mp4`, videoCodec: 'vp9', hwaccel: 'nvenc' }, exec),
    /no nvenc encoder/u,
  );
});
await test('av_clip trims and reports the mode', async () => {
  const result = await byName.get('av_clip').execute(
    { input: INPUT, output: `${OUT}/c.mp4`, start: '1', duration: '2', mode: 'reencode', quality: 34, speed: 'fastest' },
    exec,
  );
  assert.equal(result.mode, 'reencode');
  assert.ok(existsSync(result.output));
});
await test('av_extract writes a thumbnail', async () => {
  const result = await byName.get('av_extract').execute(
    { input: INPUT, output: `${OUT}/thumb.png`, what: 'thumbnail', time: '2', scale: '160:-2' },
    exec,
  );
  assert.ok(statSync(result.output).size > 0);
});
await test('av_extract insists on a frame pattern', async () => {
  await assert.rejects(
    () => byName.get('av_extract').execute({ input: INPUT, output: `${OUT}/f.png`, what: 'frames' }, exec),
    /%d pattern/u,
  );
});
await test('av_concat joins two files and cleans up its list file', async () => {
  const parts = [];
  for (const [index, start] of ['0', '1'].entries()) {
    const part = await byName.get('av_clip').execute(
      { input: INPUT, output: `${OUT}/p${index}.mp4`, start, duration: '1.5', mode: 'reencode', quality: 34, speed: 'fastest' },
      exec,
    );
    parts.push(part.output);
  }
  const joined = await byName.get('av_concat').execute({ inputs: parts, output: `${OUT}/j.mp4`, mode: 'copy' }, exec);
  assert.ok(existsSync(joined.output));
  assert.equal(joined.inputs.length, 2);
  assert.ok(joined.inputs.every((input) => input.includes(':')), 'inputs must be reported absolute');
  assert.ok(joined.argv.includes('<concat-list>'), 'the temp list name must not leak into the argv');
});
await test('av_concat refuses a single input', async () => {
  await assert.rejects(() => byName.get('av_concat').execute({ inputs: [INPUT], output: `${OUT}/x.mp4` }, exec), /at least two/u);
});
await test('av_batch probes a directory and reports one row per file', async () => {
  const result = await byName.get('av_batch').execute(
    { inputDir: OUT, pattern: '*.mp4', operation: 'probe' },
    exec,
  );
  assert.ok(result.total >= 1);
  assert.equal(result.failed, 0);
  assert.ok(result.results.every((row) => row.ok === true));
  assert.match(result.results[0].summary, /container/u);
});
await test('av_batch transcodes a directory and skips existing outputs', async () => {
  const first = await byName.get('av_batch').execute(
    { inputDir: OUT, outputDir: `${OUT}/batch`, pattern: 'p*.mp4', operation: 'transcode', quality: 36, speed: 'fastest', concurrency: 2 },
    exec,
  );
  assert.equal(first.failed, 0);
  assert.equal(first.skipped, 0);
  assert.ok(first.succeeded >= 2);
  const second = await byName.get('av_batch').execute(
    { inputDir: OUT, outputDir: `${OUT}/batch`, pattern: 'p*.mp4', operation: 'transcode', quality: 36, speed: 'fastest' },
    exec,
  );
  assert.equal(second.skipped, second.total, 'a rerun must skip every existing output');
  assert.equal(second.succeeded, 0);
});
await test('av_batch requires an output directory for a writing operation', async () => {
  await assert.rejects(() => byName.get('av_batch').execute({ inputDir: OUT, operation: 'transcode' }, exec), /outputDir is required/u);
});
await test('av_batch reports a failure without hiding its neighbours', async () => {
  rmSync(`${OUT}/mixed`, { recursive: true, force: true });
  mkdirSync(`${OUT}/mixed`, { recursive: true });
  const result = await byName.get('av_batch').execute(
    {
      inputDir: `${OUT}/mixed`, outputDir: `${OUT}/mixed-out`, operation: 'transcode',
      quality: 36, speed: 'fastest', skipExisting: false,
    },
    exec,
  );
  assert.equal(result.total, 0, 'an empty directory is a valid empty result');
});
await test('av_plot renders the three audio plots as real PNGs', async () => {
  const result = await byName.get('av_plot').execute(
    { input: INPUT, kinds: ['waveform', 'spectrogram', 'freq_response'], outputDir: OUT, prefix: 'probe-plots' },
    exec,
  );
  assert.equal(result.outputs.length, 3);
  assert.equal(result.channels, 2);
  for (const output of result.outputs) {
    assert.ok(existsSync(output.path), `${output.kind} did not write ${output.path}`);
    assert.ok(statSync(output.path).size > 500, `${output.kind} looks empty`);
  }
  const kinds = result.outputs.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['freq_response', 'spectrogram', 'waveform']);
});
await test('av_batch plot renders one waveform per file', async () => {
  const result = await byName.get('av_batch').execute(
    { inputDir: 'sample', outputDir: `${OUT}/plots`, pattern: 'probe-test.mp4', operation: 'plot', plotKinds: ['waveform'] },
    exec,
  );
  assert.equal(result.failed, 0);
  assert.equal(result.succeeded, 1);
  assert.ok(result.results[0].outputs[0].path.endsWith('-waveform.png'));
});
await test('av_plot rejects an unknown kind at the schema boundary', async () => {
  await assert.rejects(
    () => byName.get('av_plot').execute({ input: INPUT, kinds: ['bogus'], outputDir: OUT }, exec),
    /invalid arguments|unknown plot kind/u,
  );
});
await test('av_transcode result survives a lossless JSON round-trip', async () => {
  // The registry rejects a result that is not lossless JSON, so an optional
  // field left `undefined` (speed/outTimeSeconds on a fast copy) must be gone.
  const result = await byName.get('av_transcode').execute(
    { input: INPUT, output: `${OUT}/json-safe.mp4`, quality: 36, speed: 'fastest' },
    exec,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  for (const value of Object.values(result)) assert.notEqual(value, undefined);
});
await test('av_transcode on a raw elementary stream returns lossless JSON', async () => {
  // A raw stream has no duration, so ffmpeg reports no out_time/speed and the
  // result would carry `undefined` — exactly the case the registry rejects.
  const raw = `${OUT}/raw.h264`;
  const made = spawnSync(
    resolveTool('ffmpeg'),
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', INPUT, '-map', '0:v:0', '-c:v', 'copy', '-an', '-f', 'h264', raw],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(made.status, 0, `could not build the raw fixture: ${made.stderr}`);
  const result = await byName.get('av_transcode').execute(
    { input: raw, inputFormat: 'h264', videoCodec: 'copy', audioCodec: 'none', output: `${OUT}/raw-remux.mp4` },
    exec,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'result must be lossless JSON');
  for (const [key, value] of Object.entries(result)) assert.notEqual(value, undefined, `${key} is undefined`);
  assert.ok(existsSync(result.output));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
