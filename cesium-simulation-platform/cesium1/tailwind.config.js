/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'rgb(var(--primary-rgb) / <alpha-value>)',
          dark: 'rgb(var(--primary-dark-rgb) / <alpha-value>)',
          light: 'rgb(var(--primary-light-rgb) / <alpha-value>)'
        },
        secondary: 'rgb(var(--secondary-rgb) / <alpha-value>)',
        success: 'rgb(var(--success-rgb) / <alpha-value>)',
        warning: 'rgb(var(--warning-rgb) / <alpha-value>)',
        info: 'rgb(var(--info-rgb) / <alpha-value>)',
        bg: {
          primary: 'var(--bg-primary)',
          secondary: 'var(--bg-secondary)',
          tertiary: 'var(--bg-tertiary)',
          hover: 'var(--bg-hover)'
        },
        text: {
          primary: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
          muted: 'rgb(var(--text-muted-rgb) / <alpha-value>)',
          disabled: 'rgb(var(--text-disabled-rgb) / <alpha-value>)'
        },
        border: {
          primary: 'var(--border-primary)',
          secondary: 'var(--border-secondary)'
        }
      },
      spacing: {
        xs: '2px',
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '18px',
        '2xl': '22px',
        '3xl': '28px'
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px'
      },
      boxShadow: {
        'tech-sm': '0 2px 4px rgba(0, 0, 0, 0.4)',
        'tech-md': '0 4px 8px rgba(0, 0, 0, 0.5)',
        'tech-lg': '0 8px 16px rgba(0, 0, 0, 0.6)',
        glow: '0 0 8px var(--primary-color)'
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Oxygen',
          'Ubuntu',
          'Cantarell',
          'Open Sans',
          'Helvetica Neue',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'monospace']
      },
      fontSize: {
        xs: '12px',
        sm: '13px',
        base: '14px',
        lg: '16px',
        xl: '18px'
      },
      width: {
        panel: '380px'
      }
    }
  },
  plugins: []
}
