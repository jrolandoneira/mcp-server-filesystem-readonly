import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  setAllowedDirectories,
  validatePath,
  validateWritePath,
} from '../lib.js';

const SERVER_PATH = path.join(__dirname, '..', 'dist', 'index.js');
const isWindows = process.platform === 'win32';

interface SpawnResult {
  exitCode: number | null;
  stderr: string;
}

// Spawns the compiled server with given CLI args and captures stderr until
// either the process exits or the timeout elapses.
async function spawnServer(args: string[], timeoutMs = 2500): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn('node', [SERVER_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}

// Extracts the text payload of the first content block.
function firstText(result: { content: unknown }): string {
  const blocks = result.content as Array<{ type: string; text: string }>;
  return blocks[0]?.text ?? '';
}

describe('Readonly mode for allowed directories', () => {
  let testDir: string;
  let rwDir: string;
  let roDir: string;

  beforeEach(async () => {
    // Canonicalize the temp directory so it matches what the server stores
    // after resolving symlinks (e.g. /tmp -> /private/tmp on macOS).
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-readonly-test-'));
    testDir = await fs.realpath(raw);
    rwDir = path.join(testDir, 'writable');
    roDir = path.join(testDir, 'readonly');
    await fs.mkdir(rwDir);
    await fs.mkdir(roDir);
    await fs.writeFile(path.join(rwDir, 'seed.txt'), 'rw seed');
    await fs.writeFile(path.join(roDir, 'seed.txt'), 'ro seed');
  });

  afterEach(async () => {
    setAllowedDirectories([]);
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // CLI parser — basic cases (no suffix, :ro, :rw). Verified by connecting
  // a real MCP client and inspecting list_allowed_directories. The per-
  // directory startup log fires only inside oninitialized (after the
  // client completes MCP initialization), so a bare spawn cannot observe
  // the parsed modes — going through the client tests the parser, the
  // global state propagation, and the tool wiring in one shot.
  // ------------------------------------------------------------------
  describe('CLI parser', () => {
    async function callListAllowedDirectories(spawnArgs: string[]) {
      const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH, ...spawnArgs],
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'list_allowed_directories',
          arguments: {},
        });
        return {
          text: firstText(result),
          structured: result.structuredContent as {
            content: string;
            directories: Array<{ path: string; mode: 'rw' | 'ro' }>;
          },
        };
      } finally {
        await client.close();
      }
    }

    it('directory without suffix → mode rw (default)', async () => {
      const { structured } = await callListAllowedDirectories([rwDir]);
      const modes = structured.directories.map((d) => d.mode);
      expect(modes).toEqual(['rw']);
    });

    it('directory with :ro suffix → mode ro', async () => {
      const { structured } = await callListAllowedDirectories([`${rwDir}:ro`]);
      const modes = structured.directories.map((d) => d.mode);
      expect(modes).toEqual(['ro']);
    });

    it('directory with explicit :rw suffix → mode rw', async () => {
      const { structured } = await callListAllowedDirectories([`${rwDir}:rw`]);
      const modes = structured.directories.map((d) => d.mode);
      expect(modes).toEqual(['rw']);
    });

    it('list_allowed_directories header includes the (N) counter (S3)', async () => {
      const { text } = await callListAllowedDirectories([rwDir, `${roDir}:ro`]);
      expect(text).toMatch(/Allowed directories \(2\):/);
    });
  });

  // ------------------------------------------------------------------
  // Suffix escape (A4) — ":ro" or ":rw" literal in directory name.
  // Windows disallows ':' in path segments, so this is Unix-only.
  // We verify through the MCP client (same reason as above).
  // ------------------------------------------------------------------
  (isWindows ? describe.skip : describe)('Suffix escape (A4)', () => {
    async function callListAllowedDirectories(spawnArgs: string[]) {
      const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH, ...spawnArgs],
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'list_allowed_directories',
          arguments: {},
        });
        return result.structuredContent as {
          directories: Array<{ path: string; mode: 'rw' | 'ro' }>;
        };
      } finally {
        await client.close();
      }
    }

    it('"dir:ro:rw" → strips :rw, path real is "dir:ro" in mode rw', async () => {
      const weirdDir = path.join(testDir, 'weird:ro');
      await fs.mkdir(weirdDir);
      const sc = await callListAllowedDirectories([`${weirdDir}:rw`]);
      const entry = sc.directories.find((d) => d.path.endsWith('weird:ro'));
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe('rw');
    });

    it('"dir:rw:ro" → strips :ro, path real is "dir:rw" in mode ro', async () => {
      const weirdDir = path.join(testDir, 'weird:rw');
      await fs.mkdir(weirdDir);
      const sc = await callListAllowedDirectories([`${weirdDir}:ro`]);
      const entry = sc.directories.find((d) => d.path.endsWith('weird:rw'));
      expect(entry).toBeDefined();
      expect(entry?.mode).toBe('ro');
    });
  });

  // ------------------------------------------------------------------
  // Duplicate roots (A3) — same path declared multiple times.
  // ------------------------------------------------------------------
  describe('Duplicate roots (A3)', () => {
    it('same path, same mode (no suffix twice) → silent dedupe, server starts', async () => {
      const result = await spawnServer([rwDir, rwDir]);
      expect(result.stderr).toContain('Secure MCP Filesystem Server running on stdio');
      expect(result.stderr).not.toMatch(/conflicting modes/);
    });

    it('same path with :rw and :ro → exit 1 with conflict message', async () => {
      const result = await spawnServer([`${rwDir}:rw`, `${rwDir}:ro`]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/conflicting modes \(ro, rw\)/);
    });

    it('same path without suffix (rw implicit) and with :ro → exit 1', async () => {
      const result = await spawnServer([rwDir, `${rwDir}:ro`]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/conflicting modes/);
    });
  });

  // ------------------------------------------------------------------
  // validateWritePath — direct unit tests.
  // ------------------------------------------------------------------
  describe('validateWritePath', () => {
    beforeEach(() => {
      setAllowedDirectories([
        { path: rwDir, mode: 'rw' },
        { path: roDir, mode: 'ro' },
      ]);
    });

    it('write target inside rw root → resolves to a path under rwDir', async () => {
      const target = path.join(rwDir, 'newfile.txt');
      const result = await validateWritePath(target);
      expect(path.dirname(result)).toBe(rwDir);
    });

    it('write target inside ro root → throws with readonly message including the root', async () => {
      const target = path.join(roDir, 'newfile.txt');
      await expect(validateWritePath(target)).rejects.toThrow(/readonly root directory/);
      await expect(validateWritePath(target)).rejects.toThrow(roDir);
    });

    it('existing file in ro root is still readable via validatePath (read path unchanged)', async () => {
      const target = path.join(roDir, 'seed.txt');
      const result = await validatePath(target);
      expect(result).toContain('seed.txt');
    });

    it('write target outside every root → throws "outside allowed directories" (validatePath)', async () => {
      const outsideRaw = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-readonly-outside-'));
      const outside = await fs.realpath(outsideRaw);
      try {
        const target = path.join(outside, 'newfile.txt');
        await expect(validateWritePath(target)).rejects.toThrow(/outside allowed directories/);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  // ------------------------------------------------------------------
  // Nested roots — A2 "most-specific match wins".
  // ------------------------------------------------------------------
  describe('Nested roots — A2 most-specific match wins', () => {
    let outer: string;
    let inner: string;

    beforeEach(async () => {
      const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-readonly-a2-'));
      outer = await fs.realpath(raw);
      inner = path.join(outer, 'sub');
      await fs.mkdir(inner);
      await fs.writeFile(path.join(inner, 'seed.txt'), 'nested seed');
    });

    afterEach(async () => {
      await fs.rm(outer, { recursive: true, force: true });
    });

    it('outer ro + inner rw → write inside inner is allowed (most-specific is rw)', async () => {
      setAllowedDirectories([
        { path: outer, mode: 'ro' },
        { path: inner, mode: 'rw' },
      ]);
      const target = path.join(inner, 'new.txt');
      await expect(validateWritePath(target)).resolves.toBeTruthy();
    });

    it('outer ro + inner rw → write outside inner stays blocked by outer ro', async () => {
      setAllowedDirectories([
        { path: outer, mode: 'ro' },
        { path: inner, mode: 'rw' },
      ]);
      const target = path.join(outer, 'sibling.txt');
      await expect(validateWritePath(target)).rejects.toThrow(/readonly root directory/);
    });

    it('outer rw + inner ro → write inside inner is blocked (most-specific is ro)', async () => {
      setAllowedDirectories([
        { path: outer, mode: 'rw' },
        { path: inner, mode: 'ro' },
      ]);
      const target = path.join(inner, 'new.txt');
      await expect(validateWritePath(target)).rejects.toThrow(/readonly root directory/);
    });

    it('outer rw + inner ro → write outside inner is allowed by outer rw', async () => {
      setAllowedDirectories([
        { path: outer, mode: 'rw' },
        { path: inner, mode: 'ro' },
      ]);
      const target = path.join(outer, 'sibling.txt');
      await expect(validateWritePath(target)).resolves.toBeTruthy();
    });
  });

  // ------------------------------------------------------------------
  // End-to-end MCP integration: write tools enforce mode; read tools do not.
  // ------------------------------------------------------------------
  describe('MCP write tools enforce mode (integration)', () => {
    let client: Client;
    let transport: StdioClientTransport;

    beforeEach(async () => {
      transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH, rwDir, `${roDir}:ro`],
      });
      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
    });

    afterEach(async () => {
      await client?.close();
    });

    it('write_file in rw root → succeeds', async () => {
      const result = await client.callTool({
        name: 'write_file',
        arguments: { path: path.join(rwDir, 'created.txt'), content: 'hello' },
      });
      expect(result.isError).toBeFalsy();
    });

    it('write_file in ro root → returns error with readonly message', async () => {
      const result = await client.callTool({
        name: 'write_file',
        arguments: { path: path.join(roDir, 'bad.txt'), content: 'hello' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/readonly root directory/);
    });

    it('edit_file in ro root → returns error', async () => {
      const result = await client.callTool({
        name: 'edit_file',
        arguments: {
          path: path.join(roDir, 'seed.txt'),
          edits: [{ oldText: 'ro seed', newText: 'modified' }],
        },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/readonly root directory/);
    });

    it('create_directory in ro root → returns error', async () => {
      const result = await client.callTool({
        name: 'create_directory',
        arguments: { path: path.join(roDir, 'newdir') },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/readonly root directory/);
    });

    it('move_file with source in ro root → returns error (by source)', async () => {
      const result = await client.callTool({
        name: 'move_file',
        arguments: {
          source: path.join(roDir, 'seed.txt'),
          destination: path.join(rwDir, 'moved.txt'),
        },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/readonly root directory/);
    });

    it('move_file with destination in ro root → returns error (by destination)', async () => {
      const result = await client.callTool({
        name: 'move_file',
        arguments: {
          source: path.join(rwDir, 'seed.txt'),
          destination: path.join(roDir, 'moved.txt'),
        },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/readonly root directory/);
    });

    it('move_file within rw root → succeeds', async () => {
      const result = await client.callTool({
        name: 'move_file',
        arguments: {
          source: path.join(rwDir, 'seed.txt'),
          destination: path.join(rwDir, 'renamed.txt'),
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it('read_text_file in ro root → succeeds (read paths are unaffected)', async () => {
      const result = await client.callTool({
        name: 'read_text_file',
        arguments: { path: path.join(roDir, 'seed.txt') },
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe('ro seed');
    });

    it('list_directory in ro root → succeeds (read paths are unaffected)', async () => {
      const result = await client.callTool({
        name: 'list_directory',
        arguments: { path: roDir },
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('seed.txt');
    });
  });

  // ------------------------------------------------------------------
  // list_allowed_directories — S1 (structuredContent) + S3 (counter) + mode markers.
  // ------------------------------------------------------------------
  describe('list_allowed_directories', () => {
    let client: Client;
    let transport: StdioClientTransport;

    beforeEach(async () => {
      transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH, rwDir, `${roDir}:ro`],
      });
      client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
    });

    afterEach(async () => {
      await client?.close();
    });

    it('text content reports each directory with its mode and a (N) counter', async () => {
      const result = await client.callTool({
        name: 'list_allowed_directories',
        arguments: {},
      });
      const text = firstText(result);
      expect(text).toContain('Allowed directories (2):');
      expect(text).toMatch(/\(rw\)/);
      expect(text).toMatch(/\(ro\)/);
    });

    it('S1 — structuredContent.directories contains typed {path, mode} entries', async () => {
      const result = await client.callTool({
        name: 'list_allowed_directories',
        arguments: {},
      });
      const sc = result.structuredContent as {
        content: string;
        directories: Array<{ path: string; mode: 'rw' | 'ro' }>;
      };
      expect(Array.isArray(sc.directories)).toBe(true);
      expect(sc.directories).toHaveLength(2);
      const modes = sc.directories.map((d) => d.mode).sort();
      expect(modes).toEqual(['ro', 'rw']);
      for (const entry of sc.directories) {
        expect(typeof entry.path).toBe('string');
        expect(['rw', 'ro']).toContain(entry.mode);
      }
    });
  });

  // ------------------------------------------------------------------
  // Roots dynamic compatibility — dynamic roots are always rw.
  //
  // This is documented in updateAllowedDirectoriesFromRoots in index.ts.
  // A direct integration test would require a client that sends roots, which
  // is non-trivial. We assert the behavior at the source-of-truth level by
  // documenting the invariant here and verifying it via the public list tool
  // when no roots are sent (the CLI args still drive the modes).
  // ------------------------------------------------------------------
  describe('Roots dynamic (compatibility)', () => {
    it('CLI-driven setup preserves the modes the user declared', async () => {
      // Sanity check that dynamic-roots handling does not silently overwrite
      // CLI-declared modes when the client has no roots capability.
      const transport = new StdioClientTransport({
        command: 'node',
        args: [SERVER_PATH, rwDir, `${roDir}:ro`],
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'list_allowed_directories',
          arguments: {},
        });
        const sc = result.structuredContent as {
          directories: Array<{ path: string; mode: 'rw' | 'ro' }>;
        };
        const roEntry = sc.directories.find((d) => d.mode === 'ro');
        expect(roEntry).toBeDefined();
        expect(roEntry?.path).toBe(roDir);
      } finally {
        await client.close();
      }
    });
  });
});
