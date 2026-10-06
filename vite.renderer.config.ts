import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig(async () => {
  const react = await import('@vitejs/plugin-react');
  return {
    plugins: [react.default()],
  };
});
