/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // 统一字号：正文 13px（与左下角按钮一致）、次要 12px、标题 15px
      fontSize: {
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '18px' }],
        lg: ['15px', { lineHeight: '20px' }],
        xl: ['15px', { lineHeight: '20px' }],
        '2xl': ['16px', { lineHeight: '22px' }],
        '3xl': ['18px', { lineHeight: '24px' }],
      },
    },
  },
  plugins: [],
};
