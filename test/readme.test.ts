import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('README', () => {
  it('documents the V0.2 workflow, launch behavior, and safety boundaries', async () => {
    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('ccps launch <profile> --dry-run');
    expect(readme).toContain('ccps copy <from> <to>');
    expect(readme).toContain('ccps rename <old> <new>');
    expect(readme).toContain('ccps remove <name>');
    expect(readme).toContain('ccps default [name]');
    expect(readme).toContain('ccps tui');
    expect(readme).toContain('ccps launch --dry-run');
    expect(readme).toContain('没有传入 profile 时，`ccps launch` 会使用已设置的默认 profile');
    expect(readme).toContain('精确输入 profile 名称');
    expect(readme).toContain('删除前会先创建备份');
    expect(readme).toContain('允许删除当前 default profile');
    expect(readme).toContain('允许删除最后一个 profile');
    expect(readme).toContain('没有任何 profile 时');
    expect(readme).toContain('轻量交互入口');
    expect(readme).toContain('不是 GUI');
    expect(readme).toContain('不是单独的产品模式');
    expect(readme).toContain('CLAUDE_CONFIG_DIR');
    expect(readme).toContain('当前工作目录');
    expect(readme).toContain('api-settings.json');
    expect(readme).toContain('claude-home\\settings.json');
    expect(readme).toContain('autoMemoryDirectory');
    expect(readme).toContain('claude-home\\memory\\auto');
    expect(readme).toContain('claude-home\\plugins');
    expect(readme).toContain('profile 优先');
    expect(readme).toContain('OAuth');
    expect(readme).toContain('session');
    expect(readme).toContain('token');
    expect(readme).toContain('npm run check');
  });
});
