import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Installs the OpenCode V2 plugin bundled with the CLI into the global OpenCode
// plugin directory. The plugin is shipped as plain source: OpenCode provides
// `@opencode/plugin` at runtime, so the installer only copies the asset.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR_NAME = 'brick';
const PLUGIN_FILE_NAME = 'index.js';

/** First line of every file the installer owns. */
export const PLUGIN_MARKER = '// >>> brick opencode managed plugin (do not edit) >>>';

/** Path of the plugin source bundled in the CLI (`assets/opencode-plugin`). */
export function pluginAssetPath(): string {
  return join(__dirname, '..', '..', '..', 'assets', 'opencode-plugin', PLUGIN_FILE_NAME);
}

export function readPluginSource(): string {
  return readFileSync(pluginAssetPath(), 'utf8');
}

/** Global OpenCode config directory (`~/.config/opencode`). */
export function opencodeConfigDir(): string {
  return join(homedir(), '.config', 'opencode');
}

export function opencodePluginDir(): string {
  return join(opencodeConfigDir(), 'plugins', PLUGIN_DIR_NAME);
}

export function opencodePluginPath(): string {
  return join(opencodePluginDir(), PLUGIN_FILE_NAME);
}

/** Whether a file's contents are a plugin file this installer wrote. */
export function isManagedPlugin(text: string): boolean {
  return text.startsWith(PLUGIN_MARKER);
}

export interface PluginInstallResult {
  path: string;
  /** true when the plugin file did not exist before this call. */
  created: boolean;
  /** true when the plugin file was (re)written by this call. */
  changed: boolean;
}

/**
 * Write the bundled plugin to `~/.config/opencode/plugins/brick/index.js`.
 * Idempotent: an already-managed file with identical contents is left
 * untouched. A foreign `index.js` is never overwritten.
 */
export function installOpencodePlugin(): PluginInstallResult {
  const path = opencodePluginPath();
  const source = readPluginSource();
  mkdirSync(opencodePluginDir(), { recursive: true, mode: 0o700 });

  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (!isManagedPlugin(current)) {
      throw new Error(
        `refusing to overwrite unmanaged OpenCode plugin at ${path}; ` +
          'move it out of the way before running `brick connect opencode`.'
      );
    }
    if (current === source) return { path, created: false, changed: false };
    writeFileSync(path, source, { mode: 0o600 });
    return { path, created: false, changed: true };
  }

  writeFileSync(path, source, { mode: 0o600 });
  return { path, created: true, changed: true };
}

/**
 * Remove only the plugin file this installer wrote, then the now-empty `brick`
 * directory. A foreign `index.js` is left in place.
 */
export function uninstallOpencodePlugin(): { removed: boolean } {
  const path = opencodePluginPath();
  if (!existsSync(path)) return { removed: false };

  const current = readFileSync(path, 'utf8');
  if (!isManagedPlugin(current)) return { removed: false };

  rmSync(path);
  try {
    rmdirSync(opencodePluginDir());
  } catch {
    // Directory not empty (another plugin) — leave it.
  }
  return { removed: true };
}

/** Whether the managed plugin is currently installed. */
export function isOpencodePluginInstalled(): boolean {
  const path = opencodePluginPath();
  if (!existsSync(path)) return false;
  return isManagedPlugin(readFileSync(path, 'utf8'));
}
