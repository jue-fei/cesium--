const js = require('@eslint/js')
const pluginVue = require('eslint-plugin-vue')
const prettier = require('eslint-plugin-prettier/recommended')

module.exports = [
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'warn',
      'no-undef': 'off', // TypeScript handles this
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'onerror',
          message: '请使用 globalErrorCapture.js 统一注册全局错误捕获'
        },
        {
          object: 'window',
          property: 'onunhandledrejection',
          message: '请使用 globalErrorCapture.js 统一注册全局错误捕获'
        }
      ]
    },
    languageOptions: {
      globals: {
        Cesium: 'readonly',
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        performance: 'readonly',
        CustomEvent: 'readonly'
      }
    }
  },
  {
    files: ['src/App.vue', 'src/components/**/*.{js,vue}', 'src/composables/**/*.{js,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*/services/*'],
              message: '入口层请优先通过 @/features/shared/index.js 使用功能模块公共 API'
            }
          ]
        }
      ]
    }
  },
  {
    ignores: ['dist/*', 'public/*', 'coverage/*']
  }
]
