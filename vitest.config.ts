import { configDefaults, defineConfig } from 'vitest/config';

// garmin-ingester/ is its own package and runs its tests with `node --test`; collecting them here
// reports "No test suite found" for every file.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'garmin-ingester/**'],
  },
});
