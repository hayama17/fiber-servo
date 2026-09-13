import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scope discovery to this package's own suite. Background agents keep git
    // worktrees under .claude/, each with a full copy of test/, and the default
    // glob would collect all of them: the run then reports several times the
    // real test count and fails or passes on code that is not in this tree.
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
