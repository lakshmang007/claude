import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.lakshmang007.expensetracker',
  appName: 'Expense Tracker',
  webDir: 'dist',
  plugins: {
    // The page uses viewport-fit=cover and pads itself with the safe-area insets.
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
  },
};

export default config;
